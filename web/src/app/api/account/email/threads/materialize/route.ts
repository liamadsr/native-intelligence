import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { materializeSearchHit } from '@/lib/email/materialize-thread'

export const maxDuration = 30

/**
 * POST /api/account/email/threads/materialize  { threadId, accountId }
 *   → { id }   the thread's index row in this workspace
 *
 * A search result the index doesn't have is indexed before Mail acts on it
 * (star, archive, trash, labels), so the thread routes find their row. Ids,
 * flags and addresses only, through the sync's writer
 * (src/lib/email/materialize-thread.ts); only a mailbox this workspace may read.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let threadId: unknown
  let accountId: unknown
  try {
    ;({ threadId, accountId } = (await request.json()) as { threadId?: unknown; accountId?: unknown })
  } catch {
    return badRequest('Expected { threadId, accountId }')
  }
  if (typeof threadId !== 'string' || !threadId || threadId.length > 256 || typeof accountId !== 'string' || !accountId || accountId.length > 64) {
    return badRequest('Expected { threadId, accountId }')
  }

  const result = await materializeSearchHit({ userId: user.id, workspaceId, accountId, threadId })
  if (result.ok) return NextResponse.json({ id: result.id })
  if (result.reason === 'not_readable' || result.reason === 'gone') return notFound('Thread not found')
  return serverError(result.reason === 'no_mailbox' ? 'Mailbox not connected' : 'Thread could not be read')
}
