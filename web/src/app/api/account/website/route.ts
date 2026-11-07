import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { isRepoName } from '@/lib/website/github'
import { siteUrlOf } from '@/lib/website/inspect'
import { connectWebsite } from '@/lib/website/start'
import { reconcileOpenChange } from '@/lib/website/reconcile'
import { getLiveSite, getOpenChange, recentChanges } from '@/lib/website/store'
import { websiteView } from '@/lib/website/view'
import { outcomeError } from '@/lib/website/http'

/**
 * The business's website in the app (roadmap track E,
 * docs/plans/website-by-text.md): the same flow the agent runs by text, from
 * the GitHub connector's page.
 *
 *   GET    the connected site, what reading its repo found, and the change in
 *          flight (or one that just didn't work).
 *   POST   { repo, site_url? }: connect the repo the person picked (or the
 *          live address they typed): it is read and saved, exactly as
 *          connect_website does on their own turn (an owner or admin
 *          connects; the core checks, src/lib/website/start.ts).
 */

async function view(workspaceId: string, userId: string, role: string | null) {
  const svc = getServiceClient()
  const [site, token] = await Promise.all([getLiveSite(svc, workspaceId), storedGithubToken(svc, userId)])
  const found = site ? await getOpenChange(svc, workspaceId, site.id) : null
  // A change nothing will move any more (its run died, a settle was lost) is settled first, as the agent's section does: never a spinner forever.
  const open = found ? await reconcileOpenChange(svc, found).catch(() => found) : null
  const last = site && !open ? await recentChanges(svc, workspaceId, site.id, 1) : []
  return websiteView({ githubConnected: !!token, canConnect: role === 'owner' || role === 'admin', viewer: { userId, role }, site, open, last: last[0] ?? null })
}

const memberAuth = () => requireWorkspaceMember({ select: 'id, role' })

export async function GET() {
  const auth = await memberAuth()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json(await view(auth.workspaceId, auth.user.id, auth.member.role ?? null))
  } catch (err) {
    console.error('[website] view failed', err)
    return serverError('Could not load your website just now.')
  }
}

export async function POST(request: Request) {
  const auth = await memberAuth()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { repo?: unknown; site_url?: unknown } | null
  if (!isRepoName(body?.repo)) return badRequest('Pick a repository.')
  const typed = typeof body?.site_url === 'string' && body.site_url.trim() ? body.site_url.trim().slice(0, 200) : null
  const siteUrl = typed ? siteUrlOf(typed) : null
  if (typed && !siteUrl) return badRequest('That isn’t a website address (for example janescleaning.com).')
  try {
    const out = await connectWebsite(getServiceClient(), { userId: auth.user.id, workspaceId: auth.workspaceId }, { repo: body.repo, siteUrl })
    if (!out.success) return outcomeError(out)
    return NextResponse.json(await view(auth.workspaceId, auth.user.id, auth.member.role ?? null))
  } catch (err) {
    console.error('[website] connect failed', err)
    return serverError('Could not connect your website just now.')
  }
}
