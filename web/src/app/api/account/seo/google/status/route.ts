/**
 * /api/account/seo/google/status: the "Connect Google" card's read.
 *
 *   GET  for the signed-in member and their workspace, per product (Search
 *        Console, Google Analytics): its state (not_connected, choose, ready,
 *        needs_reconnect), the member's own connections, what the workspace
 *        reads and who chose it, what the member could choose (read from
 *        Google through their own connections), and the suggested choice.
 *
 * Any member may read it. Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { googleSeoStatus } from '@/lib/seo/google/source'
import { NextResponse } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json(
      await googleSeoStatus(getServiceClient(), {
        workspaceId: auth.workspaceId,
        userId: auth.user.id,
      }),
    )
  } catch (err) {
    console.error('[seo-google] status failed', err)
    return serverError('Could not load the Google connections just now.')
  }
}
