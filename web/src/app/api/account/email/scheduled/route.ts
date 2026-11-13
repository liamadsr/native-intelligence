/**
 * Send later (src/lib/email/scheduled-send.ts, migration 642).
 *
 * GET  the caller's scheduled sends in this workspace that the Scheduled
 *      folder lists ('scheduled', 'sending', and 'failed' until dismissed),
 *      soonest first, read on their own session (RLS: the owner only);
 *      `?thread_id=` only those on one thread (the thread view's badge).
 *      `{ scheduled: [...] }`, never a draft's provider id.
 *
 * POST schedule one. `send_at` (an ISO time, in the future, within a year),
 *      and either
 *        a new message: `account_id` (the From mailbox: the caller's own, the
 *        check sendEmail makes), `to`, `cc?`, `bcc?`, `subject`, `body_html`;
 *        it is saved as a draft in that mailbox, then scheduled;
 *      or a draft on a thread (a reply): `thread_id`, `draft_id` (its message
 *        id, as the thread view shows it), `edits?` (written into the draft
 *        first), `shown?` ({ to, subject }: what the folder lists when there
 *        are no edits).
 *      `{ scheduled: row }`; 400 for a time in the past, a bad address or a
 *      mailbox that is not the caller's; 404 for a draft no longer there.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { isProviderId } from '@/lib/email/provider-drafts'
import { MAX_DRAFT_BODY, MAX_DRAFT_RECIPIENTS, MAX_DRAFT_SUBJECT, isDraftAddress, parseDraftEdits } from '@/lib/email/draft-edits'
import {
  LISTED_STATUSES,
  SCHEDULED_SEND_PUBLIC_COLUMNS,
  parseSendAt,
  publicRow,
  scheduleExistingDraft,
  scheduleNewMessage,
  type ScheduleResult,
} from '@/lib/email/scheduled-send'

export const maxDuration = 30

export async function GET(request?: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const threadId = request ? new URL(request.url).searchParams.get('thread_id') : null
  if (threadId !== null && !isProviderId(threadId)) return badRequest('Invalid thread_id')
  let query = supabase
    .from('email_scheduled_send')
    .select(SCHEDULED_SEND_PUBLIC_COLUMNS)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .in('status', [...LISTED_STATUSES])
  if (threadId) query = query.eq('thread_id', threadId)
  const { data, error } = await query.order('send_at', { ascending: true }).limit(200)
  if (error) return serverError('Could not read your scheduled emails')
  return NextResponse.json({ scheduled: data ?? [] })
}

/** A list of addresses as the body gives it: trimmed, each a plain address, or 'invalid'. */
function addresses(raw: unknown, required: boolean): string[] | 'invalid' {
  if (raw === undefined || raw === null) return required ? 'invalid' : []
  if (!Array.isArray(raw)) return 'invalid'
  const out = raw.map((a) => (typeof a === 'string' ? a.trim() : ''))
  if (out.some((a) => !isDraftAddress(a))) return 'invalid'
  if (required && out.length === 0) return 'invalid'
  return out
}

function answer(result: ScheduleResult) {
  if (result.ok) return NextResponse.json({ scheduled: publicRow(result.row) })
  if (result.reason === 'not_found') return notFound(result.message)
  if (result.reason === 'failed') return serverError(result.message)
  return badRequest(result.message)
}

export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('A message and a time are required')

  const sendAt = parseSendAt(body.send_at, new Date())
  if (sendAt === 'invalid') return badRequest('send_at must be a time')
  if (sendAt === 'past') return badRequest('Pick a time in the future')
  if (sendAt === 'too_far') return badRequest('Pick a time within a year')

  // A draft already on a thread (a reply, from the thread view).
  if (body.thread_id !== undefined || body.draft_id !== undefined) {
    const threadId = typeof body.thread_id === 'string' ? body.thread_id : ''
    const draftId = typeof body.draft_id === 'string' ? body.draft_id : ''
    if (!threadId || !draftId) return badRequest('thread_id and draft_id are required')
    const edits = parseDraftEdits(body.edits)
    if (edits === 'invalid') return badRequest('Check the recipients, the subject and the message')
    const shownRaw = body.shown as { to?: unknown; subject?: unknown } | undefined
    const shownTo = shownRaw ? addresses(shownRaw.to, false) : []
    const shown = shownRaw && shownTo !== 'invalid' ? { to: shownTo, subject: typeof shownRaw.subject === 'string' ? shownRaw.subject : '' } : null
    return answer(await scheduleExistingDraft({ userId: user.id, workspaceId, threadId, draftMessageId: draftId, edits, shown, sendAt }))
  }

  // A new message (the composer).
  const accountId = typeof body.account_id === 'string' ? body.account_id : ''
  if (!accountId) return badRequest('Pick the mailbox to send from')
  const to = addresses(body.to, true)
  const cc = addresses(body.cc, false)
  const bcc = addresses(body.bcc, false)
  if (to === 'invalid' || cc === 'invalid' || bcc === 'invalid') return badRequest('Check the recipients')
  if (to.length + cc.length + bcc.length > MAX_DRAFT_RECIPIENTS) return badRequest(`Send to ${MAX_DRAFT_RECIPIENTS} people at most`)
  const subject = typeof body.subject === 'string' ? body.subject : ''
  if (!subject.trim()) return badRequest('Subject required for new emails')
  if (subject.length > MAX_DRAFT_SUBJECT || /[\r\n]/.test(subject)) return badRequest('Check the subject')
  const bodyHtml = typeof body.body_html === 'string' ? body.body_html : ''
  if (bodyHtml.length > MAX_DRAFT_BODY * 2) return badRequest('The message is too long')

  return answer(await scheduleNewMessage({ userId: user.id, workspaceId, accountId, to, cc, bcc, subject, bodyHtml, sendAt }))
}
