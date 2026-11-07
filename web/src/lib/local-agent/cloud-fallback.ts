/**
 * The offline fallback (docs/plans/environments.md §3, "Offline Mac"): when
 * the Mac is offline, a job in one of its folders may run as a cloud coding
 * run instead of waiting up to 6 hours, but only when ALL of these hold:
 *   1. the folder's linked repo (device_folder_setting.repo_full_name, set
 *      in its environment, or when a pull request opened from it) is the
 *      `github_repo` of a project in the chat's workspace;
 *   2. it runs in THAT project's shared cloud environment (its own, else the
 *      workspace's default: where that project's runs run);
 *   3. the person says yes in chat first, to a question that names the
 *      environment and its network level (the chat tool's note says so).
 * Otherwise nothing is offered: the chat says the Mac is offline and waits.
 * No name guess: a folder with no linked repo is never matched, and a
 * folder's work never runs under another workspace's setup script.
 *
 * A coding run needs the person's GitHub sign-in, so none is offered without
 * it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { projectRunEnvironment } from '@/lib/environments/resolve'
import { isRepoFullName, type NetworkAccess } from '@/lib/environments/types'

type Svc = SupabaseClient

export interface CloudFallback {
  /** `owner/repo`, as the project holds it. */
  repo: string
  projectId: string
  project: string
  /** The project's shared cloud environment the run would start in. */
  environmentId: string
  environment: string
  networkAccess: NetworkAccess
}

/** The person signed in to GitHub (a coding run pushes as them). */
export async function hasGithub(svc: Svc, userId: string): Promise<boolean> {
  const { data } = await svc
    .from('user_oauth_tokens')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'github')
    .eq('capability', 'github')
    .limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * The project and cloud environment a cloud coding run could stand in for the
 * Mac with, or null. Never throws: an offer that can't be worked out is
 * simply not made.
 */
export async function cloudFallbackFor(
  svc: Svc,
  input: { userId: string; workspaceId: string; folderId: string },
): Promise<CloudFallback | null> {
  try {
    const { data: folder } = await svc
      .from('device_folder')
      .select('id, is_git, revoked_at')
      .eq('id', input.folderId)
      .eq('user_id', input.userId)
      .maybeSingle()
    const f = folder as { is_git?: boolean; revoked_at?: string | null } | null
    if (!f || f.revoked_at || f.is_git !== true) return null

    // 1. The folder's linked repo, set by the person (never guessed from its name).
    const { data: setting } = await svc.from('device_folder_setting').select('repo_full_name').eq('device_folder_id', input.folderId).maybeSingle()
    const linked = ((setting as { repo_full_name?: unknown } | null)?.repo_full_name ?? null) as string | null
    if (typeof linked !== 'string' || !linked.trim()) return null
    const want = linked.trim().toLowerCase()

    // …is a project's repo in the chat's workspace.
    const { data: rows } = await svc
      .from('projects')
      .select('id, name, github_repo')
      .eq('workspace_id', input.workspaceId)
      .not('github_repo', 'is', null)
      .limit(200)
    const matches = ((rows ?? []) as Array<{ id: string; name: string | null; github_repo: string | null }>).filter(
      // A member-written field: only an owner/repo counts (it reaches the model).
      (p) => isRepoFullName(p.github_repo?.trim()) && p.github_repo!.trim().toLowerCase() === want,
    )
    if (matches.length === 0) return null

    // 2. That project's shared cloud environment. Several projects on the one
    //    repo must agree on it: a guess between two setups is no offer.
    const envs = await Promise.all(
      matches.map((p) => projectRunEnvironment(svc, { projectId: p.id, workspaceId: input.workspaceId })),
    )
    const first = envs[0]
    if (!first || envs.some((e) => !e || e.environmentId !== first.environmentId)) return null
    if (!(await hasGithub(svc, input.userId))) return null
    const pick = matches[0]
    return {
      repo: pick.github_repo!.trim(),
      projectId: pick.id,
      project: pick.name?.trim() || pick.github_repo!.trim(),
      environmentId: first.environmentId,
      environment: first.name,
      networkAccess: first.networkAccess,
    }
  } catch (err) {
    console.warn('[local-agent] cloud fallback lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}
