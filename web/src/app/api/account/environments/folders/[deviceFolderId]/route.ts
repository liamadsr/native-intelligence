/**
 * PATCH /api/account/environments/folders/[deviceFolderId]
 *
 * A Mac folder's two web settings, by its owner: { baseBranch?, repoFullName? }
 * (a missing key keeps the setting, null or '' clears it). The base branch is
 * a plain local branch name (the Mac checks it again in E3), the linked repo
 * owner/repo. Its mode stays the grant's: only the Mac's native confirm sets
 * it. { folder: { deviceFolderId, baseBranch, repoFullName } }
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { setFolderSetting } from '@/lib/environments/store'
import { environmentErrorResponse, readJsonObject, requireEnvironmentsWorkspace } from '@/lib/environments/http'

export async function PATCH(request: Request, { params }: { params: Promise<{ deviceFolderId: string }> }) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const { deviceFolderId } = await params
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  try {
    const folder = await setFolderSetting(getServiceClient(), {
      userId: auth.user.id,
      deviceFolderId,
      baseBranch: body.baseBranch,
      repoFullName: body.repoFullName,
    })
    return NextResponse.json({ folder })
  } catch (err) {
    return environmentErrorResponse(err, 'set folder setting')
  }
}
