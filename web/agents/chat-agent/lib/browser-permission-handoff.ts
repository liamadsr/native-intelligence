import { defineState } from 'eve/context'
import type { LanguageModel } from 'ai'
import type { ModelSelection } from './spec-client.js'
import { resolverStepIndex } from './resolver-step.js'

type LocalModel = Extract<LanguageModel, { specificationVersion: 'v4' }>
type ObjectSelection = Exclude<ModelSelection, string>
export type LivePermissionSelection = Omit<ObjectSelection, 'model'> & { model: LocalModel }
type Outcome = 'site_blocked' | 'cancelled' | 'stopped' | 'command_failed' | 'attempts'
/** `unverified` counts this turn's distinct unverified task results; `counted`
 * dedupes a result read twice (run, then wait). `blockedSite` is the entry the
 * user blocked the agent on, for site_blocked. */
type Handoff = { turnId: string; blocked: boolean; blockedSite: string | null; outcome: Outcome
  unverified: number; counted: string[]; refusals: number }
type Scope = { turnId: string; sequence: number; stepIndex: number }
const handoff = defineState<Handoff | null>('chat-agent.browser-permission-handoff', () => null)
/** The original task plus two continuations from the page it reached. */
export const MAX_UNVERIFIED_BROWSER_TASKS = 3
/** Mirrors BROWSER_TASK_HARD_STOP_REASONS in src/lib/browser-agent/task-instructions.ts:
 * these need the user, so another task in this turn cannot help. */
export const HARD_STOP_REASONS: ReadonlySet<string> = new Set(['site_blocked', 'budget_unavailable', 'not_authorized',
  'taken_over', 'needs_your_mac', 'never_automate'])
const fresh = (turnId: string): Handoff => ({ turnId, blocked: false, blockedSite: null, outcome: 'stopped', unverified: 0, counted: [], refusals: 0 })
const localUsage = defineState<Scope | null>('chat-agent.browser-handoff-local-usage', () => null)
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const validTurn = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200

/** A blocked-sites entry ("linkedin.com"); anything else is not repeated. */
function site(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 253 && /^[a-z0-9.:[\]-]+$/.test(value) ? value : null
}

/** Called by the authored proxy after its trusted server tool response. */
export function captureBrowserPermissionHandoff(input: {
  turnId: string
  toolName: string
  input: unknown
  output: unknown
}): void {
  if (!validTurn(input.turnId) || !['run_browser_task', 'wait_for_browser_command'].includes(input.toolName)) return
  const output = record(input.output)
  const result = record(output?.result)
  // The server refused a task whose start page is on a blocked site before
  // queueing it: nothing ran, and nothing this turn can change that.
  if (input.toolName === 'run_browser_task' && output?.site_blocked === true) {
    handoff.update(previous => {
      if (previous && (previous.turnId !== input.turnId || previous.blocked)) return previous
      return { ...(previous ?? fresh(input.turnId)), blocked: true, blockedSite: site(result?.blockedSite), outcome: 'site_blocked' }
    })
    return
  }
  const ownedCommand = typeof output?.browser_command_id === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(output.browser_command_id)
  // Current task responses report goal success. Preserve old responses whose
  // success=true meant only that the queue finished; pending is never terminal.
  const completedTask = output?.success === false && ownedCommand && output.browser_command_status === 'completed'
  const stoppedResult = result?.status === 'escalate' || result?.status === 'cancelled'
  // This field is authored only after the server reads an owned terminal queue
  // row. Arbitrary errors and unknown delivery outcomes are not terminal proof.
  const commandFailed = output?.success === false &&
    ownedCommand && (['failed', 'denied', 'expired'].includes(String(output.browser_command_status)) ||
      (completedTask && !stoppedResult))
  if (!output || output.pending === true || output.still_running === true ||
    (!commandFailed && (!(output.success === true || completedTask) || !stoppedResult))) return
  // An unfinished task returns what it read. The model answers from those
  // readings or continues from the reached page; only repeated misses stop it.
  if (!commandFailed && result?.status === 'escalate' && !HARD_STOP_REASONS.has(String(result.reason))) {
    const key = ownedCommand ? String(output.browser_command_id) : null
    handoff.update(previous => {
      if (previous && (previous.turnId !== input.turnId || previous.blocked)) return previous
      const current = previous ?? fresh(input.turnId)
      if (key && current.counted.includes(key)) return current
      return { ...current, unverified: current.unverified + 1, counted: key ? [...current.counted, key].slice(-8) : current.counted }
    })
    return
  }
  const outcome: Outcome = commandFailed ? 'command_failed'
    : result?.status === 'cancelled' ? 'cancelled' : result?.reason === 'site_blocked' ? 'site_blocked' : 'stopped'
  // The entry the user blocked, never the page's address: a kept-off
  // navigation leaves the old page in place.
  const blockedSite = outcome === 'site_blocked' ? site(result?.blockedSite) : null
  handoff.update(previous => {
    if (previous && (previous.turnId !== input.turnId || previous.blocked)) return previous
    return { ...(previous ?? fresh(input.turnId)), blocked: true, blockedSite, outcome }
  })
}

/**
 * Checked by the authored proxy before dispatch. After the turn's allowance of
 * unverified tasks, the next run_browser_task is refused so the model answers
 * from the readings it already has; a second refused call ends the turn.
 */
export function browserTaskLimitRefusal(turnId: string | undefined, toolName: string): Record<string, unknown> | null {
  if (toolName !== 'run_browser_task' || !validTurn(turnId)) return null
  const current = handoff.get()
  if (!current || current.turnId !== turnId || current.unverified < MAX_UNVERIFIED_BROWSER_TASKS) return null
  handoff.update(previous => {
    if (!previous || previous.turnId !== turnId) return previous
    const refusals = previous.refusals + 1
    return refusals > 1 && !previous.blocked
      ? { ...previous, refusals, blocked: true, blockedSite: null, outcome: 'attempts' }
      : { ...previous, refusals }
  })
  return {
    success: false,
    browser_task_limit: true,
    error: `${MAX_UNVERIFIED_BROWSER_TASKS} browser tasks in this turn ended without confirming the goal. Do not start another browser task now. Answer from the readings already returned, say what was not confirmed, and ask the user how to continue.`,
  }
}

/** New human turns may retry after the user unblocks a site. */
export function resetBrowserPermissionHandoff(turnId: string): void {
  handoff.update(() => validTurn(turnId) ? fresh(turnId) : null)
  localUsage.update(() => null)
}

export function browserSiteBlockedMessage(blockedSite: string | null): string {
  return `You’ve blocked me from ${blockedSite ?? 'that site'}, so I stopped there. To let me use it, unblock it under Blocked sites in my computer (its live view), then tell me to continue.`
}

function handoffMessage(blocked: Handoff): string {
  if (blocked.outcome === 'command_failed') return 'I could not verify that the browser task completed. I stopped here; check the browser and tell me whether to continue.'
  if (blocked.outcome === 'site_blocked') return browserSiteBlockedMessage(blocked.blockedSite)
  if (blocked.outcome === 'attempts') return 'The browser still had not confirmed this task after several attempts, so I stopped here. What it read is in the browser task results above. Tell me how you would like to proceed.'
  if (blocked.outcome === 'cancelled') return 'The browser task was cancelled before completion. Tell me when you would like to continue.'
  return 'The browser agent stopped before completing the task. Tell me how you would like to proceed.'
}

function scopeFrom(event: unknown, turnId: string, messages: readonly unknown[]): Scope | null {
  const data = record(record(event)?.data)
  // The resolver's stepIndex is eve 0.79's previous step past the first:
  // corrected to the step the meter reads (resolver-step.ts).
  return data?.turnId === turnId && Number.isInteger(data.sequence) && Number.isInteger(data.stepIndex) &&
    (data.sequence as number) >= 0 && (data.stepIndex as number) >= 0
    ? { turnId, sequence: data.sequence as number, stepIndex: resolverStepIndex(data.stepIndex as number, messages) } : null
}

/** Only the local step that actually ran can be assigned known-zero billing. */
export function isLocalBrowserHandoffStep(scope: Scope): boolean {
  const saved = localUsage.get()
  return saved !== null && saved.turnId === scope.turnId && saved.sequence === scope.sequence && saved.stepIndex === scope.stepIndex
}

/**
 * A deterministic application response through Eve's supported live-model
 * seam. It makes no provider request and emits no tool call, so Eve completes
 * this turn normally with the already-recorded tool result intact. Its logical
 * identity matches the user's model so the usage meter keeps prior spend on
 * the correct model; this extra step has exactly zero tokens and cost.
 */
export function browserPermissionHandoffSelection(selection: ModelSelection, turnId: string, event?: unknown, messages: readonly unknown[] = []): LivePermissionSelection | null {
  if (!validTurn(turnId)) return null
  const scope = scopeFrom(event, turnId, messages)
  if (!scope) return null
  const blocked = handoff.get()
  if (!blocked?.blocked || blocked.turnId !== turnId) return null
  const selected = typeof selection === 'string' ? { model: selection } : selection
  const slash = selected.model.indexOf('/')
  const provider = slash >= 0 ? selected.model.slice(0, slash) : 'anthropic'
  const modelId = slash >= 0 ? selected.model.slice(slash + 1) : selected.model
  const text = handoffMessage(blocked)
  const usage = {
    // Eve uses input total to cache the full history's context size. This local
    // response did not tokenize that history, so leave its estimate unset. The
    // exact scoped marker below lets our meter record the known zero charge.
    inputTokens: { total: undefined, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  }
  const providerMetadata = { gateway: { cost: 0 }, niControl: { kind: 'browser_task_handoff', local: true } }
  const model: LocalModel = {
    specificationVersion: 'v4', provider, modelId, supportedUrls: {},
    async doGenerate(params) {
      params.abortSignal?.throwIfAborted()
      localUsage.update(() => scope)
      return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, providerMetadata, warnings: [] }
    },
    async doStream(params) {
      params.abortSignal?.throwIfAborted()
      localUsage.update(() => scope)
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        controller.enqueue({ type: 'text-start', id: 'browser-permission-handoff' })
        controller.enqueue({ type: 'text-delta', id: 'browser-permission-handoff', delta: text })
        controller.enqueue({ type: 'text-end', id: 'browser-permission-handoff' })
        controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage, providerMetadata })
        controller.close()
      } }) }
    },
  }
  // Eve checks automatic compaction after selecting a model but before calling
  // it. This local response never consumes context: a finite, effectively
  // unbounded window prevents the permission text from being used as a history
  // summary. The next real model selection restores its actual context window.
  return { ...selected, modelContextWindowTokens: Number.MAX_SAFE_INTEGER, model }
}
