import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleGetHandles, handlePutHandle } from '@/lib/booking-links/account'
import { appOrigin } from '@/lib/twilio/config'

/**
 * /api/account/booking-profile — the handles booking links' addresses start
 * with (availability phase 4a): /book/<handle>/<slug>.
 *
 *   GET → { handles: { me, workspace } }
 *   PUT { handle, scope?: 'me' | 'workspace' } → { handles }   (workspace: owners and admins)
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handleGetHandles({ workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}

export async function PUT(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handlePutHandle(request, { workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}
