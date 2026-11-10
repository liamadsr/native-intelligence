/**
 * POST /api/presence: a Native Intelligence app saying its person is (or is not) at it, and
 * optionally how far they have read their home thread
 * (docs/plans/reach-follows-you.md §1 and §2). Nothing reads these yet; the
 * router (part C) will, to choose between a banner and a text.
 *
 * Body: {clientId, surface, state, seen?: {conversationId, through}}, or a
 * seen-only {clientId, surface, seen} from a desktop window other than main,
 * which never touches the row's state (src/lib/presence/presence.ts
 * parsePresencePing). Read with
 * `request.text()`, not `request.json()`, so a `navigator.sendBeacon` ping
 * (sent as text/plain) parses the same as a fetch.
 *
 * Auth: requireUser, so a cookie for the web and the desktop and a Bearer JWT
 * for iOS. Presence is per person, not per workspace, so no membership check.
 * A capture-device token (`Bearer nid_…`) is refused: a hardware recorder is
 * not the person, and a ping from one would hold their texts back.
 *
 * Writes run on the service client (user_presence grants nothing to signed-in
 * clients): one upsert when the ping says a state, then the seen update when
 * it carries one.
 * Answers 204 with no body.
 */
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { isDeviceToken } from '@/lib/device-tokens'
import { getServiceClient } from '@/lib/supabase/service'
import { parsePresencePing } from '@/lib/presence/presence'
import { markHomeSeen, upsertPresence } from '@/lib/presence/store'

/** A real ping is about 200 bytes; anything far past that is not one. */
const MAX_BODY_CHARS = 4096

export async function POST(request: Request) {
  const header = request.headers.get('authorization') ?? ''
  if (header.startsWith('Bearer ') && isDeviceToken(header.slice(7).trim())) {
    return apiError('Presence needs a signed-in session', { status: 403, code: 'DEVICE_TOKEN_REFUSED' })
  }
  const auth = await requireUser()
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_CHARS) return badRequest('Body too large')
    body = JSON.parse(text)
  } catch {
    return badRequest('Invalid JSON')
  }
  const parsed = parsePresencePing(body)
  if (!parsed.ok) return badRequest(parsed.error)

  const now = Date.now()
  const service = getServiceClient()
  try {
    const { state } = parsed.ping
    if (state) await upsertPresence(service, auth.user.id, { ...parsed.ping, state }, now)
    if (parsed.ping.seen) {
      await markHomeSeen(service, auth.user.id, parsed.ping.seen.conversationId, parsed.ping.seen.through, now)
    }
  } catch (err) {
    console.error('[presence] write failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
  return new Response(null, { status: 204 })
}
