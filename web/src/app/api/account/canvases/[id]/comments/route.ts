import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { addComment, CommentsUnavailable, listComments, type NewComment } from '@/lib/canvas/comments'
import { canvasRefusal } from '@/lib/canvas/responses'
import { afterRecordComment, fenceRecordCommentMentions } from '@/lib/record-comments/mentions'

type Ctx = { params: Promise<{ id: string }> }

/** The table arrives with migration 682; until then the editor shows comments as off. */
const unavailable = () => apiError('Comments are not set up on this server yet.', { status: 503, code: 'COMMENTS_UNAVAILABLE' })

/** GET: every comment on the canvas, oldest first, with `me` (the caller's member id). */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  const { id } = await params
  try {
    const comments = await listComments(supabase, workspaceId, id)
    if (!comments) return notFound('Canvas not found')
    return NextResponse.json({ comments, me: member.id })
  } catch (e) {
    if (e instanceof CommentsUnavailable) return unavailable()
    return serverError(e instanceof Error ? e.message : 'Could not load the comments')
  }
}

/** POST { body, parent_id?, item_id?, x?, y?, mentions?, records? }: a new thread, or a reply. The teammates it names who can open the canvas are told. */
export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as (NewComment & { records?: unknown }) | null
  if (!body || typeof body !== 'object') return badRequest('A comment needs some words.')
  try {
    // What it @-mentions (teammates, records), fenced for the author before it is stored.
    const words = typeof body.body === 'string' ? body.body.trim() : ''
    const mentions = await fenceRecordCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: body.mentions, records: body.records }, words)
    // Never from the request: only the assistant's own tool writes a comment as the assistant's.
    const result = await addComment(supabase, workspaceId, id, member.id, { body: body.body, parent_id: body.parent_id, item_id: body.item_id, x: body.x, y: body.y, mentions: mentions.memberIds })
    if (!result.ok) return canvasRefusal(result)
    void afterRecordComment(supabase, { kind: 'canvas', recordId: id, workspaceId, userId: user.id, memberId: member.id, commentId: result.value.id, parentId: result.value.parent_id, body: words, mentions })
    return NextResponse.json({ comment: result.value }, { status: 201 })
  } catch (e) {
    if (e instanceof CommentsUnavailable) return unavailable()
    return serverError(e instanceof Error ? e.message : 'Could not save the comment')
  }
}
