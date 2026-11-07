import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdOrResponse } from '@/lib/workspace'
import { trackServerEvent } from '@/lib/posthog'
import { resolveWorkspaceEditionId } from '@/lib/editions'
import { NextResponse, type NextRequest } from 'next/server'

/** GET /api/account/onboarding — fetch onboarding status for current member */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceIdOrResponse()
  if (workspaceId instanceof Response) return workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const { data: member } = await supabase
    .from('member')
    .select(
      'id, display_name, onboarding_completed_at, onboarding_progress',
    )
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!member) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  // Check if any OAuth accounts are connected
  const { data: oauthAccounts } = await supabase
    .from('connected_account')
    .select('id, provider')
    .eq('user_id', user.id)

  // Which persona this workspace was attributed to at signup. The wizard reads
  // it to pre-select the matching role chips. Attribution is stamped by
  // /api/analytics/auth-session, which a new signup's trial wall pings on mount
  // before onboarding even starts (and the onboarding page pings again) — so by
  // the time this runs the stamp is normally already there. When it isn't
  // (attribution failed, a returning user, a workspace created some other way)
  // this resolves to `full`, whose
  // `onboardingDefaultRoles` is empty: no preselection, today's exact behavior.
  const edition = await resolveWorkspaceEditionId(supabase, workspaceId)

  return NextResponse.json({
    member: {
      id: member.id,
      displayName: member.display_name,
      onboardingCompletedAt: member.onboarding_completed_at,
      onboardingProgress: member.onboarding_progress ?? {},
    },
    connectedAccounts: oauthAccounts ?? [],
    workspace: { id: workspaceId, edition },
    // The analytics identity (PostHog distinct_id), so a member who never
    // reaches the dashboard is still findable by email.
    userId: user.id,
    userEmail: user.email,
    userName:
      user.user_metadata?.full_name ??
      user.user_metadata?.name ??
      null,
    avatarUrl: user.user_metadata?.avatar_url ?? null,
  })
}

/** PATCH /api/account/onboarding — update onboarding progress */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceIdOrResponse()
  if (workspaceId instanceof Response) return workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const body = await request.json()
  const updates: Record<string, unknown> = {}

  // Update step progress (merge with existing). Reject arrays — `typeof [] ===
  // 'object'` would otherwise pass and spread numeric indices into the JSONB.
  if (
    body.progress &&
    typeof body.progress === 'object' &&
    !Array.isArray(body.progress)
  ) {
    // Atomic deep-merge in a single SQL statement, NOT a JS read-modify-write.
    // Several onboarding writers can fire near-simultaneously (the wizard's
    // step flags and answers, the research kickoff's state); a read-then-write
    // would let those requests race — each reads the same baseline and the
    // last write wins, silently dropping the others. The RPC
    // does the whole merge atomically: shallow-merge top-level keys, deep-merge
    // the nested `tutorial` object so individual step flags survive.
    const { error: mergeError } = await supabase.rpc('merge_onboarding_progress', {
      p_workspace_id: workspaceId,
      p_patch: body.progress as Record<string, unknown>,
      p_user_id: user.id,
    })
    if (mergeError) {
      return NextResponse.json({ error: mergeError.message }, { status: 500 })
    }
  }

  // Mark onboarding as complete
  if (body.completed) {
    updates.onboarding_completed_at = new Date().toISOString()
  }

  // Update workspace name if provided
  if (body.workspaceName && typeof body.workspaceName === 'string') {
    const name = body.workspaceName.trim()
    if (name) {
      await supabase
        .from('workspace')
        .update({ name })
        .eq('id', workspaceId)
    }
  }

  if (Object.keys(updates).length > 0) {
    // `.select()` so a zero-row match is DETECTABLE: a bare .update().eq() that
    // matches nothing "succeeds" silently, and the wizard would then navigate
    // to a dashboard whose layout still sees an unstamped member — bouncing the
    // user straight back here. Surfacing it as a 500 instead engages the
    // wizard's retry UI, and keeps the completion event below honest.
    const { data: stamped, error } = await supabase
      .from('member')
      .update(updates)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .select('id')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!stamped || stamped.length === 0) {
      return NextResponse.json(
        { error: 'Member not found for workspace' },
        { status: 500 }
      )
    }
  }

  if (body.completed) {
    trackServerEvent('onboarding_completed', {
      userId: user.id,
      workspaceId,
      email: user.email,
    })
  }

  return NextResponse.json({ ok: true })
}
