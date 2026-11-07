import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, featureDisabled } from '@/lib/api-errors'
import { isFeatureEnabled, resolveWorkspaceEdition } from '@/lib/editions'
import { getServiceClient } from '@/lib/supabase/service'
import { CLOUD_BROWSER, cloudBrowserNamespace } from '@/lib/cloud-browser/config'
import { ensureCloudBrowser, runningHubOrigin, touchCloudBrowser } from '@/lib/cloud-browser/host'
import { cloudBrowserSandboxName } from '@/lib/cloud-browser/ids'
import { readComputer, readDriver } from '@/lib/cloud-browser/store'
import { sandboxSigningKey, signSandboxToken } from '@/lib/cloud-browser/viewer-token'

export const maxDuration = 120

/**
 * GET: the computer card's state (C3), never waking anything. `exists: false`
 * until the person's agent has used its browser (the card hides then); else
 * its status, who drives it, whether a task is running on it now, and (C4)
 * whether a Mac of the person's carries its traffic.
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const ref = { userId: auth.user.id, workspaceId: auth.workspaceId }
  const computer = await readComputer(ref).catch(() => null)
  // No computer yet: the card still shows, and says whether a click can start one (the live view's signing key).
  if (!computer) return NextResponse.json({ exists: false, liveView: sandboxSigningKey() !== null })
  const { data } = await getServiceClient().from('browser_command_queue').select('id')
    .eq('user_id', ref.userId).eq('workspace_id', ref.workspaceId).eq('command', 'run_task').eq('status', 'claimed')
    .gt('lease_expires_at', new Date().toISOString()).limit(1)
  return NextResponse.json({ exists: true, status: computer.status, driver: computer.driver, busy: (data?.length ?? 0) > 0,
    liveView: sandboxSigningKey() !== null, macConnected: computer.status === 'running' && computer.macConnected })
}

/**
 * POST /api/account/browser/live  { mode: 'view' | 'thumbnail', wake?: boolean }
 *
 * The live view of the person's cloud browser (docs/plans/cloud-browser.md, C3).
 * `view` wakes it ("Waking your browser…") and answers a short-lived viewer
 * token for its hub: view-only, or with input while the person has taken it
 * over. With `wake: false` (a view reconnecting by itself) a sleeping browser
 * answers `asleep` instead: only the person's click wakes it, never an open
 * window. `thumbnail` never wakes it either: a sleeping browser answers `asleep`, and the
 * computer card keeps its last frame. The token goes to the hub as the
 * WebSocket's first message (or a Bearer header for the thumbnail), never a URL.
 */
export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  let mode: unknown = 'view'
  let wake = true
  try {
    const body = (await request.json()) as { mode?: unknown; wake?: unknown }
    mode = body?.mode ?? 'view'
    wake = body?.wake !== false
  } catch { /* the defaults */ }
  if (mode !== 'view' && mode !== 'thumbnail') return badRequest('mode must be view or thumbnail')
  const db = getServiceClient()
  if (!isFeatureEnabled(await resolveWorkspaceEdition(db, workspaceId), 'browser')) return featureDisabled()
  const signingKey = sandboxSigningKey()
  if (!signingKey) return apiError('The live view is not set up', { status: 503, code: 'LIVE_VIEW_UNCONFIGURED' })

  const ref = { userId: user.id, workspaceId }
  let origin: string | null
  if (mode === 'thumbnail' || !wake) {
    origin = await runningHubOrigin(ref).catch(() => null)
    if (!origin) return NextResponse.json({ state: 'asleep' })
  } else {
    try {
      origin = (await ensureCloudBrowser(ref)).hubOrigin
    } catch (error) {
      console.error('[cloud-browser] live view could not wake the browser:', error instanceof Error ? error.message : error)
      return apiError('Your browser could not start. Try again in a moment.', { status: 503, code: 'BROWSER_UNAVAILABLE' })
    }
    // Watching counts as using it: the idle stop leaves a visible browser alone.
    await touchCloudBrowser(ref).catch(() => {})
  }
  if (!origin) return apiError('The live view is not reachable', { status: 503, code: 'BROWSER_UNAVAILABLE' })

  const driver = await readDriver(ref).catch(() => 'agent' as const)
  const control = mode === 'view' && driver === 'person'
  const sandbox = cloudBrowserSandboxName(user.id, workspaceId, cloudBrowserNamespace())
  const token = signSandboxToken({ aud: 'browser-viewer', userId: user.id, workspaceId, sandbox, control },
    control ? CLOUD_BROWSER.controlTokenTtlMs : CLOUD_BROWSER.viewTokenTtlMs, signingKey)
  return NextResponse.json({
    state: 'running', driver, control, token,
    viewerUrl: `${origin.replace(/^https:/, 'wss:')}/viewer`,
    thumbnailUrl: `${origin}/thumbnail`,
  })
}
