import { defineState } from 'eve/context'

export interface BrowserDispatchUsageScope { turnId: string; sequence: number; stepIndex: number }
export type BrowserDispatchToolEvent =
  | { type: 'tool-input-start' | 'tool-input-end' | 'tool-call'; id: string }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other' }
  | { type: 'error'; reason: 'provider_error' }

/** Only bounded accounting and numeric stream diagnostics cross this bridge; never prompts or tool inputs. */
interface RecoveryUsage {
  version: 1
  usageUnknown: boolean
  reason?: string
  attempts: Array<{
    generationId: string | null
    inputTokens: number | null
    outputTokens: number | null
    usageKnown: boolean
    elapsedMs?: number
    headersMs?: number | null
    toolInputStartMs?: number | null
    toolInputChars?: number
    browserCallCount?: number
    toolEvents?: BrowserDispatchToolEvent[]
    toolEventsTruncated?: boolean
  }>
}
interface RecoveryState { turnId: string | null; steps: Record<string, RecoveryUsage> }
const MAX_STEPS = 64
const state = defineState<RecoveryState>('chat-agent.browser-dispatch-usage', () => ({ turnId: null, steps: {} }))
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const REASONS = new Set(['argument_timeout', 'argument_size', 'length', 'incomplete_stream', 'provider_error', 'multiple_calls'])
const diagnostic = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? Math.round(value) : null
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const FINISH_REASONS = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other'])

function toolEvents(value: unknown): BrowserDispatchToolEvent[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).flatMap((raw): BrowserDispatchToolEvent[] => {
    const event = record(raw)
    if (!event) return []
    if ((event.type === 'tool-input-start' || event.type === 'tool-input-end' || event.type === 'tool-call') &&
        typeof event.id === 'string' && /^b(?:[1-9]|1[0-2])$/.test(event.id)) return [{ type: event.type, id: event.id }]
    if (event.type === 'finish' && typeof event.reason === 'string' && FINISH_REASONS.has(event.reason)) {
      return [{ type: 'finish', reason: event.reason as Extract<BrowserDispatchToolEvent, { type: 'finish' }>['reason'] }]
    }
    if (event.type === 'error' && event.reason === 'provider_error') return [{ type: 'error', reason: 'provider_error' }]
    return []
  })
}

function scopeKey(scope: BrowserDispatchUsageScope): string | null {
  return typeof scope.turnId === 'string' && scope.turnId.length > 0 && scope.turnId.length <= 200 &&
    Number.isInteger(scope.sequence) && scope.sequence >= 0 && Number.isInteger(scope.stepIndex) && scope.stepIndex >= 0
    ? `${scope.sequence}:${scope.stepIndex}` : null
}

/**
 * Called immediately before the wrapper's combined finish. Eve 0.66.3 drops
 * custom provider metadata from step.completed, so the meter reads this
 * session-local slot instead. The finish remains the sole source of amounts.
 */
export function recordBrowserDispatchUsage(scope: BrowserDispatchUsageScope, metadata: unknown): void {
  const key = scopeKey(scope)
  const source = record(metadata)
  if (!key || source?.version !== 1) return
  const raw = Array.isArray(source.attempts) ? source.attempts : []
  const attempts = raw.slice(0, 2).map(value => {
    const attempt = record(value)
    const id = attempt?.generationId
    return {
      generationId: typeof id === 'string' && id.trim().length > 0 && id.trim().length <= 200 ? id.trim() : null,
      inputTokens: count(attempt?.inputTokens), outputTokens: count(attempt?.outputTokens),
      usageKnown: attempt?.usageKnown === true,
      ...(Array.isArray(attempt?.toolEvents) ? {
        toolEvents: toolEvents(attempt.toolEvents),
        toolEventsTruncated: attempt.toolEventsTruncated === true || attempt.toolEvents.length > 12,
      } : {}),
      ...Object.fromEntries(['elapsedMs', 'toolInputChars', 'browserCallCount'].flatMap(key => {
        const value = diagnostic(attempt?.[key])
        return value === null ? [] : [[key, value]]
      })),
      ...Object.fromEntries(['headersMs', 'toolInputStartMs'].flatMap(key => {
        const raw = attempt?.[key]
        const value = diagnostic(raw)
        return raw === null || value !== null ? [[key, value]] : []
      })),
    }
  })
  const usage: RecoveryUsage = {
    version: 1,
    ...(typeof source.reason === 'string' && REASONS.has(source.reason) ? { reason: source.reason } : {}),
    usageUnknown: source.usageUnknown !== false || raw.length < 1 || raw.length > 2,
    attempts,
  }
  state.update(previous => {
    const existing = previous?.turnId === scope.turnId ? previous.steps ?? {} : {}
    // Keep the latest bounded steps, including a replay of an existing slot.
    const entries = Object.entries(existing).filter(([existingKey]) => existingKey !== key).slice(-(MAX_STEPS - 1))
    return { turnId: scope.turnId, steps: { ...Object.fromEntries(entries), [key]: usage } }
  })
}

/** Keep the record until another turn so repeated step.completed hooks see the same metadata. */
export function browserDispatchUsageFor(scope: BrowserDispatchUsageScope): RecoveryUsage | null {
  const key = scopeKey(scope)
  const current = state.get()
  return key && current?.turnId === scope.turnId ? current.steps?.[key] ?? null : null
}

/** A rerun starts a fresh attempt for this slot; other completed slots survive. */
export function clearBrowserDispatchStep(scope: BrowserDispatchUsageScope): void {
  const key = scopeKey(scope)
  if (!key) return
  state.update(previous => {
    if (previous?.turnId !== scope.turnId) return { turnId: scope.turnId, steps: {} }
    const steps = { ...previous.steps }
    delete steps[key]
    return { turnId: scope.turnId, steps }
  })
}

export function clearBrowserDispatchUsage(): void {
  state.update(() => ({ turnId: null, steps: {} }))
}
