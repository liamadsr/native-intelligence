import { describe, it, expect, vi } from 'vitest'
import { lookupRepoDefaultBranch, resolveRepoDefaultBranch, FALLBACK_BASE_BRANCH } from '../github-default-branch'

const json = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('resolveRepoDefaultBranch', () => {
  it("returns the repo's default_branch ('master')", async () => {
    const fetchImpl = json(200, { default_branch: 'master' })
    await expect(resolveRepoDefaultBranch('acme/legacy', 'ghp_x', { fetchImpl })).resolves.toBe('master')
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/acme/legacy')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_x')
  })

  it.each([
    ['a 404', json(404, { message: 'Not Found' })],
    ['a missing field', json(200, {})],
    ['an unsafe ref', json(200, { default_branch: "main'; rm -rf /" })],
    ['a traversal ref', json(200, { default_branch: 'a/../b' })],
    ['a network error', vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch],
  ])('falls back to main on %s', async (_label, fetchImpl) => {
    await expect(resolveRepoDefaultBranch('acme/web', 'ghp_x', { fetchImpl })).resolves.toBe(FALLBACK_BASE_BRANCH)
  })
})

describe('lookupRepoDefaultBranch — no guessing', () => {
  it("returns the repo's default_branch", async () => {
    const fetchImpl = json(200, { default_branch: 'develop' })
    await expect(lookupRepoDefaultBranch('acme/legacy', 'ghp_x', { fetchImpl })).resolves.toBe('develop')
  })

  it.each([
    ['a 403 (rate limit)', json(403, { message: 'API rate limit exceeded' })],
    ['a missing field', json(200, {})],
    ['an unsafe ref', json(200, { default_branch: "main'; rm -rf /" })],
    ['a network error', vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch],
  ])('returns null (never main) on %s', async (_label, fetchImpl) => {
    await expect(lookupRepoDefaultBranch('acme/web', 'ghp_x', { fetchImpl })).resolves.toBeNull()
  })
})
