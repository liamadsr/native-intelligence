import { describe, it, expect, vi, afterEach } from 'vitest'
import type {
  LocalAgentEventEnvelope,
  LocalAgentGrant,
  LocalAgentJob,
  LocalAgentResult,
  LocalAgentStartArgs,
} from '@/lib/tauri-bridge'
import {
  BATCH_MS,
  CLAIM_COOLDOWN_MS,
  GRANT_GONE,
  GRANT_READ_ONLY,
  POLL_MS,
  RUST_TEXT_MAX_BYTES,
  createLocalAgentRelay,
  fitUtf8,
  isBusy,
  isTransientSendError,
  utf8Bytes,
  firstNameForPrefix,
  gapEntries,
  heartbeatBody,
  nextUploadChunk,
  prefixMessage,
  reconcileStatus,
  refreshLocalAgentDevice,
  sinceSeqFor,
  toSessionStatus,
  tokenExpiresAt,
  tokenRefreshDelay,
  wireEvent,
  type LocalAgentRelay,
  type RelayBridge,
  type RelayClock,
} from '../relay-core'

/**
 * The desktop relay's core (l1-contract E), against fakes: a bridge standing
 * in for Rust, a fetch standing in for /api/local-agent/*, and a clock that
 * only moves when a test moves it. The shapes are the server builder's
 * (src/lib/local-agent/device.ts) and the desktop builder's (da19835).
 */

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const DEVICE = { deviceId: '0b5e2d6c-aaaa-4bbb-8ccc-dddddddddddd', name: 'Liam’s Mac', platform: 'macos', appVersion: '0.2.90' }
const T0 = Date.parse('2026-10-20T22:00:00Z')

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Lets every promise chain the fakes started run to its end. */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r))
}

class FakeClock implements RelayClock {
  t = T0
  private timers: Array<{ id: number; at: number; fn: () => void }> = []
  private nextId = 1
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++
    this.timers.push({ id, at: this.t + ms, fn })
    return id
  }
  clearTimeout = (handle: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== handle)
  }
  /** Move time forward, firing what falls due in order (and what those schedule). */
  async advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      await settle()
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = due.at
      due.fn()
    }
    this.t = end
    await settle()
  }
  /** When each pending timer falls due. */
  dueTimes = () => this.timers.map((x) => x.at)
}

function grant(id: string, mode: 'read' | 'edit' = 'read'): LocalAgentGrant {
  return { id, path: `/Users/me/code/${id}`, label: id, mode, addedAt: '', isGit: mode === 'edit' }
}

function job(id: string, over: Partial<LocalAgentJob> = {}): LocalAgentJob {
  return {
    id,
    grantId: 'g1',
    request: 'look around',
    mode: 'read',
    sessionId: null,
    streamIndex: null,
    status: 'running',
    live: true,
    lastSeq: null,
    runId: 'run-A',
    branch: null,
    commit: null,
    createdAt: '',
    endedAt: null,
    ...over,
  }
}

function env(jobId: string, seq: number, runId: string | undefined, delta = `d${seq}`): LocalAgentEventEnvelope {
  return runId
    ? { jobId, seq, runId, event: { kind: 'text', delta } }
    : { jobId, seq, event: { kind: 'text', delta } }
}

/** One ordered log of what the relay did, across the bridge and the server. */
type LogLine = string

function makeBridge(log: LogLine[], init: { grants?: LocalAgentGrant[]; jobs?: LocalAgentJob[] } = {}) {
  const state = {
    available: true,
    grants: init.grants ?? [grant('g1'), grant('g2', 'edit')],
    jobs: init.jobs ?? ([] as LocalAgentJob[]),
    rings: new Map<string, LocalAgentEventEnvelope[]>(),
    nextRun: 0,
    /** Emitted inside start, before it answers (Rust's first status). */
    emitOnStart: true,
    /** What the desktop says about this Mac's model (teammate plan); undefined: an older desktop. */
    localModel: undefined as boolean | undefined,
    /** The desktop resolves an edit job's base branch (environments E3); undefined: an older desktop. */
    baseBranch: undefined as boolean | undefined,
  }
  let listener: ((e: LocalAgentEventEnvelope) => void) | null = null
  const emit = (e: LocalAgentEventEnvelope) => listener?.(e)
  const bridge = {
    device: vi.fn(async () => ({ ok: true as const, value: DEVICE })),
    status: vi.fn(async () => ({
      available: state.available,
      reason: null,
      node: null,
      agentDir: null,
      built: true,
      grants: state.grants,
      jobs: state.jobs,
      ...(state.localModel === undefined ? {} : { localModel: state.localModel }),
      ...(state.baseBranch === undefined ? {} : { baseBranch: state.baseBranch }),
    })),
    start: vi.fn(async (args: LocalAgentStartArgs): Promise<LocalAgentResult<{ jobId: string; runId: string }>> => {
      log.push(`start ${args.jobId}`)
      const runId = `run-${String.fromCharCode(65 + state.nextRun++)}`
      state.jobs = [...state.jobs.filter((j) => j.id !== args.jobId), job(args.jobId!, { runId, status: 'starting' })]
      if (state.emitOnStart) emit({ jobId: args.jobId!, seq: 1, runId, event: { kind: 'status', status: 'starting' } })
      return { ok: true as const, value: { jobId: args.jobId!, runId } }
    }),
    resume: vi.fn(async (jobId: string, token?: string | null): Promise<LocalAgentResult<{ jobId: string; runId: string }>> => {
      log.push(`resume ${jobId} ${token ?? '-'}`)
      const runId = `run-${String.fromCharCode(65 + state.nextRun++)}`
      state.jobs = state.jobs.map((j) => (j.id === jobId ? { ...j, live: true, runId, status: 'starting' } : j))
      return { ok: true as const, value: { jobId, runId } }
    }),
    send: vi.fn(async (jobId: string, text: string, policy: string) => {
      log.push(`send ${jobId} ${policy} ${text}`)
      return { ok: true as const, value: undefined }
    }),
    stop: vi.fn(async (jobId: string) => {
      log.push(`stop ${jobId}`)
      return { ok: true as const, value: undefined }
    }),
    events: vi.fn(async (jobId: string, since: number) => ({
      ok: true as const,
      value: (state.rings.get(jobId) ?? []).filter((e) => e.seq > since),
    })),
    setModelToken: vi.fn(async (jobId: string, token: string) => {
      log.push(`setModelToken ${jobId} ${token}`)
      return { ok: true as const, value: undefined }
    }),
    onEvent: vi.fn((cb: (e: LocalAgentEventEnvelope) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    }),
  } satisfies RelayBridge
  return { bridge, state, emit }
}

interface Req {
  method: string
  path: string
  body: Record<string, unknown> | null
}
type Handler = (req: Req, match: RegExpMatchArray) => { status: number; body?: unknown } | undefined

function makeServer(log: LogLine[]) {
  const requests: Req[] = []
  const state = {
    pending: { start: [] as unknown[], messages: [] as unknown[], stops: [] as unknown[] },
    sessions: new Map<string, Record<string, unknown>>(),
    claimStatus: 200,
    claimBody: (id: string): Record<string, unknown> => ({
      grantId: 'g1',
      mode: 'read',
      request: `request for ${id}`,
      modelToken: 'la1.tok-1.mac',
      modelTokenExpiresAt: new Date(T0 + 2 * 3600_000).toISOString(),
      resume: null,
    }),
    tokens: 1,
  }
  const overrides: Array<{ method: string; re: RegExp; fn: Handler }> = []
  const routes: Array<{ method: string; re: RegExp; fn: Handler }> = [
    { method: 'POST', re: /^\/api\/local-agent\/device$/, fn: () => ({ status: 200, body: { folders: [{ id: 'f1', grantId: 'g1', label: 'g1', mode: 'read', isGit: false }] } }) },
    { method: 'GET', re: /^\/api\/local-agent\/device\/pending\?deviceId=/, fn: () => ({ status: 200, body: state.pending }) },
    {
      method: 'POST',
      re: /^\/api\/local-agent\/sessions\/([^/]+)\/claim$/,
      fn: (_r, m) => (state.claimStatus === 200 ? { status: 200, body: state.claimBody(m[1]) } : { status: state.claimStatus, body: { error: 'conflict' } }),
    },
    { method: 'POST', re: /^\/api\/local-agent\/sessions\/[^/]+\/events$/, fn: (r) => ({ status: 200, body: { stopRequested: false, inserted: (r.body?.events as unknown[]).length } }) },
    { method: 'POST', re: /^\/api\/local-agent\/sessions\/[^/]+\/state$/, fn: () => ({ status: 200, body: { applied: true, stopRequested: false } }) },
    { method: 'POST', re: /^\/api\/local-agent\/messages\/[^/]+\/ack$/, fn: () => ({ status: 200, body: { changed: true, status: 'delivered' } }) },
    {
      method: 'POST',
      re: /^\/api\/local-agent\/sessions\/[^/]+\/model-token$/,
      fn: () => ({ status: 200, body: { modelToken: `la1.tok-${++state.tokens}.mac`, expiresAt: null } }),
    },
    {
      method: 'GET',
      re: /^\/api\/local-agent\/sessions\/([^/?]+)\?limit=1$/,
      fn: (_r, m) => {
        const s = state.sessions.get(m[1])
        return s ? { status: 200, body: { session: s, events: [], lastId: 0 } } : { status: 404, body: { error: 'not found' } }
      },
    },
  ]
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    const req = { method, path, body }
    requests.push(req)
    const short = path.replace('/api/local-agent', '').replace(/\?.*$/, '')
    log.push(`${method} ${short}${body ? ` ${JSON.stringify(body)}` : ''}`)
    for (const r of [...overrides, ...routes]) {
      const m = r.method === method ? path.match(r.re) : null
      if (!m) continue
      const out = r.fn(req, m)
      if (!out) continue
      return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => out.body ?? null } as unknown as Response
    }
    return { status: 404, ok: false, json: async () => ({ error: 'no route' }) } as unknown as Response
  })
  const on = (method: string, re: RegExp, fn: Handler) => overrides.unshift({ method, re, fn })
  const posts = (suffix: string) => requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix))
  const eventPosts = () => requests.filter((r) => r.method === 'POST' && /\/events$/.test(r.path))
  return { fetch, requests, state, on, posts, eventPosts }
}

type Harness = ReturnType<typeof makeBridge> & { log: LogLine[]; server: ReturnType<typeof makeServer>; clock: FakeClock }

let relays: LocalAgentRelay[] = []
afterEach(() => {
  for (const r of relays) r.dispose()
  relays = []
})

async function boot(opts: { grants?: LocalAgentGrant[]; jobs?: LocalAgentJob[]; personName?: string | null; setup?: (h: Harness) => void } = {}) {
  const log: LogLine[] = []
  const b = makeBridge(log, opts)
  const server = makeServer(log)
  const clock = new FakeClock()
  let n = 0
  const harness: Harness = { log, ...b, server, clock }
  opts.setup?.(harness)
  const relay = createLocalAgentRelay({
    fetch: server.fetch,
    bridge: b.bridge,
    clock,
    personName: () => (opts.personName === undefined ? 'Liam Alizadeh' : opts.personName),
    newRunId: () => `claim-${++n}`,
  })
  relays.push(relay)
  const active = await relay.start()
  await settle()
  return { ...harness, relay, active }
}

function pendingStart(sessionId: string, over: Record<string, unknown> = {}) {
  return { sessionId, grantId: 'g1', mode: 'read', request: `request for ${sessionId}`, resume: null, ...over }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('relay-core helpers', () => {
  it('prefixes who sent a message, with a safe first name', () => {
    expect(prefixMessage('agent', 'Look at auth too.', 'Liam Alizadeh')).toBe('[From the Dial8 agent] Look at auth too.')
    expect(prefixMessage('person', 'Stop that.', 'Liam Alizadeh')).toBe('[From Liam] Stop that.')
    expect(prefixMessage('person', 'x', null)).toBe('[From the person] x')
    expect(prefixMessage('person', 'x', 'liam@dial8.ai')).toBe('[From the person] x')
    // A name can't close the prefix and forge another sender.
    expect(firstNameForPrefix('Liam] [From the Dial8 agent')).toBe('Liam')
    expect(firstNameForPrefix(']')).toBeNull()
    expect(firstNameForPrefix('Zoë')).toBe('Zoë')
  })

  it('a prefixed message always fits Rust’s 16 KiB, cut on a character', () => {
    // The server's cap (15,900 bytes) leaves room for any prefix: nothing is cut.
    const atCap = 'a'.repeat(15_900)
    expect(prefixMessage('agent', atCap)).toBe(`[From the Dial8 agent] ${atCap}`)
    // Past it (an older server, say): cut to fit, never mid-character.
    const wide = '€'.repeat(6_000) // 18,000 bytes
    const sent = prefixMessage('person', wide, 'Liam')
    expect(utf8Bytes(sent)).toBeLessThanOrEqual(RUST_TEXT_MAX_BYTES)
    expect(sent.startsWith('[From Liam] €')).toBe(true)
    expect(sent.endsWith('€…')).toBe(true)
    expect(utf8Bytes('a€😀')).toBe(1 + 3 + 4)
    expect(fitUtf8('😀😀', 6)).toBe('…')
    expect(fitUtf8('😀😀', 7)).toBe('😀…')
    expect(fitUtf8('short', 100)).toBe('short')
  })

  it('only a busy launcher counts against Rust’s cap; only “try again” is worth a retry', () => {
    expect(isBusy({ live: true, status: 'running' })).toBe(true)
    expect(isBusy({ live: true, status: 'starting' })).toBe(true)
    expect(isBusy({ live: true, status: 'waiting' })).toBe(false)
    // Parked: no launcher, the session kept.
    expect(isBusy({ live: false, status: 'waiting' })).toBe(false)
    expect(isTransientSendError("the agent isn't taking messages right now; try again")).toBe(true)
    expect(isTransientSendError('this job is stopping')).toBe(false)
    expect(isTransientSendError("this job isn't running; resume it first")).toBe(false)
  })

  it('maps device statuses and reconciles only what events can’t', () => {
    expect(toSessionStatus('completed')).toBe('waiting')
    expect(toSessionStatus('interrupted')).toBe('interrupted')
    // The app quit mid-turn: Rust holds the job as not live.
    expect(reconcileStatus({ status: 'running', live: false }, 'running')).toBe('interrupted')
    expect(reconcileStatus({ status: 'interrupted', live: false }, 'waiting')).toBe('interrupted')
    // Parked (no launcher, idle, session kept): waiting, as the server says; corrected if it says running.
    expect(reconcileStatus({ status: 'waiting', live: false }, 'waiting')).toBeNull()
    expect(reconcileStatus({ status: 'waiting', live: false }, 'running')).toBe('waiting')
    expect(reconcileStatus({ status: 'cancelled', live: false }, 'running')).toBe('cancelled')
    expect(reconcileStatus({ status: 'completed', live: false }, 'waiting')).toBeNull()
    // The server reaped it while the page was away, but it runs.
    expect(reconcileStatus({ status: 'waiting', live: true }, 'interrupted')).toBe('waiting')
    // Live and flowing: the events carry it. Requeued or settled: leave it.
    expect(reconcileStatus({ status: 'running', live: true }, 'waiting')).toBeNull()
    expect(reconcileStatus({ status: 'interrupted', live: false }, 'queued')).toBeNull()
    expect(reconcileStatus({ status: 'interrupted', live: false }, 'cancelled')).toBeNull()
  })

  it('gap-fill math: after the server’s mark when the ring holds its run, else all', () => {
    const ring = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => env(S1, s, 'run-1')),
      env(S1, 9, 'run-2'),
      env(S1, 10, 'run-2'),
    ]
    expect(gapEntries(ring, { runId: 'run-1', seq: 5 }).map((e) => e.seq)).toEqual([6, 7, 8, 9, 10])
    expect(gapEntries(ring, { runId: 'run-2', seq: 9 }).map((e) => e.seq)).toEqual([10])
    // An earlier app run (the ring restarted at 1), or a mark that fell out of the ring.
    expect(gapEntries(ring, { runId: 'run-0', seq: 340 }).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(gapEntries(ring, null)).toHaveLength(10)
    expect(gapEntries([], { runId: 'run-1', seq: 5 })).toEqual([])

    expect(sinceSeqFor({ runId: 'run-1' }, { runId: 'run-1', seq: 5 })).toBe(5)
    expect(sinceSeqFor({ runId: 'run-2' }, { runId: 'run-1', seq: 5 })).toBe(0)
    expect(sinceSeqFor({ runId: null }, { runId: 'run-1', seq: 5 })).toBe(0)
    expect(sinceSeqFor(undefined, null)).toBe(0)
  })

  it('reads a token’s expiry and refreshes at 75% of its life', () => {
    const body = Buffer.from(JSON.stringify({ sid: S1, uid: 'u', wid: 'w', exp: 1_800_007_200 })).toString('base64url')
    expect(tokenExpiresAt(`la1.${body}.sig`)).toBe(1_800_007_200_000)
    expect(tokenExpiresAt('la1.x.y', '2026-10-21T00:00:00.000Z')).toBe(Date.parse('2026-10-21T00:00:00.000Z'))
    expect(tokenExpiresAt('la1.x.y', 1_800_000_000)).toBe(1_800_000_000_000)
    expect(tokenExpiresAt('la1.!!!.y')).toBeNull()
    expect(tokenExpiresAt('opaque')).toBeNull()
    expect(tokenRefreshDelay(0, 2 * 3600_000)).toBe(90 * 60_000)
    expect(tokenRefreshDelay(0, 1000)).toBe(5000)
  })

  it('chunks uploads by run, at most max, and passes unknown kinds back as sent', () => {
    const p = (seq: number, runId: string | null) => ({ seq, runId, event: { kind: 'text' } })
    const sorted = [p(1, 'a'), p(2, 'a'), p(3, null), p(4, 'b'), p(5, 'b')]
    expect(nextUploadChunk(sorted, 'a', 200)).toMatchObject({ runId: 'a', events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] })
    expect(nextUploadChunk(sorted, 'a', 2)?.events.map((e) => e.seq)).toEqual([1, 2])
    expect(nextUploadChunk([p(7, null)], null, 200)).toBeNull()
    expect(nextUploadChunk([], 'a', 200)).toBeNull()

    const raw = { kind: 'plan', steps: '["a"]' }
    expect(wireEvent({ kind: 'other', name: 'plan', raw })).toBe(raw)
    expect(wireEvent({ kind: 'text', delta: 'hi' })).toEqual({ kind: 'text', delta: 'hi' })
  })

  it('the heartbeat names the grants and the live session jobs', () => {
    const body = heartbeatBody(
      DEVICE,
      {
        grants: [grant('g1'), grant('g2', 'edit')],
        jobs: [job(S1), job(S2, { live: false }), job('local-dev-job'), job('33333333-3333-4333-8333-333333333333')],
      },
      new Set(['33333333-3333-4333-8333-333333333333']),
    )
    expect(body).toEqual({
      ...DEVICE,
      grants: [
        { grantId: 'g1', label: 'g1', path: '/Users/me/code/g1', mode: 'read', isGit: false },
        { grantId: 'g2', label: 'g2', path: '/Users/me/code/g2', mode: 'edit', isGit: true },
      ],
      liveJobIds: [S1],
      // No `baseBranch` in the status: an older desktop, which branches from HEAD.
      capabilities: [],
    })
    // A desktop that resolves an edit job's base branch says so (environments E3).
    expect(heartbeatBody(DEVICE, { grants: [], jobs: [], baseBranch: true })).toMatchObject({ capabilities: ['baseBranch'] })
    // Only the add-folder path rejoins (a removed Mac comes back that way alone).
    expect(heartbeatBody(DEVICE, { grants: [], jobs: [] }, new Set(), true)).toMatchObject({ rejoin: true })
    expect(heartbeatBody(DEVICE, { grants: [], jobs: [] })).not.toHaveProperty('rejoin')
  })
})

// ── The relay ───────────────────────────────────────────────────────────────

describe('relay: start and heartbeat', () => {
  it('stays dormant on a desktop without local agents', async () => {
    const h = await boot({
      setup: (x) => x.bridge.device.mockResolvedValue({ ok: false, unavailable: true, error: 'unavailable in this build' } as never),
    })
    expect(h.active).toBe(false)
    expect(h.bridge.onEvent).not.toHaveBeenCalled()
    await h.clock.advance(POLL_MS * 3)
    expect(h.server.fetch).not.toHaveBeenCalled()
  })

  it('heartbeats at start and every 60 s; refreshLocalAgentDevice goes through it', async () => {
    const h = await boot({ jobs: [job(S1, { live: true })], setup: (x) => x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null }) })
    expect(h.active).toBe(true)
    const beats = () => h.server.posts('/device')
    expect(beats()).toHaveLength(1)
    expect(beats()[0].body).toMatchObject({ deviceId: DEVICE.deviceId, liveJobIds: [S1] })
    await h.clock.advance(60_000)
    expect(beats()).toHaveLength(2)
    expect(await refreshLocalAgentDevice()).toEqual({ folders: [{ id: 'f1', grantId: 'g1', label: 'g1', mode: 'read', isGit: false }] })
    expect(beats()).toHaveLength(3)
  })
})

describe('relay: pending → claim → start', () => {
  it('duplicate doorbells don’t double-claim', async () => {
    const h = await boot({ setup: (x) => (x.server.state.pending.start = [pendingStart(S1)]) })
    // The pending list stays stale (it still offers S1) while doorbells pile up.
    await Promise.all([h.relay.ring(), h.relay.ring(), h.relay.ring()])
    await h.clock.advance(POLL_MS * 2)
    expect(h.server.posts('/claim')).toHaveLength(1)
    expect(h.bridge.start).toHaveBeenCalledTimes(1)
  })

  it('claims, starts with the claim’s args, rebinds the run, and holds uploads until then', async () => {
    const h = await boot({ setup: (x) => (x.server.state.pending.start = [pendingStart(S1)]) })
    await h.relay.flushAll()
    await h.clock.advance(BATCH_MS)
    expect(h.bridge.start).toHaveBeenCalledWith({
      grantId: 'g1',
      request: `request for ${S1}`,
      jobId: S1,
      mode: 'read',
      modelToken: 'la1.tok-1.mac',
      resume: null,
    })
    const order = h.log.filter((l) => /claim|^start|state|events/.test(l))
    expect(order).toEqual([
      `POST /sessions/${S1}/claim {"deviceId":"${DEVICE.deviceId}","runId":"claim-1"}`,
      `start ${S1}`,
      `POST /sessions/${S1}/state {"runId":"run-A","previousRunId":"claim-1","deviceId":"${DEVICE.deviceId}"}`,
      `POST /sessions/${S1}/events {"runId":"run-A","events":[{"seq":1,"event":{"kind":"status","status":"starting"}}]}`,
    ])
  })

  it('passes the Mac’s model with the claim when the desktop says (teammate plan)', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.state.localModel = true
      },
    })
    await h.relay.flushAll()
    expect(h.server.requests.find((r) => r.path.endsWith('/claim'))?.body).toEqual({ deviceId: DEVICE.deviceId, runId: 'claim-1', localModel: true })
  })

  it('a 409 on claim is skipped, and not retried until the cool-down passes', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.server.state.claimStatus = 409
      },
    })
    expect(h.server.posts('/claim')).toHaveLength(1)
    await h.relay.ring()
    await h.clock.advance(CLAIM_COOLDOWN_MS - POLL_MS)
    expect(h.server.posts('/claim')).toHaveLength(1)
    expect(h.bridge.start).not.toHaveBeenCalled()
    expect(h.server.posts('/state')).toHaveLength(0)
    await h.clock.advance(POLL_MS * 2)
    expect(h.server.posts('/claim')).toHaveLength(2)
  })

  it('a grant Rust doesn’t hold, or an edit on a read grant, fails the session', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1), pendingStart(S2)]
        x.server.state.claimBody = (id) => ({
          grantId: id === S1 ? 'g-gone' : 'g1',
          mode: id === S1 ? 'read' : 'edit',
          request: 'r',
          modelToken: null,
          resume: null,
        })
      },
    })
    expect(h.bridge.start).not.toHaveBeenCalled()
    expect(h.server.posts('/state').map((r) => [r.path.split('/')[4], r.body])).toEqual([
      [S1, { runId: 'claim-1', status: 'failed', error: GRANT_GONE }],
      [S2, { runId: 'claim-2', status: 'failed', error: GRANT_READ_ONLY }],
    ])
  })

  it('a start Rust refuses reports failed with its reason; a full Mac leaves it queued', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.bridge.start.mockResolvedValueOnce({ ok: false, unavailable: false, error: 'the folder moved' } as never)
      },
    })
    expect(h.server.posts('/state')[0].body).toEqual({ runId: 'claim-1', status: 'failed', error: 'the folder moved' })

    const busy = ['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333']
    const full = await boot({
      jobs: busy.map((id) => job(id)),
      setup: (x) => (x.server.state.pending.start = [pendingStart(S1)]),
    })
    expect(full.server.posts('/claim')).toHaveLength(0)

    // Three idle launchers don't block a start: Rust parks one to make room.
    const idle = await boot({
      jobs: busy.map((id) => job(id, { status: 'waiting' })),
      setup: (x) => (x.server.state.pending.start = [pendingStart(S1)]),
    })
    expect(idle.server.posts('/claim')).toHaveLength(1)
    expect(idle.bridge.start).toHaveBeenCalledTimes(1)
  })

  it('holds uploads until a failed rebind is retried and lands', async () => {
    let fails = 1
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.server.on('POST', /\/state$/, () => (fails-- > 0 ? { status: 503 } : undefined))
      },
    })
    h.server.state.pending.start = []
    await h.clock.advance(BATCH_MS)
    // Uploading now would store events the server never derives (it holds claim-1).
    expect(h.server.eventPosts()).toHaveLength(0)
    await h.clock.advance(1_000)
    expect(h.log.filter((l) => /state|events/.test(l))).toEqual([
      `POST /sessions/${S1}/state {"runId":"run-A","previousRunId":"claim-1","deviceId":"${DEVICE.deviceId}"}`,
      `POST /sessions/${S1}/state {"runId":"run-A","previousRunId":"claim-1","deviceId":"${DEVICE.deviceId}"}`,
      `POST /sessions/${S1}/events {"runId":"run-A","events":[{"seq":1,"event":{"kind":"status","status":"starting"}}]}`,
    ])
  })

  it('a definite no re-reads the session: rebinds from the run it holds, or lets go once it settled', async () => {
    const answers = [{ applied: false }, { applied: true }]
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.server.state.sessions.set(S1, { status: 'starting', runId: 'claim-other', lastDeviceSeq: null })
        x.server.on('POST', /\/state$/, () => ({ status: 200, body: { ...answers.shift(), stopRequested: false } }))
      },
    })
    h.server.state.pending.start = []
    await h.clock.advance(1_000 + BATCH_MS)
    expect(h.server.posts('/state').map((r) => r.body!.previousRunId)).toEqual(['claim-1', 'claim-other'])
    expect(h.server.eventPosts()).toHaveLength(1)

    const settled = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.server.state.sessions.set(S1, { status: 'cancelled', runId: 'claim-1', lastDeviceSeq: null })
        x.server.on('POST', /\/state$/, () => ({ status: 200, body: { applied: false, stopRequested: true } }))
      },
    })
    settled.server.state.pending.start = []
    await settled.clock.advance(BATCH_MS)
    // Nothing more to bind: the events only fill the transcript, and no retry follows.
    expect(settled.server.posts('/state')).toHaveLength(1)
    expect(settled.server.eventPosts()).toHaveLength(1)
    await settled.clock.advance(60_000)
    expect(settled.server.posts('/state')).toHaveLength(1)
  })
})

describe('relay: events', () => {
  async function bootStarted() {
    const h = await boot({ setup: (x) => (x.server.state.pending.start = [pendingStart(S1)]) })
    await h.clock.advance(BATCH_MS)
    h.server.state.pending.start = []
    h.server.requests.length = 0
    h.log.length = 0
    return h
  }

  it('batches at 500 ms or 50 events, and at most 200 per call', async () => {
    const h = await bootStarted()
    for (let s = 2; s <= 50; s++) h.emit(env(S1, s, 'run-A'))
    await h.clock.advance(BATCH_MS - 1)
    expect(h.server.eventPosts()).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.server.eventPosts().map((r) => (r.body!.events as unknown[]).length)).toEqual([49])

    // The 50th pending event goes at once.
    for (let s = 51; s <= 100; s++) h.emit(env(S1, s, 'run-A'))
    await settle()
    expect(h.server.eventPosts().map((r) => (r.body!.events as unknown[]).length)).toEqual([49, 50])

    for (let s = 101; s <= 550; s++) h.emit(env(S1, s, 'run-A'))
    await settle()
    expect(h.server.eventPosts().map((r) => (r.body!.events as unknown[]).length)).toEqual([49, 50, 200, 200, 50])
    expect(h.server.eventPosts().every((r) => r.body!.runId === 'run-A')).toBe(true)

    // Uploaded seqs are never sent again (a listener racing a gap-fill).
    h.emit(env(S1, 120, 'run-A'))
    await h.clock.advance(BATCH_MS)
    expect(h.server.eventPosts()).toHaveLength(5)
  })

  it('retries a failed upload, and stops the job when the server asks', async () => {
    const h = await bootStarted()
    let fail = true
    h.server.on('POST', /\/events$/, () => (fail ? { status: 503 } : undefined))
    h.emit(env(S1, 2, 'run-A'))
    await h.clock.advance(BATCH_MS)
    expect(h.server.eventPosts()).toHaveLength(1)
    fail = false
    h.server.on('POST', /\/events$/, () => ({ status: 200, body: { stopRequested: true, inserted: 1 } }))
    await h.clock.advance(2_000)
    expect(h.server.eventPosts()).toHaveLength(2)
    expect(h.server.eventPosts()[1].body!.events).toEqual([{ seq: 2, event: { kind: 'text', delta: 'd2' } }])
    expect(h.bridge.stop).toHaveBeenCalledWith(S1)
  })

  it('posts the eve session id and cursor after the events that moved them', async () => {
    const h = await bootStarted()
    h.state.jobs = h.state.jobs.map((j) => ({ ...j, sessionId: 'ses_9', streamIndex: 3, status: 'waiting' }))
    h.emit({ jobId: S1, seq: 2, runId: 'run-A', event: { kind: 'status', status: 'waiting' } })
    await h.clock.advance(BATCH_MS)
    const tail = h.log.filter((l) => /events|state/.test(l))
    expect(tail).toEqual([
      `POST /sessions/${S1}/events {"runId":"run-A","events":[{"seq":2,"event":{"kind":"status","status":"waiting"}}]}`,
      `POST /sessions/${S1}/state {"runId":"run-A","eveSessionId":"ses_9","streamIndex":3}`,
    ])
    // Unchanged on the next heartbeat: nothing more.
    await h.clock.advance(60_000)
    expect(h.server.posts('/state')).toHaveLength(1)
  })
})

describe('relay: gap-fill', () => {
  const ring = [...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => env(S1, s, 'run-1')), env(S1, 9, 'run-2'), env(S1, 10, 'run-2')]

  it('uploads the tail after the server’s (runId, seq), one call per run', async () => {
    const h = await boot({
      jobs: [job(S1, { runId: 'run-2', lastSeq: 10, status: 'running' })],
      setup: (x) => {
        x.state.rings.set(S1, ring)
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-2', lastDeviceSeq: { runId: 'run-1', seq: 5 } })
      },
    })
    await h.clock.advance(BATCH_MS)
    expect(h.bridge.events).toHaveBeenCalledWith(S1, 0)
    expect(h.server.eventPosts().map((r) => [r.body!.runId, (r.body!.events as Array<{ seq: number }>).map((e) => e.seq)])).toEqual([
      ['run-1', [6, 7, 8]],
      ['run-2', [9, 10]],
    ])
    // A live event already in the gap isn't sent again; a new one is.
    h.emit(env(S1, 9, 'run-2'))
    h.emit(env(S1, 11, 'run-2'))
    await h.clock.advance(BATCH_MS)
    expect(h.server.eventPosts().slice(2).map((r) => (r.body!.events as Array<{ seq: number }>).map((e) => e.seq))).toEqual([[11]])
  })

  it('reads the ring from the server’s seq when the job is still on that run; all of it after an app restart', async () => {
    const same = await boot({
      jobs: [job(S1, { runId: 'run-2', lastSeq: 10 })],
      setup: (x) => {
        x.state.rings.set(S1, ring)
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-2', lastDeviceSeq: { runId: 'run-2', seq: 9 } })
      },
    })
    await same.clock.advance(BATCH_MS)
    expect(same.bridge.events).toHaveBeenCalledWith(S1, 9)
    expect(same.server.eventPosts().map((r) => (r.body!.events as Array<{ seq: number }>).map((e) => e.seq))).toEqual([[10]])

    const restarted = await boot({
      jobs: [job(S1, { runId: 'run-2', lastSeq: 10 })],
      setup: (x) => {
        x.state.rings.set(S1, ring)
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-2', lastDeviceSeq: { runId: 'run-0', seq: 340 } })
      },
    })
    await restarted.clock.advance(BATCH_MS)
    expect(restarted.server.eventPosts().flatMap((r) => (r.body!.events as Array<{ seq: number }>).map((e) => e.seq))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })

  it('rebinds a run the server never heard of, and tells it a job the app lost is interrupted', async () => {
    const h = await boot({
      jobs: [job(S1, { runId: 'run-2', lastSeq: 2, live: false, status: 'interrupted', sessionId: 'ses_1', streamIndex: 4 })],
      setup: (x) => {
        x.state.rings.set(S1, [env(S1, 1, 'run-2'), env(S1, 2, 'run-2')])
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-1', lastDeviceSeq: null })
      },
    })
    await h.clock.advance(BATCH_MS)
    expect(h.log.filter((l) => /state|events/.test(l))).toEqual([
      `POST /sessions/${S1}/state {"runId":"run-2","previousRunId":"run-1","deviceId":"${DEVICE.deviceId}"}`,
      `POST /sessions/${S1}/events {"runId":"run-2","events":[{"seq":1,"event":{"kind":"text","delta":"d1"}},{"seq":2,"event":{"kind":"text","delta":"d2"}}]}`,
      `POST /sessions/${S1}/state {"runId":"run-2","status":"interrupted","eveSessionId":"ses_1","streamIndex":4}`,
    ])
  })

  it('after an app relaunch (no launcher, no ring), tells the server a job it thinks is working was interrupted', async () => {
    const relaunched = (id: string, status: LocalAgentJob['status']) =>
      job(id, { live: false, lastSeq: 0, status, runId: 'run-1', sessionId: 'ses_1', streamIndex: 3 })
    const h = await boot({
      jobs: [
        relaunched(S1, 'interrupted'),
        relaunched(S2, 'waiting'), // parked
        relaunched('33333333-3333-4333-8333-333333333333', 'cancelled'), // settled: not read
      ],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-1', lastDeviceSeq: { runId: 'run-0', seq: 40 } })
        x.server.state.sessions.set(S2, { status: 'waiting', runId: 'run-1', lastDeviceSeq: null })
      },
    })
    await h.clock.advance(BATCH_MS)
    expect(h.server.requests.filter((r) => r.method === 'GET' && r.path.includes('/sessions/')).map((r) => r.path.split('/')[4])).toEqual([
      `${S1}?limit=1`,
      `${S2}?limit=1`,
    ])
    expect(h.server.posts('/state').map((r) => [r.path.split('/')[4], r.body])).toEqual([
      [S1, { runId: 'run-1', status: 'interrupted', eveSessionId: 'ses_1', streamIndex: 3 }],
    ])
    expect(h.server.eventPosts()).toHaveLength(0)
    // Read once per relay: a reconnect doesn't read them again.
    await h.relay.reconnected()
    expect(h.server.requests.filter((r) => r.method === 'GET' && r.path.includes('/sessions/'))).toHaveLength(2)
  })

  it('ignores a job that isn’t a session of this person (the dev page’s)', async () => {
    const h = await boot({ jobs: [job(S1, { lastSeq: 3 })], setup: (x) => x.state.rings.set(S1, [env(S1, 1, 'run-A')]) })
    h.emit(env(S1, 4, 'run-A'))
    await h.clock.advance(BATCH_MS * 2)
    expect(h.server.requests.filter((r) => r.path.includes(S1)).map((r) => r.method)).toEqual(['GET'])
  })
})

describe('relay: messages and stops', () => {
  it('prefixes each message by its author, sends it once, and acks it', async () => {
    const msgs = [
      { id: 'm1', sessionId: S1, text: 'Look at auth too.', policy: 'steer', author: 'agent' },
      { id: 'm2', sessionId: S1, text: 'And the tests.', policy: 'queue', author: 'person' },
    ]
    const h = await boot({
      jobs: [job(S1)],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = msgs
      },
    })
    // Pending keeps listing them until the acks land: still sent once.
    await h.relay.ring()
    expect(h.bridge.send.mock.calls).toEqual([
      [S1, '[From the Dial8 agent] Look at auth too.', 'steer'],
      [S1, '[From Liam] And the tests.', 'queue'],
    ])
    expect(h.server.posts('/ack').map((r) => [r.path.split('/')[4], r.body])).toEqual([
      ['m1', { ok: true }],
      ['m2', { ok: true }],
    ])
  })

  it('stops come first: never behind a start or a message', async () => {
    const h = await boot({
      jobs: [job(S1)],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.start = [pendingStart(S2)]
        x.server.state.pending.messages = [{ id: 'm1', sessionId: S1, text: 'More.', policy: 'queue', author: 'agent' }]
        x.server.state.pending.stops = [{ sessionId: S1 }]
      },
    })
    const at = (line: string) => h.log.findIndex((l) => l.startsWith(line))
    expect(at(`stop ${S1}`)).toBeGreaterThanOrEqual(0)
    expect(at(`stop ${S1}`)).toBeLessThan(at(`start ${S2}`))
    expect(at(`stop ${S1}`)).toBeLessThan(at(`send ${S1}`))
  })

  it('a coding agent’s revival waits on the person off the drain, and its message rides in the resume', async () => {
    let answer: (v: { ok: true; value: { jobId: string; runId: string } }) => void = () => {}
    const h = await boot({
      jobs: [
        job(S1, { live: false, status: 'waiting', sessionId: 'ses-1', worker: 'claude-code' }),
        job(S2),
      ],
      setup: (x) => {
        for (const id of [S1, S2]) x.server.state.sessions.set(id, { status: 'waiting', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = [
          { id: 'm1', sessionId: S1, text: 'Now the tests.', policy: 'queue', author: 'person' },
          { id: 'm2', sessionId: S2, text: 'Look at auth.', policy: 'steer', author: 'agent' },
        ]
        // The person hasn't answered the confirm on the Mac yet.
        x.bridge.resume.mockImplementationOnce(() => new Promise((r) => (answer = r)))
      },
    })
    // The other session's message didn't wait for it.
    expect(h.bridge.send.mock.calls).toEqual([[S2, '[From the Dial8 agent] Look at auth.', 'steer']])
    // The message the confirm shows, and that Rust sends itself.
    expect(h.bridge.resume).toHaveBeenCalledWith(S1, expect.any(String), null, {
      text: '[From Liam] Now the tests.',
      policy: 'queue',
    })
    // A stop arriving meanwhile is handled at once.
    h.server.state.pending.stops = [{ sessionId: S2 }]
    await h.relay.ring()
    expect(h.log).toContain(`stop ${S2}`)
    expect(h.server.posts('/ack').map((r) => r.path.split('/')[4])).toEqual(['m2'])
    // The yes: delivered by the resume, never sent a second time.
    answer({ ok: true, value: { jobId: S1, runId: 'run-B' } })
    await settle()
    expect(h.server.posts('/ack').map((r) => [r.path.split('/')[4], r.body])).toEqual([
      ['m2', { ok: true }],
      ['m1', { ok: true }],
    ])
    expect(h.bridge.send.mock.calls.filter((c) => c[0] === S1)).toEqual([])
  })

  it('a coding agent’s start with no room stays queued, and the drain doesn’t spin on it', async () => {
    const S3 = '33333333-3333-4333-8333-333333333333'
    const S4 = '44444444-4444-4444-8444-444444444444'
    const h = await boot({
      jobs: [
        job(S1, { live: false, status: 'waiting', sessionId: 'ses-1', worker: 'claude-code' }),
        job(S2),
        job(S3),
        job(S4),
      ],
      setup: (x) => (x.server.state.pending.start = [pendingStart(S1)]),
    })
    const reads = h.bridge.status.mock.calls.length
    await settle()
    expect(h.bridge.status.mock.calls.length).toBe(reads)
    expect(h.server.posts('/claim')).toEqual([])
    expect(h.bridge.start).not.toHaveBeenCalled()
  })

  it('asks the person about one coding agent at a time; the other’s message waits, unacked', async () => {
    let answer: (v: { ok: true; value: { jobId: string; runId: string } }) => void = () => {}
    const h = await boot({
      jobs: [
        job(S1, { live: false, status: 'waiting', sessionId: 'ses-1', worker: 'claude-code' }),
        job(S2, { live: false, status: 'waiting', sessionId: 'ses-2', worker: 'codex' }),
      ],
      setup: (x) => {
        for (const id of [S1, S2]) x.server.state.sessions.set(id, { status: 'waiting', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = [
          { id: 'm1', sessionId: S1, text: 'One.', policy: 'queue', author: 'person' },
          { id: 'm2', sessionId: S2, text: 'Two.', policy: 'queue', author: 'person' },
        ]
        x.bridge.resume.mockImplementationOnce(() => new Promise((r) => (answer = r)))
      },
    })
    expect(h.bridge.resume.mock.calls.map((c) => c[0])).toEqual([S1])
    await h.relay.ring()
    expect(h.bridge.resume.mock.calls.map((c) => c[0]), 'never two confirms at once').toEqual([S1])
    expect(h.server.posts('/ack')).toEqual([])
    // The first answered: the drain runs again, and the second is asked.
    answer({ ok: true, value: { jobId: S1, runId: 'run-B' } })
    await settle()
    expect(h.bridge.resume.mock.calls.map((c) => c[0])).toEqual([S1, S2])
    expect(h.server.posts('/ack').map((r) => [r.path.split('/')[4], r.body])).toEqual([
      ['m1', { ok: true }],
      ['m2', { ok: true }],
    ])
  })

  it('a confirm already up on the Mac leaves a coding agent’s message pending, never failed', async () => {
    const ONE_CONFIRM = "another coding agent is waiting for the person's answer on this Mac; try again once it's answered"
    const h = await boot({
      jobs: [job(S1, { live: false, status: 'waiting', sessionId: 'ses-1', worker: 'claude-code' })],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'waiting', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = [{ id: 'm1', sessionId: S1, text: 'One.', policy: 'queue', author: 'person' }]
        x.bridge.resume.mockImplementationOnce(async () => ({ ok: false as const, unavailable: false, error: ONE_CONFIRM }))
      },
    })
    expect(h.bridge.resume).toHaveBeenCalledTimes(1)
    expect(h.server.posts('/ack')).toEqual([])
    // Rust reports a confirm up: nothing is tried meanwhile.
    h.state.jobs = [...h.state.jobs, job(S2, { status: 'starting', worker: 'codex', asking: true })]
    await h.relay.ring()
    expect(h.bridge.resume).toHaveBeenCalledTimes(1)
    // Answered: the next drain delivers it.
    h.state.jobs = h.state.jobs.filter((j) => j.id !== S2)
    await h.relay.ring()
    await settle()
    expect(h.bridge.resume).toHaveBeenCalledTimes(2)
    expect(h.server.posts('/ack').map((r) => [r.path.split('/')[4], r.body])).toEqual([['m1', { ok: true }]])
  })

  it('a coding agent’s claimed start Rust refuses for now is tried again within its claim', async () => {
    const ONE_CONFIRM = "another coding agent is waiting for the person's answer on this Mac; try again once it's answered"
    const h = await boot({
      jobs: [job(S1, { live: false, status: 'cancelled', sessionId: 'ses-1', worker: 'claude-code' })],
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.bridge.start.mockImplementationOnce(async () => ({ ok: false as const, unavailable: false, error: ONE_CONFIRM }))
      },
    })
    expect(h.bridge.start).toHaveBeenCalledTimes(1)
    expect(h.server.posts('/state').filter((r) => r.body?.status === 'failed')).toEqual([])
    await h.clock.advance(5_000)
    expect(h.bridge.start).toHaveBeenCalledTimes(2)
    expect(h.server.posts('/state').filter((r) => r.body?.status === 'failed')).toEqual([])
  })

  it('a stop while a coding agent’s start waits on the person is carried out', async () => {
    let answer: (v: { ok: true; value: { jobId: string; runId: string } }) => void = () => {}
    const h = await boot({
      jobs: [job(S1, { live: false, status: 'cancelled', sessionId: 'ses-1', worker: 'claude-code' })],
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        x.bridge.start.mockImplementationOnce(() => new Promise((r) => (answer = r)))
      },
    })
    expect(h.bridge.start).toHaveBeenCalledTimes(1)
    h.server.state.pending.start = []
    h.server.state.pending.stops = [{ sessionId: S1 }]
    await h.relay.ring()
    // Rust holds the job (its confirm up): it is stopped there at once…
    expect(h.bridge.stop.mock.calls.map((c) => c[0])).toEqual([S1])
    // …and if the yes came anyway, the launch is stopped as it lands.
    answer({ ok: true, value: { jobId: S1, runId: 'run-B' } })
    await settle()
    expect(h.bridge.stop.mock.calls.map((c) => c[0])).toEqual([S1, S1])
  })

  it('hands an edit job’s base branch to a desktop that resolves one (environments E3), and nothing else', async () => {
    const editClaim = (base: unknown) => (x: Harness) => {
      x.server.state.pending.start = [pendingStart(S1, { grantId: 'g2', mode: 'edit' })]
      const claimBody = x.server.state.claimBody
      x.server.state.claimBody = (id: string) => ({ ...claimBody(id), grantId: 'g2', mode: 'edit', baseBranch: base })
    }
    const startArgs = (h: { bridge: { start: { mock: { calls: unknown[][] } } } }) => h.bridge.start.mock.calls[0][0] as LocalAgentStartArgs
    const supported = await boot({ setup: (x) => { editClaim('develop')(x); x.state.baseBranch = true } })
    expect(startArgs(supported)).toMatchObject({ jobId: S1, mode: 'edit', baseBranch: 'develop' })
    // Its heartbeat tells the server it can (the server stamps a base only then).
    expect(supported.server.posts('/device')[0].body).toMatchObject({ capabilities: ['baseBranch'] })
    // An older desktop: no base (it branches from HEAD), and no capability.
    const older = await boot({ setup: editClaim('develop') })
    expect(startArgs(older)).not.toHaveProperty('baseBranch')
    expect(older.server.posts('/device')[0].body).toMatchObject({ capabilities: [] })
    // A name only, never a ref expression; a read job never.
    const bad = await boot({ setup: (x) => { editClaim('HEAD~1')(x); x.state.baseBranch = true } })
    expect(startArgs(bad)).not.toHaveProperty('baseBranch')
    const read = await boot({
      setup: (x) => {
        x.state.baseBranch = true
        x.server.state.pending.start = [pendingStart(S1)]
        const claimBody = x.server.state.claimBody
        x.server.state.claimBody = (id: string) => ({ ...claimBody(id), baseBranch: 'develop' })
      },
    })
    expect(startArgs(read)).not.toHaveProperty('baseBranch')
  })

  it('starts and resumes on the model the server recorded (teammate plan): the desktop launches on it or refuses', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        const claimBody = x.server.state.claimBody
        x.server.state.claimBody = (id: string) => ({ ...claimBody(id), localModel: true })
      },
    })
    await h.relay.flushAll()
    expect(h.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ jobId: S1, localModel: true }))
    // A parked job's resume takes it from the fresh token's answer.
    const r = await boot({
      jobs: [job(S2, { live: false, status: 'waiting', sessionId: 'ses_2', streamIndex: 1, runId: 'run-1' })],
      setup: (x) => {
        x.server.on('POST', /\/model-token$/, () => ({ status: 200, body: { modelToken: 'la1.tok-9.mac', expiresAt: null, localModel: false } }))
        x.server.state.sessions.set(S2, { status: 'waiting', runId: 'run-1', lastDeviceSeq: null })
        x.server.state.pending.messages = [{ id: 'm9', sessionId: S2, text: 'Carry on.', policy: 'queue', author: 'agent' }]
      },
    })
    await r.relay.flushAll()
    expect(r.bridge.resume).toHaveBeenCalledWith(S2, 'la1.tok-9.mac', false)
  })

  it('resumes a job no launcher runs (parked, say) with a fresh token, rebinds its run, then sends', async () => {
    const h = await boot({
      jobs: [job(S1, { live: false, status: 'waiting', sessionId: 'ses_1', streamIndex: 2, runId: 'run-1' })],
      setup: (x) => {
        x.state.nextRun = 1 // the resume makes run-B
        x.server.state.sessions.set(S1, { status: 'waiting', runId: 'run-1', lastDeviceSeq: null })
        x.server.state.pending.messages = [{ id: 'm1', sessionId: S1, text: 'Carry on.', policy: 'queue', author: 'agent' }]
      },
    })
    expect(h.log.filter((l) => !/^POST \/device |^GET \/device\/pending|^GET \/sessions\//.test(l))).toEqual([
      `POST /sessions/${S1}/model-token`,
      `resume ${S1} la1.tok-2.mac`,
      `POST /sessions/${S1}/state {"runId":"run-B","previousRunId":"run-1","deviceId":"${DEVICE.deviceId}"}`,
      `send ${S1} queue [From the Dial8 agent] Carry on.`,
      `POST /messages/m1/ack {"ok":true}`,
    ])
  })

  it('retries a send Rust refuses for now (three tries over ~10 s) before failing its ack', async () => {
    const busyErr = { ok: false, unavailable: false, error: "the agent isn't taking messages right now; try again" }
    const msg = { id: 'm1', sessionId: S1, text: 'hi', policy: 'steer', author: 'agent' }
    const later = await boot({
      jobs: [job(S1)],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = [msg]
        x.bridge.send.mockResolvedValueOnce(busyErr as never).mockResolvedValueOnce(busyErr as never)
      },
    })
    expect(later.bridge.send).toHaveBeenCalledTimes(1)
    expect(later.server.posts('/ack')).toHaveLength(0)
    await later.clock.advance(2_000)
    expect(later.bridge.send).toHaveBeenCalledTimes(2)
    await later.clock.advance(8_000)
    expect(later.bridge.send).toHaveBeenCalledTimes(3)
    expect(later.server.posts('/ack').map((r) => r.body)).toEqual([{ ok: true }])

    const never = await boot({
      jobs: [job(S1)],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = [msg]
        x.bridge.send.mockResolvedValue(busyErr as never)
      },
    })
    await never.clock.advance(30_000)
    expect(never.bridge.send).toHaveBeenCalledTimes(3)
    expect(never.server.posts('/ack').map((r) => r.body)).toEqual([{ ok: false, error: busyErr.error }])

    // A stopping job is final at once.
    const stopping = await boot({
      jobs: [job(S1)],
      setup: (x) => {
        x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null })
        x.server.state.pending.messages = [msg]
        x.bridge.send.mockResolvedValue({ ok: false, unavailable: false, error: 'this job is stopping' } as never)
      },
    })
    expect(stopping.bridge.send).toHaveBeenCalledTimes(1)
    expect(stopping.server.posts('/ack').map((r) => r.body)).toEqual([{ ok: false, error: 'this job is stopping' }])
  })

  it('revives a job parked since the status read, then sends', async () => {
    const h = await boot({
      jobs: [job(S1, { sessionId: 'ses_1', runId: 'run-1' })],
      setup: (x) => {
        x.state.nextRun = 1
        x.server.state.sessions.set(S1, { status: 'waiting', runId: 'run-1', lastDeviceSeq: null })
        x.server.state.pending.messages = [{ id: 'm1', sessionId: S1, text: 'Next.', policy: 'queue', author: 'agent' }]
        x.bridge.send.mockResolvedValueOnce({ ok: false, unavailable: false, error: "this job isn't running; resume it first" } as never)
      },
    })
    expect(h.bridge.resume).toHaveBeenCalledTimes(1)
    expect(h.bridge.send).toHaveBeenCalledTimes(2)
    expect(h.server.posts('/ack').map((r) => r.body)).toEqual([{ ok: true }])
  })

  it('a message for a job Rust doesn’t have fails its ack', async () => {
    const h = await boot({
      setup: (x) => (x.server.state.pending.messages = [{ id: 'm1', sessionId: S1, text: 'hi', policy: 'steer', author: 'person' }]),
    })
    expect(h.bridge.send).not.toHaveBeenCalled()
    expect(h.server.posts('/ack')[0].body).toMatchObject({ ok: false })
  })

  it('stops a live job; settles one no launcher runs as cancelled', async () => {
    const h = await boot({
      jobs: [job(S1), job(S2, { live: false, status: 'waiting', runId: 'run-Z' })],
      setup: (x) => (x.server.state.pending.stops = [{ sessionId: S1 }, { sessionId: S2 }]),
    })
    expect(h.bridge.stop.mock.calls).toEqual([[S1]])
    expect(h.server.posts('/state').map((r) => [r.path.split('/')[4], r.body])).toEqual([[S2, { runId: 'run-Z', status: 'cancelled' }]])
    // The doorbell rings again before the cancel lands: no second stop.
    await h.relay.ring()
    expect(h.bridge.stop).toHaveBeenCalledTimes(1)
  })
})

describe('relay: model token', () => {
  // Every 5 s of fake time is a poll, so these tokens live 8 minutes, not the real 2 hours:
  // waiting out 2-hour tokens fired ~2,300 timers, slow enough to time out on a busy machine.
  const LIFE = 8 * 60_000
  const DUE = 6 * 60_000 // 75% of LIFE

  /** The claim's token expires LIFE after boot. */
  const shortClaim = (x: Harness) => {
    const claim = x.server.state.claimBody
    x.server.state.claimBody = (id) => ({ ...claim(id), modelTokenExpiresAt: new Date(T0 + LIFE).toISOString() })
  }

  it('refreshes at 75% of the token’s life while the job is live, then stops', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        shortClaim(x)
        x.server.on('POST', /\/model-token$/, () => ({
          status: 200,
          body: { modelToken: `la1.tok-${++x.server.state.tokens}.mac`, expiresAt: new Date(x.clock.now() + LIFE).toISOString() },
        }))
      },
    })
    h.server.state.pending.start = []
    const refreshes = () => h.server.posts('/model-token')
    await h.clock.advance(DUE - 1_000)
    expect(refreshes()).toHaveLength(0)
    await h.clock.advance(1_000)
    expect(refreshes()).toHaveLength(1)
    expect(h.bridge.setModelToken).toHaveBeenCalledWith(S1, 'la1.tok-2.mac')

    // The new token's expiresAt sets the next one.
    await h.clock.advance(DUE)
    expect(refreshes()).toHaveLength(2)
    expect(h.bridge.setModelToken).toHaveBeenLastCalledWith(S1, 'la1.tok-3.mac')

    h.state.jobs = h.state.jobs.map((j) => ({ ...j, live: false, status: 'cancelled' }))
    await h.clock.advance(DUE)
    expect(refreshes()).toHaveLength(2)
  })

  it('a refreshed token with no expiresAt and an unreadable payload is assumed to live 2 h: the next refresh is set 90 min on', async () => {
    const h = await boot({
      setup: (x) => {
        x.server.state.pending.start = [pendingStart(S1)]
        shortClaim(x)
      },
    })
    h.server.state.pending.start = []
    await h.clock.advance(DUE)
    expect(h.server.posts('/model-token')).toHaveLength(1)
    expect(h.bridge.setModelToken).toHaveBeenCalledWith(S1, 'la1.tok-2.mac')
    expect(h.clock.dueTimes()).toContain(T0 + DUE + 90 * 60_000)
  })

  it('refreshes a live job found after a reload at once (its token’s age is unknown)', async () => {
    const h = await boot({
      jobs: [job(S1, { lastSeq: 0 })],
      setup: (x) => x.server.state.sessions.set(S1, { status: 'running', runId: 'run-A', lastDeviceSeq: null }),
    })
    expect(h.server.posts('/model-token')).toHaveLength(1)
    expect(h.bridge.setModelToken).toHaveBeenCalledWith(S1, 'la1.tok-2.mac')
  })
})
