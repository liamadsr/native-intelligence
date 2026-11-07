/**
 * GET /api/local-agent/environment — the person's environment for local
 * agents (the side panel's Environment card, and the composer's + menu):
 *
 *   {devices: DeviceRow[], folders: FolderRow[], worktrees: WorktreeRow[]}
 *
 * devices    their Macs, with presence (a heartbeat within 120 s);
 * folders    their live grants across those Macs: each is available to the
 *            Dial8 agent in every chat until they remove it on the Mac;
 * worktrees  their edit jobs' branches, live or from the last 7 days, for
 *            folders still in the environment.
 *
 * The person's own view, so a folder's path is included (the model never
 * gets one: invariant 2). Folders are added and removed only on the Mac; the
 * heartbeat mirrors them here.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, requireLocalAgentUser } from '@/lib/local-agent/http'
import { readEnvironment } from '@/lib/local-agent/store'

export async function GET(request: Request) {
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json(await readEnvironment(getServiceClient(), auth.user.id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err, 'read environment')
  }
}
