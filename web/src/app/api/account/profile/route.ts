import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { badRequest, serverError } from '@/lib/api-errors'
import { AGENT_LOOK_PROFILE_FIELD, parseAgentLook } from '@/lib/bots/agent-look'
import { ASSISTANT_NAME_PROFILE_FIELD, checkAssistantName, sanitizeAssistantName } from '@/lib/voice/assistant-name'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Settings kept on the ACCOUNT so they follow the user to every device and
 * desktop window, in auth `user_metadata` beside `full_name`, read by the
 * profile GET the app already makes at boot:
 *
 *  • the workspace menu's "Show all workspaces" switch (lib/workspace-span):
 *    one boolean. `null` from the GET means the account has never saved one
 *    (the client then carries its device's answer up once);
 *  • the agent's look and name (lib/account-setting.ts, read by
 *    lib/bots/agent-look-store and lib/voice/assistant-name-store): checked
 *    on the way in and on the way out against the same rules the device uses.
 *    `null` from the GET means the account has none (the default stands in).
 */
const SHOW_ALL_WORKSPACES_KEY = 'show_all_workspaces'

function showAllWorkspacesOf(metadata: Record<string, unknown> | undefined): boolean | null {
  const value = metadata?.[SHOW_ALL_WORKSPACES_KEY]
  return typeof value === 'boolean' ? value : null
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || null,
    avatar_url: user.user_metadata?.avatar_url || null,
    created_at: user.created_at,
    show_all_workspaces: showAllWorkspacesOf(user.user_metadata),
    [AGENT_LOOK_PROFILE_FIELD]: parseAgentLook(user.user_metadata?.[AGENT_LOOK_PROFILE_FIELD]),
    [ASSISTANT_NAME_PROFILE_FIELD]: sanitizeAssistantName(user.user_metadata?.[ASSISTANT_NAME_PROFILE_FIELD]),
  })
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { full_name, show_all_workspaces } = body as { full_name?: string; show_all_workspaces?: unknown }
  const rawLook = (body as Record<string, unknown>)[AGENT_LOOK_PROFILE_FIELD]
  const rawName = (body as Record<string, unknown>)[ASSISTANT_NAME_PROFILE_FIELD]

  if (show_all_workspaces !== undefined && typeof show_all_workspaces !== 'boolean') {
    return badRequest('show_all_workspaces must be a boolean')
  }
  const look = rawLook === undefined ? undefined : parseAgentLook(rawLook)
  if (look === null) return badRequest(`${AGENT_LOOK_PROFILE_FIELD} is not a look`)
  let assistantName: string | undefined
  if (rawName !== undefined) {
    if (typeof rawName !== 'string') return badRequest(`${ASSISTANT_NAME_PROFILE_FIELD} must be a string`)
    const checked = checkAssistantName(rawName)
    if (!checked.ok) return badRequest(checked.error)
    assistantName = checked.name
  }

  if (full_name !== undefined) {
    // Update Supabase auth user metadata
    const { error: authError } = await supabase.auth.updateUser({
      data: { full_name },
    })
    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 500 })
    }

    // Also update display_name on all member records for this user
    const service = getServiceClient()
    await service
      .from('member')
      .update({ display_name: full_name })
      .eq('user_id', user.id)
  }

  const settings: Record<string, unknown> = {}
  if (show_all_workspaces !== undefined) settings[SHOW_ALL_WORKSPACES_KEY] = show_all_workspaces
  if (look) settings[AGENT_LOOK_PROFILE_FIELD] = look
  if (assistantName !== undefined) settings[ASSISTANT_NAME_PROFILE_FIELD] = assistantName

  if (Object.keys(settings).length > 0) {
    // Through the admin API, keyed on the user `getUser()` just verified,
    // rather than `auth.updateUser`: that one needs the COOKIE session, which
    // goes stale in the desktop app's extra windows (their requests
    // authenticate by Bearer — see lib/supabase/server), and a setting that
    // silently failed to save there would undo itself on the next boot.
    // GoTrue merges `user_metadata` key by key, so `full_name`, `avatar_url`
    // and the rest are untouched.
    const { error } = await getServiceClient().auth.admin.updateUserById(user.id, {
      user_metadata: settings,
    })
    if (error) return serverError('Could not save the setting', error.message)
  }

  return NextResponse.json({ success: true })
}
