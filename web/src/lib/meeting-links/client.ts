/**
 * The app's side of the members' meeting routes (src/app/api/account/
 * meetings/*): small fetch wrappers that never throw. Each answers what its
 * caller needs, or a plain line it can say in a toast.
 */
import type { MeetingView } from './shape'

async function send(url: string, method: 'POST' | 'GET', body?: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return null
  }
}

async function errorLine(res: Response | null, fallback: string): Promise<string> {
  if (!res) return 'You’re offline. Try again.'
  const json = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
  if (res.status === 400 && json?.error) return json.error
  if (res.status === 403) return json?.error && json.code === 'FORBIDDEN' ? json.error : 'You can’t do that in this meeting.'
  return fallback
}

export interface CreatedMeeting {
  meetingId: string
  channelId: string
  url: string
  title: string
  opensAt: string
  closesAt: string
}

/** Make a meeting link (a title, maybe a start and a length). */
export async function requestNewMeeting(input: { title: string; startsAt?: string | null; minutes?: number | null }): Promise<{ ok: true; meeting: CreatedMeeting } | { ok: false; line: string }> {
  const res = await send('/api/account/meeting-links', 'POST', input)
  if (!res?.ok) return { ok: false, line: await errorLine(res, 'The link wasn’t made. Try again.') }
  const json = (await res.json().catch(() => null)) as { meeting?: CreatedMeeting } | null
  return json?.meeting ? { ok: true, meeting: json.meeting } : { ok: false, line: 'The link wasn’t made. Try again.' }
}

/** A conversation's meeting and its link, or null (not a meeting, or not readable). */
export async function fetchMeetingOf(channelId: string): Promise<MeetingView | null> {
  const res = await send(`/api/account/meeting-links?channel=${encodeURIComponent(channelId)}`, 'GET')
  if (!res?.ok) return null
  const json = (await res.json().catch(() => null)) as { meeting?: MeetingView | null } | null
  return json?.meeting ?? null
}

/** The host turns the link off. */
export async function requestRevoke(meetingId: string): Promise<{ ok: true } | { ok: false; line: string }> {
  const res = await send(`/api/account/meeting-links/${meetingId}/revoke`, 'POST')
  return res?.ok ? { ok: true } : { ok: false, line: await errorLine(res, 'The link wasn’t turned off. Try again.') }
}

/** The host replaces the link: the old one stops working. */
export async function requestNewLink(meetingId: string): Promise<{ ok: true; url: string } | { ok: false; line: string }> {
  const res = await send(`/api/account/meeting-links/${meetingId}/new-link`, 'POST')
  if (!res?.ok) return { ok: false, line: await errorLine(res, 'No new link was made. Try again.') }
  const json = (await res.json().catch(() => null)) as { url?: string } | null
  return json?.url ? { ok: true, url: json.url } : { ok: false, line: 'No new link was made. Try again.' }
}

/** The host ends the meeting's call for everyone. */
export async function requestEnd(meetingId: string): Promise<{ ok: true } | { ok: false; line: string }> {
  const res = await send(`/api/account/meeting-links/${meetingId}/end`, 'POST')
  return res?.ok ? { ok: true } : { ok: false, line: await errorLine(res, 'The meeting didn’t end. Try again.') }
}

/** A member opens a meeting link from inside the app (a calendar event's Join): its conversation, joined. */
export async function requestJoinLink(token: string): Promise<{ ok: true; channelId: string; title: string } | { ok: false; line: string }> {
  const res = await send('/api/account/meeting-links/join', 'POST', { token })
  if (!res?.ok) return { ok: false, line: res?.status === 404 ? 'This link is no longer active.' : await errorLine(res, 'Couldn’t open the meeting. Try again.') }
  const json = (await res.json().catch(() => null)) as { channelId?: string; title?: string } | null
  return json?.channelId ? { ok: true, channelId: json.channelId, title: json.title ?? 'Meeting' } : { ok: false, line: 'Couldn’t open the meeting. Try again.' }
}

/** Admit or decline a waiting guest (someone in the call). */
export async function requestDecide(guestId: string, admit: boolean): Promise<{ ok: true; state: string } | { ok: false; line: string }> {
  const res = await send(`/api/account/meeting-links/guests/${guestId}`, 'POST', { action: admit ? 'admit' : 'decline' })
  if (!res?.ok) return { ok: false, line: await errorLine(res, admit ? 'They weren’t let in. Try again.' : 'Couldn’t decline. Try again.') }
  const json = (await res.json().catch(() => null)) as { state?: string } | null
  return { ok: true, state: json?.state ?? 'waiting' }
}

/** Remove a guest from the meeting, for good. */
export async function requestRemoveGuest(guestId: string): Promise<{ ok: true } | { ok: false; line: string }> {
  const res = await send(`/api/account/meeting-links/guests/${guestId}`, 'POST', { action: 'remove' })
  return res?.ok ? { ok: true } : { ok: false, line: await errorLine(res, 'They weren’t removed. Try again.') }
}
