import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleCreateLink, handleListLinks } from '@/lib/booking-links/account'
import { appOrigin } from '@/lib/twilio/config'

/**
 * /api/account/booking-links — Settings' booking links (availability phase
 * 4a) in the current workspace.
 *
 *   GET → { links: [{ id, url, profile, slug, purpose, title, …, hosts, active, can_edit }], handles: { me, workspace }, can_manage, user_id }
 *   POST { title, slug?, description?, duration_minutes?, buffer_before_minutes?, buffer_after_minutes?,
 *          notice_minutes?, window_days?, step_minutes?, daily_cap?, questions?, video?, location?,
 *          ask_first?, host_mode?, hosts?, weekly_hours?, time_zone?, active?, team? } → 201 { link }
 *
 * The rules (who may edit, who may host) are src/lib/booking-links/links.ts's;
 * only the service role writes.
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handleListLinks({ workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}

export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handleCreateLink(request, { workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}
