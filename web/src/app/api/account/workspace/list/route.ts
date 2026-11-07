import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { NextResponse } from 'next/server'

export async function GET() {
  // Cookie session OR Bearer (desktop / device token). The hardware device
  // calls this to populate its on-screen workspace picker, so it must accept
  // a device-token Bearer, not just a browser cookie.
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  // Read via the service client scoped explicitly to this user's id. A
  // device-token request has no Supabase session/JWT, so the member-table RLS
  // (is_workspace_member, which needs auth.uid()) would return zero rows for
  // the anon client. The id we filter on comes from the validated token, so
  // this stays correctly user-scoped. (Same pattern as the device-tokens and
  // MCP routes.)
  const service = getServiceClient()
  const { data: memberships, error } = await service
    .from('member')
    // `settings` rides along so the client workspace cache can resolve each
    // workspace's persona edition (settings.edition) without a second round
    // trip — the nav rail, hotkeys, and home view are all gated on it, and they
    // render before any per-workspace settings fetch could land.
    .select('role, workspace:workspace_id(id, name, slug, logo_url, plan, description, settings)')
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  type WorkspaceRow = Record<string, unknown> & { id?: string; role: string }
  const mapped: WorkspaceRow[] =
    memberships?.map((m) => {
      const ws = (m.workspace as unknown as Record<string, unknown> | null) ?? {}
      return { ...ws, role: m.role as string }
    }) ?? []

  // Member counts for each of the user's workspaces, in one grouped query. The
  // workspaces veil's cards show these; the device picker ignores the extra
  // field. Failure here degrades gracefully to a count of 1 (at least the user)
  // rather than failing the whole list.
  const workspaceIds = mapped
    .map((w) => w.id)
    .filter((id): id is string => typeof id === 'string')

  const memberCounts: Record<string, number> = {}
  if (workspaceIds.length > 0) {
    const { data: counts } = await service
      .from('member')
      .select('workspace_id')
      .in('workspace_id', workspaceIds)
    for (const row of counts ?? []) {
      const wid = (row as { workspace_id: string }).workspace_id
      memberCounts[wid] = (memberCounts[wid] ?? 0) + 1
    }
  }

  const workspaces = mapped.map((w) => ({
    ...w,
    member_count:
      typeof w.id === 'string' ? memberCounts[w.id] ?? 1 : 1,
  }))

  return NextResponse.json({ workspaces })
}
