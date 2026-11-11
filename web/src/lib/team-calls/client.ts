/**
 * The page's side of the team call routes (src/app/api/account/team-calls/*):
 * small fetch wrappers that never throw. Each answers what the provider
 * (src/components/team-calls/team-calls-provider.tsx) needs, or a plain
 * reason it can say in a toast.
 */
import type { TeamCallJoin } from './call-session'
import type { TeamCallRing, TeamCallRingState } from './types'
import { NO_CALL_FEATURES, type TeamCallFeatures, type TeamCallNotesView } from './notes'

export interface CallPlace {
  id: string
  channelId: string
  /** The call's workspace (a ring can come from one other than the one on screen). */
  workspaceId: string
  messageId: string | null
  channelKind: 'channel' | 'dm'
  /** The person's member id in the call's workspace. */
  memberId: string
  /** What the server offers this call (notes, recording); nothing shows for what is off. */
  features: TeamCallFeatures
  /** The call's notes and recording as the join found them (Realtime keeps them after). */
  notes: TeamCallNotesView
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

/** Is calling on here, the person's rings open now, and what the server offers a call. */
export async function fetchTeamCalls(): Promise<{ available: boolean; rings: TeamCallRing[]; features: TeamCallFeatures }> {
  try {
    const res = await fetch('/api/account/team-calls')
    if (!res.ok) return { available: false, rings: [], features: NO_CALL_FEATURES }
    const json = (await res.json()) as { available?: boolean; rings?: TeamCallRing[]; features?: Partial<TeamCallFeatures> }
    return {
      available: json.available === true,
      rings: Array.isArray(json.rings) ? json.rings : [],
      features: { notes: json.features?.notes === true, recording: json.features?.recording === true },
    }
  } catch {
    return { available: false, rings: [], features: NO_CALL_FEATURES }
  }
}

/** Start a call in a conversation (or join the one live there); `notes`: a new call starts with its notes on (the starter's Auto-record setting). */
export async function requestStart(channelId: string, notes = false): Promise<{ ok: true; call: CallPlace; join: TeamCallJoin } | { ok: false; why: CallFailure }> {
  const res = await post('/api/account/team-calls', { channelId, notes })
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

/** Turn the call's notes on or off; a failure carries what its toast says. */
export async function requestNotes(callId: string, on: boolean): Promise<{ ok: true; notes: boolean } | { ok: false; line: string }> {
  const res = await post(`/api/account/team-calls/${callId}/notes`, { on })
  if (res?.ok) {
    const json = (await res.json().catch(() => null)) as { notes?: boolean } | null
    return { ok: true, notes: json?.notes === true }
  }
  const json = (await res?.json().catch(() => null)) as { code?: string; error?: string } | null
  if (json?.code === 'NOTES_FULL') return { ok: false, line: 'This call has 3 hours of notes already.' }
  if (res?.status === 403) return { ok: false, line: 'Only someone in the call can change its notes.' }
  if (res?.status === 409) return { ok: false, line: 'That call has ended.' }
  return { ok: false, line: on ? 'Notes didn’t turn on. Try again.' : 'Notes didn’t turn off. Try again.' }
}

/** Start or stop recording the call. */
export async function requestRecording(callId: string, action: 'start' | 'stop'): Promise<{ ok: true } | { ok: false; line: string }> {
  const res = await post(`/api/account/team-calls/${callId}/recording`, { action })
  if (res?.ok) return { ok: true }
  const json = (await res?.json().catch(() => null)) as { code?: string } | null
  if (json?.code === 'RECORDING_BUSY') return { ok: false, line: 'Another recording is running. Try again when it ends.' }
  if (json?.code === 'RECORDING_SAVED') return { ok: false, line: 'This call was recorded already.' }
  if (res?.status === 403) return { ok: false, line: 'Only someone in the call can record it.' }
  if (res?.status === 409) return { ok: false, line: 'That call has ended.' }
  return { ok: false, line: action === 'start' ? 'The recording didn’t start. Try again.' : 'The recording didn’t stop. Try again.' }
}

/** A link to a call's saved recording (an hour long), or null when the person may not play it. */
export async function fetchRecordingLink(callId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/account/team-calls/${callId}/recording`)
    if (!res.ok) return null
    const json = (await res.json()) as { url?: string }
    return typeof json.url === 'string' && /^https?:/.test(json.url) ? json.url : null
  } catch {
    return null
  }
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
