import type { UIMessage } from '@ai-sdk/react'

/**
 * Bounded in-memory retention for a tab's chat transcript.
 *
 * WHY: every open dashboard tab keeps a live `useChat()` mounted for the whole
 * session (dashboard-shell keeps inactive panels mounted behind
 * `visibility:hidden`, never unmounted), and its `messages` array grew without
 * any cap — full tool-result dumps included. That array is then duplicated into
 * `TabsState.chat.chatMessages` on snapshot and JSON-stringified into
 * localStorage. A 7h desktop session measured a 948MB WebContent heap (1.82GB
 * peak); an uncapped multi-MB transcript per open tab is one of the growth
 * vectors behind it.
 *
 * Nothing is lost by capping: every message is durably written server-side by
 * `use-chat-auto-save.ts` (POST/PATCH /api/account/chat-history) as soon as its
 * turn completes, so the cap only bounds what the CLIENT holds in the heap.
 *
 * TRANSPORT NOTE: the eve transport holds the conversation's history
 * server-side, so capping the client array never shortens what the model sees.
 *
 * Every helper here returns the SAME array/message/part reference when nothing
 * needed changing. That identity contract is load-bearing twice over: the
 * continuous trim effect in chat-panel needs `needsChatRetention` to go FALSE
 * on its own output (the real `@ai-sdk/react` setter always stores a fresh
 * `[...next]` copy and notifies, so identity alone can never stop the loop —
 * idempotence is what does), and tab-context's 300ms debounced persist effect
 * diffs `seen.get(t.id) !== t.chat` by identity — a new object every render
 * would re-stringify every tab's transcript into localStorage forever. It is
 * the same discipline `sanitizeEntryForHistory` uses for history entries.
 *
 * RELATION TO src/lib/chat/eve/tool-output-truncation.ts: that sibling
 * runs at the TRANSPORT boundary and already bounds every tool output the
 * eve transport emits at TOOL_OUTPUT_MAX_SERIALIZED_CHARS (64_000).
 * This module is therefore the backstop for what that boundary does not cover:
 * the cloud path, text parts, error text, historical transcripts written by
 * older builds, and the message COUNT (which no transport bounds). Its
 * per-string threshold must stay BELOW 64_000, or it would never fire on
 * anything the transport already trimmed and this guard would be dead weight.
 */

/**
 * Hard cap on messages retained per tab. Generous on purpose: only very long
 * sessions reach it, and the server keeps everything beyond it. Must stay far
 * above any single tool-call chain so a trim can never orphan one.
 */
export const MAX_LIVE_MESSAGES = 300

/**
 * Messages at the tail that are never size-trimmed. The model's immediate
 * follow-up reasoning and the UI's tool cards both want the most recent
 * results whole; only the older body is worth shrinking.
 */
export const RECENT_MESSAGE_WINDOW = 10

/**
 * An oversized string on an old message (tool output, text part, or
 * `output-error` errorText) is replaced by a marker above this length.
 * `String.length` counts UTF-16 code units, not bytes — same unit the sibling
 * `TOOL_OUTPUT_MAX_SERIALIZED_CHARS` uses, and it must stay below that 64_000.
 */
export const MAX_PART_CHARS = 32_768

/** Characters of the original kept in the marker, so the transcript still reads. */
export const TRUNCATED_PREVIEW_CHARS = 4_096

const TRUNCATION_MARKER =
  '\n…[truncated %N% characters for memory; full output is saved in chat history]'

/** Shrink an oversized string to `preview + marker`; same reference if it fits. */
function truncateString(value: string): string {
  if (value.length <= MAX_PART_CHARS) return value
  const marker = TRUNCATION_MARKER.replace('%N%', String(value.length - TRUNCATED_PREVIEW_CHARS))
  return value.slice(0, TRUNCATED_PREVIEW_CHARS) + marker
}

type AnyPart = UIMessage['parts'][number]

/** A tool part whose result is final — the only state safe to shrink. A part
 *  still `input-available` / `input-streaming` is a PENDING tool call that
 *  `addToolResult` (ask_user resume) will target by
 *  toolCallId; touching one could strand an in-flight turn. */
function isSettledToolPart(
  part: AnyPart,
): part is AnyPart & { state: 'output-available'; output: unknown } {
  if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return false
  const state = (part as { state?: unknown }).state
  return state === 'output-available'
}

/** Tool-part states that mean "this call has not produced a result yet".
 *  `approval-requested` is included: the AI SDK parks a part there while the UI
 *  waits on a human decision, and resolving it targets the same toolCallId. */
const PENDING_TOOL_STATES = new Set(['input-streaming', 'input-available', 'approval-requested'])

/** True when ANY tool part of the message is still awaiting a result. Such a
 *  message is left completely alone, both by the size guard and (via
 *  capMessages) as a message the cut is clamped in front of — dropping it would
 *  wedge chat-panel's `pendingQuestion` popover, whose answer path maps `prev`
 *  by toolCallId and silently no-ops when the message is gone. */
export function hasPendingToolCall(message: UIMessage): boolean {
  for (const part of message.parts ?? []) {
    if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') continue
    const state = (part as { state?: unknown }).state
    if (typeof state === 'string' && PENDING_TOOL_STATES.has(state)) return true
  }
  return false
}

/**
 * Replace every oversized STRING payload on a part with a truncated marker,
 * keeping `type`, `state`, `toolCallId` and `input` intact so every renderer
 * and the pending-question scan still see the shape they expect.
 *
 * Three payloads qualify, and they are the only ones:
 *  - a settled tool part's string `output`;
 *  - an `output-error` tool part's `errorText` (a failed Bash/Read can dump the
 *    whole stderr there, and nothing else bounds it);
 *  - a `text` part's `text` (long model answers, pasted logs — these were
 *    previously exempt and are the biggest
 *    remaining unbounded payload in a long transcript).
 *
 * Structured (object/array) outputs are NEVER touched: the dedicated card
 * renderers (web-search-card, prospecting-run-card, email-draft-card, …)
 * destructure specific fields out of them and would break on a marker.
 */
function truncateMessageParts(message: UIMessage): UIMessage {
  const parts = message.parts
  if (!parts || parts.length === 0) return message
  let changed = false
  const next = parts.map((part) => {
    // A plain text part: the body is display-only here, the durable copy is
    // server-side, and the transports never bounded it.
    if (part.type === 'text') {
      const value = (part as { text?: unknown }).text
      if (typeof value !== 'string') return part
      const trimmed = truncateString(value)
      if (trimmed === value) return part
      changed = true
      return { ...part, text: trimmed }
    }

    if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return part
    const state = (part as { state?: unknown }).state

    if (state === 'output-error') {
      const errorText = (part as { errorText?: unknown }).errorText
      if (typeof errorText !== 'string') return part
      const trimmed = truncateString(errorText)
      if (trimmed === errorText) return part
      changed = true
      return { ...part, errorText: trimmed }
    }

    if (!isSettledToolPart(part)) return part
    const output = (part as { output?: unknown }).output
    if (typeof output !== 'string') return part
    const trimmed = truncateString(output)
    if (trimmed === output) return part
    changed = true
    return { ...part, output: trimmed }
  })
  if (!changed) return message
  return { ...message, parts: next as UIMessage['parts'] }
}

/**
 * Shrink oversized strings (tool outputs, text bodies, error text) on messages
 * older than the trailing RECENT_MESSAGE_WINDOW. Messages with a still-pending
 * tool call are skipped entirely. Returns the same array when nothing changed.
 *
 * SAFE vs use-chat-auto-save: its `unsaved` filter is by message ID
 * (`savedIdsRef`), never by content, and only messages older than the last 10
 * are eligible here — those completed turns were already POSTed/PATCHed with
 * their FULL content, so truncating them client-side can never re-send or
 * downgrade a persisted row.
 */
export function truncateOldParts(messages: UIMessage[]): UIMessage[] {
  const cutoff = messages.length - RECENT_MESSAGE_WINDOW
  if (cutoff <= 0) return messages
  let changed = false
  const next = messages.map((m, i) => {
    if (i >= cutoff) return m
    if (hasPendingToolCall(m)) return m
    const trimmed = truncateMessageParts(m)
    if (trimmed !== m) changed = true
    return trimmed
  })
  return changed ? next : messages
}

/**
 * How far either side of the desired cut we will look for a user message
 * before giving up on alignment. Bounded on purpose in BOTH directions: an
 * unbounded forward walk is what made the cap never fire for assistant-only
 * transcripts, and an unbounded backward walk would reintroduce the same bug
 * through the other door — a single `user` message at index 0 (the live-capture
 * tab's opening prompt) would pin every cut back to 0 forever.
 */
const TRIM_ALIGN_WINDOW = 50

/**
 * The fewest messages a thread can hold once retention has cut it from the
 * front: capMessages aims at the newest MAX_LIVE_MESSAGES, findTrimStart lands
 * the cut at most TRIM_ALIGN_WINDOW later, and a thread only grows between
 * cuts. A thread holding fewer was never cut — a message missing from its
 * front was never in it.
 */
export const MIN_TRIMMED_MESSAGES = MAX_LIVE_MESSAGES - TRIM_ALIGN_WINDOW

/**
 * The index to start keeping from, given a desired drop point.
 *
 * Aligning the cut to a `user` message keeps a trim boundary from landing
 * between an assistant tool call and the message carrying its result. We look
 * for one in two directions, in this order:
 *
 *  1. FORWARD, at most TRIM_ALIGN_WINDOW messages — dropping a few extra
 *     messages is the cheapest way to land on a clean turn boundary.
 *  2. BACKWARD, at most TRIM_ALIGN_WINDOW messages — keeping a few extra is
 *     the next cheapest. Bounded too, or a lone opening `user` message would
 *     drag every cut back to index 0 and the cap would never bind.
 *
 * If NEITHER finds one, we hard-cut at `desired`. That last clause is the
 * whole point of the two-sided search: the old version walked forward
 * unboundedly and returned 0 ("keep everything") when no user message existed
 * at or after the cut, which meant the cap NEVER fired on an assistant-only
 * transcript. That is not a hypothetical shape — the live-capture / ambient
 * agent tab is exactly it: `src/lib/live-agent/conversation-writer.ts` writes
 * only assistant rows and `use-live-conversation.ts` merges them into useChat
 * for the entire meeting, so a long meeting grew without any bound at all.
 * A split tool pair is a recoverable cosmetic artifact (the orphaned result
 * card renders on its own); unbounded retention is the bug this module exists
 * to stop, so it wins.
 */
export function findTrimStart(messages: UIMessage[], desired: number): number {
  if (desired <= 0) return 0
  const ahead = Math.min(messages.length, desired + TRIM_ALIGN_WINDOW)
  for (let i = desired; i < ahead; i++) {
    if (messages[i].role === 'user') return i
  }
  const behind = Math.max(0, desired - TRIM_ALIGN_WINDOW)
  for (let i = desired - 1; i >= behind; i--) {
    if (messages[i].role === 'user') return i
  }
  return desired
}

/**
 * Keep roughly the newest `max` messages, with the cut aligned to a user
 * message where one is near, and clamped in front of the oldest message
 * carrying a still-pending tool call. Returns the same array when nothing is
 * dropped.
 *
 * The pending clamp is not decoration: chat-panel's `pendingQuestion` memo
 * scans `messages` for an unanswered ask_user part, and
 * `handleAnswerQuestion` resolves it by mapping `prev` for that toolCallId. If
 * the cap dropped that message while the turn sat at status 'ready' — which is
 * exactly when the trim effect runs — the popover would vanish or, once
 * answered, wedge with nothing to write the result onto.
 */
export function capMessages(messages: UIMessage[], max: number = MAX_LIVE_MESSAGES): UIMessage[] {
  if (messages.length <= max) return messages
  let start = findTrimStart(messages, messages.length - max)
  if (start > 0) {
    const firstPending = messages.findIndex(hasPendingToolCall)
    if (firstPending !== -1 && firstPending < start) start = firstPending
  }
  if (start <= 0) return messages
  return messages.slice(start)
}

/**
 * The whole retention pass: cap the count, then shrink oversized old strings.
 * Returns the SAME array reference when neither applied — and is IDEMPOTENT,
 * which is what actually stops chat-panel's trim effect (the real
 * `@ai-sdk/react` setter always stores a fresh copy, so the effect re-runs on
 * its own output and terminates only because the second pass is a no-op).
 */
export function applyChatRetention(
  messages: UIMessage[],
  max: number = MAX_LIVE_MESSAGES,
): UIMessage[] {
  return truncateOldParts(capMessages(messages, max))
}

/** True when the retention pass would change anything — the cheap guard the
 *  continuous trim effect uses before calling setMessages. */
export function needsChatRetention(
  messages: UIMessage[],
  max: number = MAX_LIVE_MESSAGES,
): boolean {
  return applyChatRetention(messages, max) !== messages
}
