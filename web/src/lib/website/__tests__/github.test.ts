/**
 * The website flow's GitHub calls (roadmap track E): the merge pinned to the
 * approved head (and its method fallback), the preview and production deploy
 * reads, the revert, and the shapes they trust.
 */
import { describe, expect, it, vi } from 'vitest'
import { findPreviewUrl, getPull, isProductionEnvironment, listOwnerRepos, mergePull, parsePullUrl, productionDeploy, revertPull, toRepoFacts } from '../github'

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown }

function fakeFetch(route: Route) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    const { status, body } = route(u, init)
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const SHA = 'a'.repeat(40)

describe('repos', () => {
  it('keeps only well-formed repos and reads push permission', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: [
        { full_name: 'jane/site', default_branch: 'main', permissions: { push: true }, homepage: 'https://janes.com' },
        { full_name: 'jane/readonly', default_branch: 'main', permissions: { pull: true } },
        { full_name: 'not a repo', default_branch: 'main' },
        { full_name: 'jane/bad-branch', default_branch: '../etc' },
      ],
    }))
    const got = await listOwnerRepos({ token: 't', fetchImpl })
    expect(got.ok && got.value.map((r) => [r.fullName, r.canPush])).toEqual([
      ['jane/site', true],
      ['jane/readonly', false],
    ])
  })

  it('an admin or maintainer may push too', () => {
    expect(toRepoFacts({ full_name: 'a/b', default_branch: 'main', permissions: { admin: true } })?.canPush).toBe(true)
    expect(toRepoFacts({ full_name: 'a/b', default_branch: 'main', permissions: { maintain: true } })?.canPush).toBe(true)
  })
})

describe('mergePull', () => {
  it('pins the merge to the approved head and squashes when allowed', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { sha: 'b'.repeat(40), merged: true } }))
    const out = await mergePull({ token: 't', fetchImpl }, 'jane/site', 7, SHA, 'Send website quote requests to Dial8')
    expect(out).toEqual({ ok: true, sha: 'b'.repeat(40), method: 'squash' })
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/jane/site/pulls/7/merge', method: 'PUT', body: { sha: SHA, merge_method: 'squash' } })
  })

  it('falls back to a merge commit, then a rebase, when the repo forbids a method', async () => {
    const { fetchImpl, calls } = fakeFetch((_url, init) => {
      const method = JSON.parse(String(init?.body)).merge_method
      if (method === 'squash') return { status: 405, body: { message: 'Squash merges are not allowed on this repository.' } }
      if (method === 'merge') return { status: 405, body: { message: 'Merge commits are not allowed on this repository.' } }
      return { status: 200, body: { sha: 'c'.repeat(40) } }
    })
    expect(await mergePull({ token: 't', fetchImpl }, 'jane/site', 7, SHA, 't')).toEqual({ ok: true, sha: 'c'.repeat(40), method: 'rebase' })
    expect(calls.map((c) => (c.body as { merge_method: string }).merge_method)).toEqual(['squash', 'merge', 'rebase'])
  })

  it('refuses a head that moved, a conflict and a forbidden token, without trying further', async () => {
    const moved = fakeFetch(() => ({ status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } }))
    expect(await mergePull({ token: 't', fetchImpl: moved.fetchImpl }, 'jane/site', 7, SHA, 't')).toMatchObject({ ok: false, code: 'HEAD_MOVED' })
    expect(moved.calls).toHaveLength(1)
    const conflict = fakeFetch(() => ({ status: 405, body: { message: 'Pull Request is not mergeable' } }))
    expect(await mergePull({ token: 't', fetchImpl: conflict.fetchImpl }, 'jane/site', 7, SHA, 't')).toMatchObject({ ok: false, code: 'NOT_MERGEABLE' })
    const forbidden = fakeFetch(() => ({ status: 403, body: { message: 'Resource not accessible' } }))
    expect(await mergePull({ token: 't', fetchImpl: forbidden.fetchImpl }, 'jane/site', 7, SHA, 't')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('refuses a malformed sha before calling GitHub', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }))
    expect(await mergePull({ token: 't', fetchImpl }, 'jane/site', 7, 'main', 't')).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })
})

describe('deploys', () => {
  it('finds a PR preview from a non-production deployment', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.includes('/deployments?sha=')) return { status: 200, body: [{ id: 11, environment: 'Preview', production_environment: false, creator: { login: 'vercel[bot]', type: 'Bot' } }, { id: 12, environment: 'Production', production_environment: true, creator: { login: 'vercel[bot]', type: 'Bot' } }] }
      if (url.endsWith('/deployments/11/statuses?per_page=5')) return { status: 200, body: [{ state: 'success', environment_url: 'https://site-git-dial8-jane.vercel.app' }] }
      return { status: 404 }
    })
    expect(await findPreviewUrl({ token: 't', fetchImpl }, 'jane/site', SHA)).toEqual({ state: 'success', url: 'https://site-git-dial8-jane.vercel.app/' })
  })

  it("never texts a preview a person's workflow made, or one off a preview host's own domain", async () => {
    const at = (deployment: Record<string, unknown>, url: string) =>
      fakeFetch((u) => {
        if (u.includes('/deployments?sha=')) return { status: 200, body: [{ id: 11, environment: 'Preview', ...deployment }] }
        if (u.endsWith('/deployments/11/statuses?per_page=5')) return { status: 200, body: [{ state: 'success', environment_url: url }] }
        if (u.endsWith('/status')) return { status: 200, body: { statuses: [] } }
        return { status: 404 }
      }).fetchImpl
    expect((await findPreviewUrl({ token: 't', fetchImpl: at({ creator: { login: 'someone', type: 'User' } }, 'https://site.vercel.app') }, 'jane/site', SHA)).url).toBeNull()
    // Any workflow on the branch runs as github-actions[bot]: never a host's preview.
    expect((await findPreviewUrl({ token: 't', fetchImpl: at({ creator: { login: 'github-actions[bot]', type: 'Bot' } }, 'https://phish.pages.dev') }, 'jane/site', SHA)).url).toBeNull()
    expect((await findPreviewUrl({ token: 't', fetchImpl: at({ creator: { login: 'vercel[bot]', type: 'Bot' } }, 'https://login-check.example.com') }, 'jane/site', SHA)).url).toBeNull()
  })

  it('finds a Netlify deploy preview from a commit status on its own domain, and nothing from elsewhere', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.includes('/deployments?sha=')) return { status: 200, body: [] }
      if (url.endsWith('/status')) {
        return {
          status: 200,
          body: {
            statuses: [
              { state: 'success', target_url: 'https://evil.example.com/x', creator: { login: 'netlify[bot]', type: 'Bot' } },
              { state: 'success', target_url: 'https://deploy-preview-7--phish.netlify.app', creator: { login: 'github-actions[bot]', type: 'Bot' } },
              { state: 'success', target_url: 'https://deploy-preview-7--janes.netlify.app', creator: { login: 'netlify[bot]', type: 'Bot' } },
            ],
          },
        }
      }
      return { status: 404 }
    })
    expect(await findPreviewUrl({ token: 't', fetchImpl }, 'jane/site', SHA)).toEqual({ state: 'success', url: 'https://deploy-preview-7--janes.netlify.app/' })
  })

  it('reads the production deploy: pending, success, failure, none', async () => {
    const at = (state: string | null) =>
      fakeFetch((url) => {
        if (url.includes('/deployments?sha=')) return { status: 200, body: state === null ? [] : [{ id: 1, environment: 'github-pages' }] }
        return { status: 200, body: [{ state, environment_url: 'https://janes.com' }] }
      }).fetchImpl
    expect((await productionDeploy({ token: 't', fetchImpl: at('in_progress') }, 'jane/site', SHA)).state).toBe('pending')
    expect(await productionDeploy({ token: 't', fetchImpl: at('success') }, 'jane/site', SHA)).toEqual({ state: 'success', url: 'https://janes.com/' })
    expect((await productionDeploy({ token: 't', fetchImpl: at('failure') }, 'jane/site', SHA)).state).toBe('failure')
    expect((await productionDeploy({ token: 't', fetchImpl: at(null) }, 'jane/site', SHA)).state).toBe('none')
  })

  it('names production environments the hosts use', () => {
    expect(isProductionEnvironment('Production', false)).toBe(true)
    expect(isProductionEnvironment('github-pages', false)).toBe(true)
    expect(isProductionEnvironment('Production – janes-site', false)).toBe(true)
    expect(isProductionEnvironment('Preview', false)).toBe(false)
    expect(isProductionEnvironment('anything', true)).toBe(true)
  })
})

describe('pull request files', () => {
  it('names the files and the outside hosts the diff adds (not ones it only moves)', async () => {
    const { addedHostsOf, getPullFiles } = await import('../github')
    expect(addedHostsOf(['@@ -1 +1 @@\n-<a href="https://old.com">\n+<script src="https://cdn.evil.io/x.js"></script>\n+<a href="https://old.com">', '+fetch("https://dial8.ai/api/intake/quotes/x")', '+<script src="//cdn.sneaky.net/a.js">'])).toEqual(['cdn.evil.io', 'cdn.sneaky.net', 'dial8.ai'])
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: [{ filename: 'app/quote/page.tsx', patch: '+const U = "https://dial8.ai/x"' }] }))
    expect(await getPullFiles({ token: 't', fetchImpl }, 'jane/site', 7)).toEqual({ ok: true, value: { files: ['app/quote/page.tsx'], addedHosts: ['dial8.ai'], complete: true } })
    const big = fakeFetch(() => ({ status: 200, body: [{ filename: 'public/photo.jpg' }] }))
    expect(await getPullFiles({ token: 't', fetchImpl: big.fetchImpl }, 'jane/site', 7)).toMatchObject({ ok: true, value: { complete: false } })
  })
})

describe('pull requests', () => {
  it('reads a pull request and parses its URL', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { number: 7, node_id: 'PR_x', html_url: 'https://github.com/jane/site/pull/7', title: 'T', body: 'Owner summary: Hi.', state: 'open', head: { sha: SHA }, base: { ref: 'main' }, changed_files: 2 } }))
    const got = await getPull({ token: 't', fetchImpl }, 'jane/site', 7)
    expect(got.ok && got.value).toMatchObject({ number: 7, nodeId: 'PR_x', headSha: SHA, changedFiles: 2, state: 'open' })
    expect(parsePullUrl('https://github.com/jane/site/pull/7')).toEqual({ repo: 'jane/site', number: 7 })
    expect(parsePullUrl('https://github.com/jane/site/issues/7')).toBeNull()
    expect(parsePullUrl('https://gitlab.com/jane/site/pull/7')).toBeNull()
  })

  it("makes GitHub's own revert and reads its number", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: { revertPullRequest: { revertPullRequest: { number: 9, url: 'https://github.com/jane/site/pull/9' } } } } }))
    expect(await revertPull({ token: 't', fetchImpl }, { nodeId: 'PR_x', title: 'Undo', body: 'b' })).toEqual({ ok: true, value: { number: 9, url: 'https://github.com/jane/site/pull/9' } })
    expect(calls[0].url).toBe('https://api.github.com/graphql')
    const failed = fakeFetch(() => ({ status: 200, body: { errors: [{ message: 'cannot revert' }] } }))
    expect(await revertPull({ token: 't', fetchImpl: failed.fetchImpl }, { nodeId: 'PR_x', title: 'Undo', body: 'b' })).toMatchObject({ ok: false, error: 'cannot revert' })
  })
})
