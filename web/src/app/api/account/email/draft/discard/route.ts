import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { discardProviderDraft } from '@/lib/integrations/email'

export const maxDuration = 30

/**
 * Discard a draft that sits in the mailbox, from Mail's thread view (an
 * agent's reply, or any draft on the thread): it is deleted at the provider.
 *
 * Body: `thread_id` (the provider thread the draft is on) and `draft_id` (the
 * draft message's provider id, as the thread view names it). 404 when the
 * mailbox no longer holds that draft on that thread (sent, edited or discarded
 * elsewhere): nothing is deleted, the caller reloads. `thread_remains` is
 * false when the draft was all there was of the thread, which then leaves Mail.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const body = (await request.json().catch(() => null)) as { thread_id?: unknown; draft_id?: unknown } | null
  const threadId = typeof body?.thread_id === 'string' ? body.thread_id : ''
  const draftId = typeof body?.draft_id === 'string' ? body.draft_id : ''
  if (!threadId || !draftId) return badRequest('thread_id and draft_id are required')

  try {
    const result = await discardProviderDraft(user.id, workspaceId, threadId, draftId)
    if (!result.ok) {
      return notFound('This draft is no longer in your mailbox. It may have been sent, edited or discarded elsewhere.')
    }
    return NextResponse.json({ thread_id: threadId, thread_remains: result.threadRemains })
  } catch (err) {
    console.error('[email] draft discard failed:', err instanceof Error ? err.message : err)
    return serverError('Could not discard the draft')
  }
}
