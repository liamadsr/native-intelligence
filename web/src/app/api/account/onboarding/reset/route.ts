import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse } from 'next/server'

/**
 * POST /api/account/onboarding/reset
 *
 * Resets the current user's onboarding state so the wizard replays.
 * ONLY available in development — hard-blocked in production.
 */
export async function POST() {
  // ─── HARD BLOCK: never allow in production ───────────────
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Not available in production' },
      { status: 403 },
    )
  }
  // ──────────────────────────────────────────────────────────

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('member')
    .update({
      onboarding_completed_at: null,
      // Everything, getting started included: the replay's wizard stamps a new
      // onboarding_completed_at, and getting started counts only the captures
      // made after it (src/lib/onboarding/getting-started.ts).
      onboarding_progress: {},
    })
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
