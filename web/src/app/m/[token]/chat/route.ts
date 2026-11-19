/**
 * The meeting's chat, for a guest while they are in its call (migration
 * 670). A guest has no database session: their page asks every few seconds
 * while the call is on screen.
 *
 *   GET /m/<token>/chat → { messages: [{ id, at, author, name, mine, text,
 *     note }] }: the conversation's own messages since the guest first came
 *     into this call, oldest first (the newest GUEST_CHAT_READ_MAX), made
 *     plain (src/lib/meeting-links/guest-chat.ts: never a link's address
 *     behind a label, a link into the signed-in app, a record's id, a file's
 *     path, a link preview or a shared email).
 *   POST /m/<token>/chat { text } → 201 { message }: the guest's message, 1
 *     to 2000 characters, into the meeting's chat as theirs (author_kind
 *     'guest', their name). Same-origin only (the meeting's own page). It
 *     reaches the members over Realtime like any message, and nothing else:
 *     no agent's turn, no notification, no email, no loop, no mention, no
 *     link preview (the members' route does those; this one never calls them).
 *
 * Checked as every guest route is: the signed cookie first, with no read (a
 * forged or missing one is a 401 that touched nothing), then limits counted
 * in memory per guest (and, for a send, per address), then 670's functions
 * (by the guest and the link's hash), which also say they are still let into
 * that live call: 403 once they are not (left, removed, the call over, the
 * link revoked). Chat does not need the call's notes: it works with them off.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { meetingMemoryLimiter, MEETING_LIMITS } from '@/lib/meeting-links/limits'
import { rateKeyOf, tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, noGuest, privateHeaders, smallBody, tooManyTries } from '@/lib/meeting-links/public'
import { GUEST_CHAT_MAX, GUEST_CHAT_READ_MAX, guestChatMessagesOf, guestChatTextOf, tidyGuestWords, type GuestChatMessage } from '@/lib/meeting-links/guest-chat'

export const dynamic = 'force-dynamic'

/** A send's body: 2000 characters, each up to a few bytes and escaped in JSON, with room to spare. */
const CHAT_BODY_MAX = 16 * 1024

type Params = { params: Promise<{ token: string }> }

const notInCall = () => privateHeaders(apiError('The meeting’s chat is for the people in its call', { status: 403, code: 'NOT_IN_CALL' }))

export async function GET(request: NextRequest, { params }: Params) {
  const { token } = await params
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.chatReadsPerGuest, guestId) || !meetingMemoryLimiter.hit(MEETING_LIMITS.pollPerAddress, rateKeyOf(request.headers))) {
    return privateHeaders(tooManyTries())
  }
  try {
    const { data, error } = await getServiceClient().rpc('meeting_guest_chat_read', {
      target_guest: guestId,
      token_digest: tokenDigest(token),
      max_messages: GUEST_CHAT_READ_MAX,
    })
    if (error) throw new Error(error.message)
    const answer = (data ?? {}) as { allowed?: unknown; messages?: unknown }
    if (answer.allowed !== true) return notInCall()
    return privateHeaders(NextResponse.json({ messages: guestChatMessagesOf(answer.messages) }))
  } catch (err) {
    console.error('[meetings] guest chat read failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return privateHeaders(serverError())
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params
  if (!isSameOriginPost(request)) return privateHeaders(apiError('Forbidden', { status: 403, code: 'FORBIDDEN' }))
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  if (!meetingMemoryLimiter.hit(MEETING_LIMITS.chatPostsPerGuest, guestId) || !meetingMemoryLimiter.hit(MEETING_LIMITS.chatPostsPerAddress, rateKeyOf(request.headers))) {
    return privateHeaders(tooManyTries())
  }
  const raw = await smallBody(request, CHAT_BODY_MAX)
  if (raw instanceof Response) return raw
  let input: { text?: unknown } = {}
  try {
    input = raw ? (JSON.parse(raw) as { text?: unknown }) : {}
  } catch {
    return privateHeaders(badRequest('Invalid JSON body'))
  }
  if (!input || typeof input !== 'object') return privateHeaders(badRequest('Invalid JSON body'))
  const words = tidyGuestWords(input.text)
  if (!words) return privateHeaders(apiError(`Write 1 to ${GUEST_CHAT_MAX} characters.`, { status: 400, code: 'BAD_TEXT' }))
  try {
    const { data, error } = await getServiceClient().rpc('meeting_guest_chat_post', {
      target_guest: guestId,
      token_digest: tokenDigest(token),
      words,
    })
    if (error?.code === '22023') return privateHeaders(apiError(`Write 1 to ${GUEST_CHAT_MAX} characters.`, { status: 400, code: 'BAD_TEXT' }))
    if (error) throw new Error(error.message)
    const answer = (data ?? {}) as { allowed?: unknown; id?: unknown; created_at?: unknown; name?: unknown }
    if (answer.allowed !== true) return notInCall()
    if (typeof answer.id !== 'string' || typeof answer.created_at !== 'string') throw new Error('no message came back')
    const message: GuestChatMessage = {
      id: answer.id,
      at: answer.created_at,
      author: 'guest',
      name: typeof answer.name === 'string' && answer.name.trim() ? answer.name.trim() : 'Guest',
      mine: true,
      text: guestChatTextOf(words),
      note: null,
    }
    // Ids and outcomes only, never words.
    console.info(`[meetings] guest=${guestId} outcome=chat_sent message=${message.id}`)
    return privateHeaders(NextResponse.json({ message }, { status: 201 }))
  } catch (err) {
    console.error('[meetings] guest chat send failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return privateHeaders(serverError())
  }
}
