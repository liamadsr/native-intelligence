/**
 * GET /api/account/drive/chat-files: the team chat files the person may read,
 * newest first, for Drive (docs/plans/drive-files.md, phase 2).
 *
 *   ?tab=       all (default) | mine (files they sent) | shared (files others sent)
 *   ?q=         a part of the file's name
 *   ?before=    the last answer's cursor
 *   ?limit=     messages a page, 1..100 (default 50)
 *
 * → { files: DriveChatFile[], before: string | null, memberId }
 *
 * On the session client: team_chat_message's own row security lists a file
 * only to its channel's readers (lib/drive/chat-files.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { CHAT_FILES_PAGE_MAX, listChatFiles } from '@/lib/drive/chat-files'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const params = request.nextUrl.searchParams
  const tab = params.get('tab') ?? 'all'
  if (tab !== 'all' && tab !== 'mine' && tab !== 'shared') return badRequest('tab must be all, mine or shared')
  const rawLimit = params.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_FILES_PAGE_MAX) return badRequest(`limit must be a whole number from 1 to ${CHAT_FILES_PAGE_MAX}`)
  const q = (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  try {
    const page = await listChatFiles(auth.supabase, auth.workspaceId, {
      limit,
      before: params.get('before'),
      ...(q ? { q } : {}),
      ...(tab === 'mine' ? { authorMemberId: auth.member.id } : tab === 'shared' ? { notAuthorMemberId: auth.member.id } : {}),
    })
    return NextResponse.json({ ...page, memberId: auth.member.id })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the files')
  }
}
