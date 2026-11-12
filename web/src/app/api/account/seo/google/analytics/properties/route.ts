/**
 * /api/account/seo/google/analytics/properties: what the member could choose.
 *
 *   GET  { accounts, properties, suggested, source }: the member's own
 *        Google Analytics connections, every GA4 property each can see, the
 *        only one when there is exactly one, and what the workspace reads now.
 *
 * Any member may read it. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import {
  listAnalyticsProperties,
  readGoogleSources,
} from '@/lib/seo/google/source'
import { NextResponse } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const [listed, sources] = await Promise.all([
      listAnalyticsProperties(svc, { userId: auth.user.id }),
      readGoogleSources(svc, auth.workspaceId),
    ])
    return NextResponse.json({
      accounts: listed.accounts,
      properties: listed.options,
      suggested:
        listed.options.length === 1 ? listed.options[0].property_id : null,
      source: sources.analytics,
    })
  } catch (err) {
    console.error('[seo-google] properties failed', err)
    return serverError(
      'Could not list your Google Analytics properties just now.',
    )
  }
}
