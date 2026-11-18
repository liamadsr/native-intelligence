import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { getServiceClient } from '@/lib/supabase/service'
import { DemoResetRefused, resetDemoWorkspace } from '@/lib/demo/reset'

/**
 * POST { workspace_id }: an admin puts one demo workspace back now (the
 * nightly job's reset, on demand: src/lib/demo/reset.ts). Any workspace that
 * is not flagged in `demo_workspace` is refused there, whoever asks.
 */
export const maxDuration = 300

export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let workspaceId: unknown
  try {
    workspaceId = ((await request.json()) as { workspace_id?: unknown })?.workspace_id
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 })
  }

  // This deployment's own database, as the nightly job and the reset's own
  // helpers use: never the one the admin panel's environment switch points at.
  const service = getServiceClient()
  try {
    const report = await resetDemoWorkspace(service, workspaceId)
    if (report.skipped === 'live_call') {
      return NextResponse.json({ error: 'A call is going on in this workspace. Reset it once the call is over.', code: 'LIVE_CALL', report }, { status: 409 })
    }
    return NextResponse.json({ ok: report.seeded, report })
  } catch (err) {
    if (err instanceof DemoResetRefused) {
      return NextResponse.json({ error: err.message, code: 'NOT_A_DEMO_WORKSPACE' }, { status: 403 })
    }
    console.error('[admin/demo-workspace/reset] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reset failed' }, { status: 500 })
  }
}
