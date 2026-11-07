import { requireUser } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { isDeviceToken, setActiveDeviceWorkspace } from '@/lib/device-tokens'

/**
 * POST /api/account/device-tokens/switch-workspace  { workspace_id: string }
 *
 * Switch the active workspace of the CALLING device token. The device's
 * on-screen workspace picker calls this with its own Bearer token; every
 * subsequent capture / agent request the device makes then resolves to the
 * chosen workspace (via resolveDeviceToken's active_workspace_id).
 *
 * This is the device equivalent of the cookie-based /api/account/workspace/switch
 * (a headless device has no cookie jar, so the active workspace lives on the
 * device_token row instead — mirroring mcp_oauth_token.active_workspace_id).
 *
 * Auth: device-token Bearer only — there's no token to switch otherwise.
 * Membership is validated inside setActiveDeviceWorkspace.
 */
export async function POST(req: Request) {
  // Validate the bearer up front (rejects unknown/expired tokens with 401).
  const auth = await requireUser()
  if (auth instanceof Response) return auth

  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token || !isDeviceToken(token)) {
    return badRequest('This endpoint requires a device-token Bearer credential')
  }

  let body: { workspace_id?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : ''
  if (!workspaceId) return badRequest('workspace_id is required')

  // Returns false if the token is gone or the owner isn't a member of the
  // target workspace — surface the latter as a 403 (don't reveal which).
  let ok: boolean
  try {
    ok = await setActiveDeviceWorkspace(token, workspaceId)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to switch workspace')
  }
  if (!ok) return forbidden('Not a member of that workspace')

  return Response.json({ ok: true, active_workspace_id: workspaceId })
}
