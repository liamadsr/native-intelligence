/**
 * Resolve a repository's default branch for a coding run (the clone ref and
 * the PR base). Main's retired runner cloned with no ref, which follows the
 * repo's default branch; the eve sandbox clones `--branch <base>` explicitly,
 * so the base has to be the REAL default (`master`, `develop`, …), not an
 * assumed 'main'.
 *
 * GET /repos/{owner}/{repo} with the triggering user's token.
 * - lookupRepoDefaultBranch: the branch, or null on any failure (network, 404,
 *   rate limit, a malformed name or answer). For a check that must not guess.
 * - resolveRepoDefaultBranch: the same, falling back to 'main', the old
 *   constant, so a GitHub blip never makes a run less runnable than before.
 */
export const FALLBACK_BASE_BRANCH = 'main'

/** A ref name we are willing to hand to `git clone --branch` (shell-quoted there too). */
const SAFE_REF = /^[A-Za-z0-9._\/-]{1,200}$/

type LookupOpts = { fetchImpl?: typeof fetch; timeoutMs?: number }

export async function lookupRepoDefaultBranch(
  repoFullName: string,
  githubToken: string,
  opts: LookupOpts = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { default_branch?: unknown }
    const branch = body?.default_branch
    if (typeof branch === 'string' && SAFE_REF.test(branch) && !branch.includes('..')) return branch
    return null
  } catch {
    return null
  }
}

export async function resolveRepoDefaultBranch(
  repoFullName: string,
  githubToken: string,
  opts: LookupOpts = {},
): Promise<string> {
  return (await lookupRepoDefaultBranch(repoFullName, githubToken, opts)) ?? FALLBACK_BASE_BRANCH
}
