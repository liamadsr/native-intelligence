/**
 * The git read gate (git-read-proxy.ts): the only way a coding run's sandbox
 * reads its repo from GitHub. The GitHub token never leaves the app: the
 * sandbox side presents the run's git gate token, and the gate adds the
 * GitHub token server-side. Under test:
 *   - each of the four read endpoints goes to the run's repo on GitHub (from
 *     the database, never the request), with the GitHub token and ONLY the
 *     whitelisted client headers (Git-Protocol, Content-Type, Content-Encoding,
 *     Accept): the client's Authorization (the gate token) and cookies never
 *     reach GitHub;
 *   - a wrong method, service or path, a missing, invalid or expired token, a
 *     run that ended or whose repo changed: refused with nothing sent upstream;
 *   - a body over the cap is refused; GitHub's answer is streamed through,
 *     never held; GitHub unreachable is a 502;
 *   - handleGitGate sends the push endpoints to the push gate, unchanged.
 * The last block drives REAL git (a clone and a fetch, protocol v2 and v0)
 * through the gate from a local bare repo standing in for GitHub.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

import { GIT_PUSH_PATH, type PushTarget } from '../git-push-proxy'
import {
  FORWARDED_READ_HEADERS,
  handleGitGate,
  handleGitRead,
  MAX_LFS_ANSWER_BYTES,
  MAX_LFS_REQUEST_BYTES,
  MAX_UPLOAD_PACK_REQUEST_BYTES,
  READS_PER_RUN,
  ReadSlots,
  type GitReadDeps,
} from '../git-read-proxy'
import { mintGitPushToken, verifyGitPushToken } from '../git-push-token'
import { mintAgentRunToken } from '../agent-run-token'

const SECRET = 'test-agent-run-secret-read-gate-00'
// Set at load: some it.each tables mint tokens while the suite is collected.
process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
const BRANCH = 'dial8/web-9-run00009'
const RUN = { agentRunId: 'run-copper-kite-9', workspaceId: 'ws-copper-kite', repoFullName: 'copper-kite/shop', branchName: BRANCH }
const GH_TOKEN = 'gho_copperkite_owner_token'
const TARGET: PushTarget = { repoFullName: 'copper-kite/shop', branchName: BRANCH, baseBranch: 'main', githubToken: GH_TOKEN }
const GH_BASIC = 'Basic ' + Buffer.from(`x-access-token:${GH_TOKEN}`).toString('base64')
const GITHUB = 'https://github.com/copper-kite/shop.git'

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
})

/** Fresh seams per call, with a slot table of their own (so one test's open reads never reach another's). */
function deps(over: Partial<GitReadDeps> = {}) {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response('upstream-ok', {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result', 'set-cookie': 'gh=1', 'x-github-request-id': 'abc' },
    }),
  )
  const loadTarget = vi.fn(async () => TARGET as PushTarget | { refused: string })
  return { verifyToken: (t: string | null) => verifyGitPushToken(t), loadTarget, fetchImpl, readSlots: new ReadSlots(), ...over } as GitReadDeps & {
    fetchImpl: typeof fetchImpl
    loadTarget: typeof loadTarget
    readSlots: ReadSlots
  }
}

const gateToken = () => mintGitPushToken(RUN)
/** ONE gate token instance: a leak check must look for the very token the request carried. */
const GATE_TOKEN = mintGitPushToken(RUN)
const basicAuth = (token: string) => 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64')
const auth = (token = gateToken()) => ({ authorization: basicAuth(token) })

/** The four read endpoints as git and git-lfs call them. */
const ENDPOINTS = [
  { name: 'the clone/fetch advertisement', method: 'GET', path: 'info/refs?service=git-upload-pack', upstream: `${GITHUB}/info/refs?service=git-upload-pack`, type: undefined },
  { name: 'upload-pack', method: 'POST', path: 'git-upload-pack', upstream: `${GITHUB}/git-upload-pack`, type: 'application/x-git-upload-pack-request' },
  { name: 'the LFS batch API', method: 'POST', path: 'info/lfs/objects/batch', upstream: `${GITHUB}/info/lfs/objects/batch`, type: 'application/vnd.git-lfs+json' },
  { name: "git-lfs's lock check", method: 'POST', path: 'info/lfs/locks/verify', upstream: `${GITHUB}/info/lfs/locks/verify`, type: 'application/vnd.git-lfs+json' },
] as const

function segmentsOf(path: string) {
  return path.split('?')[0].split('/')
}

function req(method: string, path: string, headers: Record<string, string> = auth(), body?: BodyInit) {
  return new Request(`https://app.test${GIT_PUSH_PATH}/${path}`, { method, headers, ...(body !== undefined ? { body } : {}) })
}

const upstreamCall = (d: ReturnType<typeof deps>, i = 0) => d.fetchImpl.mock.calls[i] as unknown as [string, RequestInit]

describe('handleGitRead: what reaches GitHub', () => {
  it.each(ENDPOINTS)("$name goes to the run's repo on GitHub with the GitHub token and the whitelisted headers only", async (e) => {
    const d = deps()
    const body = e.method === 'POST' ? '0011command=fetch0000' : undefined
    const headers: Record<string, string> = {
      ...auth(),
      'git-protocol': 'version=2',
      accept: 'application/x-git-upload-pack-result',
      'user-agent': 'git/2.45.1',
      cookie: 'session=copper-kite-session',
      'x-forwarded-for': '203.0.113.9',
      'proxy-authorization': 'Basic c2VjcmV0',
      'x-vercel-protection-bypass': 'bypass-secret',
      ...(e.type ? { 'content-type': e.type } : {}),
    }
    const res = await handleGitRead(req(e.method, e.path, headers, body), segmentsOf(e.path), d)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('upstream-ok')
    expect(d.loadTarget).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: RUN.agentRunId, workspaceId: RUN.workspaceId }))
    expect(d.fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = upstreamCall(d)
    expect(url).toBe(e.upstream)
    expect(init.method).toBe(e.method)
    // A redirect is never followed (a moved repo is answered, see below).
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({
      authorization: GH_BASIC,
      'user-agent': 'git/2.45.1',
      'git-protocol': 'version=2',
      accept: 'application/x-git-upload-pack-result',
      ...(e.type ? { 'content-type': e.type } : {}),
    })
    if (body) expect(Buffer.from(init.body as Uint8Array).toString()).toBe(body)
    else expect(init.body).toBeUndefined()
  })

  it("the client's Authorization (the gate token, Basic or Bearer) never reaches GitHub, nor any cookie", async () => {
    for (const authorization of [basicAuth(GATE_TOKEN), `Bearer ${GATE_TOKEN}`]) {
      const d = deps()
      const res = await handleGitRead(req('GET', 'info/refs?service=git-upload-pack', { authorization, cookie: 'a=b' }), ['info', 'refs'], d)
      expect(res.status).toBe(200)
      const sent = JSON.stringify(upstreamCall(d)[1].headers)
      // The very token this request carried, raw, in parts and in its Basic form.
      expect(sent).not.toContain(GATE_TOKEN.split('.')[0])
      expect(sent).not.toContain(GATE_TOKEN.split('.')[1])
      expect(sent).not.toContain(basicAuth(GATE_TOKEN).slice(6))
      expect(sent).not.toContain('cookie')
      expect((upstreamCall(d)[1].headers as Record<string, string>).authorization).toBe(GH_BASIC)
    }
  })

  it('the whitelist is exactly Git-Protocol, Content-Type, Content-Encoding and Accept', () => {
    expect([...FORWARDED_READ_HEADERS]).toEqual(['git-protocol', 'content-type', 'content-encoding', 'accept'])
  })

  it('a gzipped upload-pack request is forwarded byte for byte, with its Content-Encoding', async () => {
    const d = deps()
    const gz = new Uint8Array(gzipSync(new TextEncoder().encode('0011command=fetch0000')))
    const res = await handleGitRead(
      req('POST', 'git-upload-pack', { ...auth(), 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip' }, gz),
      ['git-upload-pack'],
      d,
    )
    expect(res.status).toBe(200)
    const [, init] = upstreamCall(d)
    expect((init.headers as Record<string, string>)['content-encoding']).toBe('gzip')
    expect([...(init.body as Uint8Array)]).toEqual([...gz])
  })

  it('a client that is not git gets a git/… user agent upstream', async () => {
    const d = deps()
    await handleGitRead(req('POST', 'info/lfs/objects/batch', { ...auth(), 'user-agent': 'git-lfs/3.4.0 (GitHub; linux amd64)' }, '{}'), segmentsOf('info/lfs/objects/batch'), d)
    expect((upstreamCall(d)[1].headers as Record<string, string>)['user-agent']).toMatch(/^git\//)
  })

  it('a whitelisted header too long to be git\'s is refused, nothing upstream', async () => {
    const d = deps()
    const res = await handleGitRead(req('GET', 'info/refs?service=git-upload-pack', { ...auth(), 'git-protocol': 'version=2:' + 'x'.repeat(2000) }), ['info', 'refs'], d)
    expect(res.status).toBe(400)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('handleGitRead: what comes back', () => {
  it("relays GitHub's status and content type, with cache-control no-cache, and no other upstream header", async () => {
    const d = deps({
      fetchImpl: vi.fn(async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain', 'set-cookie': 'gh=1', 'x-github-request-id': 'abc' } })),
    })
    const res = await handleGitRead(req('GET', 'info/refs?service=git-upload-pack'), ['info', 'refs'], d)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-github-request-id')).toBeNull()
  })

  it("STREAMS GitHub's body through: the gate answers before GitHub has finished sending (it never holds the pack)", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const upstreamBody = new ReadableStream<Uint8Array>({ start: (c) => { controller = c } })
    controller.enqueue(new TextEncoder().encode('PACK-part-1'))
    const d = deps({
      fetchImpl: vi.fn(async () => new Response(upstreamBody, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } })),
    })
    // GitHub's body is still open: a gate that buffered it would never answer.
    const res = await handleGitRead(req('POST', 'git-upload-pack', auth(), '0000'), ['git-upload-pack'], d)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('PACK-part-1')
    controller.enqueue(new TextEncoder().encode('PACK-part-2'))
    controller.close()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('PACK-part-2')
    expect((await reader.read()).done).toBe(true)
  })

  it('GitHub unreachable is a 502', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed') }) })
    const res = await handleGitRead(req('POST', 'git-upload-pack', auth(), '0000'), ['git-upload-pack'], d)
    expect(res.status).toBe(502)
  })

  it("the client's abort signal reaches the GitHub request, on every endpoint", async () => {
    for (const e of ENDPOINTS) {
      const d = deps()
      const request = req(e.method, e.path, auth(), e.method === 'POST' ? '0000' : undefined)
      await handleGitRead(request, segmentsOf(e.path), d)
      expect(upstreamCall(d)[1].signal).toBe(request.signal)
    }
  })
})

describe("handleGitRead: GitHub's 401, redirects and headers", () => {
  it("a 401 from GitHub reaches git as a 403 saying GitHub refused the person's credential, with nothing of GitHub's answer", async () => {
    for (const e of ENDPOINTS) {
      const d = deps({
        fetchImpl: vi.fn(async () => new Response(`Bad credentials ${GH_TOKEN}`, { status: 401, headers: { 'www-authenticate': 'Basic realm="GitHub"', 'content-type': 'text/plain' } })),
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const res = await handleGitRead(req(e.method, e.path, auth(), e.method === 'POST' ? '0000' : undefined), segmentsOf(e.path), d)
      expect(res.status).toBe(403)
      expect(res.headers.get('www-authenticate')).toBeNull()
      const text = await res.text()
      expect(text).toMatch(/GitHub refused/)
      expect(text).not.toContain(GH_TOKEN)
      expect(JSON.stringify(warn.mock.calls)).toContain(RUN.agentRunId)
      warn.mockRestore()
    }
  })

  it.each([301, 302, 307, 308])('a %i from GitHub (a moved or renamed repo) is a 502 saying so; never followed, no location relayed', async (status) => {
    for (const e of ENDPOINTS) {
      const d = deps({
        fetchImpl: vi.fn(async () => new Response(null, { status, headers: { location: 'https://github.com/copper-kite/new-shop.git/info/refs' } })),
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const res = await handleGitRead(req(e.method, e.path, auth(), e.method === 'POST' ? '0000' : undefined), segmentsOf(e.path), d)
      expect(res.status).toBe(502)
      expect(res.headers.get('location')).toBeNull()
      const text = await res.text()
      expect(text).toMatch(/moved or been renamed/)
      expect(text).not.toContain('new-shop')
      expect(d.fetchImpl).toHaveBeenCalledTimes(1)
      expect(upstreamCall(d)[1].redirect).toBe('manual')
      warn.mockRestore()
    }
  })

  it('www-authenticate and location from GitHub never reach the client, streamed or LFS', async () => {
    for (const e of ENDPOINTS) {
      for (const status of [200, 404]) {
        const d = deps({
          fetchImpl: vi.fn(async () => new Response('{}', { status, headers: { 'content-type': 'application/json', 'www-authenticate': 'Basic realm="GitHub"', location: 'https://example.com/' } })),
        })
        const res = await handleGitRead(req(e.method, e.path, auth(), e.method === 'POST' ? '0000' : undefined), segmentsOf(e.path), d)
        expect(res.status).toBe(status)
        expect(res.headers.get('www-authenticate')).toBeNull()
        expect(res.headers.get('location')).toBeNull()
      }
    }
  })

  it("the push gate still relays GitHub's own status, a 401 included (unchanged)", async () => {
    const d = deps({ fetchImpl: vi.fn(async () => new Response('Bad credentials', { status: 401 })) })
    const res = await handleGitGate(req('GET', 'info/refs?service=git-receive-pack'), ['info', 'refs'], d)
    expect(res.status).toBe(401)
    expect(upstreamCall(d)[1].redirect).toBe('error')
  })
})

describe("handleGitRead: an LFS answer never carries the person's GitHub token to the sandbox", () => {
  const LFS = [
    ['the LFS batch API', 'info/lfs/objects/batch'],
    ["git-lfs's lock check", 'info/lfs/locks/verify'],
  ] as const
  const lfsDeps = (body: BodyInit, status = 200) =>
    deps({ fetchImpl: vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/vnd.git-lfs+json' } })) })

  it.each(LFS)('%s: an answer with the token raw is a 502, with nothing of the answer, logged with the run id only', async (_label, path) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = lfsDeps(JSON.stringify({ objects: [{ oid: 'a1', actions: { download: { href: 'https://lfs.example/a1', header: { Authorization: `token ${GH_TOKEN}` } } } }] }))
    const res = await handleGitRead(req('POST', path, auth(), '{}'), segmentsOf(path), d)
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain(GH_TOKEN)
    expect(text).not.toContain('lfs.example')
    const logged = JSON.stringify(err.mock.calls)
    expect(logged).toContain(RUN.agentRunId)
    expect(logged).not.toContain(GH_TOKEN)
    err.mockRestore()
  })

  it.each(LFS)('%s: an answer with the token as its Basic credential (base64) is a 502 too', async (_label, path) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = lfsDeps(JSON.stringify({ objects: [{ oid: 'a1', actions: { download: { href: 'https://lfs.example/a1', header: { Authorization: GH_BASIC } } } }] }))
    const res = await handleGitRead(req('POST', path, auth(), '{}'), segmentsOf(path), d)
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain(GH_BASIC.slice(6))
    err.mockRestore()
  })

  it.each(LFS)('%s: an answer without the token comes back byte for byte, with its status and content type', async (_label, path) => {
    for (const status of [200, 422]) {
      const bytes = new Uint8Array(Buffer.from(JSON.stringify({ objects: [{ oid: 'b2', size: 7, actions: { download: { href: 'https://lfs.example/b2', header: { Authorization: 'RemoteAuth short-lived' } } } }] }) + 'é', 'utf8'))
      const d = lfsDeps(bytes, status)
      const res = await handleGitRead(req('POST', path, auth(), '{}'), segmentsOf(path), d)
      expect(res.status).toBe(status)
      expect(res.headers.get('content-type')).toBe('application/vnd.git-lfs+json')
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
    }
  })

  it.each(LFS)('%s: an answer over the cap is a 502; at the cap it comes back', async (_label, path) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const over = await handleGitRead(req('POST', path, auth(), '{}'), segmentsOf(path), lfsDeps(new Uint8Array(MAX_LFS_ANSWER_BYTES + 1)))
    expect(over.status).toBe(502)
    expect((await over.text()).length).toBeLessThan(1000)
    const at = await handleGitRead(req('POST', path, auth(), '{}'), segmentsOf(path), lfsDeps(new Uint8Array(MAX_LFS_ANSWER_BYTES)))
    expect(at.status).toBe(200)
    expect((await at.arrayBuffer()).byteLength).toBe(MAX_LFS_ANSWER_BYTES)
    warn.mockRestore()
  })

  it('the LFS answer cap is 4 MB', () => {
    expect(MAX_LFS_ANSWER_BYTES).toBe(4 * 1024 * 1024)
  })
})

describe('handleGitRead: at most READS_PER_RUN reads in flight per run', () => {
  const RUN2 = { ...RUN, agentRunId: 'run-copper-kite-10', branchName: 'dial8/web-10-run00010' }
  const TARGET2: PushTarget = { ...TARGET, branchName: RUN2.branchName }

  /** "GitHub" answering every upload-pack with a stream that stays open until the test ends it. */
  function openUpstreams() {
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({ start: (c) => { controllers.push(c) } })
      controllers.at(-1)?.enqueue(new TextEncoder().encode('PACK'))
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } })
    })
    const d = deps({
      fetchImpl,
      loadTarget: vi.fn(async (c: { agentRunId: string }) => (c.agentRunId === RUN2.agentRunId ? TARGET2 : TARGET)),
    })
    return { d, controllers }
  }
  const read = (d: GitReadDeps, token = GATE_TOKEN, init: { signal?: AbortSignal } = {}) =>
    handleGitRead(
      new Request(`https://app.test${GIT_PUSH_PATH}/git-upload-pack`, { method: 'POST', headers: auth(token), body: '0000', ...init }),
      ['git-upload-pack'],
      d,
    )

  it('is 4', () => {
    expect(READS_PER_RUN).toBe(4)
  })

  it('the fifth concurrent read of one run is a 429 while four are open, and GitHub is not asked; another run is unaffected', async () => {
    const { d } = openUpstreams()
    const open = await Promise.all([read(d), read(d), read(d), read(d)])
    expect(open.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(d.readSlots!.count(RUN.agentRunId)).toBe(4)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fifth = await read(d)
    expect(fifth.status).toBe(429)
    expect(d.fetchImpl).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(warn.mock.calls)).toContain(RUN.agentRunId)
    warn.mockRestore()
    const other = await read(d, mintGitPushToken(RUN2))
    expect(other.status).toBe(200)
    expect(d.readSlots!.count(RUN2.agentRunId)).toBe(1)
  })

  it('a slot comes back when an answer ends, is cancelled, or fails mid-stream', async () => {
    const { d, controllers } = openUpstreams()
    const open = await Promise.all([read(d), read(d), read(d), read(d)])
    // Ended: GitHub finishes and the client reads to the end.
    controllers[0].close()
    await open[0].text()
    expect(d.readSlots!.count(RUN.agentRunId)).toBe(3)
    // Cancelled: the client goes away mid-stream.
    await open[1].body!.cancel()
    expect(d.readSlots!.count(RUN.agentRunId)).toBe(2)
    // Failed: GitHub's stream errors mid-transfer.
    controllers[2].error(new Error('connection reset'))
    await open[2].text().catch(() => {})
    expect(d.readSlots!.count(RUN.agentRunId)).toBe(1)
    expect((await Promise.all([read(d), read(d), read(d)])).map((r) => r.status)).toEqual([200, 200, 200])
    expect((await read(d)).status).toBe(429)
  })

  it('a slot comes back when the client aborts, even if nothing reads or cancels the answer', async () => {
    const { d } = openUpstreams()
    const abort = new AbortController()
    const res = await read(d, GATE_TOKEN, { signal: abort.signal })
    expect(res.status).toBe(200)
    expect(d.readSlots!.count(RUN.agentRunId)).toBe(1)
    abort.abort()
    expect(d.readSlots!.count(RUN.agentRunId)).toBe(0)
  })

  it('no slot is kept by a read that never streams: GitHub unreachable, a 401, a redirect, an LFS answer, a body over the cap', async () => {
    const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
    const slots = new ReadSlots()
    const answers: Array<() => Promise<Response>> = [
      async () => { throw new TypeError('fetch failed') },
      async () => new Response('Bad credentials', { status: 401 }),
      async () => new Response(null, { status: 301, headers: { location: 'https://github.com/x/y.git' } }),
      async () => new Response(`{"t":"${GH_TOKEN}"}`, { status: 200 }),
      async () => new Response('{}', { status: 200 }),
    ]
    for (const answer of answers) {
      for (let i = 0; i < READS_PER_RUN + 2; i++) {
        const d = deps({ fetchImpl: vi.fn(answer), readSlots: slots })
        const res = await handleGitRead(req('POST', 'info/lfs/objects/batch', auth(), '{}'), segmentsOf('info/lfs/objects/batch'), d)
        expect(res.status).not.toBe(429)
        await res.arrayBuffer()
      }
      expect(slots.count(RUN.agentRunId)).toBe(0)
    }
    for (let i = 0; i < READS_PER_RUN + 2; i++) {
      const d = deps({ readSlots: slots })
      const res = await handleGitRead(req('POST', 'git-upload-pack', auth(), new Uint8Array(MAX_UPLOAD_PACK_REQUEST_BYTES + 1)), ['git-upload-pack'], d)
      expect(res.status).toBe(413)
    }
    expect(slots.count(RUN.agentRunId)).toBe(0)
    for (const q of quiet) q.mockRestore()
  })
})

describe('handleGitRead: refusals (nothing reaches GitHub)', () => {
  it.each([
    ['GET upload-pack', 'GET', 'git-upload-pack'],
    ['POST the advertisement', 'POST', 'info/refs?service=git-upload-pack'],
    ['GET the LFS batch API', 'GET', 'info/lfs/objects/batch'],
    ['GET the LFS lock check', 'GET', 'info/lfs/locks/verify'],
    ['PUT upload-pack', 'PUT', 'git-upload-pack'],
  ])('a wrong method (%s) is a 405, before the run is read', async (_label, method, path) => {
    const d = deps()
    const res = await handleGitRead(req(method, path, auth(), method === 'GET' ? undefined : '0000'), segmentsOf(path), d)
    expect(res.status).toBe(405)
    expect(d.loadTarget).not.toHaveBeenCalled()
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['the push advertisement', 'info/refs?service=git-receive-pack'],
    ['an advertisement with no service', 'info/refs'],
    ['another service', 'info/refs?service=git-upload-archive'],
    ['receive-pack', 'git-receive-pack'],
    ['an LFS lock create', 'info/lfs/locks'],
    ['an LFS unlock', 'info/lfs/locks/1/unlock'],
    ['another repo by path', 'other/repo.git/git-upload-pack'],
    ['a path past upload-pack', 'git-upload-pack/x'],
    ['nothing', ''],
  ])('%s is not a read endpoint (404), whatever the method', async (_label, path) => {
    for (const method of ['GET', 'POST']) {
      const d = deps()
      const res = await handleGitRead(req(method, path, auth(), method === 'POST' ? '0000' : undefined), path ? segmentsOf(path) : [], d)
      expect(res.status).toBe(404)
      expect(d.loadTarget).not.toHaveBeenCalled()
      expect(d.fetchImpl).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['no credential', {}],
    ['a run token instead of a gate token', { authorization: `Bearer ${mintAgentRunToken({ agentRunId: RUN.agentRunId, workspaceId: RUN.workspaceId, userId: 'u-1' })}` }],
    ['a forged token', auth('eyJmYWtlIjp0cnVlfQ.bm90LWEtbWFj')],
    ['an expired gate token', auth(mintGitPushToken(RUN, Date.now() - 7 * 60 * 60 * 1000))],
    ['the GitHub token itself', auth(GH_TOKEN)],
  ])('refuses %s with a 403 (never a 401 password prompt), before reading the run', async (_label, headers) => {
    for (const e of ENDPOINTS) {
      const d = deps()
      const res = await handleGitRead(req(e.method, e.path, headers as Record<string, string>, e.method === 'POST' ? '0000' : undefined), segmentsOf(e.path), d)
      expect(res.status).toBe(403)
      expect(d.loadTarget).not.toHaveBeenCalled()
      expect(d.fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('a run that has ended (or is not runnable) reads nothing, and the refusal is logged with the run id only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const refused of ['this run has ended', 'this run is not runnable']) {
      const d = deps({ loadTarget: vi.fn(async () => ({ refused })) })
      const res = await handleGitRead(req('POST', 'git-upload-pack', auth(GATE_TOKEN), '0000'), ['git-upload-pack'], d)
      expect(res.status).toBe(403)
      expect(d.fetchImpl).not.toHaveBeenCalled()
    }
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain(RUN.agentRunId)
    expect(logged).not.toContain(GH_TOKEN)
    // The very token the requests carried.
    expect(logged).not.toContain(GATE_TOKEN.split('.')[0])
    expect(logged).not.toContain(GATE_TOKEN.split('.')[1])
    warn.mockRestore()
  })

  it.each([
    ['a project re-pointed at another repo mid-run', { ...TARGET, repoFullName: 'copper-kite/other-shop' }],
    ['a run whose branch changed', { ...TARGET, branchName: 'dial8/web-9-other000' }],
  ])('refuses %s: the gate token binds the repo and branch it was minted for', async (_label, target) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ loadTarget: vi.fn(async () => target) })
    const res = await handleGitRead(req('GET', 'info/refs?service=git-upload-pack'), ['info', 'refs'], d)
    expect(res.status).toBe(403)
    expect(d.fetchImpl).not.toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toContain(GH_TOKEN)
    err.mockRestore()
  })

  it.each([
    ['is its base', { ...TARGET, branchName: 'main' }],
    ['is not a run branch', { ...TARGET, branchName: 'release' }],
  ])("serves a run whose branch %s: the push gate's branch-shape checks do not apply to a read", async (_label, target) => {
    const d = deps({ loadTarget: vi.fn(async () => target) })
    const token = mintGitPushToken({ ...RUN, branchName: target.branchName })
    const res = await handleGitRead(req('GET', 'info/refs?service=git-upload-pack', auth(token)), ['info', 'refs'], d)
    expect(res.status).toBe(200)
  })

  it('a run that cannot be read is a hold (503), never a read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ loadTarget: vi.fn(async () => { throw new Error('db down') }) })
    const res = await handleGitRead(req('POST', 'git-upload-pack', auth(), '0000'), ['git-upload-pack'], d)
    expect(res.status).toBe(503)
    expect(d.fetchImpl).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it.each([
    ['upload-pack', 'git-upload-pack', MAX_UPLOAD_PACK_REQUEST_BYTES],
    ['the LFS batch API', 'info/lfs/objects/batch', MAX_LFS_REQUEST_BYTES],
    ['the LFS lock check', 'info/lfs/locks/verify', MAX_LFS_REQUEST_BYTES],
  ])('a %s body over its cap is refused (413), nothing upstream; at the cap it goes', async (_label, path, cap) => {
    const over = deps()
    const res = await handleGitRead(req('POST', path, auth(), new Uint8Array(cap + 1)), segmentsOf(path), over)
    expect(res.status).toBe(413)
    expect(over.fetchImpl).not.toHaveBeenCalled()
    const at = deps()
    expect((await handleGitRead(req('POST', path, auth(), new Uint8Array(cap)), segmentsOf(path), at)).status).toBe(200)
  })

  it('the caps are 8 MB for upload-pack and 1 MB for LFS', () => {
    expect(MAX_UPLOAD_PACK_REQUEST_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_LFS_REQUEST_BYTES).toBe(1024 * 1024)
  })
})

describe('handleGitGate: one mount, two halves', () => {
  it('sends the read endpoints to the read gate', async () => {
    for (const e of ENDPOINTS) {
      const d = deps()
      const res = await handleGitGate(req(e.method, e.path, auth(), e.method === 'POST' ? '0000' : undefined), segmentsOf(e.path), d)
      expect(res.status).toBe(200)
      expect(upstreamCall(d)[0]).toBe(e.upstream)
    }
  })

  it('sends the push advertisement to the push gate, as before', async () => {
    const d = deps()
    const res = await handleGitGate(req('GET', 'info/refs?service=git-receive-pack'), ['info', 'refs'], d)
    expect(res.status).toBe(200)
    expect(upstreamCall(d)[0]).toBe(`${GITHUB}/info/refs?service=git-receive-pack`)
  })

  it('a push of the default branch is still judged and refused by the push gate, nothing upstream', async () => {
    const d = deps()
    const pkt = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s
    const body = new Uint8Array(Buffer.from(pkt(`${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/main\0report-status\n`) + '0000PACK', 'latin1'))
    const res = await handleGitGate(req('POST', 'git-receive-pack', { ...auth(), 'content-type': 'application/x-git-receive-pack-request' }, body), ['git-receive-pack'], d)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toContain('ng refs/heads/main')
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['an advertisement with no service', 'GET', 'info/refs', 403],
    ['an unknown path', 'POST', 'info/lfs/locks', 404],
    ['another repo by path', 'POST', 'other/repo.git/git-upload-pack', 404],
  ])('%s is refused by the push gate as before (%s %s → %i)', async (_label, method, path, status) => {
    const d = deps()
    const res = await handleGitGate(req(method, path, auth(), method === 'POST' ? '0000' : undefined), segmentsOf(path), d)
    expect(res.status).toBe(status)
    expect(d.fetchImpl).not.toHaveBeenCalled()
  })
})

// ── Real git, end to end ─────────────────────────────────────────────────────

function cat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

let gitEnv: Record<string, string> = {}

function git(args: string[], opts: { cwd?: string; input?: Uint8Array; env?: Record<string, string> } = {}) {
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

describe('handleGitGate with real git: a shallow clone and a fetch through the gate, like the sandbox', () => {
  let dir: string
  let bare: string
  let server: Server
  let gateUrl: string
  let target: PushTarget | { refused: string } = TARGET
  /** Every request "GitHub" saw: its URL and headers. */
  const seen: Array<{ url: string; headers: Record<string, string> }> = []

  const pkt = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s

  /** "GitHub": a local bare repo behind git's own stateless upload-pack (as git http-backend runs it). */
  const github: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    seen.push({ url, headers })
    if (headers.authorization !== GH_BASIC) return new Response('bad credentials', { status: 401 })
    const env = headers['git-protocol'] ? { GIT_PROTOCOL: headers['git-protocol'] } : undefined
    const v2 = (headers['git-protocol'] ?? '').includes('version=2')
    if (url === `${GITHUB}/info/refs?service=git-upload-pack`) {
      const adv = await git(['upload-pack', '--stateless-rpc', '--advertise-refs', bare], { env })
      const head = v2 ? new Uint8Array(0) : new Uint8Array(Buffer.from(pkt('# service=git-upload-pack\n') + '0000'))
      return new Response(cat([head, adv.stdout]), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
    }
    if (url === `${GITHUB}/git-upload-pack`) {
      let body = new Uint8Array(init!.body as Uint8Array)
      if (headers['content-encoding'] === 'gzip') body = new Uint8Array(gunzipSync(body))
      const r = await git(['upload-pack', '--stateless-rpc', bare], { input: body, env })
      return new Response(r.stdout, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } })
    }
    return new Response('not found', { status: 404 })
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ni-read-gate-'))
    gitEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Copper Kite',
      GIT_AUTHOR_EMAIL: 'owner@copperkite.example',
      GIT_COMMITTER_NAME: 'Copper Kite',
      GIT_COMMITTER_EMAIL: 'owner@copperkite.example',
    }
    writeFileSync(join(dir, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[uploadpack]\n\tallowFilter = true\n')
    bare = join(dir, 'shop.git')
    const seed = join(dir, 'seed')
    await git(['init', '--bare', bare])
    await git(['init', seed])
    for (const n of [1, 2, 3]) {
      writeFileSync(join(seed, 'index.html'), `<h1>Copper Kite ${n}</h1>\n`)
      await git(['add', '.'], { cwd: seed })
      await git(['commit', '-m', `shop ${n}`], { cwd: seed })
    }
    await git(['push', bare, 'main'], { cwd: seed })
    await git(['checkout', '-b', 'dial8/fix-pr'], { cwd: seed })
    writeFileSync(join(seed, 'index.html'), '<h1>Copper Kite</h1><p>Open daily</p>\n')
    await git(['commit', '-am', 'hours'], { cwd: seed })
    await git(['push', bare, 'dial8/fix-pr'], { cwd: seed })

    server = createServer(async (incoming, res) => {
      const chunks: Uint8Array[] = []
      for await (const c of incoming) chunks.push(c as Uint8Array)
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        body: incoming.method === 'POST' ? cat(chunks) : undefined,
      })
      const segments = url.pathname.slice(GIT_PUSH_PATH.length + 1).split('/')
      const out = await handleGitGate(request, segments, {
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
  }, 30_000)

  beforeEach(() => {
    target = TARGET
    seen.length = 0
    process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  /** The sandbox's unbrokered clone: the gate token as a one-shot git config env, for the gate URL only. */
  const cloneEnv = () => ({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${gateUrl}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${basicAuth(GATE_TOKEN)}`,
  })

  it.each(['2', '0'])('a shallow clone (protocol v%s) through the gate, then a fetch of another branch', async (version) => {
    const work = join(dir, `work-v${version}`)
    const clone = await git(['-c', `protocol.version=${version}`, 'clone', '--depth', '2', '--branch', 'main', gateUrl, work], { env: cloneEnv() })
    expect(clone.stderr).not.toContain('fatal')
    expect(clone.code).toBe(0)
    expect(readFileSync(join(work, 'index.html'), 'utf8')).toBe('<h1>Copper Kite 3</h1>\n')
    // As the sandbox does: the token moves into the repo config for the gate URL only.
    await git(['config', `http.${gateUrl}.extraheader`, `Authorization: ${basicAuth(GATE_TOKEN)}`], { cwd: work })
    const fetched = await git(['-c', `protocol.version=${version}`, 'fetch', '--depth', '2', 'origin', 'refs/heads/dial8/fix-pr:refs/remotes/origin/dial8/fix-pr'], { cwd: work })
    expect(fetched.code).toBe(0)
    const show = await git(['show', 'origin/dial8/fix-pr:index.html'], { cwd: work })
    expect(Buffer.from(show.stdout).toString()).toContain('Open daily')

    // What GitHub saw: the run's repo, the GitHub token, the protocol, never the gate token.
    expect(seen.length).toBeGreaterThan(1)
    for (const s of seen) {
      expect(s.url.startsWith(`${GITHUB}/`)).toBe(true)
      expect(s.headers.authorization).toBe(GH_BASIC)
      // The very token git sent the gate (raw parts and Basic form) never reaches GitHub.
      expect(JSON.stringify(s.headers)).not.toContain(GATE_TOKEN.split('.')[0])
      expect(JSON.stringify(s.headers)).not.toContain(GATE_TOKEN.split('.')[1])
      expect(JSON.stringify(s.headers)).not.toContain(basicAuth(GATE_TOKEN).slice(6))
      expect(Object.keys(s.headers).sort()).toEqual(
        expect.arrayContaining(['authorization', 'user-agent']),
      )
      for (const name of Object.keys(s.headers)) {
        expect(['authorization', 'user-agent', ...FORWARDED_READ_HEADERS]).toContain(name)
      }
    }
    if (version === '2') expect(seen.every((s) => s.headers['git-protocol'] === 'version=2')).toBe(true)
  })

  it('without the gate token the clone fails at once (403, no password prompt), and GitHub is never asked', async () => {
    const r = await git(['clone', '--depth', '1', gateUrl, join(dir, 'no-token')])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/403/)
    expect(seen).toHaveLength(0)
  })

  it('once the run has ended, the clone fails and GitHub is never asked', async () => {
    target = { refused: 'this run has ended' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await git(['clone', '--depth', '1', gateUrl, join(dir, 'ended')], { env: cloneEnv() })
    expect(r.code).not.toBe(0)
    expect(seen).toHaveLength(0)
    warn.mockRestore()
  })
})
