import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { parseDraftEdits } from '@/lib/email/draft-edits'
import { sendProviderDraft } from '@/lib/integrations/email'

export const maxDuration = 30

/**
 * Send a draft that sits in the mailbox, as it was reviewed in Mail's thread
 * view (an agent's reply, or any draft on the thread) or on the chat's draft
 * card, or with the user's edits from either editor.
 *
 * The mailbox that holds the thread sends it, which is not always the user's
 * first account: both editors depend on that, since an agent can draft from
 * any connected mailbox.
 *
 * Body: `thread_id` (the provider thread the draft is on), `draft_id` (the
 * draft message's provider id, as the thread view and the email tools name
 * it), and optionally `edits` ({ to, cc, bcc?, subject, body }, see
 * src/lib/email/draft-edits.ts). 404 when the mailbox no longer holds that
 * draft on that thread (sent, edited or discarded elsewhere): nothing is
 * sent, the caller reloads.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const body = (await request.json().catch(() => null)) as
    | { thread_id?: unknown; draft_id?: unknown; edits?: unknown }
    | null
  const threadId = typeof body?.thread_id === 'string' ? body.thread_id : ''
  const draftId = typeof body?.draft_id === 'string' ? body.draft_id : ''
  if (!threadId || !draftId) return badRequest('thread_id and draft_id are required')
  const edits = parseDraftEdits(body?.edits)
  if (edits === 'invalid') return badRequest('Check the recipients, the subject and the message')

  try {
    const result = await sendProviderDraft(user.id, workspaceId, threadId, draftId, edits)
    if (!result.ok) {
      return result.reason === 'no_recipients'
        ? badRequest('This draft has no recipients')
        : notFound('This draft is no longer in your mailbox. It may have been sent, edited or discarded elsewhere.')
    }
    return NextResponse.json({ thread_id: result.threadId, message_id: result.messageId })
  } catch (err) {
    console.error('[email] draft send failed:', err instanceof Error ? err.message : err)
    return serverError('Could not send the email')
  }
}
