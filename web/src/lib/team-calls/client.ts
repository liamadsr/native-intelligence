/**
 * The page's side of the team call routes (src/app/api/account/team-calls/*):
 * small fetch wrappers that never throw. Each answers what the provider
 * (src/components/team-calls/team-calls-provider.tsx) needs, or a plain
 * reason it can say in a toast.
 */
import type { TeamCallJoin } from './call-session'
import type { TeamCallRing, TeamCallRingState } from './types'

export interface CallPlace {
  id: string
  channelId: string
  messageId: string | null
  channelKind: 'channel' | 'dm'
}

export type CallFailure = 'unavailable' | 'ended' | 'unreachable' | 'forbidden' | 'failed'

async function post(url: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return null
  }
}

async function failureOf(res: Response | null): Promise<CallFailure> {
  if (!res) return 'failed'
  const json = (await res.json().catch(() => null)) as { code?: string } | null
  if (json?.code === 'CALLS_NOT_AVAILABLE') return 'unavailable'
  if (json?.code === 'CALL_ENDED' || res.status === 409) return 'ended'
  if (json?.code === 'CALLS_UNREACHABLE' || res.status === 503) return 'unreachable'
  if (res.status === 403 || res.status === 404) return 'forbidden'
  return 'failed'
}

/** Is calling on here, and the person's rings open now. */
export async function fetchTeamCalls(): Promise<{ available: boolean; rings: TeamCallRing[] }> {
  try {
    const res = await fetch('/api/account/team-calls')
    if (!res.ok) return { available: false, rings: [] }
    const json = (await res.json()) as { available?: boolean; rings?: TeamCallRing[] }
    return { available: json.available === true, rings: Array.isArray(json.rings) ? json.rings : [] }
  } catch {
    return { available: false, rings: [] }
  }
}

/** Start a call in a conversation (or join the one live there). */
export async function requestStart(channelId: string): Promise<{ ok: true; call: CallPlace; join: TeamCallJoin } | { ok: false; why: CallFailure }> {
  const res = await post('/api/account/team-calls', { channelId })
  if (!res?.ok) return { ok: false, why: await failureOf(res) }
  const json = (await res.json().catch(() => null)) as { call?: CallPlace & { created?: boolean }; join?: TeamCallJoin } | null
  if (!json?.call || !json.join) return { ok: false, why: 'failed' }
  return { ok: true, call: json.call, join: json.join }
}

/** A join for a live call (the Join button, a rejoin). */
export async function requestJoin(callId: string): Promise<{ ok: true; call: CallPlace; join: TeamCallJoin } | { ok: false; why: CallFailure }> {
  const res = await post(`/api/account/team-calls/${callId}/token`)
  if (!res?.ok) return { ok: false, why: await failureOf(res) }
  const json = (await res.json().catch(() => null)) as { call?: CallPlace; join?: TeamCallJoin } | null
  if (!json?.call || !json.join) return { ok: false, why: 'failed' }
  return { ok: true, call: json.call, join: json.join }
}

/** Answer a ring. Accepted: the join too. */
export async function requestAnswer(
  ringId: string,
  accept: boolean,
): Promise<{ ok: true; state: TeamCallRingState; call?: CallPlace; join?: TeamCallJoin } | { ok: false; why: CallFailure }> {
  const res = await post(`/api/account/team-calls/rings/${ringId}`, { accept })
  if (!res?.ok) return { ok: false, why: await failureOf(res) }
  const json = (await res.json().catch(() => null)) as { state?: TeamCallRingState; call?: CallPlace; join?: TeamCallJoin } | null
  if (!json?.state) return { ok: false, why: 'failed' }
  return { ok: true, state: json.state, call: json.call, join: json.join }
}

/** Ring people into a call. The ones rung (or told quietly, being in another call). */
export async function requestRing(callId: string, memberIds: string[]): Promise<Array<{ memberId: string; state: 'ringing' | 'busy' }> | null> {
  const res = await post(`/api/account/team-calls/${callId}/ring`, { memberIds })
  if (!res?.ok) return null
  const json = (await res.json().catch(() => null)) as { rings?: Array<{ memberId: string; state: 'ringing' | 'busy' }> } | null
  return json?.rings ?? []
}

/** Tell the server the person hung up. */
export async function requestLeave(callId: string): Promise<void> {
  await post(`/api/account/team-calls/${callId}/leave`)
}

/** What a failure says. */
export function callFailureLine(why: CallFailure): string {
  switch (why) {
    case 'unavailable':
      return 'Calls aren’t available here.'
    case 'ended':
      return 'That call has ended.'
    case 'unreachable':
      return 'The call server can’t be reached. Try again in a moment.'
    case 'forbidden':
      return 'You can’t join that call.'
    default:
      return 'The call didn’t start. Try again.'
  }
}
