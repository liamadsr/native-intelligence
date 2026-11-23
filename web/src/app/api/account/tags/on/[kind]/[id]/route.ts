/**
 * The tags on one record, for every taggable kind (lib/tags/kinds.ts):
 *   GET     → { tags: [{ id, name, color, personal }] }
 *   POST    { label_id } or { label_ids }   adds (idempotent)
 *   PUT     { label_ids }                   replaces the caller's visible set
 *   DELETE  ?label_id=…                     removes one
 * All on the caller's client: the record's and the tag's row-level security
 * decide (migration 700). The older per-kind label routes keep working.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { isTagKind, type TagKind } from '@/lib/tags/kinds'
import { addRecordTags, listRecordTags, removeRecordTags, setRecordTags, type TagResult } from '@/lib/tags/record-tags'

type Params = { params: Promise<{ kind: string; id: string }> }

function fail(r: Extract<TagResult<unknown>, { ok: false }>) {
  return apiError(r.error, { status: r.status })
}

async function target(params: Params['params']): Promise<{ kind: TagKind; id: string } | Response> {
  const { kind, id } = await params
  if (!isTagKind(kind)) return badRequest('This kind of record does not take tags')
  return { kind, id }
}

function labelIdsOf(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { label_id?: unknown; label_ids?: unknown }
  if (typeof b.label_id === 'string') return [b.label_id]
  if (Array.isArray(b.label_ids) && b.label_ids.every((x) => typeof x === 'string') && b.label_ids.length <= 100) {
    return b.label_ids as string[]
  }
  return null
}

export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const t = await target(params)
  if (t instanceof Response) return t
  const r = await listRecordTags(auth.supabase, t.kind, t.id)
  return r.ok ? NextResponse.json({ tags: r.value }) : fail(r)
}

export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const t = await target(params)
  if (t instanceof Response) return t
  const ids = labelIdsOf(await request.json().catch(() => null))
  if (!ids || ids.length === 0) return badRequest('label_id is required')
  const r = await addRecordTags(auth.supabase, t.kind, t.id, ids)
  return r.ok ? NextResponse.json({ added: r.value }) : fail(r)
}

export async function PUT(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const t = await target(params)
  if (t instanceof Response) return t
  const ids = labelIdsOf(await request.json().catch(() => null))
  if (!ids) return badRequest('label_ids is required')
  const r = await setRecordTags(auth.supabase, t.kind, t.id, ids)
  return r.ok ? NextResponse.json({ tags: r.value }) : fail(r)
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const t = await target(params)
  if (t instanceof Response) return t
  const labelId = request.nextUrl.searchParams.get('label_id')
  if (!labelId) return badRequest('label_id is required')
  const r = await removeRecordTags(auth.supabase, t.kind, t.id, [labelId])
  return r.ok ? NextResponse.json({ removed: r.value }) : fail(r)
}
