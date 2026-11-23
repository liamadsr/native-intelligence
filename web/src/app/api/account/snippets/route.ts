import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { createSnippet, listSnippets } from '@/lib/snippets/store'

/**
 * /api/account/snippets (migration 699, docs/plans/snippets.md).
 *
 *   GET   → { snippets, me: { name } }: the caller's own and the workspace's
 *           shared ones, and the caller's name (the `{{my_name}}` fill-ins).
 *   POST  { name, shortcut, body, visibility?: 'personal' | 'workspace' } → { snippet }
 *
 * Runs on the caller's own client: row-level security holds, and the store
 * fences the same way besides.
 */

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const r = await listSnippets(supabase, { workspaceId, userId: user.id })
  if (!r.ok) return apiError(r.error, { status: r.status })
  const { data: member } = await supabase.from('member').select('display_name').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle()
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const name = [member?.display_name, meta.full_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null
  return NextResponse.json({ snippets: r.value, me: { name } }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the snippet as JSON.')
  const r = await createSnippet(supabase, { workspaceId, userId: user.id }, body)
  if (!r.ok) return apiError(r.error, { status: r.status })
  return NextResponse.json({ snippet: r.value }, { status: 201 })
}
