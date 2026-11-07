import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { getServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/account/github/repos
 * Fetches the authenticated user's GitHub repositories using their connected GitHub token.
 * Returns repos sorted by most recently pushed.
 */
export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  // The token columns are the service role's alone (migration 466), so the
  // token is read with the service client, scoped to the signed-in user's own
  // id: the session is the authorization, and no id comes from the request.
  const githubToken = await storedGithubToken(getServiceClient(), user.id)

  if (!githubToken) {
    return NextResponse.json(
      { error: 'GitHub not connected', repos: [] },
      { status: 200 },
    )
  }

  try {
    // Fetch all repos the user has access to (paginated, up to 100)
    const res = await fetch(
      'https://api.github.com/user/repos?sort=pushed&per_page=100&type=all',
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
        },
      },
    )

    if (!res.ok) {
      const text = await res.text()
      console.error('GitHub API error:', res.status, text)
      return NextResponse.json(
        { error: 'Failed to fetch repositories', repos: [] },
        { status: 200 },
      )
    }

    const data = await res.json()

    const repos = data.map(
      (r: { full_name: string; name: string; owner: { login: string; avatar_url: string }; private: boolean; html_url: string; description: string | null; default_branch: string }) => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        owner_avatar: r.owner.avatar_url,
        private: r.private,
        html_url: r.html_url,
        description: r.description,
        default_branch: r.default_branch,
      }),
    )

    return NextResponse.json({ repos })
  } catch (err) {
    console.error('Failed to fetch GitHub repos:', err)
    return NextResponse.json(
      { error: 'Failed to fetch repositories', repos: [] },
      { status: 200 },
    )
  }
}
