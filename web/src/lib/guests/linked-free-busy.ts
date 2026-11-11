/**
 * A linked guest's free/busy, read for the host's own agent (availability
 * phase 5: a poll's guest answered from their calendar,
 * src/lib/time-offers/polls.ts).
 *
 * The grant is the one that already lets the host's agent ask theirs
 * get_free_busy over an agent link (src/lib/agent-links/, ./guest-tools.ts):
 *
 *   - the guest's email is the one a Native Intelligence user signs in with
 *     (the agent links' own lookup, migration 436);
 *   - an ACTIVE link stands between that user and the host;
 *   - that user's half for the host (their agent_guest row for the host, in
 *     their own workspace) is active, holds their agent as a channel, and
 *     holds get_free_busy set to Always allow. Needs approval or Blocked is
 *     no grant: a read like this has no card, so it is never made.
 *
 * Anything else (no such user, no link, a link ended, a half changed, a read
 * that fails) is no grant, and the guest is asked like anyone else: unknown
 * is never free. What crosses: whether each time is busy, nothing else (no
 * title, place, attendee or calendar), read from the calendars that count
 * for that user, strictly (src/lib/availability/slot-check.ts).
 *
 * The grant fence (#74): a guest's or a linked agent's own turn reads no
 * grant of the owner's, so the caller passes `omitGrants` and gets null.
 *
 * Server only; service role. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSpansFree } from '@/lib/availability/slot-check'
import type { Span } from '@/lib/availability/engine'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { halfFor, openLinkBetween } from '@/lib/agent-links/store'
import { resolveEmailTarget } from '@/lib/agent-links/outside'
import { guestCeiling } from './guest-turn'
import type { AgentGuest } from './store'

/** Whose free/busy may be read, and in which of their workspaces. */
export interface LinkedFreeBusyGrant {
  peerUserId: string
  workspaceId: string
}

export interface LinkedFreeBusyDeps {
  resolveEmail?: (email: string) => Promise<string | null>
  activeLink?: (hostUserId: string, peerUserId: string) => Promise<boolean>
  half?: (peerUserId: string, hostUserId: string) => Promise<AgentGuest | null>
  /** The linked guest's calendar read (default: their counted calendars, strictly). */
  linkedCheckFree?: typeof checkSpansFree
  /** The linked guest's own zone, for an all-day event's day. */
  linkedTimeZone?: (grant: LinkedFreeBusyGrant) => Promise<string>
}

/** Whether a half lets the other side's agent read its owner's free/busy without asking. Pure. */
export function halfSharesFreeBusy(half: Pick<AgentGuest, 'state' | 'channels' | 'tools' | 'askTools' | 'preset' | 'peerBoundAt'>): boolean {
  if (half.state !== 'active' || !half.channels.includes('dial8') || !half.peerBoundAt) return false
  // Needs approval (askTools, migration 429) is never a grant: get_free_busy has no card (./guest-tools.ts OWNER_ASKS_FIRST).
  return guestCeiling(half).has('get_free_busy') && !half.askTools.includes('get_free_busy')
}

/** The grant for the guest at `email`, or null (see the header). */
export async function linkedFreeBusyGrant(
  supabase: SupabaseClient,
  args: { hostUserId: string; email: string | null; omitGrants?: boolean },
  deps: LinkedFreeBusyDeps = {},
): Promise<LinkedFreeBusyGrant | null> {
  if (args.omitGrants || !args.email) return null
  try {
    const peerUserId = await (deps.resolveEmail ?? ((e) => resolveEmailTarget(supabase, e)))(args.email)
    if (!peerUserId || peerUserId === args.hostUserId) return null
    const linked = await (deps.activeLink ?? (async (a, b) => (await openLinkBetween(supabase, a, b))?.state === 'active'))(args.hostUserId, peerUserId)
    if (!linked) return null
    // Their half for the host: what they let the host's agent ask theirs.
    const half = await (deps.half ?? ((peer, host) => halfFor(supabase, peer, host)))(peerUserId, args.hostUserId)
    if (!half || half.peerUserId !== args.hostUserId || !halfSharesFreeBusy(half)) return null
    return { peerUserId, workspaceId: half.workspaceId }
  } catch {
    return null
  }
}

/** Whether each span is busy for the linked guest, or unknown (see the header). */
export async function linkedSpansBusy(
  supabase: SupabaseClient,
  grant: LinkedFreeBusyGrant,
  spans: readonly Span[],
  deps: LinkedFreeBusyDeps = {},
): Promise<{ known: true; busy: boolean[] } | { known: false }> {
  try {
    const timeZone = await (deps.linkedTimeZone ?? (async (g) => (await readMemberTimeZone(supabase, { userId: g.peerUserId, workspaceId: g.workspaceId })).timeZone))(grant)
    const read = await (deps.linkedCheckFree ?? checkSpansFree)({ userId: grant.peerUserId, workspaceId: grant.workspaceId, timeZone, spans })
    return read.known ? { known: true, busy: read.busy } : { known: false }
  } catch {
    return { known: false }
  }
}
