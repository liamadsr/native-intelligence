/**
 * After a summary (or a clear), the next turn starts with only the core tools
 * again, and no expertise pack counts as loaded.
 *
 * What `search_tools` finds stays advertised for the rest of the session
 * (./discovered-tools.ts), and every advertised tool's definition rides every
 * model call. The main chat is one session for good, so it kept every tool it
 * ever searched for: on PROD (10-27) the always-on chat's tool definitions
 * grew from 24K to 46K tokens a call over 97 turns, compacting did nothing
 * about it, and it ate the room compaction makes (compaction-window.ts: a
 * 150K target with ~40K of it fixed). The packs that rode those searches'
 * results (./expertise.ts) are summarized away with them, so they count as
 * unloaded again too: reopening an area brings its pack back.
 *
 * WHEN: on a turn's start (../instructions/context-reset.ts, a `turn.started`
 * resolver, which runs before the turn's first model call resolves its tools),
 * once the history holds a summary it didn't hold before:
 *   - eve's summary is the history's `Summary of our conversation so far:`
 *     message and the assistant message after it (eve 0.79.1
 *     harness/compaction/engine.js COMPACTION_CHECKPOINT_MARKER,
 *     extractPreviousCheckpoint). A new one means older turns, with the
 *     searches in them, were summarized away.
 *   - `compaction.completed` is NOT the signal: eve also emits it for a pass
 *     that only trimmed old tool results (toolResultCapHeuristic) and kept
 *     every message, the searches included. Resetting then would make the
 *     agent search again for tools its history still shows it using.
 *   - A clear (../hooks/context-reset.ts, `context.cleared`) always resets: it
 *     drops the whole history.
 * Never mid-turn: a reply running when eve summarizes keeps what it found;
 * the reset waits for the next turn. A steer or an answered question continues
 * its turn, so it keeps its tools.
 *
 * A call to a tool no longer advertised comes back to the model as a tool
 * error (eve 0.79.1 harness/tool-call-input-errors.js), and it searches again:
 * never a failed turn. Never throws.
 */
import { defineState } from 'eve/context'
import { resetDiscoveredTools } from './discovered-tools.js'
import { resetLoadedPacks } from './expertise.js'

/** eve's summary marker: the user-role message right before the summary itself. */
export const SUMMARY_MARKER = 'Summary of our conversation so far:'

/** A clear happened: the next turn resets whatever its history holds. */
const clearPending = defineState<boolean>('chat-agent.context-reset-pending', () => false)
/** The fingerprint of the summary the last reset (or first look) saw; null for none. */
const lastSummary = defineState<string | null>('chat-agent.context-reset-summary', () => null)

function textOf(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/**
 * The fingerprint of the history's summary (its length and a 32-bit hash), or
 * null when it holds none. Two summaries with the same text are the same one.
 */
export function summaryFingerprint(messages: readonly unknown[]): string | null {
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i] as { role?: unknown } | null
    if (m?.role !== 'user' || textOf(m).trim() !== SUMMARY_MARKER) continue
    const next = messages[i + 1] as { role?: unknown } | null
    if (next?.role !== 'assistant') return null
    const text = textOf(next).trim()
    if (!text) return null
    let hash = 0x811c9dc5
    for (let j = 0; j < text.length; j++) {
      hash ^= text.charCodeAt(j)
      hash = Math.imul(hash, 0x01000193)
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`
  }
  return null
}

/** A clear dropped the history: the next turn starts with the core tools. */
export function markClear(): void {
  try {
    clearPending.update(() => true)
  } catch (err) {
    console.error(`[chat-agent] context reset mark failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * At a turn's start: reset when a clear is pending or the history holds a
 * summary it didn't before. True when it reset.
 */
export function resetIfSummarized(messages: readonly unknown[]): boolean {
  try {
    const summary = summaryFingerprint(messages)
    const cleared = clearPending.get()
    const summarized = summary !== null && summary !== lastSummary.get()
    if (summary !== lastSummary.get()) lastSummary.update(() => summary)
    if (!cleared && !summarized) return false
    resetDiscoveredTools()
    resetLoadedPacks()
    if (cleared) clearPending.update(() => false)
    return true
  } catch (err) {
    console.error(`[chat-agent] context reset failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
