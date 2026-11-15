/**
 * /api/account/environments/[id]
 *
 * PATCH   change an environment. A Mac: { name?, worker? } by its owner
 *         (worker: who does its work, a coding agent's id or null for Native
 *         Intelligence's own agent, migration 658). A cloud
 *         one: { name?, networkAccess?, envVars?, setupScript?, shared? }, by
 *         its creator or a workspace admin; one a project or the workspace
 *         default uses stays shared (409 ENVIRONMENT_IN_USE). { environment }
 * DELETE  archive a cloud environment (its creator or an admin): its projects
 *         unlink, and chats and defaults that named it fall back to the next
 *         one. A Mac is removed with DELETE /api/account/environments/macs/
 *         [deviceId] instead (400 here). { archived: true }
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { archiveEnvironment, updateEnvironment } from '@/lib/environments/store'
import { environmentErrorResponse, readJsonObject, requireEnvironmentsWorkspace } from '@/lib/environments/http'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const { id } = await params
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  try {
    const environment = await updateEnvironment(getServiceClient(), {
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      environmentId: id,
      patch: {
        name: body.name,
        networkAccess: body.networkAccess,
        envVars: body.envVars,
        setupScript: body.setupScript,
        shared: body.shared,
        worker: body.worker,
      },
    })
    return NextResponse.json({ environment })
  } catch (err) {
    return environmentErrorResponse(err, 'update environment')
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const { id } = await params
  try {
    return NextResponse.json(await archiveEnvironment(getServiceClient(), { userId: auth.user.id, workspaceId: auth.workspaceId, environmentId: id }))
  } catch (err) {
    return environmentErrorResponse(err, 'archive environment')
  }
}
