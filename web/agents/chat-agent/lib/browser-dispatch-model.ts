import { gateway, wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import type { ModelSelection } from './spec-client.js'
import { recordBrowserDispatchUsage, type BrowserDispatchToolEvent } from './browser-dispatch-usage-state.js'
import { resolverStepIndex } from './resolver-step.js'

// Derive these from the SDK boundary: the app also installs an older provider
// package for another integration, whose JSON types differ from AI SDK 7's.
type WrapArguments = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]
type LanguageModelV4CallOptions = WrapArguments['params']
type StreamResult = Awaited<ReturnType<WrapArguments['doStream']>>
type Part = StreamResult['stream'] extends ReadableStream<infer P> ? P : never
type LanguageModelV4Usage = Extract<Part, { type: 'finish' }>['usage']

const MODEL = 'deepseek/deepseek-v4-flash'
const BROWSER_TOOL = 'run_browser_task'
const FAILURE = 'The browser task was not started because the model could not finish its browser instructions. Please try again.'
// The task schema permits ~45k characters before JSON escaping. Six-character
// escapes can expand that above 256KiB. The timer is the latency bound; these
// larger limits bound memory without rejecting a fully populated valid task.
const MAX_ARGUMENT_CHARS = 320_000
const MAX_BUFFER_CHARS = 640_000
const ARGUMENT_TIMEOUT_MS = 15_000
type Finish = Extract<Part, { type: 'finish' }>
type Reason = 'argument_timeout' | 'argument_size' | 'length' | 'incomplete_stream' | 'provider_error' | 'multiple_calls'
type AttemptDiagnostics = { elapsedMs: number; headersMs: number | null; toolInputStartMs: number | null; toolInputChars: number; browserCallCount: number;
  toolEvents: BrowserDispatchToolEvent[]; toolEventsTruncated: boolean }
type Attempt = {
  generationId: string | null
  provider: string | null
  cost: number | null
  inputTokens: number | null
  outputTokens: number | null
  usageKnown: boolean
} & AttemptDiagnostics

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const number = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
const string = (value: unknown): string | null => typeof value === 'string' && value ? value : null

function emptyUsage(): LanguageModelV4Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function sumUsage(finishes: Finish[]): LanguageModelV4Usage {
  const usage = emptyUsage()
  for (const side of ['inputTokens', 'outputTokens'] as const) {
    for (const key of Object.keys(usage[side])) {
      const values = finishes.map(f => (f.usage[side] as Record<string, number | undefined>)[key]).filter((n): n is number => n !== undefined)
      if (values.length) (usage[side] as Record<string, number | undefined>)[key] = values.reduce((a, b) => a + b, 0)
    }
  }
  return usage
}

function attempt(finish: Finish | undefined, diagnostics: AttemptDiagnostics): Attempt {
  const meta = record(finish?.providerMetadata?.gateway)
  return {
    ...diagnostics,
    // response-metadata.id can be an upstream provider ID, not a Gateway
    // generation ID. A canceled stream without final metadata stays unknown.
    generationId: string(meta?.generationId),
    provider: string(record(meta?.routing)?.finalProvider),
    cost: number(meta?.cost),
    inputTokens: number(finish?.usage.inputTokens.total),
    outputTokens: number(finish?.usage.outputTokens.total),
    usageKnown: finish !== undefined && number(finish.usage.inputTokens.total) !== null && number(finish.usage.outputTokens.total) !== null && number(meta?.cost) !== null,
  }
}

function terminal(finish: Finish | undefined, finishes: Finish[], attempts: Attempt[], reason: Reason, failed: boolean): Finish {
  const knownCosts = attempts.flatMap(a => a.cost === null ? [] : [a.cost])
  const providerMetadata = { ...finish?.providerMetadata }
  const gatewayMetadata = { ...record(providerMetadata.gateway) }
  // This is a known subtotal if an aborted attempt did not report cost. The
  // explicit unknown flag prevents the report from presenting it as complete.
  if (knownCosts.length) gatewayMetadata.cost = knownCosts.reduce((a, b) => a + b, 0)
  else delete gatewayMetadata.cost
  providerMetadata.gateway = gatewayMetadata as NonNullable<Finish['providerMetadata']>[string]
  providerMetadata.browserDispatch = {
    version: 1, retried: attempts.length > 1, reason, failed,
    attempts, usageUnknown: attempts.some(a => !a.usageKnown),
  }
  return {
    type: 'finish', finishReason: failed ? { unified: 'stop', raw: 'browser_dispatch_failed' } : finish!.finishReason,
    usage: sumUsage(finishes), providerMetadata,
  }
}

/** Retry only inside the existing privacy allowlist; never broaden routing. */
function retryParams(params: LanguageModelV4CallOptions, failedProvider: string | null): LanguageModelV4CallOptions | null {
  const options = params.providerOptions ?? {}
  const routing = record(options.gateway)
  const only = Array.isArray(routing?.only) ? routing.only.filter((h): h is string => typeof h === 'string') : []
  // Aborted Gateway streams do not reliably identify their host. Alibaba is
  // the explicit recovery host for the observed Wafer failure, only when the
  // caller already permits it. Do not claim the unknown first host differed.
  const host = failedProvider
    ? only.find(h => h !== failedProvider && h === 'alibaba') ?? only.find(h => h !== failedProvider)
    : only.includes('alibaba') ? 'alibaba' : null
  if (!host) return null
  return {
    ...params,
    toolChoice: { type: 'tool', toolName: BROWSER_TOOL },
    tools: params.tools?.filter(t => t.type === 'function' && t.name === BROWSER_TOOL),
    providerOptions: { ...options, gateway: { ...routing, only: [host], order: [host] } },
    // No partial assistant calls or tool results are added: nothing executed.
    prompt: [...params.prompt, { role: 'user', content: [{ type: 'text', text: 'The previous browser instruction generation did not finish; no tool was executed. Produce exactly one concise run_browser_task call for the pending user request. Do not repeat any previously completed tools.' }] }],
  }
}

const isToolPart = (part: Part): boolean => part.type.startsWith('tool-')

/** Bound even providers that do not promptly honor their abort signal. */
function withAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('Aborted'))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/**
 * Eve runs this supported AI SDK middleware before tool execution. The SDK
 * executes tools only after a clean finish; buffering prevents its UI/history
 * from retaining calls discarded by a length finish. Ordinary text/reasoning
 * retain their existing budgets and streaming behavior.
 */
export function browserDispatchMiddleware(options: {
  argumentTimeoutMs?: number
  retryTimeoutMs?: number
  onRecoveryMetadata?: (metadata: unknown) => void
} = {}): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    async wrapStream({ model, params, doStream }) {
      if (!params.tools?.some(t => t.type === 'function' && t.name === BROWSER_TOOL)) return doStream()
      const cancellation = new AbortController()
      const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, cancellation.signal]) : cancellation.signal
      const firstAbort = new AbortController()
      const firstSignal = AbortSignal.any([signal, firstAbort.signal])
      const firstStarted = performance.now()
      const first = await withAbort(model.doStream({ ...params, abortSignal: firstSignal }), firstSignal)
      const firstHeadersMs = Math.max(0, Math.round(performance.now() - firstStarted))
      let activeReader: ReadableStreamDefaultReader<Part> | undefined
      return {
        ...first,
        stream: new ReadableStream<Part>({
          async start(controller) {
            const finishes: Finish[] = []
            const attempts: Attempt[] = []
            const openBlocks = new Map<string, 'text' | 'reasoning'>()
            let reason: Reason = 'incomplete_stream'
            let firstResponse = true
            const emit = (part: Part) => controller.enqueue(part)
            const emitRecoveryFinish = (part: Finish) => {
              // Eve's step event strips all provider metadata except the final
              // Gateway ID. Bridge these bounded accounting facts through its
              // durable state, then let the normal once-per-turn meter fold it.
              try { options.onRecoveryMetadata?.(part.providerMetadata?.browserDispatch) }
              catch { console.error('[chat-agent] browser dispatch usage metadata could not be recorded') }
              emit(part)
            }
            try {
              for (let index = 0; index < 2; index++) {
                const abort = index === 0 ? firstAbort : new AbortController()
                const currentParams = index === 0 ? params : retryParams(params, attempts[0].provider)
                if (!currentParams) break
                // The first attempt's ordinary reasoning/text has no added
                // deadline. Recovery has a separate ceiling, including headers;
                // its browser arguments retain the shorter 15-second deadline.
                const attemptSignal = AbortSignal.any([signal, abort.signal, ...(index > 0 ? [AbortSignal.timeout(options.retryTimeoutMs ?? 45_000)] : [])])
                const attemptStarted = index === 0 ? firstStarted : performance.now()
                let current
                try {
                  current = index === 0 ? first : await withAbort(model.doStream({ ...currentParams, abortSignal: attemptSignal }), attemptSignal)
                } catch (error) {
                  signal.throwIfAborted()
                  if (index === 0) throw error
                  reason = 'provider_error'
                  attempts.push(attempt(undefined, { elapsedMs: Math.max(0, Math.round(performance.now() - attemptStarted)), headersMs: null, toolInputStartMs: null, toolInputChars: 0, browserCallCount: 0, toolEvents: [], toolEventsTruncated: false }))
                  break
                }
                const headersMs = index === 0 ? firstHeadersMs : Math.max(0, Math.round(performance.now() - attemptStarted))
                let toolInputStartMs: number | null = null
                const reader = current.stream.getReader()
                activeReader = reader
                const buffered: Part[] = []
                const inputs = new Map<string, { browser: boolean; chars: number }>()
                const browserCallIds = new Set<string>()
                // Keep only anonymous browser event envelopes. Equal provider
                // IDs get the same alias, revealing correlation mistakes
                // without retaining IDs, argument text, or other tools.
                const aliases = new Map<string, string>()
                const toolEvents: BrowserDispatchToolEvent[] = []
                let toolEventsTruncated = false
                const envelope = (event: BrowserDispatchToolEvent) => {
                  if (toolEvents.length >= 12) { toolEventsTruncated = true; return }
                  toolEvents.push(event)
                }
                const toolEnvelope = (type: 'tool-input-start' | 'tool-input-end' | 'tool-call', id: string) => {
                  if (toolEvents.length >= 12) { toolEventsTruncated = true; return }
                  let alias = aliases.get(id)
                  if (!alias) { alias = `b${aliases.size + 1}`; aliases.set(id, alias) }
                  envelope({ type, id: alias })
                }
                let bufferChars = 0
                let browserStarted = index > 0
                let providerExecuted = false
                let finish: Finish | undefined
                let timer: ReturnType<typeof setTimeout> | undefined
                let rejectTimeout: (error: Error) => void = () => {}
                const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject })
                const watchdog = (why: Reason) => {
                  reason = why
                  const error = new Error(`Browser dispatch ${why}`)
                  rejectTimeout(error)
                  abort.abort(error)
                }
                const startTimer = () => {
                  timer ??= setTimeout(() => watchdog('argument_timeout'), options.argumentTimeoutMs ?? ARGUMENT_TIMEOUT_MS)
                }
                const startedBrowserCall = (id: string) => {
                  browserStarted = true
                  toolInputStartMs ??= Math.max(0, Math.round(performance.now() - attemptStarted))
                  browserCallIds.add(id)
                  // A second task can never be accepted for the same active tab.
                  // Recover as soon as it starts instead of paying for its full
                  // arguments or waiting for the 15-second watchdog. Provider
                  // actions already executed must never be replayed.
                  if (browserCallIds.size > 1 && !providerExecuted) {
                    watchdog('multiple_calls')
                    throw abort.signal.reason
                  }
                  startTimer()
                }
                try {
                  while (true) {
                    attemptSignal.throwIfAborted()
                    const next = await withAbort(Promise.race([reader.read(), timeout]), attemptSignal)
                    attemptSignal.throwIfAborted()
                    if (next.done) break
                    const part = next.value
                    if ('providerExecuted' in part && part.providerExecuted === true) providerExecuted = true
                    if (part.type === 'tool-input-start') {
                      inputs.set(part.id, { browser: part.toolName === BROWSER_TOOL, chars: 0 })
                      if (part.toolName === BROWSER_TOOL) {
                        toolEnvelope(part.type, part.id)
                        startedBrowserCall(part.id)
                      }
                    }
                    if (part.type === 'tool-input-end' && inputs.get(part.id)?.browser) toolEnvelope(part.type, part.id)
                    if (part.type === 'tool-input-delta') {
                      bufferChars += part.delta.length
                      const input = inputs.get(part.id)
                      if (input) input.chars += part.delta.length
                      if (browserStarted && ((input?.browser && input.chars > MAX_ARGUMENT_CHARS) || bufferChars > MAX_BUFFER_CHARS)) {
                        watchdog('argument_size')
                        throw abort.signal.reason
                      }
                    }
                    if (part.type === 'tool-call' && part.toolName === BROWSER_TOOL) {
                      toolEnvelope(part.type, part.toolCallId)
                      if (!inputs.has(part.toolCallId)) bufferChars += part.input.length
                      startedBrowserCall(part.toolCallId)
                      if (part.input.length > MAX_ARGUMENT_CHARS) { watchdog('argument_size'); throw abort.signal.reason }
                    }
                    if (part.type === 'finish') {
                      const reason = part.finishReason.unified
                      envelope({ type: 'finish', reason: reason === 'stop' || reason === 'length' || reason === 'tool-calls' ||
                        reason === 'content-filter' || reason === 'error' ? reason : 'other' })
                      finish = part
                      break
                    }
                    if (part.type === 'error' && browserStarted) {
                      envelope({ type: 'error', reason: 'provider_error' })
                      reason = 'provider_error'
                      break
                    }
                    if (isToolPart(part)) buffered.push(part)
                    else if (index === 0) {
                      if (part.type === 'text-start' || part.type === 'reasoning-start') openBlocks.set(part.id, part.type === 'text-start' ? 'text' : 'reasoning')
                      if (part.type === 'text-end' || part.type === 'reasoning-end') openBlocks.delete(part.id)
                      emit(part)
                      if (part.type === 'response-metadata') firstResponse = false
                    } else if (part.type === 'response-metadata') {
                      // One response metadata event, from the successful attempt,
                      // suffices. Attempt IDs remain in explicit metadata below.
                      if (firstResponse) { emit(part); firstResponse = false }
                    }
                  }
                } catch (error) {
                  signal.throwIfAborted()
                  if (!browserStarted || providerExecuted) throw error
                  if (!abort.signal.aborted) reason = 'provider_error'
                } finally {
                  if (timer) clearTimeout(timer)
                  void reader.cancel().catch(() => {})
                  activeReader = undefined
                }
                signal.throwIfAborted()
                if (finish) finishes.push(finish)
                attempts.push(attempt(finish, { elapsedMs: Math.max(0, Math.round(performance.now() - attemptStarted)), headersMs, toolInputStartMs, toolInputChars: bufferChars, browserCallCount: browserCallIds.size, toolEvents, toolEventsTruncated }))
                const calls = buffered.filter((p): p is Extract<Part, { type: 'tool-call' }> => p.type === 'tool-call' && p.toolName === BROWSER_TOOL)
                const completeIds = new Set(buffered.flatMap(p => p.type === 'tool-call' ? [p.toolCallId] : []))
                const partialInput = [...inputs.keys()].some(id => !completeIds.has(id))
                const clean = finish && (finish.finishReason.unified === 'stop' || finish.finishReason.unified === 'tool-calls')
                const accepted = clean && (!browserStarted || (calls.length === 1 && !partialInput))
                if (accepted || !browserStarted || providerExecuted) {
                  for (const part of buffered) emit(part)
                  if (finish) {
                    if (index === 0) emit(finish)
                    else emitRecoveryFinish(terminal(finish, finishes, attempts, reason, false))
                  }
                  controller.close()
                  return
                }
                if (calls.length > 1) reason = 'multiple_calls'
                if (finish?.finishReason.unified === 'length') reason = 'length'
                abort.abort(new Error(`Browser dispatch ${reason}`))
                // Complete visible blocks, without replaying the first attempt's
                // text or exposing discarded tool IDs on the retry.
                for (const [id, kind] of openBlocks) emit({ type: kind === 'text' ? 'text-end' : 'reasoning-end', id })
                openBlocks.clear()
              }
              const id = 'browser-dispatch-failed'
              emit({ type: 'text-start', id })
              emit({ type: 'text-delta', id, delta: FAILURE })
              emit({ type: 'text-end', id })
              emitRecoveryFinish(terminal(finishes.at(-1), finishes, attempts, reason, true))
              controller.close()
            } catch (error) { controller.error(error) }
          },
          cancel(reason) {
            cancellation.abort(reason)
            void activeReader?.cancel(reason).catch(() => {})
          },
        }),
      }
    },
  }
}

/** Live models are legal only at Eve's step.started scope. */
export function browserDispatchSelection(selection: ModelSelection, event?: unknown, messages: readonly unknown[] = []) {
  const selected = typeof selection === 'string' ? { model: selection } : selection
  if (selected.model !== MODEL) return selection
  const data = record(record(event)?.data)
  // The resolver's stepIndex is eve 0.79's previous step past the first:
  // corrected so the usage lands under the step the meter reads (resolver-step.ts).
  const scope = typeof data?.turnId === 'string' && typeof data.sequence === 'number' && typeof data.stepIndex === 'number'
    ? { turnId: data.turnId, sequence: data.sequence, stepIndex: resolverStepIndex(data.stepIndex, messages) } : null
  const providerOptions = selected.modelOptions?.providerOptions ?? {}
  // The wrapped model keeps the Gateway model's own provider (`gateway`) and
  // id. eve 0.75.1+ reads web search, Gateway session ids and attribution off
  // the model's provider (harness/model-profile.js): the logical `deepseek`
  // alias this used on eve 0.66.3 made the step a non-Gateway model, and eve
  // then DELETED web_search (DeepSeek has no native search). The cost: with
  // an explicit context window eve names a live model `${provider}/${modelId}`
  // (runtime/agent/resolve-model.js), so step.started reports
  // `gateway/deepseek/deepseek-v4-flash`; the usage readers strip the
  // `gateway/` prefix (turn-usage.ts gatewaySlugOf) to keep billing on the slug.
  return { ...selected,
    // Gateway prompt caching rides providerOptions.gateway.caching. eve 0.79
    // merges `auto` for a Gateway profile itself (harness/prompt-cache.js
    // mergeGatewayAutoCaching); keeping it explicit here is the same value.
    modelOptions: { providerOptions: { ...providerOptions, gateway: {
      ...providerOptions.gateway, caching: providerOptions.gateway?.caching ?? 'auto',
    } } },
    model: wrapLanguageModel({
    model: gateway(selected.model),
    middleware: browserDispatchMiddleware({
      onRecoveryMetadata: scope ? metadata => recordBrowserDispatchUsage(scope, metadata) : undefined,
    }),
    }),
  }
}
