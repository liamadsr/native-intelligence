import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, featureDisabled } from '@/lib/api-errors'
import { isFeatureEnabled, resolveWorkspaceEdition } from '@/lib/editions'
import { getServiceClient } from '@/lib/supabase/service'
import { CLOUD_BROWSER, cloudBrowserNamespace } from '@/lib/cloud-browser/config'
import { runningHubOrigin } from '@/lib/cloud-browser/host'
import { cloudBrowserSandboxName } from '@/lib/cloud-browser/ids'
import { sandboxSigningKey, signSandboxToken } from '@/lib/cloud-browser/viewer-token'

/**
 * POST /api/account/browser/exit  { deviceId? }
 *
 * The desktop's ticket for the Mac exit (docs/plans/cloud-browser.md, C4): an
 * Ed25519 `browser-exit` token for the person's running browser, naming its
 * hub, and the tunnel's URL. Never wakes the browser: the exit follows it, and
 * the desktop asks again at its `browser-up`. The desktop checks the token
 * itself before connecting (the page that asked isn't trusted with the URL).
 */
export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  let deviceId: string | undefined
  try {
    const body = (await request.json()) as { deviceId?: unknown }
    if (typeof body?.deviceId === 'string' && body.deviceId.length <= 128) deviceId = body.deviceId
  } catch { /* none */ }
  const db = getServiceClient()
  if (!isFeatureEnabled(await resolveWorkspaceEdition(db, workspaceId), 'browser')) return featureDisabled()
  const signingKey = sandboxSigningKey()
  if (!signingKey) return apiError('The cloud browser exit is not set up', { status: 503, code: 'EXIT_UNCONFIGURED' })
  const ref = { userId: user.id, workspaceId }
  const origin = await runningHubOrigin(ref).catch(() => null)
  if (!origin) return NextResponse.json({ state: 'asleep' })
  const hub = new URL(origin).host
  const sandbox = cloudBrowserSandboxName(user.id, workspaceId, cloudBrowserNamespace())
  // The desktop takes it only for the account it is signed into (browser_exit.rs).
  const token = signSandboxToken({ aud: 'browser-exit', userId: user.id, workspaceId, sandbox, hub, ...(deviceId ? { deviceId } : {}) },
    CLOUD_BROWSER.sessionTimeoutMs, signingKey)
  return NextResponse.json({ state: 'running', token, url: `wss://${hub}/exit` })
}
