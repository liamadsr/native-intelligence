import { requireWorkspaceMember } from '@/lib/api-auth'
import { getViewerAndOrg, listTeams } from '@/lib/integrations/linear-api'
import { linearErrorResponse, requireLinearToken } from '@/lib/tasks/linear-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/linear/teams
 *
 * Server-side proxy for the destination picker's FIRST step — Linear has no
 * site/tenant to pick before it (a token belongs to exactly one organization),
 * so the team is where configuration starts.
 *
 * Returns the ORGANIZATION alongside the teams because the save funnel persists
 * `organization_id`: it is the value the webhook read-back sanity-checks a
 * delivery against, and this is the only call that knows it. Bundling the two
 * keeps the client from needing a second round trip just to learn who it is
 * connected as.
 *
 * No search box, so the list has to be COMPLETE: listTeams follows the cursor
 * (up to its page cap) rather than returning a first page of 50. Teams are a
 * coarse unit — one per squad, not one per project — so most organizations fit
 * in one page anyway, but an enterprise org exceeds it, and silently omitting a
 * team here makes it permanently unconfigurable with nothing on screen to say
 * why.
 *
 * A rejected token surfaces as 400 `reconnect_required`.
 */
export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const resolved = await requireLinearToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    // Two shallow queries rather than one nested document: Linear budgets by
    // complexity points, and `teams` and `organization` are independent roots.
    const [teams, identity] = await Promise.all([
      listTeams(resolved.token),
      getViewerAndOrg(resolved.token),
    ])

    return NextResponse.json({
      teams: teams.map((t) => ({ id: t.id, key: t.key ?? null, name: t.name ?? t.key ?? t.id })),
      organization: identity.organization
        ? { id: identity.organization.id, name: identity.organization.name ?? null }
        : null,
    })
  } catch (err) {
    return linearErrorResponse(err, 'list Linear teams')
  }
}
