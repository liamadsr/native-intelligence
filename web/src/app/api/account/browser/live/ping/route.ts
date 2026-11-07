import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { touchCloudBrowser } from '@/lib/cloud-browser/host'

/** POST: the live view is still on screen; the idle stop leaves the browser alone (docs/plans/cloud-browser.md, C3). */
export async function POST() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  await touchCloudBrowser({ userId: auth.user.id, workspaceId: auth.workspaceId }).catch(() => {})
  return NextResponse.json({ ok: true })
}
