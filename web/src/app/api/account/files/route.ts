/**
 * GET /api/account/files: the Files page (Liam, 11-11: "a new page that shows
 * all available files that were uploaded anywhere in the app, uploaded to
 * captures or action items or projects"): the workspace's attachments the
 * person may see, newest first, a page at a time.
 *
 *   ?limit=50     1..100
 *   ?offset=0     where the page starts (the last answer's next_offset)
 *   ?category=    image | document (absent: all)
 *   ?q=           a part of the file's name
 *
 * → { files: WorkspaceFile[], next_offset: number | null }
 *
 * On the session client, fenced twice (lib/attachments/workspace-files.ts):
 * the attachments RLS, then each file's record labelled through the person's
 * own RLS, a file on a record they can't read dropped. Separate from GET
 * /api/account/attachments, which lists one record's files and is unchanged.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { listWorkspaceFiles } from '@/lib/attachments/workspace-files'
import { parseFilesQuery } from '@/lib/attachments/workspace-files-model'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const parsed = parseFilesQuery(request.nextUrl.searchParams)
  if (!parsed.ok) return badRequest(parsed.error)
  try {
    return NextResponse.json(await listWorkspaceFiles(auth.supabase, auth.workspaceId, parsed.query))
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the files')
  }
}
