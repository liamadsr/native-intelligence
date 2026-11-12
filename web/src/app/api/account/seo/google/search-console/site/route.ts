/**
 * /api/account/seo/google/search-console/site: the workspace's choice.
 *
 *   PUT     { site_url, account_id? }: read this Search Console site for the
 *           workspace, through the member's own connection (it must list the
 *           site as verified; `account_id` picks one of several). Every
 *           member then reads it through that connection. Answers
 *           { source }.
 *   DELETE  stop reading Search Console here (any member).
 *
 * Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { googleRefusalResponse } from '@/lib/seo/google/respond'
import {
  clearSearchConsoleSite,
  setSearchConsoleSite,
} from '@/lib/seo/google/source'
import { NextResponse, type NextRequest } from 'next/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PUT(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as {
    site_url?: unknown
    account_id?: unknown
  } | null
  if (
    typeof body?.site_url !== 'string' ||
    !body.site_url.trim() ||
    body.site_url.length > 2048
  )
    return badRequest(
      'Which site? Give its Search Console name, like sc-domain:example.com.',
    )
  if (
    body.account_id !== undefined &&
    body.account_id !== null &&
    (typeof body.account_id !== 'string' || !UUID.test(body.account_id))
  )
    return badRequest('That isn’t one of your connections.')
  try {
    const out = await setSearchConsoleSite(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      {
        site_url: body.site_url,
        ...(typeof body.account_id === 'string'
          ? { account_id: body.account_id }
          : {}),
      },
    )
    if (!out.ok) return googleRefusalResponse(out)
    return NextResponse.json({ source: out.source })
  } catch (err) {
    console.error('[seo-google] set site failed', err)
    return serverError('Could not choose the site just now.')
  }
}

export async function DELETE() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    await clearSearchConsoleSite(getServiceClient(), {
      workspaceId: auth.workspaceId,
    })
    return NextResponse.json({ source: null })
  } catch (err) {
    console.error('[seo-google] clear site failed', err)
    return serverError('Could not clear the site just now.')
  }
}
