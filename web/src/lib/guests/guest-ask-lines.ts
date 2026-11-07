/**
 * A guest_ask home turn's input (guest access, migration 429), as the turn
 * carries it and as its body renders it: the pure half of ./guest-asks.ts,
 * so the client-safe home-turn vocabulary (src/lib/chat/home-turn.ts) can
 * render it. JSON-safe. No imports.
 */

/** One ask as the turn carries it. JSON-safe (an Inngest step output). */
export interface PlannedGuestAsk {
  askId: string
  guestId: string
  guestName: string
  tier: string
  question: string
  createdAt: string
  /** What that guest's agent learned about them (never the owner's memory). */
  learned: string[]
  /** Whether the owner's free times may go to them (guestTimes). Absent reads as ask first. */
  times?: GuestTimes
}

/**
 * Whether the owner's free times may go to a guest, from their guest agent's
 * calendar tools (agent_guest.tools) and the ones the owner set to Needs
 * approval (agent_guest.ask_tools): `shared` when a calendar read runs
 * without asking, `ask_first` when every one they hold needs the owner's
 * approval (or the setting can't be read) or free/busy itself needs it,
 * `none` when they hold neither.
 * The same switch the guest's own agent follows (src/lib/guests/guest-spec.ts
 * guestInvitationLine).
 */
export type GuestTimes = 'shared' | 'ask_first' | 'none'

const CALENDAR_READS = ['get_free_busy', 'get_calendar_events'] as const

export function guestTimes(tools: unknown, askTools: unknown): GuestTimes {
  const held = CALENDAR_READS.filter((name) => Array.isArray(tools) && tools.includes(name))
  if (held.length === 0) return 'none'
  if (!Array.isArray(askTools)) return 'ask_first'
  // Free/busy set to Needs approval asks first even when "Your calendar" is
  // Always allow: free times are free/busy's to give (guestInvitationLine).
  if (held.includes('get_free_busy') && askTools.includes('get_free_busy')) return 'ask_first'
  return held.some((name) => !askTools.includes(name)) ? 'shared' : 'ask_first'
}

/** How a line says it, to the owner's agent. */
const TIMES_NOTE: Record<GuestTimes, string> = {
  shared: "free times: may share, the owner confirms",
  ask_first: 'free times: ask the owner first',
  none: "free times: not theirs to see",
}

export interface HomeTurnGuestAsks {
  asks: PlannedGuestAsk[]
  askIds: string[]
}

/** What each tier may be told, in the words the turn reads. */
const TIER_NOTE: Record<string, string> = {
  household: 'household: family, may know your plans and the owner’s day',
  colleague: 'colleague: may know when the owner is free, never what they are doing',
  custom: 'custom: only what the owner gave their agent',
}

/** The data lines a guest_ask turn carries: each ask, then what that guest's agent learned about them. Pure. */
export function guestAskTurnLines(asks: readonly PlannedGuestAsk[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const ask of asks) {
    lines.push(`ask ${ask.askId} · from ${ask.guestName} (${TIER_NOTE[ask.tier] ?? TIER_NOTE.custom}) · ${TIMES_NOTE[ask.times ?? 'ask_first']} · ${ask.createdAt}: ${ask.question}`)
    if (!seen.has(ask.guestId) && ask.learned.length) {
      seen.add(ask.guestId)
      for (const line of ask.learned) lines.push(`  learned by ${ask.guestName}'s agent, not by you: ${line}`)
    }
  }
  return lines
}
