import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { runContactDeduplication } from '@/lib/crm/contact-dedup'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 120

/**
 * Run the automatic contact dedup pass for the current workspace on demand.
 * Pass `{ "dry_run": true }` to preview how many clusters would merge without
 * changing anything. The same engine runs nightly via /api/cron/email-management.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Only workspace members may trigger a dedup pass.
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!member) return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const dryRun = body?.dry_run === true

  const result = await runContactDeduplication(workspaceId, { dryRun })

  return NextResponse.json({ ok: true, dry_run: dryRun, ...result })
}
