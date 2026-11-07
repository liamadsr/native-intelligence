/**
 * A person's own run that a bot was routed to (bots-v4 Phase 5): the work is
 * theirs, a bot (the Assistant) only fronts it for attribution
 * (`source.teammate_routed` on its ledger row), so its chat is the person's
 * own run's, on the run's own limits, never the bot speaking.
 *
 * Pure (no client imports), so both the bubble and the bot's page
 * (item-run-chat.ts re-exports these) and the server's relay to a run's chat
 * (src/lib/bots/bot-relay.ts) read the same rule.
 */

/** A person's own run that a bot was routed to (bots-v4 Phase 5): the row's `source.teammate_routed`. */
export function isOwnRun(row: { source?: Record<string, unknown> | null }): boolean {
  return row.source?.teammate_routed === true
}

/** Who speaks in a person's own run's chat: the run, never the bot it came through. */
export const OWN_RUN_SPEAKER = 'Your run'

/**
 * The words before an item's title on the quiet line over a chat about it:
 * "About" (its run's chat, or the teammate's thread with the item attached),
 * "Answering" (a reply answers its run's question), and for a person's own
 * run a bot was routed to (`own`), "Your run’s chat" / "Your run asks": its
 * chat is theirs, on the run's own limits, not the bot's.
 */
export function aboutLineLabel(about: { asking?: boolean; own?: boolean }): string {
  if (about.own) return about.asking ? 'Your run asks' : 'Your run’s chat'
  return about.asking ? 'Answering' : 'About'
}
