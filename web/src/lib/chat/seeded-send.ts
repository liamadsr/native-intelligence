/**
 * Seeded sends (A2 review): messages the UI composes and sends as the person,
 * from a proposal's "chat about it" (its text, description, reasoning, a
 * transcript quote) or an action's "work on it" (its description). The words
 * in them are the app's and the meeting's, not the person's own, so the
 * memory evidence rule must never take a quote from one, nor the capture pass
 * read one as something the person said.
 *
 * Least invasive, robust: the message starts with SEEDED_SEND_MARKER, two
 * U+2063 INVISIBLE SEPARATORs. It renders as nothing, travels with the text
 * through every path (the eve delivery, eve's history, the stored chat
 * message), and nobody types it. Every reader of the person's words leaves a
 * marked message out whole: agents/chat-agent/lib/person-messages.ts (twin
 * constant, kept equal by a drift test), the slot's capture slice, and the
 * nightly catch-up (src/lib/memory/capture-slice.ts). Moving the seeded
 * context into the turn context instead would change what the model and the
 * person see in the thread; the marker changes nothing visible.
 *
 * Client-safe: no imports.
 */

export const SEEDED_SEND_MARKER = '⁣⁣'

/** A UI-composed message, marked so it never counts as the person's own words. */
export function markSeededSend(text: string): string {
  return text.startsWith(SEEDED_SEND_MARKER) ? text : `${SEEDED_SEND_MARKER}${text}`
}

export function isSeededSend(text: string): boolean {
  return text.startsWith(SEEDED_SEND_MARKER)
}
