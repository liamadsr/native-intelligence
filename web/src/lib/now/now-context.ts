/**
 * Where the person's Now file is read and written from on the main chat's
 * tool route (docs/plans/now-file.md): their own main chat in the app, and
 * the main agent's check-in.
 *
 *   person, no server turn   the person typing in the app: writer 'chat',
 *                            and get_document, find and the history tools
 *                            may show the note.
 *   home_turn + check_in     the check-in, in its own fresh session (Slice 2,
 *                            "Who may write the note"): writer 'check_in'
 *                            only. It reads the note through its `now`
 *                            section, never through get_document, find or the
 *                            history tools, so `readable` stays off.
 *   anything else            nothing: any other home turn, a channel turn (a
 *                            Slack DM is `person`, but the server sent it), a
 *                            text or the device ask (person_remote), a relayed
 *                            turn, a teammate chat, and a quick helper's call
 *                            (`helper`: helpers run on the main chat's token,
 *                            so the caller class alone would let them in).
 *
 * Read only from claims whose HMAC verified and the proxy's own `helper` mark,
 * never from a model. Pure.
 */
import type { NowToolContext } from '@/lib/ai/tools/now'
import { isCheckInClaims, type ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { callerClassOf } from '@/lib/safety/caller'

/**
 * The check-in's one attended-only grant on the tool route (callerRefusal's
 * `granted`): update_now, for exactly the check-in's own call (the same
 * claims nowContextForChatCall gives the writer 'check_in'). Every other
 * server turn, and every other attended-only tool, stays refused. Pure.
 */
export function checkInNowGrant(claims: ChatRunTokenClaims, toolName: string, body: { helper?: unknown }): boolean {
  return toolName === 'update_now' && nowContextForChatCall(claims, body)?.writer === 'check_in'
}

export function nowContextForChatCall(claims: ChatRunTokenClaims, body: { helper?: unknown }): NowToolContext | undefined {
  if (body.helper === true) return undefined
  // The check-in: a home turn's own token, with nothing else on it (no teammate, relay, surface or guest).
  if (isCheckInClaims(claims)) {
    if (claims.teammateId || claims.relay !== undefined || claims.surface !== undefined || claims.guestId !== undefined) return undefined
    return { writer: 'check_in' }
  }
  if (claims.server !== undefined || claims.teammateId || claims.relay !== undefined || claims.surface !== undefined || claims.guestId !== undefined) return undefined
  if (callerClassOf({ kind: 'chat_run', claims }) !== 'person') return undefined
  return { writer: 'chat', readable: true }
}
