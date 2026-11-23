/**
 * Drive's Recent tab (migration 696; lib/drive/opens.ts).
 *
 *   GET            → { files: RecentFile[] } the files the person opened last,
 *                    newest first, each still one they may read
 *   POST { key }   record that they opened one: `upload:<id>` or
 *                    `team_chat:<object path>`; never a mail attachment
 *
 * On the session client: each person's own rows only.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { openKeyOf, recentFiles, recordOpen } from '@/lib/drive/opens'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json({ files: await recentFiles(auth.supabase, { workspaceId: auth.workspaceId, userId: auth.user.id }) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the recent files')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { key?: unknown } | null
  const key = openKeyOf(body?.key)
  if (!key) return badRequest('key must be upload:<id> or team_chat:<path>')
  try {
    await recordOpen(auth.supabase, { workspaceId: auth.workspaceId, userId: auth.user.id }, key)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not record the open')
  }
}
