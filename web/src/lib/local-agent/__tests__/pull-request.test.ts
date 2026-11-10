/**
 * C5's server half (teammate plan, WS-C): what a pull request for a local
 * agent's branch may name, and the server opening it with the person's Native Intelligence
 * GitHub sign-in (open-pull-request.ts), the way the agent-run outcome route
 * does: only the session's own branch, github.com only, replay-safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isPlainBranchName,
  isPullRequestUrl,
  isSessionBranch,
  parseRemoteRepo,
  repoFullName,
} from '../pull-request'
import { openSessionPullRequest } from '../open-pull-request'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { createSession } from '../store'
import { CONV, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

describe('pull request helpers', () => {
  it('parses push URLs as push.rs sends them', () => {
    expect(parseRemoteRepo('https://github.com/liamadsr/native-intelligence.git')).toEqual({ host: 'github.com', owner: 'liamadsr', repo: 'native-intelligence' })
    expect(parseRemoteRepo('https://github.com/liamadsr/native-intelligence')).toEqual({ host: 'github.com', owner: 'liamadsr', repo: 'native-intelligence' })
    expect(parseRemoteRepo('git@github.com:liamadsr/native-intelligence.git')).toEqual({ host: 'github.com', owner: 'liamadsr', repo: 'native-intelligence' })
    expect(parseRemoteRepo('ssh://git@GitHub.com/o/r.git')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
    expect(parseRemoteRepo('https://gitlab.example.com/o/r.git')).toEqual({ host: 'gitlab.example.com', owner: 'o', repo: 'r' })
    expect(repoFullName(parseRemoteRepo('git@github.com:o/r.git')!)).toBe('o/r')
    for (const bad of ['', 'not a url', 'https://github.com/o', 'https://github.com/o/r/extra', 'https://github.com/../r', 'file:///Users/l/r', 'https://github.com/o/r x', 42, null]) {
      expect(parseRemoteRepo(bad), String(bad)).toBeNull()
    }
  })

  it('takes only a plain branch, and only the session’s own', () => {
    expect(isPlainBranchName('main')).toBe(true)
    expect(isPlainBranchName('release/v1.2')).toBe(true)
    for (const bad of ['', '-x', '/x', 'x/', 'a..b', 'a//b', 'x.lock', 'a b', 'a:b', 'x.', '.hidden', 'a/.b', 'x'.repeat(301)]) {
      expect(isPlainBranchName(bad), bad).toBe(false)
    }
    const s = { id: '38cb0eef-89e9-496d-bf08-0688225dbfcd', branch: null }
    expect(isSessionBranch('dial8/native-intelligence-38cb0eef', s)).toBe(true)
    expect(isSessionBranch('dial8/other-12345678', s)).toBe(false)
    expect(isSessionBranch('main', s)).toBe(false)
    expect(isSessionBranch('dial8/x-38cb0eef', { ...s, branch: 'dial8/native-intelligence-38cb0eef' })).toBe(false)
    expect(isSessionBranch('dial8/native-intelligence-38cb0eef', { ...s, branch: 'dial8/native-intelligence-38cb0eef' })).toBe(true)
  })

  it('knows a pull request URL', () => {
    expect(isPullRequestUrl('https://github.com/o/r/pull/12')).toBe(true)
    expect(isPullRequestUrl('https://ghe.corp.example:8443/o/r/pull/3')).toBe(true)
    for (const bad of ['http://github.com/o/r/pull/1', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/1 x', 'https://github.com/o/r/pull/1?x', `https://github.com/o/r/pull/${'1'.repeat(11)}`]) {
      expect(isPullRequestUrl(bad), bad).toBe(false)
    }
  })
})

describe('openSessionPullRequest', () => {
  let db: FakeDb
  let sid: string
  let row: Record<string, unknown>
  let branch: string
  const claims = () => ({ sid, uid: USER, wid: WS })
  const body = (extra: Record<string, unknown> = {}) => ({
    sessionId: sid, remoteUrl: 'https://github.com/liamadsr/native-intelligence.git', branch, base: 'main', title: 'Fix the login redirect', body: 'Fixes it.', ...extra,
  })
  const token = async () => 'gho_test'

  beforeEach(async () => {
    db = seeded()
    const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'agent' })
    sid = session.id
    branch = `dial8/native-intelligence-${sid.slice(0, 8)}`
    row = db.tables.local_agent_session.find((s) => s.id === sid)!
    Object.assign(row, { status: 'waiting', run_id: 'r' })
  })
  afterEach(() => vi.restoreAllMocks())

  it('opens it with the person’s GitHub sign-in, on the session’s own branch, and keeps the URL; a replay returns it while it is open', async () => {
    let state = 'open'
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ html_url: 'https://github.com/liamadsr/native-intelligence/pull/12' }), { status: 201 })
        : new Response(JSON.stringify({ state, merged: false }), { status: 200 }),
    )
    const out = await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(out).toEqual({ ok: true, url: 'https://github.com/liamadsr/native-intelligence/pull/12' })
    const create = fetchImpl.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(create[0]).toBe('https://api.github.com/repos/liamadsr/native-intelligence/pulls')
    expect(JSON.parse(String(create[1]!.body))).toEqual({ title: 'Fix the login redirect', body: 'Fixes it.', head: branch, base: 'main' })
    expect((create[1]!.headers as Record<string, string>).Authorization).toBe('Bearer gho_test')
    expect(row.pr_url).toBe('https://github.com/liamadsr/native-intelligence/pull/12')
    // A replay answers with the stored one while GitHub says it's open, without a second create.
    const again = await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(again).toEqual({ ok: true, url: 'https://github.com/liamadsr/native-intelligence/pull/12', reused: true })
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1)
    // Closed (or merged) since: not the answer to a new push; it opens again.
    state = 'closed'
    const reopened = await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(reopened).toEqual({ ok: true, url: 'https://github.com/liamadsr/native-intelligence/pull/12' })
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(2)
  })

  it('a base that isn’t a branch name falls back to the default branch', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.github.com/repos/liamadsr/native-intelligence') return new Response(JSON.stringify({ default_branch: 'develop' }), { status: 200 })
      return new Response(JSON.stringify({ html_url: 'https://github.com/liamadsr/native-intelligence/pull/3' }), { status: init?.method === 'POST' ? 201 : 200 })
    })
    const out = await openSessionPullRequest(db as never, claims(), body({ base: '--upload-pack=evil' }), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(out).toMatchObject({ ok: true })
    expect(JSON.parse(String(fetchImpl.mock.calls.find((c) => c[1]?.method === 'POST')![1]!.body)).base).toBe('develop')
  })

  it('a create that timed out or failed on GitHub’s side may have landed: it looks for the open one once', async () => {
    for (const create of [async () => { throw new Error('The operation was aborted due to timeout') }, async () => new Response('{"message":"Server Error"}', { status: 502 })]) {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return create()
        return new Response(JSON.stringify([{ html_url: 'https://github.com/liamadsr/native-intelligence/pull/21' }]), { status: 200 })
      })
      row.pr_url = null
      const out = await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })
      expect(out).toEqual({ ok: true, url: 'https://github.com/liamadsr/native-intelligence/pull/21' })
    }
    // Nothing open either: the failure stands.
    const none = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? new Response('{}', { status: 500 }) : new Response('[]', { status: 200 })))
    row.pr_url = null
    expect(await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: none as never, githubToken: token })).toMatchObject({ ok: false, code: 'GITHUB_FAILED' })
  })

  it('a job that ended after the person allowed its push still gets its pull request; one that never pushed doesn’t', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ html_url: 'https://github.com/liamadsr/native-intelligence/pull/30' }), { status: 201 }))
    row.status = 'cancelled'
    expect(await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })).toMatchObject({ ok: false, code: 'ENDED' })
    db.tables.local_agent_event = [{ id: 1, session_id: sid, user_id: USER, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'allowed' }, created_at: new Date().toISOString() }]
    expect(await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })).toEqual({ ok: true, url: 'https://github.com/liamadsr/native-intelligence/pull/30' })
  })

  it('finds the open one after GitHub’s 422, and looks up the base when the Mac couldn’t', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.github.com/repos/liamadsr/native-intelligence') return new Response(JSON.stringify({ default_branch: 'develop' }), { status: 200 })
      if (init?.method === 'POST') return new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] }), { status: 422 })
      return new Response(JSON.stringify([{ html_url: 'https://github.com/liamadsr/native-intelligence/pull/7' }]), { status: 200 })
    })
    const out = await openSessionPullRequest(db as never, claims(), body({ base: null }), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(out).toEqual({ ok: true, url: 'https://github.com/liamadsr/native-intelligence/pull/7' })
    const create = fetchImpl.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(JSON.parse(String(create[1]!.body)).base).toBe('develop')
    expect(fetchImpl.mock.calls.at(-1)![0]).toContain(`head=${encodeURIComponent(`liamadsr:${branch}`)}`)
  })

  it('refuses what isn’t this job’s to open, and says why', async () => {
    const fetchImpl = vi.fn()
    const deps = { fetchImpl: fetchImpl as never, githubToken: token }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sessionId: '00000000-0000-4000-8000-000000000000' }, 'SESSION_MISMATCH'],
      [{ remoteUrl: 'nope' }, 'BAD_REMOTE'],
      [{ remoteUrl: 'https://gitlab.com/o/r.git' }, 'UNSUPPORTED_HOST'],
      [{ title: '' }, 'BAD_TITLE'],
      [{ title: 'x'.repeat(257) }, 'BAD_TITLE'],
      [{ title: '😀'.repeat(257) }, 'BAD_TITLE'],
      [{ body: 'x'.repeat(60_001) }, 'BAD_BODY'],
      [{ branch: 'main' }, 'NOT_THIS_JOBS_BRANCH'],
      [{ branch: 'dial8/other-12345678' }, 'NOT_THIS_JOBS_BRANCH'],
    ]
    for (const [extra, code] of cases) {
      const out = await openSessionPullRequest(db as never, claims(), body(extra), deps)
      expect(out, code).toMatchObject({ ok: false, code })
    }
    // Once the session knows its branch, only that one.
    row.branch = `dial8/renamed-${sid.slice(0, 8)}`
    expect(await openSessionPullRequest(db as never, claims(), body(), deps)).toMatchObject({ ok: false, code: 'NOT_THIS_JOBS_BRANCH' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a read job, an ended one, another person’s or workspace’s, and asks for GitHub when it isn’t connected', async () => {
    const deps = { fetchImpl: vi.fn() as never, githubToken: token }
    row.mode = 'read'
    expect(await openSessionPullRequest(db as never, claims(), body(), deps)).toMatchObject({ ok: false, status: 409, code: 'NOT_AN_EDIT_JOB' })
    row.mode = 'edit'
    row.status = 'cancelled'
    expect(await openSessionPullRequest(db as never, claims(), body(), deps)).toMatchObject({ ok: false, status: 409, code: 'ENDED' })
    row.status = 'waiting'
    expect(await openSessionPullRequest(db as never, { ...claims(), uid: '22222222-2222-4222-8222-222222222222' }, body(), deps)).toMatchObject({ ok: false, status: 404 })
    expect(await openSessionPullRequest(db as never, { ...claims(), wid: '00000000-0000-4000-8000-000000000000' }, body(), deps)).toMatchObject({ ok: false, status: 404 })
    const none = await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: vi.fn() as never, githubToken: async () => null })
    expect(none).toMatchObject({ ok: false, status: 409, code: 'GITHUB_NOT_CONNECTED' })
    expect((none as { error: string }).error).toContain('sign in to gh on your Mac')
  })

  it('counts lengths in code points, as the desktop cuts them', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ html_url: 'https://github.com/liamadsr/native-intelligence/pull/1' }), { status: 201 }))
    // 256 emoji are 512 UTF-16 units: still a title the desktop sends whole.
    const out = await openSessionPullRequest(db as never, claims(), body({ title: '😀'.repeat(256), body: '😀'.repeat(60_000) }), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(out).toMatchObject({ ok: true })
  })

  it('passes GitHub’s refusal on in a few words', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
    const out = await openSessionPullRequest(db as never, claims(), body(), { fetchImpl: fetchImpl as never, githubToken: token })
    expect(out).toEqual({ ok: false, status: 502, code: 'GITHUB_FAILED', error: 'GitHub refused the pull request: Not Found' })
    expect(row.pr_url ?? null).toBeNull()
  })

  it('reads the person’s newest GitHub token', async () => {
    db.tables.user_oauth_tokens = [
      { user_id: USER, provider: 'github', capability: 'github', access_token: 'old', updated_at: '2026-01-01T00:00:00Z' },
      { user_id: USER, provider: 'github', capability: 'github', access_token: 'new', updated_at: '2026-10-01T00:00:00Z' },
      { user_id: USER, provider: 'google', capability: 'mail', access_token: 'g', updated_at: '2026-10-02T00:00:00Z' },
    ]
    expect(await storedGithubToken(db as never, USER)).toBe('new')
    expect(await storedGithubToken(db as never, '22222222-2222-4222-8222-222222222222')).toBeNull()
  })
})
