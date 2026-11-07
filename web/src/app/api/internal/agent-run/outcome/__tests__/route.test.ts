/**
 * Route tests for POST /api/internal/agent-run/outcome — the eve coding-agent's
 * SINGLE terminal writer (Phase 3).
 *
 * Load-bearing invariants:
 *   1. AUTH: 401 without secret / token; 400 on a bad result enum.
 *   2. TERMINAL SETTLE + ACTION MIRROR: a completed/failed/pr_open result writes
 *      agent_run.status + finished_at and mirrors actions.agent_run_status with
 *      the SAME mapping legacy record-outcome uses (pr_open->'pr_open',
 *      completed->'idle', failed->'failed').
 *   3. IDEMPOTENCY MATRIX:
 *        - re-POST of the SAME outcome after terminal → 200 alreadySettled.
 *        - a CONFLICTING outcome after terminal → 409 OUTCOME_CONFLICT.
 *        - any outcome against a canceling/canceled row → 409 RUN_CANCELED (no
 *          resurrection).
 *   4. PR CREATE + REPLAY: pr_open creates the PR via the GitHub REST API (user's
 *      OAuth token) and upserts action_github_pr with onConflict
 *      'action_id,repo_full_name,pr_number'. A 422 "already exists" is handled by
 *      looking up the open PR and proceeding (replay-safe) — no failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-agent-run-secret-outcome-00'

// ── Stateful table store ────────────────────────────────────────────────────
const store: {
  agent_run: Record<string, unknown> | null
  actions: Record<string, unknown> | null
  user_oauth_tokens: Record<string, unknown> | null
} = { agent_run: null, actions: null, user_oauth_tokens: null }

const writes: {
  table: string
  op: 'update' | 'upsert'
  patch: Record<string, unknown>
  onConflict?: string
  /** The update's WHERE: eq filters + a `status NOT IN (...)` list, if any. */
  eqs?: Record<string, unknown>
  notInStatus?: string
  /** Whether the WHERE matched the stored row (i.e. the write actually landed). */
  took?: boolean
}[] = []

/**
 * Hook fired when the GitHub PR create is called — lets a test land a Stop
 * (flip the row to canceled) in the gap between the route's status read and
 * its terminal write.
 */
let onPrCreate: (() => void) | null = null

function makeClient() {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c
    c.maybeSingle = async () => ({ data: (store as Record<string, unknown>)[table] ?? null, error: null })
    // An UPDATE honors its WHERE like the database would: every eq filter and
    // a `.not('status','in','(a,b)')` guard must match the stored row, or the
    // write is refused (zero rows back from .select()).
    c.update = (patch: Record<string, unknown>) => {
      const rec: (typeof writes)[number] = { table, op: 'update', patch, eqs: {} }
      writes.push(rec)
      const apply = () => {
        const row = (store as Record<string, Record<string, unknown> | null>)[table]
        const eqOk = !!row && Object.entries(rec.eqs!).every(([k, v]) => row[k] === v)
        const notOk =
          !rec.notInStatus ||
          (!!row && !rec.notInStatus.replace(/[()]/g, '').split(',').includes(row.status as string))
        rec.took = eqOk && notOk
        if (rec.took) (store as Record<string, unknown>)[table] = { ...row, ...patch }
        return rec.took
      }
      const q: Record<string, unknown> = {
        eq: (k: string, v: unknown) => {
          rec.eqs![k] = v
          return q
        },
        not: (k: string, op: string, list: string) => {
          if (k === 'status' && op === 'in') rec.notInStatus = list
          return q
        },
        select: async () => ({ data: apply() ? [{ id: 'run-1' }] : [], error: null }),
        then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve().then(() => {
            apply()
            return { error: null }
          }).then(res, rej),
      }
      return q
    }
    c.upsert = (patch: Record<string, unknown>, opts?: { onConflict?: string }) => {
      writes.push({ table, op: 'upsert', patch, onConflict: opts?.onConflict })
      return { error: null }
    }
    return c
  }
  return { from: (t: string) => chain(t) }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeClient() }))
// The reviewer (P10 F6) approves here; its own gate is pinned in
// src/lib/coding/__tests__/review.test.ts and outcome-review.test.ts.
vi.mock('@/lib/coding/review', () => ({ reviewBeforePr: vi.fn(async () => ({ kind: 'open', entry: null, section: '' })) }))

import { POST } from '@/app/api/internal/agent-run/outcome/route'
import {
  mintAgentRunToken,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
} from '@/lib/agent-run/agent-run-token'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }

function outcomeReq(opts: { secret?: string | null; token?: string | null; body?: unknown }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret != null) headers[AGENT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token != null) headers[AGENT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/agent-run/outcome', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  })
}

/** Seed a running action-origin run ready to settle. */
function seedRunning(overrides: Record<string, unknown> = {}) {
  store.agent_run = {
    id: 'run-1',
    workspace_id: 'ws-1',
    status: 'running',
    action_id: 'action-1',
    triggered_by: 'user-1',
    repo_full_name: 'acme/web',
    branch: 'dial8/eng-42-run-1',
    base_branch: 'main',
    pr_url: null,
    log_tail: 'work...',
    ...overrides,
  }
  store.actions = { id: 'action-1', identifier: 'ENG-42', agent_run_status: 'running' }
  store.user_oauth_tokens = { access_token: 'ghp_outcome_token' }
}

const realFetch = globalThis.fetch

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  store.agent_run = null
  store.actions = null
  store.user_oauth_tokens = null
  writes.length = 0
  onPrCreate = null
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('POST /api/internal/agent-run/outcome — auth + validation', () => {
  it('401 without the shared secret', async () => {
    seedRunning()
    const res = await POST(outcomeReq({ token: mintAgentRunToken(CLAIMS), body: { result: 'completed' } }))
    expect(res.status).toBe(401)
  })
  it('401 with a garbage token', async () => {
    seedRunning()
    const res = await POST(outcomeReq({ secret: SECRET, token: 'nope', body: { result: 'completed' } }))
    expect(res.status).toBe(401)
  })
  it('400 on an invalid result enum', async () => {
    seedRunning()
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'weird' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_RESULT')
  })
  it('404 when the run is missing', async () => {
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'completed' } }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/internal/agent-run/outcome — terminal settle + action mirror', () => {
  it("completed → status 'completed' + action 'idle' + finished_at", async () => {
    seedRunning()
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'completed', summary: 'done' } }))
    expect(res.status).toBe(200)
    expect(store.agent_run!.status).toBe('completed')
    expect(typeof store.agent_run!.finished_at).toBe('string')
    expect(store.actions!.agent_run_status).toBe('idle')
  })

  it("failed → status 'failed' + action 'failed' + error recorded", async () => {
    seedRunning()
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'failed', error: 'boom' } }))
    expect(res.status).toBe(200)
    expect(store.agent_run!.status).toBe('failed')
    expect(store.agent_run!.error_message).toBe('boom')
    expect(store.actions!.agent_run_status).toBe('failed')
  })
})

describe('POST /api/internal/agent-run/outcome — PR create + single-writer upsert', () => {
  it('pr_open creates the PR, sets pr_url, and upserts action_github_pr with the legacy onConflict key', async () => {
    seedRunning()
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/7', number: 7 }), { status: 201 }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.prUrl).toBe('https://github.com/acme/web/pull/7')

    // agent_run settled pr_open with the URL.
    expect(store.agent_run!.status).toBe('pr_open')
    expect(store.agent_run!.pr_url).toBe('https://github.com/acme/web/pull/7')
    // action mirror → 'pr_open'.
    expect(store.actions!.agent_run_status).toBe('pr_open')

    // The PR was created via a POST to the GitHub pulls endpoint.
    const createCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/repos/acme/web/pulls'))
    expect(createCall).toBeTruthy()

    // Single-writer upsert with the SAME key legacy record-outcome uses.
    const upsert = writes.find((w) => w.table === 'action_github_pr' && w.op === 'upsert')
    expect(upsert).toBeTruthy()
    expect(upsert!.onConflict).toBe('action_id,repo_full_name,pr_number')
    expect(upsert!.patch).toMatchObject({
      workspace_id: 'ws-1',
      action_id: 'action-1',
      pr_url: 'https://github.com/acme/web/pull/7',
      repo_full_name: 'acme/web',
      pr_number: 7,
      head_branch: 'dial8/eng-42-run-1',
    })
  })

  it("pr_open with no base targets the repo's default branch (never an assumed 'main')", async () => {
    seedRunning({ base_branch: null }) // a run built before migration 371: no stored base
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/repos/acme/web')) {
        return new Response(JSON.stringify({ default_branch: 'master' }), { status: 200 })
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/8', number: 8 }), { status: 201 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1' } },
      }),
    )
    expect(res.status).toBe(200)
    const createCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/repos/acme/web/pulls'))
    expect(JSON.parse(String(createCall![1]!.body)).base).toBe('master')
  })

  it('pr_open replay: a 422 "already exists" looks up the open PR and proceeds (no failure)', async () => {
    seedRunning()
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/repos/acme/web/pulls')) {
        // POST create → 422 already exists.
        return new Response(JSON.stringify({ message: 'A pull request already exists' }), { status: 422 })
      }
      // GET lookup → the existing open PR.
      return new Response(JSON.stringify([{ html_url: 'https://github.com/acme/web/pull/7', number: 7 }]), { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(200)
    expect(store.agent_run!.status).toBe('pr_open')
    expect(store.agent_run!.pr_url).toBe('https://github.com/acme/web/pull/7')
    const upsert = writes.find((w) => w.table === 'action_github_pr' && w.op === 'upsert')
    expect(upsert!.patch).toMatchObject({ pr_number: 7 })
  })

  it('pr_open where PR creation hard-fails → run settled failed + 502', async () => {
    seedRunning()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'no commits between main and branch' }), { status: 422 })) as unknown as typeof fetch
    // 422 with NO matching open PR on lookup → real failure.
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('PR_CREATE_FAILED')
    // The run is settled FAILED, not left dangling.
    expect(store.agent_run!.status).toBe('failed')
    expect(store.actions!.agent_run_status).toBe('failed')
  })
})

// ── Branch guard: the PR comes from the spec's head into the spec's base ─────
describe('POST /api/internal/agent-run/outcome — head/base must be the spec branches', () => {
  function githubFetch() {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/repos/acme/web')) {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/9', number: 9 }), { status: 201 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    return fetchSpy
  }
  const prCreates = (spy: ReturnType<typeof githubFetch>) =>
    spy.mock.calls.filter((c) => String(c[0]).endsWith('/pulls'))

  for (const head of ['main', 'release', 'dial8/eng-42-other123', 'DIAL8/ENG-42-RUN-1']) {
    it(`pr.head '${head}' → 400 PR_HEAD_MISMATCH, no PR opened, nothing settled`, async () => {
      seedRunning()
      const fetchSpy = githubFetch()
      const res = await POST(
        outcomeReq({
          secret: SECRET,
          token: mintAgentRunToken(CLAIMS),
          body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head, base: 'main' } },
        }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('PR_HEAD_MISMATCH')
      expect(body.error).toContain("'dial8/eng-42-run-1'")
      expect(prCreates(fetchSpy)).toEqual([])
      expect(store.agent_run!.status).toBe('running')
      expect(writes).toEqual([])
    })
  }

  it('a pr.base other than the spec base (the default branch) → 400 PR_BASE_MISMATCH, no PR opened', async () => {
    seedRunning()
    const fetchSpy = githubFetch()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'release' } },
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('PR_BASE_MISMATCH')
    expect(prCreates(fetchSpy)).toEqual([])
    expect(store.agent_run!.status).toBe('running')
  })

  it('no pr.head → the PR opens from the spec head (never a row or model guess)', async () => {
    seedRunning({ branch: null })
    const fetchSpy = githubFetch()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', base: 'main' } },
      }),
    )
    expect(res.status).toBe(200)
    const created = JSON.parse(String(prCreates(fetchSpy)[0][1]!.body))
    expect(created).toMatchObject({ head: 'dial8/eng-42-run-1', base: 'main' })
    expect(store.agent_run!.branch).toBe('dial8/eng-42-run-1')
  })

  it('an action without an identifier keys the spec head off its id (no stored pair)', async () => {
    seedRunning({ branch: null, base_branch: null })
    store.actions = { id: 'action-1', identifier: null, agent_run_status: 'running' }
    const fetchSpy = githubFetch()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/action-1-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(String(prCreates(fetchSpy)[0][1]!.body)).head).toBe('dial8/action-1-run-1')
  })

  it("no stored pair and the run's action is gone → 400 PR_CONTEXT_MISSING, no PR opened", async () => {
    seedRunning({ branch: null, base_branch: null })
    store.actions = null
    const fetchSpy = githubFetch()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('PR_CONTEXT_MISSING')
    expect(prCreates(fetchSpy)).toEqual([])
  })

  it('flow-origin: a head other than dial8/flow-<run8>-<run8> → 400 PR_HEAD_MISMATCH', async () => {
    seedRunning({ action_id: null, repo_full_name: 'acme/api', branch: null })
    store.actions = null
    const fetchSpy = githubFetch()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'main', base: 'main' } },
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('PR_HEAD_MISMATCH')
    expect(prCreates(fetchSpy)).toEqual([])
  })

  it('the stored pair wins: a renamed identifier or a changed default branch does not move the check', async () => {
    seedRunning({ branch: 'dial8/eng-42-run-1', base_branch: 'develop' })
    store.actions = { id: 'action-1', identifier: 'WEB-99', agent_run_status: 'running' }
    const fetchSpy = githubFetch() // would answer default_branch 'main'
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: ' dial8/eng-42-run-1 ', base: 'develop\n' } },
      }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(String(prCreates(fetchSpy)[0][1]!.body))).toMatchObject({ head: 'dial8/eng-42-run-1', base: 'develop' })
    // No default-branch lookup: the stored base is the spec's.
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/repos/acme/web'))).toBe(false)
  })

  it('the stored base refuses the current default branch when the spec cloned another', async () => {
    seedRunning({ base_branch: 'develop' })
    const fetchSpy = githubFetch()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('PR_BASE_MISMATCH')
    expect(prCreates(fetchSpy)).toEqual([])
  })

  it('no stored base and the default-branch lookup fails → 503 BASE_LOOKUP_FAILED, nothing opened or settled', async () => {
    seedRunning({ base_branch: null })
    const fetchSpy = vi.fn(async (url: string) =>
      url.endsWith('/repos/acme/web')
        ? new Response('rate limited', { status: 403 })
        : new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/9', number: 9 }), { status: 201 }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('BASE_LOOKUP_FAILED')
    expect(prCreates(fetchSpy as never)).toEqual([])
    expect(store.agent_run!.status).toBe('running')
    expect(writes).toEqual([])
  })

  it('completed / failed results carry no PR and skip the branch guard', async () => {
    seedRunning()
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'completed', summary: 's', pr: { title: 'T', body: 'B', head: 'main', base: 'x' } },
      }),
    )
    expect(res.status).toBe(200)
    expect(store.agent_run!.status).toBe('completed')
  })
})

// ── Flow-origin runs (action_id NULL) ────────────────────────────────────────
// Flow-origin coding runs reach this route on eve for the first time: the run
// row settles like any other, and NOTHING is written to actions or
// action_github_pr (there is no action to mirror onto).
describe('POST /api/internal/agent-run/outcome — flow-origin run (no action)', () => {
  function seedFlowRunning() {
    seedRunning({ action_id: null, repo_full_name: 'acme/api', branch: 'dial8/flow-run-1-run-1' })
    store.actions = null
  }
  const noActionWrites = () =>
    writes.filter((w) => w.table === 'actions' || w.table === 'action_github_pr')

  it('pr_open → PR opened on the row repo, agent_run pr_open with pr_url, no actions / action_github_pr write', async () => {
    seedFlowRunning()
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ html_url: 'https://github.com/acme/api/pull/3', number: 3 }), { status: 201 }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', summary: 's', pr: { title: 'T', body: 'B', head: 'dial8/flow-run-1-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).prUrl).toBe('https://github.com/acme/api/pull/3')
    expect(store.agent_run!.status).toBe('pr_open')
    expect(store.agent_run!.pr_url).toBe('https://github.com/acme/api/pull/3')
    expect(store.agent_run!.branch).toBe('dial8/flow-run-1-run-1')
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/repos/acme/api/pulls'))).toBe(true)
    expect(noActionWrites()).toEqual([])
  })

  it('failed → agent_run failed with the error, no actions write', async () => {
    seedFlowRunning()
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'failed', error: 'tests broke' } }))
    expect(res.status).toBe(200)
    expect(store.agent_run!.status).toBe('failed')
    expect(store.agent_run!.error_message).toBe('tests broke')
    expect(noActionWrites()).toEqual([])
  })

  it('pr_open where PR creation hard-fails → agent_run failed + 502, no actions write', async () => {
    seedFlowRunning()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'no commits between main and branch' }), { status: 422 })) as unknown as typeof fetch
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/flow-run-1-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('PR_CREATE_FAILED')
    expect(store.agent_run!.status).toBe('failed')
    expect(noActionWrites()).toEqual([])
  })
})

describe('POST /api/internal/agent-run/outcome — idempotency matrix', () => {
  it('re-POST of the SAME outcome after terminal → 200 alreadySettled (no re-write)', async () => {
    seedRunning({ status: 'completed', pr_url: null })
    store.actions = { id: 'action-1', identifier: 'ENG-42', agent_run_status: 'idle' }
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'completed' } }))
    expect(res.status).toBe(200)
    expect((await res.json()).alreadySettled).toBe(true)
    // No terminal write happened on the replay.
    expect(writes.length).toBe(0)
  })

  it('a CONFLICTING outcome after terminal → 409 OUTCOME_CONFLICT', async () => {
    seedRunning({ status: 'completed' })
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'failed', error: 'x' } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('OUTCOME_CONFLICT')
    expect(writes.length).toBe(0)
  })

  it('same pr_open replay after already pr_open → 200 alreadySettled with the existing pr_url', async () => {
    seedRunning({ status: 'pr_open', pr_url: 'https://github.com/acme/web/pull/7' })
    // fetch must NOT be called — the replay short-circuits before PR creation.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const res = await POST(
      outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'pr_open', pr: { head: 'x', base: 'main' } } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.alreadySettled).toBe(true)
    expect(body.prUrl).toBe('https://github.com/acme/web/pull/7')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writes.length).toBe(0)
  })

  it('any outcome against a canceling row → 409 RUN_CANCELED (no resurrection)', async () => {
    seedRunning({ status: 'canceling' })
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'completed' } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_CANCELED')
    expect(writes.length).toBe(0)
    expect(store.agent_run!.status).toBe('canceling') // untouched
  })

  it('any outcome against a canceled row → 409 RUN_CANCELED', async () => {
    seedRunning({ status: 'canceled' })
    const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'failed', error: 'x' } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_CANCELED')
    expect(writes.length).toBe(0)
  })
})

// ── CAS on the coding-path terminal write ────────────────────────────────────
// The canceled check is an earlier read and PR creation is a GitHub round trip:
// a Stop that lands in between (agentRunCancel settling the row canceled) must
// NOT be overwritten by the late finish_run, and none of the mirrors may run.
describe('POST /api/internal/agent-run/outcome — terminal write is CAS-guarded', () => {
  const sideWrites = () =>
    writes.filter((w) => (w.table === 'actions' || w.table === 'action_github_pr') && w.took !== false)

  it('Stop lands during PR creation → row stays canceled, action untouched, 409 RUN_CANCELED carrying the prUrl', async () => {
    seedRunning()
    store.actions = { id: 'action-1', identifier: 'ENG-42', agent_run_status: 'idle' }
    globalThis.fetch = (async () => {
      // agentRunCancel settles the row while the GitHub call is in flight.
      store.agent_run = { ...store.agent_run!, status: 'canceled', error_message: 'Canceled by user' }
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/9', number: 9 }), { status: 201 })
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('RUN_CANCELED')
    expect(body.prUrl).toBe('https://github.com/acme/web/pull/9')
    // Not resurrected: the canceled row is intact.
    expect(store.agent_run!.status).toBe('canceled')
    expect(store.agent_run!.pr_url).toBeNull()
    expect(store.agent_run!.error_message).toBe('Canceled by user')
    // No action mirror, no PR link — the settle was dropped whole.
    expect(sideWrites()).toEqual([])
    expect(store.actions!.agent_run_status).toBe('idle')
    // The attempted write carried the tenancy + liveness guard.
    const attempt = writes.find((w) => w.table === 'agent_run' && w.patch.status === 'pr_open')
    expect(attempt?.eqs).toEqual({ id: 'run-1', workspace_id: 'ws-1' })
    expect(attempt?.notInStatus).toBe('(pr_open,completed,failed,canceled,canceling)')
    expect(attempt?.took).toBe(false)
    warn.mockRestore()
  })

  it('a row that went canceling between read and write is not settled (failed result)', async () => {
    // No GitHub call on this path, so flip the status via the token lookup read.
    seedRunning()
    const original = store.agent_run!
    let reads = 0
    Object.defineProperty(store, 'agent_run', {
      configurable: true,
      get: () => (reads++ === 0 ? original : { ...original, status: 'canceling' }),
      set: (v) => Object.assign(original, v),
    })
    try {
      const res = await POST(outcomeReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { result: 'failed', error: 'x' } }))
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('RUN_CANCELED')
      expect(sideWrites()).toEqual([])
    } finally {
      Object.defineProperty(store, 'agent_run', { configurable: true, writable: true, value: null })
    }
  })

  it('a concurrent identical settle won the CAS → 200 alreadySettled, no second mirror', async () => {
    seedRunning()
    globalThis.fetch = (async () => {
      store.agent_run = { ...store.agent_run!, status: 'pr_open', pr_url: 'https://github.com/acme/web/pull/9' }
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/9', number: 9 }), { status: 201 })
    }) as unknown as typeof fetch
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.alreadySettled).toBe(true)
    expect(body.prUrl).toBe('https://github.com/acme/web/pull/9')
    expect(sideWrites()).toEqual([])
  })

  it('Stop lands while a PR create fails → row stays canceled (not failed), 409 RUN_CANCELED', async () => {
    seedRunning()
    store.actions = { id: 'action-1', identifier: 'ENG-42', agent_run_status: 'idle' }
    globalThis.fetch = (async () => {
      store.agent_run = { ...store.agent_run!, status: 'canceled' }
      return new Response(JSON.stringify({ message: 'no commits between main and branch' }), { status: 422 })
    }) as unknown as typeof fetch
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_CANCELED')
    expect(store.agent_run!.status).toBe('canceled')
    expect(sideWrites()).toEqual([])
    expect(store.actions!.agent_run_status).toBe('idle')
  })

  it('flow-origin: Stop during PR creation leaves the canceled row alone', async () => {
    seedRunning({ action_id: null, repo_full_name: 'acme/api', branch: 'dial8/flow-run-1-run-1' })
    store.actions = null
    globalThis.fetch = (async () => {
      store.agent_run = { ...store.agent_run!, status: 'canceled' }
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/api/pull/4', number: 4 }), { status: 201 })
    }) as unknown as typeof fetch
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/flow-run-1-run-1', base: 'main' } },
      }),
    )
    expect(res.status).toBe(409)
    expect(store.agent_run!.status).toBe('canceled')
    expect(sideWrites()).toEqual([])
  })

  it('a DIFFERENT settle won the CAS after the PR was opened → 409 OUTCOME_CONFLICT carrying the prUrl, winner intact', async () => {
    seedRunning()
    globalThis.fetch = (async () => {
      // e.g. the watcher settled the row failed during the GitHub call.
      store.agent_run = { ...store.agent_run!, status: 'failed', error_message: 'agent ended without reporting an outcome' }
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/web/pull/9', number: 9 }), { status: 201 })
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('OUTCOME_CONFLICT')
    expect(body.prUrl).toBe('https://github.com/acme/web/pull/9')
    expect(store.agent_run!.status).toBe('failed')
    expect(store.agent_run!.pr_url).toBeNull()
    expect(store.agent_run!.error_message).toBe('agent ended without reporting an outcome')
    expect(sideWrites()).toEqual([])
    expect(store.actions!.agent_run_status).toBe('running')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a PR create fails while a non-cancel settle wins → 409 OUTCOME_CONFLICT (not 502), the winner is not overwritten', async () => {
    seedRunning()
    globalThis.fetch = (async () => {
      store.agent_run = { ...store.agent_run!, status: 'completed' }
      return new Response(JSON.stringify({ message: 'no commits between main and branch' }), { status: 422 })
    }) as unknown as typeof fetch

    const res = await POST(
      outcomeReq({
        secret: SECRET,
        token: mintAgentRunToken(CLAIMS),
        body: { result: 'pr_open', pr: { title: 'T', body: 'B', head: 'dial8/eng-42-run-1', base: 'main' } },
      }),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('OUTCOME_CONFLICT')
    expect(typeof body.prError).toBe('string')
    expect(store.agent_run!.status).toBe('completed')
    expect(sideWrites()).toEqual([])
    expect(store.actions!.agent_run_status).toBe('running')
  })
})
