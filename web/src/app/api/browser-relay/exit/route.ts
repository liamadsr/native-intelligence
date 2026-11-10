import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { ringComputer } from '@/lib/browser-agent/queue'
import { setExitMode } from '@/lib/cloud-browser/host'
import { relayActor, relayOriginCalled } from '@/lib/cloud-browser/relay-routes'

/**
 * POST /api/browser-relay/exit  { mode: 'mac' | 'cloud', tunnel: { up, deviceId? } }
 *
 * The relay switched where its browser's traffic leaves (docs/plans/cloud-browser.md,
 * C4), between tasks, or reports its Mac's tunnel: the session's network
 * policy follows the mode (`mac`: nothing out but the relay's own requests),
 * the row records both, and the person's computer card reads them again.
 */
export async function POST(request: Request) {
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  let body: { mode?: unknown; tunnel?: { up?: unknown; deviceId?: unknown } } = {}
  try { body = await request.json() } catch { /* checked below */ }
  if (body.mode !== 'mac' && body.mode !== 'cloud') return badRequest('mode must be mac or cloud')
  const tunnel = { up: body.tunnel?.up === true, deviceId: typeof body.tunnel?.deviceId === 'string' ? body.tunnel.deviceId : null }
  const ref = { userId: actor.userId, workspaceId: actor.workspaceId }
  try {
    // The rule is set for the relay host this relay calls, which it just did.
    await setExitMode(ref, body.mode, tunnel, relayOriginCalled(request))
  } catch (error) {
    console.error('[cloud-browser] exit switch failed:', error instanceof Error ? error.message : error)
    return apiError('Could not switch the browser’s exit', { status: 503, code: 'EXIT_UNAVAILABLE' })
  }
  await ringComputer(ref, 'computer-changed')
  return NextResponse.json({ ok: true, mode: body.mode })
}
