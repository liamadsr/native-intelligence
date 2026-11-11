/**
 * What the public meeting surface shares (server only): the page
 * (src/app/m/[token]/page.tsx) and the guest's routes beside it
 * (src/app/m/[token]/{join,lobby,token,leave}/route.ts). Nobody here is
 * signed in; what vouches for a caller is the link's token (looked up by its
 * hash) and, for a guest, their signed cookie.
 *
 *   - A token of the wrong shape, unknown, revoked, run out or of an
 *     archived conversation all answer the same: "This link is no longer
 *     active" (nothing tells a bad link from an old one).
 *   - Opening a link is limited per address and per link (src/lib/meeting-links/
 *     limits.ts); over it, a plain "Too many tries".
 *   - Nothing of the workspace is said beyond the meeting's title and its
 *     host's first name.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '@/lib/api-errors'
import { readCookie } from '@/lib/oauth/state'
import { hitLimits, MEETING_LIMITS } from './limits'
import { MEETING_GUEST_COOKIE, rateKeyOf, tokenDigest, verifyGuestCookie } from './link'
import { isMeetingToken } from './shape'
import { meetingByDigest, type PublicMeeting } from './store'

export type PublicLookup =
  | { kind: 'open'; meeting: PublicMeeting; digest: string; rateKey: string }
  | { kind: 'early'; meeting: PublicMeeting; digest: string; rateKey: string }
  | { kind: 'inactive' }
  | { kind: 'limited' }

/** A meeting as a public caller may reach it: limited first, then looked up by the token's hash. */
export async function lookUpMeeting(svc: SupabaseClient, token: string, headers: Headers, now: number = Date.now()): Promise<PublicLookup> {
  if (!isMeetingToken(token)) return { kind: 'inactive' }
  const rateKey = rateKeyOf(headers)
  const digest = tokenDigest(token)
  const under = await hitLimits(svc, [
    [MEETING_LIMITS.lookupPerAddress, rateKey],
    [MEETING_LIMITS.lookupPerLink, digest.slice(0, 32)],
  ])
  if (!under) return { kind: 'limited' }
  const meeting = await meetingByDigest(svc, digest)
  if (!meeting || meeting.revoked_at || now >= Date.parse(meeting.closes_at)) return { kind: 'inactive' }
  const { data: channel } = await svc.from('team_chat_channel').select('archived_at').eq('id', meeting.channel_id).maybeSingle<{ archived_at: string | null }>()
  if (!channel || channel.archived_at) return { kind: 'inactive' }
  if (now < Date.parse(meeting.opens_at)) return { kind: 'early', meeting, digest, rateKey }
  return { kind: 'open', meeting, digest, rateKey }
}

/** The guest a request's cookie names for this link (checked before any read), or null. */
export function guestOf(request: Request, token: string): string | null {
  if (!isMeetingToken(token)) return null
  return verifyGuestCookie(token, readCookie(request.headers.get('cookie'), MEETING_GUEST_COOKIE))
}

/** The one answer for a link that doesn't work, whatever the reason. */
export function linkInactive(): Response {
  return apiError('This link is no longer active', { status: 404, code: 'MEETING_INACTIVE' })
}

export function tooManyTries(): Response {
  return apiError('Too many tries. Wait a minute, then try again.', { status: 429, code: 'RATE_LIMITED' })
}

/** The meeting hasn't opened yet: when it does. */
export function linkEarly(meeting: Pick<PublicMeeting, 'opens_at'>): Response {
  return apiError('This meeting has not started yet', { status: 409, code: 'MEETING_EARLY', details: { opensAt: meeting.opens_at } })
}

/** No guest here (no cookie, a bad or expired one, another link's). */
export function noGuest(): Response {
  return apiError('Ask to join first', { status: 401, code: 'NO_GUEST' })
}

/** Responses a guest's routes send: never cached, never indexed. */
export function privateHeaders(res: Response): Response {
  res.headers.set('Cache-Control', 'private, no-store')
  res.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return res
}
