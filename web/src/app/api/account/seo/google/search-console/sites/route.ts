/**
 * /api/account/seo/google/search-console/sites: what the member could choose.
 *
 *   GET  { accounts, sites, suggested, source }: the member's own Search
 *        Console connections, every property each can see (verified or not;
 *        an unverified one can't be chosen), the one matching the
 *        workspace's website when exactly one does, and what the workspace
 *        reads now.
 *
 * Any member may read it. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import {
  listSearchConsoleSites,
  readGoogleSources,
  suggestSite,
} from '@/lib/seo/google/source'
import { workspaceSiteUrl } from '@/lib/seo/site'
import { NextResponse } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const [listed, sources, website] = await Promise.all([
      listSearchConsoleSites(svc, { userId: auth.user.id }),
      readGoogleSources(svc, auth.workspaceId),
      workspaceSiteUrl(svc, auth.workspaceId).catch(() => null),
    ])
    return NextResponse.json({
      accounts: listed.accounts,
      sites: listed.options,
      suggested: suggestSite(website, listed.options),
      source: sources.search_console,
    })
  } catch (err) {
    console.error('[seo-google] sites failed', err)
    return serverError('Could not list your Search Console sites just now.')
  }
}
