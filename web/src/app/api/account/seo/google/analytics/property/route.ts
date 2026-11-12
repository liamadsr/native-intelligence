/**
 * /api/account/seo/google/analytics/property: the workspace's choice.
 *
 *   PUT     { property_id, account_id? }: read this GA4 property
 *           ('properties/123' or '123') for the workspace, through the
 *           member's own connection (it must list the property; `account_id`
 *           picks one of several). Its name, time zone and currency are read
 *           from Google then. Every member reads it through that connection.
 *           Answers { source }.
 *   DELETE  stop reading Google Analytics here (any member).
 *
 * Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { googleRefusalResponse } from '@/lib/seo/google/respond'
import {
  clearAnalyticsProperty,
  setAnalyticsProperty,
} from '@/lib/seo/google/source'
import { NextResponse, type NextRequest } from 'next/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PUT(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as {
    property_id?: unknown
    account_id?: unknown
  } | null
  if (
    typeof body?.property_id !== 'string' ||
    !body.property_id.trim() ||
    body.property_id.length > 40
  )
    return badRequest('Which property? Give its id, like properties/123456.')
  if (
    body.account_id !== undefined &&
    body.account_id !== null &&
    (typeof body.account_id !== 'string' || !UUID.test(body.account_id))
  )
    return badRequest('That isn’t one of your connections.')
  try {
    const out = await setAnalyticsProperty(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      {
        property_id: body.property_id,
        ...(typeof body.account_id === 'string'
          ? { account_id: body.account_id }
          : {}),
      },
    )
    if (!out.ok) return googleRefusalResponse(out)
    return NextResponse.json({ source: out.source })
  } catch (err) {
    console.error('[seo-google] set property failed', err)
    return serverError('Could not choose the property just now.')
  }
}

export async function DELETE() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    await clearAnalyticsProperty(getServiceClient(), {
      workspaceId: auth.workspaceId,
    })
    return NextResponse.json({ source: null })
  } catch (err) {
    console.error('[seo-google] clear property failed', err)
    return serverError('Could not clear the property just now.')
  }
}
