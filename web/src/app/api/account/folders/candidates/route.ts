import { NextResponse, type NextRequest } from 'next/server'
import { serverError } from '@/lib/api-errors'
import { unfiledRecords } from '@/lib/drive/folder-store'
import { requireFolderMember } from '@/lib/drive/folder-auth'

/** GET ?q=: docs, tables, spreadsheets and canvases the caller can open that sit in no folder (the Add picker). */
export async function GET(request: NextRequest) {
  const auth = await requireFolderMember()
  if (auth instanceof Response) return auth
  try {
    const q = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 100)
    return NextResponse.json({ records: await unfiledRecords(auth.supabase, auth.workspaceId, q) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load records')
  }
}
