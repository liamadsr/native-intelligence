/**
 * Client-side NDJSON reader + turn reducer for a work run's follow-up chat
 * (Loops v3 interactive work runs). The follow-up-chat proxy streams W2's reduced
 * event vocabulary (@/lib/agent-run/run-chat-events → RunChatEvent) one JSON
 * object per line; this module turns that byte stream into rendered follow-up
 * turns. Pure + framework-free so the fold table is unit-tested directly (a
 * partial/garbled line is skipped, a BUSY error is softened) without a DOM.
 */

import type { RunChatEvent, RunChatQuestionPayload, RunChatUserFile } from '@/lib/agent-run/run-chat-events'

/**
 * The stream vocabulary this client reader accepts. It is W2's {@link RunChatEvent}
 * PLUS the `user-message` reduced event (W2 maps eve's `message.received` →
 * `{type:'user-message', text}` so a reloaded transcript can rebuild the user's own
 * turns — see run-chat-events.ts). We model `user-message` locally as a union
 * extension so this module type-checks whether or not W2's `RunChatEvent` has
 * merged the variant yet; the shapes are identical, so once it lands the extension
 * collapses to a no-op. `user-message` is a REPLAY-only signal for the transcript
 * builder (run-follow-up-chat.tsx): live sends already render the user turn
 * optimistically, so the component ignores the echoed `user-message` on the POST
 * path and honours it only on GET replay.
 */
export type RunChatStreamEvent = RunChatEvent | { type: 'user-message'; text: string; files?: RunChatUserFile[] }

/** One rendered follow-up turn. A user turn is plain text; an assistant turn
 *  accumulates streamed text, the tool NAMES it used, and a pending question.
 *  `answered` marks a question turn whose picker must render inert (a replayed,
 *  already-answered question — never a live pending one). */
export interface FollowUpTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  question?: RunChatQuestionPayload
  answered?: boolean
}

/** The gentle notice shown when a send hit a non-waiting session (a double-send
 *  race) — a BUSY error is not a hard failure, the agent is just mid-turn. */
export const BUSY_NOTICE = 'The agent is still finishing a turn — try again in a moment.'

/**
 * Fold one reduced event into the open assistant turn. Pure: returns the NEXT
 * turn (same reference when nothing changed, so a memoized renderer can skip).
 * `done` closes a turn at the CALLER (boundary ownership stays with the caller);
 * here it's a no-op. An `error` is surfaced separately (see reduceError) — it
 * doesn't mutate the turn.
 */
export function applyEventToTurn(turn: FollowUpTurn, event: RunChatStreamEvent): FollowUpTurn {
  switch (event.type) {
    case 'text-delta':
      return event.delta ? { ...turn, text: turn.text + event.delta } : turn
    case 'tool':
      return event.name ? { ...turn, tools: [...turn.tools, event.name] } : turn
    case 'question':
      return { ...turn, question: event.question }
    case 'done':
    case 'error':
    // `user-message` opens a NEW user turn at the caller (the replay builder) — it
    // is never folded into the open assistant turn, so it's a no-op here.
    case 'user-message':
      return turn
  }
}

/** The user-facing message for an `error` event — BUSY is softened; everything
 *  else surfaces its (already-clamped) message. Returns null for non-error events. */
export function reduceError(event: RunChatStreamEvent): string | null {
  if (event.type !== 'error') return null
  if (event.code === 'BUSY') return BUSY_NOTICE
  return event.message || 'The run session hit an error.'
}

/** Parse one NDJSON line into a RunChatStreamEvent, or null (blank / malformed
 *  line). Never throws — a dropped or partial line is simply skipped. A
 *  `user-message` line must carry a string `text` (else it's dropped). */
export function parseChatLine(line: string): RunChatStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const type = (parsed as { type?: unknown }).type
  if (
    type === 'text-delta' ||
    type === 'tool' ||
    type === 'question' ||
    type === 'done' ||
    type === 'error'
  ) {
    return parsed as RunChatStreamEvent
  }
  if (type === 'user-message') {
    const text = (parsed as { text?: unknown }).text
    if (typeof text !== 'string') return null
    const files = parseUserFiles((parsed as { files?: unknown }).files)
    return files.length > 0 ? { type: 'user-message', text, files } : { type: 'user-message', text }
  }
  return null
}

/** A user message's files (names and types only: run-chat-events.ts RunChatUserFile); malformed entries dropped. */
function parseUserFiles(raw: unknown): RunChatUserFile[] {
  if (!Array.isArray(raw)) return []
  const out: RunChatUserFile[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue
    const mediaType = (f as { mediaType?: unknown }).mediaType
    const filename = (f as { filename?: unknown }).filename
    if (typeof mediaType !== 'string' || !mediaType) continue
    out.push({ mediaType, ...(typeof filename === 'string' && filename ? { filename } : {}) })
  }
  return out
}

/**
 * Read an NDJSON ReadableStream, dispatching each parsed RunChatEvent to
 * `onEvent`. Buffers across chunk boundaries (a line split across two reads is
 * only dispatched once complete) and flushes a trailing non-newline-terminated
 * line at end-of-stream. Resolves when the stream closes.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RunChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const event = parseChatLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (event) onEvent(event)
        nl = buffer.indexOf('\n')
      }
    }
    const tail = parseChatLine(buffer)
    if (tail) onEvent(tail)
  } finally {
    reader.releaseLock()
  }
}
