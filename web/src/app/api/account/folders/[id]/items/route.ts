import { NextResponse, type NextRequest } from 'next/server'
import { badRequest, notFound } from '@/lib/api-errors'
import { isFolderItemType, isUuid } from '@/lib/drive/folders'
import { folderRefusal } from '@/lib/drive/folder-store'
import { requireFolderMember } from '@/lib/drive/folder-auth'

type Params = { params: Promise<{ id: string }> }

async function readItem(request: NextRequest) {
  const body = ((await request.json().catch(() => null)) ?? null) as Record<string, unknown> | null
  if (!body || !isFolderItemType(body.type) || !isUuid(body.id)) return null
  return { type: body.type, id: body.id }
}

/**
 * POST { type, id }: put a record in this folder (moved here if it sat in
 * another). The database files only a record the caller can open, in this
 * workspace, as themself (migration 690).
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { id: folderId } = await params
  if (!isUuid(folderId)) return notFound('No such folder.')
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  const item = await readItem(request)
  if (!item) return badRequest('Send { type, id }: a doc, table, spreadsheet, canvas or file.')
  const { error } = await auth.supabase
    .from('drive_folder_item')
    .upsert(
      { item_type: item.type, item_id: item.id, folder_id: folderId, workspace_id: auth.workspaceId },
      { onConflict: 'item_type,item_id' },
    )
  if (error) {
    const r = folderRefusal(error)
    return NextResponse.json({ error: r.message }, { status: r.status })
  }
  return NextResponse.json({ ok: true, item: { ...item, folder_id: folderId } })
}

/** DELETE { type, id }: take a record out of this folder (the record stays). */
export async function DELETE(request: NextRequest, { params }: Params) {
  const { id: folderId } = await params
  if (!isUuid(folderId)) return notFound('No such folder.')
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  const item = await readItem(request)
  if (!item) return badRequest('Send { type, id }: a doc, table, spreadsheet, canvas or file.')
  const { error } = await auth.supabase
    .from('drive_folder_item')
    .delete()
    .eq('folder_id', folderId)
    .eq('item_type', item.type)
    .eq('item_id', item.id)
  if (error) {
    const r = folderRefusal(error)
    return NextResponse.json({ error: r.message }, { status: r.status })
  }
  return NextResponse.json({ ok: true })
}
