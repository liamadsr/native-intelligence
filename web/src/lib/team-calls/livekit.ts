/**
 * The app's side of the self-hosted LiveKit server (deploy/livekit, PR #80),
 * server only. Three settings, all or none:
 *
 *   LIVEKIT_URL         the public signalling address browsers connect to
 *                       (wss://livekit.<domain>); the server API is the same
 *                       host over https.
 *   LIVEKIT_API_KEY     the key pair's key, and the issuer of every token.
 *   LIVEKIT_API_SECRET  its secret: signs the join tokens and checks the
 *                       webhooks LiveKit signs. Never leaves the server.
 *
 * With any of them unset (an empty value counts as unset) calling is off:
 * {@link teamCallsConfig} is null, every call route answers "not available"
 * and the app shows no call button. Nothing here is loaded by a page.
 *
 * Join tokens ({@link teamCallToken}): one room, the person's member id as
 * the identity, their name as the display name, ten minutes (LiveKit hands
 * a connected participant fresh ones; a full rejoin asks the token route
 * again), and only what a call needs: join, subscribe, and publish the
 * microphone, the camera and a shared screen. No data messages, no
 * metadata of their own, never room admin.
 */
import 'server-only'
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver, type VideoGrant, type WebhookEvent } from 'livekit-server-sdk'
import {
  TEAM_CALL_DEPARTURE_TIMEOUT_SECONDS,
  TEAM_CALL_EMPTY_TIMEOUT_SECONDS,
  TEAM_CALL_MAX_PARTICIPANTS,
  TEAM_CALL_TOKEN_TTL_SECONDS,
} from './types'

export interface TeamCallsConfig {
  /** wss:// (or ws:// on a developer's machine): what the browser dials. */
  url: string
  /** https:// (or http://): the server API, the same host. */
  apiUrl: string
  apiKey: string
  apiSecret: string
}

function setting(name: string, env: NodeJS.ProcessEnv): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

/** The LiveKit settings, or null when calling is off (any of the three unset, or the address not a ws(s) URL). */
export function teamCallsConfig(env: NodeJS.ProcessEnv = process.env): TeamCallsConfig | null {
  const url = setting('LIVEKIT_URL', env)
  const apiKey = setting('LIVEKIT_API_KEY', env)
  const apiSecret = setting('LIVEKIT_API_SECRET', env)
  if (!url || !apiKey || !apiSecret) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null
  const apiUrl = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`
  return { url: url.replace(/\/+$/, ''), apiUrl, apiKey, apiSecret }
}

/** The grants a member's token carries: one room, and only what a call needs. */
export function teamCallGrant(room: string): VideoGrant {
  return {
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canPublishData: false,
    canUpdateOwnMetadata: false,
    roomCreate: false,
    roomAdmin: false,
    roomList: false,
    roomRecord: false,
    hidden: false,
  }
}

/** A join token for one member and one room. */
export async function teamCallToken(config: TeamCallsConfig, input: { room: string; memberId: string; name: string }): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.memberId,
    name: input.name.trim().slice(0, 120) || 'A teammate',
    ttl: TEAM_CALL_TOKEN_TTL_SECONDS,
  })
  token.addGrant(teamCallGrant(input.room))
  return token.toJwt()
}

function rooms(config: TeamCallsConfig): RoomServiceClient {
  return new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret)
}

/** Make a call's room, with LiveKit's own timers ending it when nobody comes or the last person leaves. */
export async function createTeamCallRoom(config: TeamCallsConfig, room: string): Promise<void> {
  await rooms(config).createRoom({
    name: room,
    emptyTimeout: TEAM_CALL_EMPTY_TIMEOUT_SECONDS,
    departureTimeout: TEAM_CALL_DEPARTURE_TIMEOUT_SECONDS,
    maxParticipants: TEAM_CALL_MAX_PARTICIPANTS,
  })
}

/** Which of these rooms are open on the server now. Throws when the server can't be asked (the caller then changes nothing). */
export async function openTeamCallRooms(config: TeamCallsConfig, names: readonly string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const list = await rooms(config).listRooms([...names])
  return new Set(list.map((r) => r.name))
}

/** LiveKit's "no such room / participant": what was to go is gone already. */
function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  const code = (err as { code?: unknown } | null)?.code
  if (status === 404 || code === 'not_found') return true
  const message = err instanceof Error ? err.message : String(err)
  return /not.?found|does not exist/i.test(message)
}

/** Close a call's room (a DM's person hung up, its channel archived or deleted). A room already gone is fine. */
export async function closeTeamCallRoom(config: TeamCallsConfig, room: string): Promise<void> {
  try {
    await rooms(config).deleteRoom(room)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/**
 * Take someone out of a call's room now (their access to its conversation
 * ended). A token running out never cuts off a connected participant, so
 * this is what does. Someone not in the room (left already) is fine.
 */
export async function removeFromTeamCallRoom(config: TeamCallsConfig, room: string, identity: string): Promise<void> {
  try {
    await rooms(config).removeParticipant(room, identity)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/**
 * A webhook delivery, checked: its `Authorization` is a token signed with
 * our secret whose body hash is this body's. Null for anything else (a bad
 * or missing signature, a body that isn't an event).
 */
export async function receiveTeamCallWebhook(config: TeamCallsConfig, body: string, authorization: string | null): Promise<WebhookEvent | null> {
  if (!authorization) return null
  try {
    return await new WebhookReceiver(config.apiKey, config.apiSecret).receive(body, authorization)
  } catch {
    return null
  }
}
