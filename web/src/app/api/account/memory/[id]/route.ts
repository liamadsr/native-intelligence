import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { memoryTextProblem, normalizeMemoryText, type MemoryLine } from '@/lib/packs/memory-types'
import { MEMORY_LINE_COLUMNS } from '@/lib/packs/memory-write'

/**
 * One line of what Native Intelligence has learned (migration 317): edit it, accept it, or
 * delete it (dismiss a proposal, the chip's Undo).
 *
 * By id on the person's own session, not the current workspace: the chat's
 * chip may sit in a conversation of another workspace. RLS and the guard
 * decide: your own personal lines; a workspace line only as an owner or
 * admin, except that a member may withdraw their own proposal. A line the
 * caller may not touch is indistinguishable from one that doesn't exist.
 */

const NOT_YOURS =
  'No such line, or it is not yours to change: workspace lines are changed by an owner or admin, and a member can only withdraw their own proposal.'

type Params = { params: Promise<{ id: string }> }

/** PATCH { text } edits a line; { status: 'active' } accepts a proposal. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return badRequest("Send JSON: { text } to edit, or { status: 'active' } to accept.")

  let patch: Record<string, unknown>
  let q
  if (body.status !== undefined) {
    if (body.status !== 'active') return badRequest("status can only be 'active' (accept). To dismiss a proposal, DELETE it.")
    patch = { status: 'active' }
    q = auth.supabase.from('area_memory').update(patch).eq('id', id).eq('status', 'proposed')
  } else if (typeof body.text === 'string') {
    const text = normalizeMemoryText(body.text)
    const problem = memoryTextProblem(text)
    if (problem) return badRequest(problem)
    patch = { text, source: 'edited' }
    q = auth.supabase.from('area_memory').update(patch).eq('id', id)
  } else {
    return badRequest("Send { text } to edit, or { status: 'active' } to accept.")
  }

  const { data, error } = await q.select(MEMORY_LINE_COLUMNS)
  if (error) return serverError(error.message)
  const line = ((data ?? []) as MemoryLine[])[0]
  if (!line) return notFound(NOT_YOURS)
  return NextResponse.json({ line })
}

/** DELETE: the line is gone (deleted, dismissed, undone). */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params

  const { data, error } = await auth.supabase.from('area_memory').delete().eq('id', id).select('id')
  if (error) return serverError(error.message)
  if (!data || data.length === 0) return notFound(NOT_YOURS)
  return NextResponse.json({ ok: true })
}
