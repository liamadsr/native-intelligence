/**
 * The git push gate (git-push-proxy.ts): the only way a coding run's commits
 * reach GitHub. The hole it closes: a run's sandbox used to hold a GitHub
 * credential that could push the site's live branch, held back only by a hook
 * the model could skip. Now:
 *   - a push to the default branch, or any branch but the run's, is refused,
 *     and nothing reaches GitHub;
 *   - the run's own branch goes through, with the run's GitHub token, to the
 *     run's repo (from the database, never the request);
 *   - a bad token, or a run that has ended, pushes nothing.
 * The last block drives REAL git (a push from a shallow clone, like the
 * sandbox's) through the gate into a local bare repo standing in for GitHub.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

import { GIT_PUSH_PATH, handleGitPush, type GitPushProxyDeps, type PushTarget } from '../git-push-proxy'
import { mintGitPushToken, verifyGitPushToken } from '../git-push-token'

const SECRET = 'test-agent-run-secret-gate-0000000'
// Set at load: some it.each tables mint tokens while the suite is collected.
process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
const BRANCH = 'dial8/web-7-run00007'
const RUN = { agentRunId: 'run-bright-loom-7', workspaceId: 'ws-bright-loom', repoFullName: 'bright-loom/site', branchName: BRANCH }
const GH_TOKEN = 'gho_brightloom_owner_token'
const TARGET: PushTarget = { repoFullName: 'bright-loom/site', branchName: BRANCH, baseBranch: 'main', githubToken: GH_TOKEN }
const GH_BASIC = 'Basic ' + Buffer.from(`x-access-token:${GH_TOKEN}`).toString('base64')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const Z = '0'.repeat(40)
const pkt = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s
const CAPS = '\0report-status side-band-64k agent=git/2.45.0'
/** Bytes typed as fetch/Request accept them (a plain ArrayBuffer view). */
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
function cat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const pushBody = (...cmds: string[]) =>
  bytes(cmds.map((c, i) => pkt(`${c}${i === 0 ? CAPS : ''}\n`)).join('') + '0000' + 'PACK\0\0\0\x02rest-of-pack')

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
})

function deps(over: Partial<GitPushProxyDeps> = {}) {
  const fetchImpl = vi.fn(async () => new Response('upstream-ok', { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } }))
  const loadTarget = vi.fn(async () => TARGET as PushTarget | { refused: string })
  return { verifyToken: (t: string | null) => verifyGitPushToken(t), loadTarget, fetchImpl, ...over } as GitPushProxyDeps & {
    fetchImpl: typeof fetchImpl
    loadTarget: typeof loadTarget
  }
}

function auth(token = mintGitPushToken(RUN)) {
  return { authorization: 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64') }
}

function post(body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = auth()) {
  return new Request(`https://app.test${GIT_PUSH_PATH}/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request', ...headers },
    body,
  })
}

describe('handleGitPush: receive-pack', () => {
  it("forwards the run's own branch to the run's repo on GitHub, with the run's GitHub token", async () => {
    const d = deps()
    const body = pushBody(`${A} ${B} refs/heads/${BRANCH}`)
    const res = await handleGitPush(post(body), ['git-receive-pack'], d)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('upstream-ok')
    expect(d.loadTarget).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: RUN.agentRunId, workspaceId: RUN.workspaceId }))
    const [url, init] = d.fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://github.com/bright-loom/site.git/git-receive-pack')
    expect((init.headers as Record<string, string>).authorization).toBe(GH_BASIC)
    expect(Buffer.from(init.body as Uint8Array).equals(body)).toBe(true)
  })

  it.each([
    ['the default branch', `${A} ${B} refs/heads/main`],
    ['a new default-looking branch', `${Z} ${B} refs/heads/master`],
    ["another run's branch", `${A} ${B} refs/heads/dial8/web-8-run00008`],
    ['a tag', `${Z} ${B} refs/tags/v1`],
    ['a delete of its own branch', `${A} ${Z} refs/heads/${BRANCH}`],
  ])('refuses %s as git\'s "[remote rejected]", and nothing reaches GitHub', async (_label, cmd) => {
    const d = deps()
    const res = await handleGitPush(post(pushBody(cmd)), ['git-receive-pack'], d)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-git-receive-pack-result')
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1')
    expect(text).toContain('ng refs/')
    expect(text).toContain('dial8:')
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses the whole push when its own branch rides with the default branch', async () => {
    const d = deps()
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${BRANCH}`, `${A} ${B} refs/heads/main`)), ['git-receive-pack'], d)
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1')
    expect(text).toContain(`ng refs/heads/${BRANCH}`)
    expect(text).toContain('ng refs/heads/main')
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it('a client that asked for no report gets a 403', async () => {
    const d = deps()
    const raw = bytes(pkt(`${A} ${B} refs/heads/main\0side-band-64k\n`) + '0000')
    const res = await handleGitPush(post(raw), ['git-receive-pack'], d)
    expect(res.status).toBe(403)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a malformed command list (fail closed)', async () => {
    const d = deps()
    const raw = bytes(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`) + '0004' + pkt(`${A} ${B} refs/heads/main\n`) + '0000')
    const res = await handleGitPush(post(raw), ['git-receive-pack'], d)
    expect(res.status).toBe(400)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it("answers git's auth probe without touching GitHub", async () => {
    const d = deps()
    const res = await handleGitPush(post(bytes('0000')), ['git-receive-pack'], d)
    expect(res.status).toBe(200)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['no credential', {}],
    ['a run token instead of a push token', { authorization: 'Bearer not.apushtoken' }],
    ['an expired push token', auth(mintGitPushToken(RUN, Date.now() - 7 * 60 * 60 * 1000))],
  ])('refuses %s with a 403 (never a 401 password prompt), before reading the run', async (_label, headers) => {
    const d = deps()
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${BRANCH}`), headers as Record<string, string>), ['git-receive-pack'], d)
    expect(res.status).toBe(403)
    expect(d.loadTarget).not.toHaveBeenCalled()
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['a project re-pointed at another repo mid-run', { ...TARGET, repoFullName: 'bright-loom/other-site' }],
    ['a run whose branch changed', { ...TARGET, branchName: 'dial8/web-7-other000' }],
  ])('refuses %s: the push token binds the repo and branch it was minted for', async (_label, target) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ loadTarget: vi.fn(async () => target) })
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${target.branchName}`)), ['git-receive-pack'], d)
    expect(res.status).toBe(403)
    expect(d.fetchImpl).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('refuses a push with push options, so no unjudged section reaches GitHub', async () => {
    const d = deps()
    const raw = bytes(pkt(`${A} ${B} refs/heads/${BRANCH}\0report-status push-options\n`) + '0000' + pkt('ci.skip\n') + '0000' + 'PACK')
    const res = await handleGitPush(post(raw), ['git-receive-pack'], d)
    expect(res.status).toBe(400)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it('a run that has ended pushes nothing', async () => {
    const d = deps({ loadTarget: vi.fn(async () => ({ refused: 'this run has ended' })) })
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${BRANCH}`)), ['git-receive-pack'], d)
    expect(res.status).toBe(403)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['is its base', { ...TARGET, branchName: 'main' }],
    ['is not a run branch', { ...TARGET, branchName: 'release' }],
  ])('refuses a run whose branch %s, whatever the push names', async (_label, target) => {
    const d = deps({ loadTarget: vi.fn(async () => target) })
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${target.branchName}`)), ['git-receive-pack'], d)
    expect(res.status).toBe(403)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it('a run that cannot be read is a hold (503), never a push', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ loadTarget: vi.fn(async () => { throw new Error('db down') }) })
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${BRANCH}`)), ['git-receive-pack'], d)
    expect(res.status).toBe(503)
    expect(d.fetchImpl).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('refuses a compressed body it cannot read', async () => {
    const d = deps()
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${BRANCH}`), { ...auth(), 'content-encoding': 'gzip' }), ['git-receive-pack'], d)
    expect(res.status).toBe(400)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('handleGitPush: the rest of the surface', () => {
  it('serves the push advertisement from the run\'s repo', async () => {
    const d = deps()
    const res = await handleGitPush(
      new Request(`https://app.test${GIT_PUSH_PATH}/info/refs?service=git-receive-pack`, { headers: auth() }),
      ['info', 'refs'],
      d,
    )
    expect(res.status).toBe(200)
    const [url, init] = d.fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://github.com/bright-loom/site.git/info/refs?service=git-receive-pack')
    expect((init.headers as Record<string, string>).authorization).toBe(GH_BASIC)
  })

  it('never serves a fetch (upload-pack): reads go to GitHub directly', async () => {
    const d = deps()
    const adv = await handleGitPush(new Request(`https://app.test${GIT_PUSH_PATH}/info/refs?service=git-upload-pack`, { headers: auth() }), ['info', 'refs'], d)
    expect(adv.status).toBe(403)
    const up = await handleGitPush(new Request(`https://app.test${GIT_PUSH_PATH}/git-upload-pack`, { method: 'POST', headers: auth(), body: '0000' }), ['git-upload-pack'], d)
    expect(up.status).toBe(404)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it('a path naming another repo changes nothing: the repo is always the run\'s', async () => {
    const d = deps()
    const res = await handleGitPush(post(pushBody(`${A} ${B} refs/heads/${BRANCH}`)), ['other', 'repo.git', 'git-receive-pack'], d)
    expect(res.status).toBe(404)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })
})

// ── Real git, end to end ─────────────────────────────────────────────────────

function git(args: string[], opts: { cwd?: string; input?: Buffer; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; stdout: Uint8Array<ArrayBuffer>; stderr: string }>((resolve) => {
    const env = { ...gitEnv, ...opts.env } as unknown as NodeJS.ProcessEnv
    const child = spawn('git', args, { cwd: opts.cwd, env, stdio: 'pipe' })
    const out: Uint8Array[] = []
    let err = ''
    child.stdout.on('data', (c: Uint8Array) => out.push(c))
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('close', (code: number | null) => resolve({ code: code ?? 1, stdout: cat(out), stderr: err }))
    if (opts.input) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

let gitEnv: Record<string, string> = {}

describe('handleGitPush with real git (a shallow clone, like the sandbox)', () => {
  let dir: string
  let bare: string
  let work: string
  let server: Server
  let gateUrl: string
  let target: PushTarget | { refused: string } = TARGET

  /** "GitHub": a local bare repo behind git's own stateless receive-pack. */
  const github: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers.authorization !== GH_BASIC) return new Response('bad credentials', { status: 401 })
    if (url === 'https://github.com/bright-loom/site.git/info/refs?service=git-receive-pack') {
      const adv = await git(['receive-pack', '--stateless-rpc', '--advertise-refs', bare])
      return new Response(cat([bytes(pkt('# service=git-receive-pack\n') + '0000'), adv.stdout]), {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
      })
    }
    if (url === 'https://github.com/bright-loom/site.git/git-receive-pack') {
      const r = await git(['receive-pack', '--stateless-rpc', bare], { input: Buffer.from(init!.body as Uint8Array) })
      return new Response(r.stdout, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } })
    }
    return new Response('not found', { status: 404 })
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dial8-push-gate-'))
    gitEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Bright Loom',
      GIT_AUTHOR_EMAIL: 'owner@brightloom.example',
      GIT_COMMITTER_NAME: 'Bright Loom',
      GIT_COMMITTER_EMAIL: 'owner@brightloom.example',
    }
    writeFileSync(join(dir, 'gitconfig'), '[init]\n\tdefaultBranch = main\n')
    bare = join(dir, 'site.git')
    const seed = join(dir, 'seed')
    await git(['init', '--bare', bare])
    await git(['init', seed])
    for (const n of [1, 2, 3]) {
      writeFileSync(join(seed, 'index.html'), `<h1>Bright Loom ${n}</h1>\n`)
      await git(['add', '.'], { cwd: seed })
      await git(['commit', '-m', `site ${n}`], { cwd: seed })
    }
    await git(['push', bare, 'main'], { cwd: seed })

    server = createServer(async (req, res) => {
      const chunks: Uint8Array[] = []
      for await (const c of req) chunks.push(c as Uint8Array)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === 'POST' ? cat(chunks) : undefined,
      })
      const segments = url.pathname.slice(GIT_PUSH_PATH.length + 1).split('/')
      const out = await handleGitPush(request, segments, {
        verifyToken: (t) => verifyGitPushToken(t),
        loadTarget: async () => target,
        fetchImpl: github,
      })
      res.writeHead(out.status, Object.fromEntries(out.headers))
      res.end(Buffer.from(await out.arrayBuffer()))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    gateUrl = `http://127.0.0.1:${port}${GIT_PUSH_PATH}`

    // The sandbox's setup: a shallow clone, the gate as push URL, the push
    // token for that URL only, the run's branch checked out.
    process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
    work = join(dir, 'work')
    await git(['clone', '--depth', '1', `file://${bare}`, work])
    await git(['config', 'remote.origin.pushurl', gateUrl], { cwd: work })
    await git(['config', `http.${gateUrl}.extraheader`, `Authorization: ${auth().authorization}`], { cwd: work })
    await git(['checkout', '-b', BRANCH], { cwd: work })
    writeFileSync(join(work, 'index.html'), '<h1>Bright Loom</h1><p>Call +16465550173</p>\n')
    await git(['commit', '-am', 'Add the phone number'], { cwd: work })
  }, 30_000)

  beforeEach(() => {
    target = TARGET
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  const refOf = async (ref: string) => Buffer.from((await git(['rev-parse', '--verify', '--quiet', ref], { cwd: bare })).stdout).toString().trim()

  it('a push of the default branch is refused and the live branch does not move', async () => {
    const before = await refOf('refs/heads/main')
    const r = await git(['push', 'origin', `HEAD:refs/heads/main`], { cwd: work })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('[remote rejected]')
    expect(r.stderr).toContain('dial8: this run may only push its own branch')
    expect(await refOf('refs/heads/main')).toBe(before)
  })

  it('a push to another branch, or a tag, is refused too', async () => {
    const other = await git(['push', 'origin', 'HEAD:refs/heads/gh-pages'], { cwd: work })
    expect(other.code).not.toBe(0)
    expect(await refOf('refs/heads/gh-pages')).toBe('')
    await git(['tag', 'v9'], { cwd: work })
    const tag = await git(['push', 'origin', 'v9'], { cwd: work })
    expect(tag.code).not.toBe(0)
    expect(await refOf('refs/tags/v9')).toBe('')
  })

  it("the run's own branch is accepted and lands on GitHub", async () => {
    const head = Buffer.from((await git(['rev-parse', 'HEAD'], { cwd: work })).stdout).toString().trim()
    const r = await git(['push', 'origin', BRANCH], { cwd: work })
    expect(r.stderr).not.toContain('rejected')
    expect(r.code).toBe(0)
    expect(await refOf(`refs/heads/${BRANCH}`)).toBe(head)
  })

  it('deleting its own branch is refused', async () => {
    const r = await git(['push', 'origin', `:refs/heads/${BRANCH}`], { cwd: work })
    expect(r.code).not.toBe(0)
    expect(await refOf(`refs/heads/${BRANCH}`)).not.toBe('')
  })

  it('once the run has ended, even its own branch is refused', async () => {
    target = { refused: 'this run has ended' }
    writeFileSync(join(work, 'index.html'), '<h1>Bright Loom</h1><p>late</p>\n')
    await git(['commit', '-am', 'late'], { cwd: work })
    const before = await refOf(`refs/heads/${BRANCH}`)
    const r = await git(['push', 'origin', BRANCH], { cwd: work })
    expect(r.code).not.toBe(0)
    expect(await refOf(`refs/heads/${BRANCH}`)).toBe(before)
  })
})
