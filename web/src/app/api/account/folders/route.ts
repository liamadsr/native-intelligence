import { NextResponse, type NextRequest } from 'next/server'
import { badRequest, serverError } from '@/lib/api-errors'
import { folderName, isUuid } from '@/lib/drive/folders'
import { folderRefusal, listFolders } from '@/lib/drive/folder-store'
import { requireFolderMember } from '@/lib/drive/folder-auth'

/** GET: the workspace's folders, every one (the page builds the tree). */
export async function GET() {
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json({ folders: await listFolders(auth.supabase, auth.workspaceId) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load folders')
  }
}

/** POST { name, parent_id? }: a new folder, made as the caller (migration 690's guard holds it). */
export async function POST(request: NextRequest) {
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  const body = ((await request.json().catch(() => null)) ?? null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Bad request.')
  const name = folderName(body.name)
  if (!name) return badRequest('A folder needs a name (up to 200 characters).')
  const parentId = body.parent_id == null || body.parent_id === '' ? null : body.parent_id
  if (parentId !== null && !isUuid(parentId)) return badRequest('Invalid parent_id')
  const { data, error } = await auth.supabase
    .from('drive_folder')
    .insert({ workspace_id: auth.workspaceId, name, parent_id: parentId, created_by: auth.member.id })
    .select('id, name, parent_id, created_by, created_at, updated_at')
    .single()
  if (error) {
    const r = folderRefusal(error)
    return NextResponse.json({ error: r.message }, { status: r.status })
  }
  return NextResponse.json({ folder: data }, { status: 201 })
}
