import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { jsonSchema, streamText, tool, wrapLanguageModel, type LanguageModelMiddleware, type ToolSet } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { browserDispatchMiddleware, browserDispatchSelection } from '../browser-dispatch-model'
import { browserDispatchUsageFor, recordBrowserDispatchUsage } from '../browser-dispatch-usage-state'
import { gatewaySlugOf } from '../turn-usage'

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]
type Part = Awaited<ReturnType<Wrapped['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
const input = JSON.stringify({ goal: 'Open the Ada Lovelace article', completion: [{ kind: 'heading', value: 'Ada Lovelace' }] })
const usage = (n = 10) => ({ inputTokens: { total: n, noCache: n - 2, cacheRead: 2, cacheWrite: 0 }, outputTokens: { total: n, text: n - 1, reasoning: 1 } })
const finish = (reason: 'length' | 'tool-calls' | 'stop', id = 'gen-first', host = 'wafer', n = 10): Extract<Part, { type: 'finish' }> => ({
  type: 'finish', finishReason: { unified: reason, raw: reason }, usage: usage(n),
  providerMetadata: { gateway: { cost: 0.01, generationId: id, routing: { finalProvider: host } } },
})
const calls = (id = 'call-first', value = input, name = 'run_browser_task'): Part[] => [
  { type: 'tool-input-start', id, toolName: name },
  { type: 'tool-input-delta', id, delta: value },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName: name, input: value },
]
const text: Part[] = [{ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Working.' }, { type: 'text-end', id: 'text' }]
function readable(parts: Part[]) {
  return new ReadableStream<Part>({ start(c) { for (const p of parts) c.enqueue(p); c.close() } })
}
type Factory = (params: Wrapped['params']) => Awaited<ReturnType<Wrapped['doStream']>> | Promise<Awaited<ReturnType<Wrapped['doStream']>>>
function setup(attempts: (Part[] | Factory)[], options: { timeout?: number; retryTimeout?: number; tools?: boolean; only?: string[]; signal?: AbortSignal; onMetadata?: (value: unknown) => void } = {}) {
  const execute = vi.fn(async () => ({ status: 'pending' }))
  let index = 0
  const provider = new MockLanguageModelV4({
    provider: 'gateway', modelId: 'deepseek/deepseek-v4-flash',
    doStream: async params => {
      const next = attempts[index++]
      if (!next) throw new Error('Unexpected retry')
      return typeof next === 'function' ? next(params) : { stream: readable([{ type: 'stream-start', warnings: [] }, ...next]) }
    },
  })
  const model = wrapLanguageModel({ model: provider, middleware: browserDispatchMiddleware({ argumentTimeoutMs: options.timeout, retryTimeoutMs: options.retryTimeout, onRecoveryMetadata: options.onMetadata }) })
  const tools: ToolSet = options.tools === false ? {} : {
    run_browser_task: tool({ description: 'Run a bounded browser task', inputSchema: jsonSchema({ type: 'object' }), execute }),
  }
  const result = streamText({
    model, prompt: 'Open Ada in the browser', tools, maxRetries: 0,
    reasoning: 'xhigh', abortSignal: options.signal,
    providerOptions: { deepseek: { thinking: { type: 'enabled' } }, gateway: { only: options.only ?? ['wafer', 'alibaba'], user: 'user-test', tags: ['test'] } },
  })
  const parts: unknown[] = []
  const done = (async () => { for await (const part of result.fullStream) parts.push(part) })()
  return { provider, execute, result, parts, done }
}

describe('browser dispatch recovery at the actual SDK execution boundary', () => {
  it('discards valid length-ended calls, retries once, and executes only the successful call', async () => {
    const s = setup([[...text, ...calls(), finish('length')], [...text, ...calls('call-retry'), finish('tool-calls', 'gen-second', 'alibaba', 20)]])
    await s.done
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['call-retry'])
    expect(await s.result.text).toBe('Working.')
    expect((await s.result.usage).inputTokens).toBe(30)
    expect((await s.result.usage).outputTokens).toBe(30)
    expect(await s.result.providerMetadata).toMatchObject({ gateway: { cost: 0.02 }, browserDispatch: {
      version: 1, retried: true, reason: 'length', failed: false, usageUnknown: false,
      attempts: [{ generationId: 'gen-first', provider: 'wafer' }, { generationId: 'gen-second', provider: 'alibaba' }],
    } })
    const retry = s.provider.doStreamCalls[1]
    expect(retry.reasoning).toBe('xhigh')
    expect(retry.providerOptions).toMatchObject({ deepseek: { thinking: { type: 'enabled' } }, gateway: { only: ['alibaba'], user: 'user-test', tags: ['test'] } })
    expect(retry.toolChoice).toEqual({ type: 'tool', toolName: 'run_browser_task' })
    expect(retry.prompt.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'tool-call'))).toBe(false)
  })

  it('passes a clean single task through without retry or altered usage', async () => {
    const s = setup([[...calls(), finish('tool-calls')]])
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(1)
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect(await s.result.providerMetadata).not.toHaveProperty('browserDispatch')
  })

  it('rejects an oversized input even when a clean finish is already queued', async () => {
    const s = setup([[...calls('large', ' '.repeat(320_001)), finish('tool-calls')], [...calls('retry'), finish('tool-calls', 'gen-second', 'alibaba')]])
    await s.done
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['retry'])
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { reason: 'argument_size', usageUnknown: true } })
  })

  it('cancels a stalled tool stream and recovers without waiting for provider cancellation', async () => {
    let firstSignal: AbortSignal | undefined
    const s = setup([params => {
      firstSignal = params.abortSignal
      return { stream: new ReadableStream<Part>({ start(c) { c.enqueue({ type: 'tool-input-start', id: 'stuck', toolName: 'run_browser_task' }) } }) }
    }, [...calls('retry'), finish('tool-calls', 'gen-second', 'alibaba')]], { timeout: 5 })
    await s.done
    expect(firstSignal?.aborted).toBe(true)
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { reason: 'argument_timeout', usageUnknown: true } })
  })

  it('does not let multiple calls race the same browser tab', async () => {
    const s = setup([[...calls('one'), ...calls('two'), finish('tool-calls')], [...calls('only'), finish('tool-calls', 'gen-second', 'alibaba')]])
    await s.done
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['only'])
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { reason: 'multiple_calls' } })
  })

  it('diagnoses mismatched stream/completed IDs without accepting or exposing the discarded call', async () => {
    const mismatched = calls('private-stream-id')
    mismatched[3] = { type: 'tool-call', toolCallId: 'private-completed-id', toolName: 'run_browser_task', input }
    const s = setup([[...mismatched, finish('tool-calls')], [...calls('retry'), finish('tool-calls', 'gen-second', 'alibaba')]])
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(2)
    expect(s.execute).toHaveBeenCalledOnce()
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['retry'])
    const metadata = await s.result.providerMetadata
    expect(metadata).toMatchObject({ browserDispatch: { reason: 'multiple_calls', attempts: [
      { browserCallCount: 2, toolEventsTruncated: false, toolEvents: [
        { type: 'tool-input-start', id: 'b1' }, { type: 'tool-input-end', id: 'b1' }, { type: 'tool-call', id: 'b2' },
      ] },
      { toolEvents: [
        { type: 'tool-input-start', id: 'b1' }, { type: 'tool-input-end', id: 'b1' }, { type: 'tool-call', id: 'b1' }, { type: 'finish', reason: 'tool-calls' },
      ] },
    ] } })
    expect(JSON.stringify(metadata)).not.toContain('private-')
    expect(JSON.stringify(metadata)).not.toContain(input)
  })

  it('keeps only browser envelopes and an enumerated finish reason', async () => {
    const otherFinish: Part = { ...finish('stop'), finishReason: { unified: 'other', raw: 'private finish reason' } }
    const s = setup([[...calls('private-other-id', '{}', 'unrelated_tool'), ...calls(), otherFinish], [...calls('retry'), finish('tool-calls')]])
    await s.done
    expect(s.execute).toHaveBeenCalledOnce()
    const metadata = await s.result.providerMetadata
    expect(metadata).toMatchObject({ browserDispatch: { attempts: [
      { toolEvents: [{ type: 'tool-input-start', id: 'b1' }, { type: 'tool-input-end', id: 'b1' }, { type: 'tool-call', id: 'b1' }, { type: 'finish', reason: 'other' }] },
      expect.any(Object),
    ] } })
    expect(JSON.stringify(metadata)).not.toMatch(/private|unrelated_tool/)
  })

  it('records provider errors as a fixed enum without their raw error text', async () => {
    const s = setup([[calls()[0], { type: 'error', error: new Error('private provider error') }], [...calls('retry'), finish('tool-calls')]])
    await s.done
    const metadata = await s.result.providerMetadata
    expect(metadata).toMatchObject({ browserDispatch: { reason: 'provider_error', attempts: [
      { toolEvents: [{ type: 'tool-input-start', id: 'b1' }, { type: 'error', reason: 'provider_error' }] }, expect.any(Object),
    ] } })
    expect(JSON.stringify(metadata)).not.toContain('private')
  })

  it('caps recorded envelopes without changing rejection of a second browser call', async () => {
    const first = [...calls('one'), ...Array.from({ length: 20 }, (): Part => ({ type: 'tool-input-end', id: 'one' })), ...calls('two'), finish('tool-calls')]
    const s = setup([first, [...calls('retry'), finish('tool-calls')]])
    await s.done
    expect(s.execute).toHaveBeenCalledOnce()
    const metadata = (await s.result.providerMetadata)?.browserDispatch as unknown as { attempts: { toolEvents: unknown[]; toolEventsTruncated: boolean }[] }
    expect(metadata.attempts[0].toolEvents).toHaveLength(12)
    expect(metadata.attempts[0].toolEventsTruncated).toBe(true)
  })

  it('recovers immediately when a second browser input starts, even if that stream never finishes', async () => {
    let firstSignal: AbortSignal | undefined
    const cancelled = vi.fn()
    const s = setup([params => {
      firstSignal = params.abortSignal
      return { stream: new ReadableStream<Part>({ start(c) {
        for (const part of calls('one')) c.enqueue(part)
        c.enqueue({ type: 'tool-input-start', id: 'two', toolName: 'run_browser_task' })
        // No finish, no second arguments, and no provider cooperation needed.
      }, cancel: cancelled }) }
    }, [...calls('only'), finish('tool-calls', 'gen-second', 'alibaba')]], { timeout: 60_000 })
    await s.done
    expect(firstSignal?.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(s.provider.doStreamCalls).toHaveLength(2)
    expect(s.execute).toHaveBeenCalledOnce()
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['only'])
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { reason: 'multiple_calls', usageUnknown: true, attempts: [
      { toolEvents: [{ type: 'tool-input-start', id: 'b1' }, { type: 'tool-input-end', id: 'b1' }, { type: 'tool-call', id: 'b1' }, { type: 'tool-input-start', id: 'b2' }] },
      expect.any(Object),
    ] } })
    expect(s.provider.doStreamCalls[1].reasoning).toBe('xhigh')
  })

  it('also rejects a second complete browser call from nonincremental providers before waiting for finish', async () => {
    const s = setup([() => ({ stream: new ReadableStream<Part>({ start(c) {
      c.enqueue({ type: 'tool-call', toolCallId: 'one', toolName: 'run_browser_task', input })
      c.enqueue({ type: 'tool-call', toolCallId: 'two', toolName: 'run_browser_task', input })
    } }) }), [...calls('only'), finish('tool-calls', 'gen-second', 'alibaba')]], { timeout: 60_000 })
    await s.done
    expect(s.execute).toHaveBeenCalledOnce()
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { reason: 'multiple_calls' } })
  })

  it('does not accept an incomplete first browser call even on a clean stop', async () => {
    const s = setup([[...calls().slice(0, 2), finish('stop')], [...calls('retry'), finish('tool-calls', 'gen-second', 'alibaba')]])
    await s.done
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['retry'])
  })

  it('does not flush a partial second input beside one completed browser call', async () => {
    const s = setup([[...calls(), ...calls('partial').slice(0, 2), finish('tool-calls')], [...calls('retry'), finish('tool-calls', 'gen-second', 'alibaba')]])
    await s.done
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect((await s.result.toolCalls).map(c => c.toolCallId)).toEqual(['retry'])
  })

  it('bounds retry response headers even when the provider ignores abort', async () => {
    let retrySignal: AbortSignal | undefined
    const s = setup([[...calls(), finish('length')], params => {
      retrySignal = params.abortSignal
      return new Promise(() => {})
    }], { retryTimeout: 5 })
    await s.done
    expect(retrySignal?.aborted).toBe(true)
    expect(s.provider.doStreamCalls).toHaveLength(2)
    expect(s.execute).not.toHaveBeenCalled()
    expect(await s.result.text).toContain('browser task was not started')
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { failed: true, usageUnknown: true, attempts: [expect.any(Object), { elapsedMs: expect.any(Number), headersMs: null, toolInputStartMs: null, toolInputChars: 0, browserCallCount: 0 }] } })
  })

  it.each([
    ['another length finish', [...calls('retry'), finish('length', 'gen-second', 'alibaba')]],
    ['no tool call', [...text, finish('stop', 'gen-second', 'alibaba')]],
    ['multiple tool calls', [...calls('two'), ...calls('three'), finish('tool-calls', 'gen-second', 'alibaba')]],
    ['request rejection', async () => { throw new Error('host unavailable') }],
  ] as const)('ends honestly with no dangling calls after %s', async (_name, second) => {
    const s = setup([[...calls(), finish('length')], second as Part[] | Factory])
    await s.done
    expect(s.execute).not.toHaveBeenCalled()
    expect(await s.result.toolCalls).toEqual([])
    expect(await s.result.text).toContain('browser task was not started')
    expect(s.provider.doStreamCalls).toHaveLength(2)
    expect(await s.result.providerMetadata).toMatchObject({ browserDispatch: { failed: true, retried: true } })
    expect((await s.result.usage).inputTokens).toBeGreaterThanOrEqual(10)
  })

  it('does not expand a privacy allowlist to obtain a retry', async () => {
    const s = setup([[...calls(), finish('length')]], { only: ['wafer'] })
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(1)
    expect(s.execute).not.toHaveBeenCalled()
    expect(await s.result.text).toContain('browser task was not started')
  })

  it('does not replay an attempt that included a provider-executed action', async () => {
    const providerCall: Part = { type: 'tool-call', toolCallId: 'server', toolName: 'remote', input: '{}', providerExecuted: true }
    const s = setup([[providerCall, ...calls(), finish('length')]])
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(1)
    expect(s.execute).not.toHaveBeenCalled()
  })

  it('does not use early duplicate recovery after a provider-executed action', async () => {
    const providerCall: Part = { type: 'tool-call', toolCallId: 'server', toolName: 'remote', input: '{}', providerExecuted: true }
    const s = setup([[providerCall, ...calls('one'), ...calls('two'), finish('length')]])
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(1)
    expect(s.execute).not.toHaveBeenCalled()
  })

  it('keeps nonbrowser streams and their output budget unchanged', async () => {
    const s = setup([[...text, finish('length')]], { tools: false })
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(1)
    expect(await s.result.text).toBe('Working.')
    expect(s.provider.doStreamCalls[0].maxOutputTokens).toBeUndefined()
  })

  it('does not retry after user cancellation', async () => {
    const abort = new AbortController()
    const s = setup([() => ({ stream: new ReadableStream<Part>({ start(c) {
      c.enqueue({ type: 'tool-input-start', id: 'stuck', toolName: 'run_browser_task' })
      setTimeout(() => abort.abort(), 5)
    } }) })], { signal: abort.signal })
    await s.done
    expect(s.provider.doStreamCalls).toHaveLength(1)
    expect(s.execute).not.toHaveBeenCalled()
  })
})

describe('Eve live model selection', () => {
  it('preserves unrelated selections verbatim', () => {
    const selected = { model: 'moonshotai/kimi-k2.6', reasoning: 'xhigh' as const }
    expect(browserDispatchSelection(selected)).toBe(selected)
  })

  it('the installed Eve resolver accepts the live selection and preserves Max policy', async () => {
    const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
    const { resolveRuntimeModelSelection } = await import(pathToFileURL(join(eveRoot, 'dist/src/runtime/agent/resolve-model.js')).href)
    const selection = browserDispatchSelection({
      model: 'deepseek/deepseek-v4-flash', reasoning: 'xhigh', modelContextWindowTokens: 1_000_000,
      modelOptions: { providerOptions: { gateway: { only: ['wafer', 'alibaba'] }, deepseek: { thinking: { type: 'enabled' } } } },
    })
    const out = await resolveRuntimeModelSelection({ selection, durability: 'live', state: { get: vi.fn(), set: vi.fn() } })
    // eve names a live model with an explicit window `${provider}/${modelId}`; the
    // usage readers bill on the slug (gatewaySlugOf).
    expect(out.reference).toMatchObject({ id: 'gateway/deepseek/deepseek-v4-flash', reasoning: 'xhigh', contextWindowTokens: 1_000_000,
      providerOptions: { gateway: { only: ['wafer', 'alibaba'] }, deepseek: { thinking: { type: 'enabled' } } },
    })
    expect(out.model).toBe(selection && typeof selection === 'object' ? selection.model : null)
    expect(out.reference.providerOptions.gateway.caching).toBe('auto')
    const { resolveWebSearchBackend } = await import(pathToFileURL(join(eveRoot, 'dist/src/harness/provider-tools.js')).href)
    const { resolveModelProfile } = await import(pathToFileURL(join(eveRoot, 'dist/src/harness/model-profile.js')).href)
    expect(gatewaySlugOf(out.reference.id)).toBe('deepseek/deepseek-v4-flash')
    // A Gateway profile: web_search stays on the pinned Exa (a non-Gateway
    // provider alias would make eve delete it: DeepSeek has no native search).
    expect(resolveModelProfile(out.model)).toMatchObject({ gateway: true })
    expect(resolveWebSearchBackend(resolveModelProfile(out.model), { provider: 'exa' })).toBe('exa')
  })

  it('records retry metadata from the asynchronous model stream in actual Eve durable context', async () => {
    const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
    const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, 'dist/src/context/container.js')).href)
    const scope = { turnId: 'turn-real-context', sequence: 2, stepIndex: 3 }
    await contextStorage.run(new ContextContainer(), async () => {
      const onMetadata = vi.fn((metadata: unknown) => recordBrowserDispatchUsage(scope, metadata))
      const s = setup([[...calls(), finish('length')], [...calls('retry'), finish('tool-calls', 'gen-second', 'alibaba')]], { onMetadata })
      await s.done
      expect(onMetadata).toHaveBeenCalledTimes(1)
      expect(browserDispatchUsageFor(scope)).toMatchObject({ version: 1, usageUnknown: false, reason: 'length',
        attempts: [{ generationId: 'gen-first', usageKnown: true, elapsedMs: expect.any(Number), headersMs: expect.any(Number), toolInputStartMs: expect.any(Number), toolInputChars: input.length, browserCallCount: 1 }, { generationId: 'gen-second', usageKnown: true, elapsedMs: expect.any(Number), headersMs: expect.any(Number), toolInputStartMs: expect.any(Number), toolInputChars: input.length, browserCallCount: 1 }],
      })
      expect(browserDispatchUsageFor({ ...scope, stepIndex: 4 })).toBeNull()
    })
  })
})
