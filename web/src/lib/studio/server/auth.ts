// Who may use the Studio: a member of the workspace who is not a guest, in a workspace with the Studio switched on
// (the `studio` feature, as search honours it). The routes resolve the person through the app's usual helpers
// (session cookie, or a bearer token for the desktop app), then work through the service role, fenced to that
// workspace (studio tables have no row-level policies).
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { deviceTokenWorkspace, requireUser, requireWorkspaceMember } from '@/lib/api-auth'
import { featureDisabled, forbidden, notMember, serverError } from '@/lib/api-errors'
import { isFeatureEnabled, resolveWorkspaceEdition } from '@/lib/editions'
import type { StudioContext } from './context'
import { isUuid } from './context'

/** What a workspace with the Studio switched off is answered (403 FEATURE_DISABLED, as the app's other switched-off features). */
const STUDIO_OFF = 'The Studio is not enabled for this workspace.'

/** How long a workspace's switch is kept: every Studio request asks, and the editor polls every two seconds. */
export const STUDIO_SWITCH_TTL_MS = 30_000

/** Each workspace's switch as last read, kept on globalThis (the route bundles are built apart). */
const SWITCHES = Symbol.for('ni.studio.feature-switches')
const shared = globalThis as { [SWITCHES]?: Map<string, { on: boolean; at: number }> }
const switches: Map<string, { on: boolean; at: number }> = (shared[SWITCHES] ??= new Map())

/** Whether the workspace has the Studio switched on (its edition and overrides), read at most every 30 s per workspace. */
export async function studioSwitchedOn(supabase: SupabaseClient, workspaceId: string, now = Date.now()): Promise<boolean> {
  const kept = switches.get(workspaceId)
  if (kept && now - kept.at < STUDIO_SWITCH_TTL_MS) return kept.on
  const on = isFeatureEnabled(await resolveWorkspaceEdition(supabase, workspaceId), 'studio')
  if (switches.size > 10_000) switches.clear()
  switches.set(workspaceId, { on, at: now })
  return on
}

/** Forget the switches read (tests). */
export function forgetStudioSwitches(): void {
  switches.clear()
}

/** Guests of a workspace see what is shared with them, not its Studio. */
const GUEST_REFUSED = "Guests can't use the Studio in this workspace."

/** The person, their current workspace and a service client, or the answer that refuses them (401/400/403). */
export async function requireStudio(): Promise<StudioContext | Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role === 'guest') return forbidden(GUEST_REFUSED)
  const supabase = getServiceClient()
  if (!(await studioSwitchedOn(supabase, auth.workspaceId))) return featureDisabled(STUDIO_OFF)
  return { supabase, workspaceId: auth.workspaceId, userId: auth.user.id }
}

/**
 * The person as a member of the workspace a file link names (a <video> or <img> request carries the session
 * cookie but no workspace header), or the answer that refuses them. A device token pinned to a workspace reaches
 * that workspace's files only, whatever other workspaces its person belongs to (as requireWorkspace holds it there).
 */
export async function requireStudioMemberOf(workspaceId: string): Promise<StudioContext | Response> {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  if (!isUuid(workspaceId)) return notMember()
  const pinned = await deviceTokenWorkspace()
  if (pinned && pinned !== workspaceId) return notMember()
  const supabase = getServiceClient()
  const { data, error } = await supabase.from('member').select('role').eq('user_id', auth.user.id).eq('workspace_id', workspaceId).maybeSingle()
  if (error) {
    console.error('[studio] file membership check failed:', error.message)
    return serverError()
  }
  if (!data) return notMember()
  if ((data as { role?: string | null }).role === 'guest') return forbidden(GUEST_REFUSED)
  if (!(await studioSwitchedOn(supabase, workspaceId))) return featureDisabled(STUDIO_OFF)
  return { supabase, workspaceId, userId: auth.user.id }
}
