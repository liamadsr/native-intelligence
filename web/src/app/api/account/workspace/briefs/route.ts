import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { NextResponse } from 'next/server'

/**
 * Workspace-level knowledge briefs for every workspace the signed-in user
 * belongs to, keyed by workspace_id. Powers the one-line brief shown on each
 * card of the workspaces veil.
 *
 * Read via the service client scoped to the user's memberships (same pattern as
 * the sibling `list` route): we resolve the user's workspace ids from `member`,
 * then fetch the one workspace-scoped brief per workspace. Only workspace-scope
 * briefs (scope_type='workspace', scope_id NULL) are returned — project/package
 * briefs are out of scope here.
 */
export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  const service = getServiceClient()

  const { data: memberships, error: mErr } = await service
    .from('member')
    .select('workspace_id')
    .eq('user_id', user.id)
  if (mErr) {
    return NextResponse.json({ error: mErr.message }, { status: 500 })
  }

  const workspaceIds = [
    ...new Set((memberships ?? []).map((m) => m.workspace_id as string)),
  ]
  if (workspaceIds.length === 0) {
    return NextResponse.json({ briefs: {} })
  }

  const { data: rows, error: bErr } = await service
    .from('knowledge_brief')
    .select('workspace_id, content, claim_count, generated_at')
    .eq('scope_type', 'workspace')
    .is('scope_id', null)
    .in('workspace_id', workspaceIds)
  if (bErr) {
    return NextResponse.json({ error: bErr.message }, { status: 500 })
  }

  const briefs: Record<
    string,
    { content: string; claim_count: number; generated_at: string }
  > = {}
  for (const r of rows ?? []) {
    briefs[r.workspace_id as string] = {
      content: r.content as string,
      claim_count: (r.claim_count as number) ?? 0,
      generated_at: r.generated_at as string,
    }
  }

  return NextResponse.json({ briefs })
}
