/**
 * The person's incoming calls, as one tab holds them (pure; the incoming-call
 * surface, src/components/team-calls/incoming-calls.tsx, runs it).
 *
 * The truth is each ring's row (migration 564): every tab and device of the
 * person gets its inserts and updates over Realtime (RLS: their own rings
 * only), so a ring answered, declined or run out anywhere stops here as the
 * row changes. This tab adds two things the row can't know:
 *
 *   - its clock: a ring past its time stops here even before the server's
 *     timer has written it missed (and stays stopped when that write lands);
 *   - whether this person is in a call on this page: then a ring is a quiet
 *     notice, never a ringtone (and a ring for the call they are in is
 *     nothing at all).
 *
 * A full read (`sync`, on (re)subscribing) replaces what is open: a ring
 * settled while the tab was away is gone.
 */
import type { TeamCallRing } from './types'

export interface RingState {
  /** Open rings by id ('ringing' or 'busy' when they arrived). */
  open: Record<string, TeamCallRing>
  /** Rings this tab has settled or seen settle: a late or repeated row never brings one back. */
  settled: Record<string, true>
}

export type RingAction =
  | { type: 'row'; ring: TeamCallRing }
  | { type: 'sync'; rings: readonly TeamCallRing[] }
  | { type: 'settle'; ringId: string }
  | { type: 'tick'; now: number }

export const EMPTY_RINGS: RingState = { open: {}, settled: {} }

const OPEN_STATES = new Set(['ringing', 'busy'])
/** How many settled ids a tab remembers. */
const SETTLED_MAX = 200

function remember(settled: Record<string, true>, id: string): Record<string, true> {
  const next = { ...settled, [id]: true as const }
  const keys = Object.keys(next)
  if (keys.length > SETTLED_MAX) for (const k of keys.slice(0, keys.length - SETTLED_MAX)) delete next[k]
  return next
}

function expired(ring: TeamCallRing, now: number): boolean {
  return Date.parse(ring.expires_at) <= now
}

export function ringReducer(state: RingState, action: RingAction): RingState {
  switch (action.type) {
    case 'row': {
      const ring = action.ring
      if (!ring?.id) return state
      if (!OPEN_STATES.has(ring.state)) {
        if (!state.open[ring.id] && state.settled[ring.id]) return state
        const open = { ...state.open }
        delete open[ring.id]
        return { open, settled: remember(state.settled, ring.id) }
      }
      if (state.settled[ring.id]) return state
      return { ...state, open: { ...state.open, [ring.id]: ring } }
    }
    case 'sync': {
      const open: Record<string, TeamCallRing> = {}
      for (const ring of action.rings) if (OPEN_STATES.has(ring.state) && !state.settled[ring.id]) open[ring.id] = ring
      let settled = state.settled
      for (const id of Object.keys(state.open)) if (!open[id]) settled = remember(settled, id)
      return { open, settled }
    }
    case 'settle': {
      if (!state.open[action.ringId] && state.settled[action.ringId]) return state
      const open = { ...state.open }
      delete open[action.ringId]
      return { open, settled: remember(state.settled, action.ringId) }
    }
    case 'tick': {
      const gone = Object.values(state.open).filter((r) => expired(r, action.now))
      if (gone.length === 0) return state
      const open = { ...state.open }
      let settled = state.settled
      for (const r of gone) {
        delete open[r.id]
        settled = remember(settled, r.id)
      }
      return { open, settled }
    }
  }
}

export interface RingSurface {
  /** Rings to ring for: the card with Accept / Decline, and a ringtone. Oldest first. */
  ringing: TeamCallRing[]
  /** Rings to say quietly (a toast): the person is in another call. */
  quiet: TeamCallRing[]
}

/**
 * What the surface shows now. `inCall`: the call this page is in, if any.
 * A ring for that call is nothing; any other ring while in a call is quiet;
 * a ring that arrived 'busy' (in a call elsewhere) is quiet.
 */
export function ringSurface(state: RingState, ctx: { now: number; inCall: string | null }): RingSurface {
  const live = Object.values(state.open)
    .filter((r) => !expired(r, ctx.now) && r.call_id !== ctx.inCall)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  return {
    ringing: live.filter((r) => r.state === 'ringing' && !ctx.inCall),
    quiet: live.filter((r) => r.state === 'busy' || !!ctx.inCall),
  }
}

/** When the next open ring runs out (ms since the epoch), for one timer; null when none is open. */
export function nextExpiry(state: RingState): number | null {
  const times = Object.values(state.open).map((r) => Date.parse(r.expires_at)).filter(Number.isFinite)
  return times.length ? Math.min(...times) : null
}
