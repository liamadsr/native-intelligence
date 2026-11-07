import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { ringComputer } from '@/lib/browser-agent/queue'
import { setDriver } from '@/lib/cloud-browser/store'

/**
 * POST /api/account/browser/driver  { driver: 'person' | 'agent' }
 *
 * Take the cloud browser over, or hand it back (docs/plans/cloud-browser.md, C3).
 * While the person drives, the agent's running task ends `taken_over` at its
 * next step and no new one starts; the live view reconnects with input.
 * Every other window's live view reconnects too (`driver-changed`), so input
 * ends everywhere at a hand back, not when a control token runs out.
 */
export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  let driver: unknown
  try { driver = ((await request.json()) as { driver?: unknown })?.driver } catch { /* checked below */ }
  if (driver !== 'person' && driver !== 'agent') return badRequest('driver must be person or agent')
  const ref = { userId: auth.user.id, workspaceId: auth.workspaceId }
  const changed = await setDriver(ref, driver).catch(() => null)
  if (changed === null) return apiError('Could not change who drives the browser', { status: 500, code: 'INTERNAL' })
  if (!changed) return apiError('Your browser has not started yet', { status: 409, code: 'BROWSER_NOT_STARTED' })
  await ringComputer(ref, 'driver-changed')
  return NextResponse.json({ driver })
}
