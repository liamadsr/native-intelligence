/**
 * /api/account/environments/default
 *
 * GET ?workspaceId=<id>&projectId=<id>
 *   This person's own default: with a projectId, "run this project's work on
 *   my Mac" (one of their Macs, or null); without one, their default for the
 *   workspace. One that can't be used any more (archived, unshared, a removed
 *   Mac) reads as null, as getDefault reads it. workspaceId defaults to the
 *   current workspace; another one must be one they belong to (else 403).
 *   { environmentId: string | null }
 * PUT
 *   Set this person's default environment:
 *   { environmentId: string | null, projectId?: string | null, workspaceId? }
 *   (workspaceId as for GET: the current one by default, else one they
 *   belong to, else 403).
 *     no projectId   their default for the workspace: one of their Macs, or a
 *                    cloud environment of the workspace they can use;
 *     a projectId    "run this project's work on my Mac": one of their Macs only
 *                    (the project's own environment is set on the project).
 *   environmentId null clears it, and the next default applies.
 *   { environmentId, projectId }
 * Both refuse a capture-device token (requireEnvironmentsWorkspace).
 */
import { NextResponse } from 'next/server'
import { badRequest, forbidden } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isUuid } from '@/lib/local-agent/store'
import { getDefault, memberRole, setDefault } from '@/lib/environments/store'
import { environmentErrorResponse, readJsonObject, requireEnvironmentsWorkspace } from '@/lib/environments/http'

export async function GET(request: Request) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const params = new URL(request.url).searchParams
  const workspaceId = params.get('workspaceId') || auth.workspaceId
  const projectId = params.get('projectId') || null
  if (!isUuid(workspaceId)) return badRequest('workspaceId must be an id')
  if (projectId !== null && !isUuid(projectId)) return badRequest('projectId must be an id')
  try {
    const svc = getServiceClient()
    if (workspaceId !== auth.workspaceId && !(await memberRole(svc, auth.user.id, workspaceId))) {
      return forbidden('Not a workspace member')
    }
    const environmentId = await getDefault(svc, { userId: auth.user.id, workspaceId, projectId })
    return NextResponse.json({ environmentId }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return environmentErrorResponse(err, 'read default')
  }
}

export async function PUT(request: Request) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  if (!('environmentId' in body)) return badRequest('environmentId is required (null clears the default)')
  if (body.workspaceId !== undefined && body.workspaceId !== null && !isUuid(body.workspaceId)) return badRequest('workspaceId must be an id')
  const workspaceId = (body.workspaceId as string | null | undefined) || auth.workspaceId
  try {
    // setDefault refuses a workspace they don't belong to (403), as GET does.
    const set = await setDefault(getServiceClient(), {
      userId: auth.user.id,
      workspaceId,
      projectId: body.projectId,
      environmentId: body.environmentId,
    })
    return NextResponse.json(set)
  } catch (err) {
    return environmentErrorResponse(err, 'set default')
  }
}
