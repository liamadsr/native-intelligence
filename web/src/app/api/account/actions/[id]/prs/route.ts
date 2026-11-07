import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { getServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/account/actions/[id]/prs — List PRs linked to an action.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data: prs, error } = await supabase
    .from('action_github_pr')
    .select('*')
    .eq('action_id', id)
    .eq('workspace_id', workspaceId)
    .order('linked_at', { ascending: false })

  if (error) return serverError(error.message)

  return NextResponse.json({ prs })
}

/**
 * POST /api/account/actions/[id]/prs — Link a PR to an action.
 * Body: { pr_url: "https://github.com/owner/repo/pull/123" }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: actionId } = await params
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json()
  const prUrl = body.pr_url?.trim()
  if (!prUrl) return badRequest('pr_url is required')

  // Parse the GitHub PR URL
  const parsed = parseGitHubPrUrl(prUrl)
  if (!parsed) {
    return badRequest('Invalid GitHub PR URL. Expected format: https://github.com/owner/repo/pull/123')
  }

  // Verify the action exists and belongs to this workspace
  const { data: action, error: actionError } = await supabase
    .from('actions')
    .select('id')
    .eq('id', actionId)
    .eq('workspace_id', workspaceId)
    .single()

  if (actionError || !action) {
    return notFound('Action not found')
  }

  // Try to fetch PR metadata from GitHub API (best effort — works without auth for public repos)
  const prMeta = await fetchPrMetadata(parsed.repoFullName, parsed.prNumber, user.id)

  const { data: pr, error } = await supabase
    .from('action_github_pr')
    .upsert(
      {
        workspace_id: workspaceId,
        action_id: actionId,
        pr_url: prUrl,
        repo_full_name: parsed.repoFullName,
        pr_number: parsed.prNumber,
        pr_title: prMeta?.title || null,
        pr_state: prMeta?.state || 'open',
        pr_draft: prMeta?.draft || false,
        head_branch: prMeta?.headBranch || null,
        created_by: user.id,
        last_synced_at: prMeta ? new Date().toISOString() : null,
      },
      { onConflict: 'action_id,repo_full_name,pr_number' },
    )
    .select()
    .single()

  if (error) return serverError(error.message)

  return NextResponse.json({ pr }, { status: 201 })
}

function parseGitHubPrUrl(url: string): { repoFullName: string; prNumber: number } | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return null

    // Expected path: /owner/repo/pull/123
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 4 || parts[2] !== 'pull') return null

    const prNumber = parseInt(parts[3], 10)
    if (isNaN(prNumber)) return null

    return {
      repoFullName: `${parts[0]}/${parts[1]}`,
      prNumber,
    }
  } catch {
    return null
  }
}

async function fetchPrMetadata(
  repoFullName: string,
  prNumber: number,
  userId: string,
): Promise<{ title: string; state: string; draft: boolean; headBranch: string } | null> {
  try {
    // The signed-in user's own GitHub token, for authenticated API access. The
    // token columns are the service role's alone (migration 466), so it is read
    // with the service client, scoped to the session's user id (never one from
    // the request).
    const accessToken = await storedGithubToken(getServiceClient(), userId)

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    }
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`
    }

    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      { headers },
    )

    if (!res.ok) return null

    const data = await res.json()
    return {
      title: data.title,
      state: data.merged ? 'merged' : data.state, // GitHub API returns 'open' or 'closed'
      draft: data.draft || false,
      headBranch: data.head?.ref || null,
    }
  } catch {
    return null
  }
}
