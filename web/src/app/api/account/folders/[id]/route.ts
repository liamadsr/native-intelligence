import { NextResponse, type NextRequest } from 'next/server'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { folderName, isUuid } from '@/lib/drive/folders'
import { folderItems, folderRefusal, getFolder } from '@/lib/drive/folder-store'
import { requireFolderMember } from '@/lib/drive/folder-auth'

type Params = { params: Promise<{ id: string }> }

const refuse = (error: { code?: string; message?: string }) => {
  const r = folderRefusal(error)
  return NextResponse.json({ error: r.message }, { status: r.status })
}

/** GET: one folder and the records in it the caller can open. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params
  if (!isUuid(id)) return notFound('No such folder.')
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  try {
    const folder = await getFolder(auth.supabase, auth.workspaceId, id)
    if (!folder) return notFound('No such folder.')
    return NextResponse.json({ folder, items: await folderItems(auth.supabase, auth.workspaceId, id) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the folder')
  }
}

/** PATCH { name?, parent_id? }: rename or move (null: to the top). Nothing else about a folder changes here. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params
  if (!isUuid(id)) return notFound('No such folder.')
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  const body = ((await request.json().catch(() => null)) ?? null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Bad request.')
  const updates: { name?: string; parent_id?: string | null } = {}
  if (body.name !== undefined) {
    const name = folderName(body.name)
    if (!name) return badRequest('A folder needs a name (up to 200 characters).')
    updates.name = name
  }
  if (body.parent_id !== undefined) {
    const parentId = body.parent_id === null || body.parent_id === '' ? null : body.parent_id
    if (parentId !== null && !isUuid(parentId)) return badRequest('Invalid parent_id')
    if (parentId === id) return badRequest('A folder cannot sit inside itself.')
    updates.parent_id = parentId
  }
  if (Object.keys(updates).length === 0) return badRequest('Nothing to change.')
  const { data, error } = await auth.supabase
    .from('drive_folder')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', auth.workspaceId)
    .select('id, name, parent_id, created_by, created_at, updated_at')
    .maybeSingle()
  if (error) return refuse(error)
  if (!data) return notFound('No such folder.')
  return NextResponse.json({ folder: data })
}

/** DELETE: the folder and its subfolders; the records in them are unfiled, never deleted. Its maker, or an owner or admin. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params
  if (!isUuid(id)) return notFound('No such folder.')
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  const { data, error } = await auth.supabase.from('drive_folder').delete().eq('id', id).eq('workspace_id', auth.workspaceId).select('id')
  if (error) return refuse(error)
  if (!data || data.length === 0) {
    // Seen but not deleted: someone else's folder (row security on delete).
    const seen = await getFolder(auth.supabase, auth.workspaceId, id).catch(() => null)
    return seen
      ? NextResponse.json({ error: 'Only its maker, or an owner or admin, deletes a folder.' }, { status: 403 })
      : notFound('No such folder.')
  }
  return NextResponse.json({ ok: true })
}
