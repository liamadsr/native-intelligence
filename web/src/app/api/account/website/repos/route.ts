import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { listOwnerRepos } from '@/lib/website/github'
import { siteUrlOf } from '@/lib/website/inspect'
import { rankingHints, rankWebsiteRepos, WEBSITE_REPO_CHOICES } from '@/lib/website/repos'
import type { WebsiteRepoView } from '@/lib/website/view'

/**
 * GET /api/account/website/repos: the person's GitHub repos they can change,
 * the likeliest to be the business's website first (the same ranking as the
 * numbered list texted when GitHub connects).
 */
export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const svc = getServiceClient()
  const token = await storedGithubToken(svc, auth.user.id)
  if (!token) return apiError('Connect GitHub first.', { status: 409, code: 'NO_GITHUB' })
  const listed = await listOwnerRepos({ token })
  if (!listed.ok) return apiError('GitHub didn’t answer just now. Try again in a moment.', { status: 502, code: 'GITHUB_UNAVAILABLE' })
  const ranked = rankWebsiteRepos(listed.value, await rankingHints(svc, auth.workspaceId))
  const repos: WebsiteRepoView[] = ranked.map((r, i) => ({ fullName: r.fullName, private: r.private, homepage: siteUrlOf(r.homepage), likely: i < WEBSITE_REPO_CHOICES }))
  return NextResponse.json({ repos })
}
