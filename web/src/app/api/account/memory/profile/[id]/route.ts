import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { acceptProfileFact, deleteProfileFact, editProfileFact, type ProfileFactResult } from '@/lib/memory/profile-facts'

/**
 * One fact about you (migration 328): edit it, accept a proposal, or delete it
 * (dismiss a proposal, the chip's Undo). By id on the person's own session;
 * only their own facts exist for them (RLS), and the writer fences by user.
 */

type Params = { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An id that can't be a fact's is simply not one of theirs: 404, before Postgres sees it. */
const NO_SUCH_FACT = 'No such fact about you.'

function answer(result: ProfileFactResult) {
  if (result.ok) return NextResponse.json({ fact: result.fact })
  if (result.code === 'NOT_FOUND') return notFound(result.error)
  if (result.code === 'SAVE_FAILED') return serverError(result.error)
  return apiError(result.error, { status: result.code === 'INPUT_INVALID' ? 400 : 409, code: result.code })
}

/** PATCH { text?, importance? } edits a fact; { status: 'active' } accepts a proposal. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound(NO_SUCH_FACT)

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return badRequest("Send JSON: { text } or { importance } to edit, or { status: 'active' } to accept.")

  if (body.status !== undefined) {
    if (body.status !== 'active') return badRequest("status can only be 'active' (accept). To dismiss a proposal, DELETE it.")
    return answer(await acceptProfileFact(auth.supabase, { userId: auth.user.id, id }))
  }
  if (body.text !== undefined && typeof body.text !== 'string') return badRequest('text must be the fact, as a string.')
  if (body.importance !== undefined && typeof body.importance !== 'number') return badRequest('importance must be a number from 1 to 5.')
  if (body.text === undefined && body.importance === undefined) {
    return badRequest("Send { text } or { importance } to edit, or { status: 'active' } to accept.")
  }
  return answer(
    await editProfileFact(auth.supabase, {
      userId: auth.user.id,
      id,
      text: body.text as string | undefined,
      importance: body.importance as number | undefined,
    }),
  )
}

/** DELETE: the fact is gone (deleted, dismissed, undone). */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound(NO_SUCH_FACT)

  const result = await deleteProfileFact(auth.supabase, { userId: auth.user.id, id })
  if (!result.ok) return result.code === 'NOT_FOUND' ? notFound(result.error) : serverError(result.error)
  return NextResponse.json({ ok: true })
}
