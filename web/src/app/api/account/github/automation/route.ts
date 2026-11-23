import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { REPO_RE } from '@/lib/github/reviews'

/**
 * The repositories this workspace takes pull-request automation from
 * (workspace_github_repo, migration 694; docs/plans/github-reviews.md, phase
 * 2). An identifier in a branch or pull request of any other repository
 * moves nothing here.
 *
 *   GET     the repos, and whether the person may change them
 *   POST    { repo: "owner/name" }  add one (owners and admins)
 *   DELETE  ?repo=owner/name        remove one (owners and admins)
 *
 * Written through the person's own client: the table's policies are the
 * fence (owners and admins of this workspace, added_by the caller).
 */
const ADMIN = new Set(['owner', 'admin'])

export async function GET() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { data, error } = await auth.supabase
    .from('workspace_github_repo')
    .select('repo_full_name, created_at')
    .eq('workspace_id', auth.workspaceId)
    .order('repo_full_name', { ascending: true })
  if (error) return serverError(error.message)
  return NextResponse.json({ repos: data ?? [], canManage: ADMIN.has(auth.member.role ?? '') })
}

export async function POST(request: Request) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (!ADMIN.has(auth.member.role ?? '')) return forbidden('Only owners and admins choose the repositories.')
  const body = (await request.json().catch(() => null)) as { repo?: unknown } | null
  const repo = typeof body?.repo === 'string' ? body.repo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '') : ''
  if (!REPO_RE.test(repo)) return badRequest('repo must be owner/name')
  const { error } = await auth.supabase
    .from('workspace_github_repo')
    .upsert({ workspace_id: auth.workspaceId, repo_full_name: repo.toLowerCase(), added_by: auth.user.id }, { onConflict: 'workspace_id,repo_full_name', ignoreDuplicates: true })
  if (error) return serverError(error.message)
  return NextResponse.json({ repo: repo.toLowerCase() }, { status: 201 })
}

export async function DELETE(request: Request) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (!ADMIN.has(auth.member.role ?? '')) return forbidden('Only owners and admins choose the repositories.')
  const repo = (new URL(request.url).searchParams.get('repo') ?? '').trim()
  if (!REPO_RE.test(repo)) return badRequest('repo must be owner/name')
  const { error } = await auth.supabase.from('workspace_github_repo').delete().eq('workspace_id', auth.workspaceId).eq('repo_full_name', repo.toLowerCase())
  if (error) return serverError(error.message)
  return NextResponse.json({ removed: repo.toLowerCase() })
}
