/**
 * The person's go-ahead, in a run with nobody to give it.
 *
 * The prospecting tools that spend or write (searches, publish, dismiss) take
 * `confirmed_with_user`, true only after the person said yes to that call
 * (prospecting.ts goAheadRefusal). A scheduled or headless skill run has no
 * person: nobody can have said yes, so a true there is the model guessing.
 * The skill-run tool route refuses it before the tool runs, as a tool result
 * the model reads, naming what to do instead.
 *
 * Refused for a skill run's own unattended calls, and for a job on the
 * person's Mac that a loop started (the local-agent tool route). A work run can carry
 * a yes the person gave elsewhere (a delegation from the chat, an answer to
 * the run's question, a follow-up chat turn), so its route leaves the flag to
 * the tool.
 */

/** The refusal for `confirmed_with_user: true` in a run nobody is watching, or null to go on. */
export function unattendedGoAheadRefusal(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  if ((input as Record<string, unknown>).confirmed_with_user !== true) return null
  return {
    success: false,
    needs_go_ahead: true,
    error:
      'Refused, nothing ran: confirmed_with_user can only be true when the person said yes in a chat, and this run has nobody to ask. ' +
      'Do not call it again. Report what you would run (which list, which step, which entries) so the person can start it.',
  }
}
