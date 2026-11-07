/**
 * /api/account/environments (docs/plans/environments.md, migration 420).
 *
 * GET   every environment this person may use from the current workspace:
 *       their Macs first (each with its live folders: label, id, mode
 *       ceiling, is_git, base branch and linked repo; never a path), then
 *       the workspace's cloud environments they can see. Env vars and setup
 *       scripts only for an environment's creator and workspace admins.
 *         { environments: Environment[], defaultEnvironmentId: string | null }
 *       defaultEnvironmentId is their own default for this workspace.
 * POST  a new cloud environment: { name, networkAccess?, envVars?,
 *       setupScript?, shared? } (network defaults to restricted, sharing to
 *       the workspace). { environment }
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { createCloudEnvironment, getDefault, listEnvironments } from '@/lib/environments/store'
import { environmentErrorResponse, readJsonObject, requireEnvironmentsWorkspace } from '@/lib/environments/http'

export async function GET(request: Request) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const scope = { userId: auth.user.id, workspaceId: auth.workspaceId }
    const [environments, defaultEnvironmentId] = await Promise.all([listEnvironments(svc, scope), getDefault(svc, scope)])
    return NextResponse.json({ environments, defaultEnvironmentId }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return environmentErrorResponse(err, 'list environments')
  }
}

export async function POST(request: Request) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  try {
    const environment = await createCloudEnvironment(getServiceClient(), {
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      name: body.name,
      networkAccess: body.networkAccess,
      envVars: body.envVars,
      setupScript: body.setupScript,
      shared: body.shared,
    })
    return NextResponse.json({ environment })
  } catch (err) {
    return environmentErrorResponse(err, 'create environment')
  }
}
