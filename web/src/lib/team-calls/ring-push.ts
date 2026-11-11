/**
 * A team call's ring on the person's phones (calls plan, phase 8): a VoIP
 * push (PushKit) that the iOS app turns into an incoming call (CallKit),
 * beside the web's ring over Realtime. Server only, on the service client.
 *
 * Apple's rule shapes all of it: every VoIP push must become an incoming
 * call on the phone before its handler returns (iOS 13 and later), so a
 * push the phone did not need still flashes a call there. So:
 *
 *   - a ring is pushed once (migration 571's claim), and only while it is
 *     ringing and its time is not up ({@link pushRings}: after the ring is
 *     made, beside its timer). A 'busy' ring (the person is in another
 *     call) is a quiet notice and never pushed;
 *   - its one cancel goes when the ring left ringing before its time ran
 *     out, and only when it was pushed ({@link cancelRingPushes}: the
 *     answer route, LiveKit's join webhook, a call's end). A ring that ran
 *     out gets none: the phone's own clock stops it, from the push's
 *     `seconds_left`. The phone that answered gets none either (the answer
 *     names its VoIP token): it is in the call;
 *   - the phone never trusts the push alone: after it shows the call it
 *     reads the ring's row (Realtime, else a fetch), and a ring settled by
 *     then is ended on the phone at once.
 *
 * What a push carries is ids and the words the incoming-call screen shows
 * (the caller's name, the place); never a LiveKit token (the phone asks the
 * token route as the person once they answer). With the APNs settings unset
 * nothing here reads or writes anything.
 *
 * Privacy: logs carry ids and counts only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { livePushDeps, voipToPerson, type PushDeps } from '@/lib/push/send'
import type { ApnsVoipPush } from '@/lib/push/apns'
import type { TeamCallRingState } from './types'

/** A pushed ring's push kinds, as the iOS app's TeamCallPush reads them. */
export const TEAM_CALL_RING_PUSH = 'team_call_ring' as const
export const TEAM_CALL_CANCEL_PUSH = 'team_call_cancel' as const

/** What a ring's push says (571's team_call_ring_push_claim's row). */
export interface ClaimedRing {
  ring_id: string
  call_id: string
  workspace_id: string
  channel_id: string
  user_id: string
  caller_name: string
  channel_kind: 'channel' | 'dm'
  channel_name: string | null
  expires_at: string
}

/** A cancel that may go (571's team_call_ring_push_cancel's row). */
export interface CancelledRing {
  ring_id: string
  call_id: string
  user_id: string
  state: TeamCallRingState
}

/**
 * A ring's VoIP push: the ids the phone answers and declines with, and what
 * its incoming-call screen says. When it stops ringing, twice: `expires_at`
 * (absolute: a push delivered late never rings a full 40 seconds again)
 * and `seconds_left` as it is sent (whatever the phone's clock skew); the
 * phone stops at the earlier. Calls start with the camera off on every app, so none offers video
 * (`video` false: CallKit shows an audio call; the camera can go on in it).
 * Expires when the ring does: Apple drops a push it could not deliver by
 * then. Pure.
 */
export function ringPush(ring: ClaimedRing, nowMs: number): ApnsVoipPush {
  const expiresAtMs = Date.parse(ring.expires_at)
  return {
    data: {
      kind: TEAM_CALL_RING_PUSH,
      ring_id: ring.ring_id,
      call_id: ring.call_id,
      channel_id: ring.channel_id,
      workspace_id: ring.workspace_id,
      caller_name: ring.caller_name.slice(0, 120),
      channel_kind: ring.channel_kind,
      channel_name: ring.channel_name ? ring.channel_name.slice(0, 80) : null,
      video: false,
      expires_at: ring.expires_at,
      seconds_left: Math.max(0, Math.round((expiresAtMs - nowMs) / 1000)),
    },
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
  }
}

/**
 * A ring's cancel: stop ringing, and how it was settled (the phone ends the
 * call with the matching reason: answered or declined elsewhere, or the
 * caller gave up). Now or never: a phone that is ringing is reachable, and
 * one that is not would only flash a call it never showed. Pure.
 */
export function cancelPush(ring: CancelledRing): ApnsVoipPush {
  return {
    data: { kind: TEAM_CALL_CANCEL_PUSH, ring_id: ring.ring_id, call_id: ring.call_id, state: ring.state },
    expiresAtMs: 0,
  }
}

export interface RingPushDeps {
  push: PushDeps
  claim(ringId: string): Promise<ClaimedRing | null>
  cancel(filter: { ringIds?: readonly string[]; callId?: string; memberId?: string }): Promise<CancelledRing[]>
  now?: () => number
}

/** The real claims and Apple, on the service client. */
export function liveRingPushDeps(svc: SupabaseClient): RingPushDeps {
  return {
    push: livePushDeps(svc),
    claim: async (ringId) => {
      const { data, error } = await svc.rpc('team_call_ring_push_claim', { target_ring: ringId })
      if (error) throw new Error(`team calls: ring push claim failed: ${error.message}`)
      const row = (Array.isArray(data) ? data[0] : data) as ClaimedRing | undefined
      return row?.ring_id ? row : null
    },
    cancel: async (filter) => {
      const { data, error } = await svc.rpc('team_call_ring_push_cancel', {
        target_rings: filter.ringIds?.length ? [...filter.ringIds] : null,
        for_call: filter.callId ?? null,
        for_member: filter.memberId ?? null,
      })
      if (error) throw new Error(`team calls: ring push cancel failed: ${error.message}`)
      return (data ?? []) as CancelledRing[]
    },
  }
}

/** Push each new ring that is ringing to its person's phones, once. Returns how many went. Never throws. */
export async function pushRings(deps: RingPushDeps, rings: ReadonlyArray<{ ringId: string; state: string }>): Promise<number> {
  if (!deps.push.config) return 0
  let sent = 0
  for (const ring of rings) {
    if (ring.state !== 'ringing') continue
    try {
      const claimed = await deps.claim(ring.ringId)
      if (!claimed) continue
      const outcome = await voipToPerson(deps.push, { userId: claimed.user_id, push: ringPush(claimed, (deps.now ?? Date.now)()) })
      if (outcome === 'sent') sent++
      console.info(`[team-call-push] ring=${ring.ringId} outcome=${outcome}`)
    } catch (err) {
      console.warn(`[team-call-push] ring=${ring.ringId} not pushed:`, err instanceof Error ? err.message : 'unknown')
    }
  }
  return sent
}

/**
 * Stop the phones still ringing for rings that left ringing: these rings,
 * one member's rings in one call (their join, their removal), or a call's
 * rings (it ended by a trigger: its conversation archived). Only rings that were
 * pushed, once each; never to `exceptToken` (the phone that answered).
 * Returns how many cancels went. Never throws.
 */
export async function cancelRingPushes(
  deps: RingPushDeps,
  filter: { ringIds?: readonly string[]; callId?: string; memberId?: string; exceptToken?: string | null },
): Promise<number> {
  if (!deps.push.config) return 0
  if (!filter.ringIds?.length && !filter.callId) return 0
  let settled: CancelledRing[]
  try {
    settled = await deps.cancel(filter)
  } catch (err) {
    console.warn('[team-call-push] cancels not claimed:', err instanceof Error ? err.message : 'unknown')
    return 0
  }
  let sent = 0
  for (const ring of settled) {
    const outcome = await voipToPerson(deps.push, {
      userId: ring.user_id,
      push: cancelPush(ring),
      exceptTokens: filter.exceptToken ? [filter.exceptToken] : [],
    })
    if (outcome === 'sent') sent++
    console.info(`[team-call-push] ring=${ring.ring_id} cancel=${ring.state} outcome=${outcome}`)
  }
  return sent
}

/** A VoIP token as the answer route takes it (the phone that answered), or null. */
export function voipTokenOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase()
  return /^[0-9a-f]{64,200}$/.test(token) ? token : null
}
