/**
 * Capture visibility ("Workspace" vs "Only me") enforcement in the AI tool layer.
 *
 * These tools run on SERVICE-ROLE Supabase clients on the MCP / unattended
 * paths (RLS bypassed), so the filters asserted here — not RLS — are the real
 * enforcement. See docs/design-capture-visibility.md.
 *
 * Two axes are covered:
 *   1. Interactive (omitPrivateCaptures = false): the requester sees their own
 *      private captures, never someone else's.
 *   2. Unattended (omitPrivateCaptures = true): NO private capture is reachable,
 *      not even the run-as user's own, because unattended output lands in
 *      workspace-readable tables.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCaptureTools } from '../captures'
import { createSearchTools } from '../search'
import { createActionTools } from '../actions'
import { isCaptureVisible, applyCaptureVisibility } from '../_shared'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2]) }))
vi.mock('@/lib/ai/gemini-embeddings', () => ({ embedQuery: vi.fn(async () => [0.3]) }))
vi.mock('@/lib/email/email-search-service', () => ({ searchEmails: vi.fn(async () => ({ results: [] })) }))
vi.mock('@/lib/email/email-context-service', () => ({ searchEmailsWithContext: vi.fn(async () => []) }))
vi.mock('@/lib/proposed-changes/apply-engine', () => ({ applyChange: vi.fn() }))

const USER_ID = 'user-mine'
const OTHER_USER_ID = 'user-theirs'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<
  Record<string, unknown>
>

type CaptureRow = {
  id: string
  workspace_id: string
  user_id: string
  visibility: string
  title: string
  status?: string | null
  started_at?: string | null
  created_at?: string
}

const capture = (p: Partial<CaptureRow> & { id: string }): CaptureRow => ({
  workspace_id: WORKSPACE_ID,
  user_id: USER_ID,
  visibility: 'workspace',
  title: `capture ${p.id}`,
  status: 'ready',
  started_at: '2026-06-01T00:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  ...p,
})

const PUBLIC_CAPTURE = capture({ id: 'cap-public', visibility: 'workspace', user_id: OTHER_USER_ID })
const MY_PRIVATE = capture({ id: 'cap-mine-private', visibility: 'private', user_id: USER_ID })
const THEIR_PRIVATE = capture({ id: 'cap-theirs-private', visibility: 'private', user_id: OTHER_USER_ID })

const ALL_CAPTURES = [PUBLIC_CAPTURE, MY_PRIVATE, THEIR_PRIVATE]

/**
 * Chainable Supabase double for `captures` that actually EVALUATES the
 * visibility predicate the tool applies — either `.or('visibility.eq.workspace,
 * user_id.eq.<id>')` or `.eq('visibility','workspace')` — so the tests assert
 * on real filtering rather than a canned blob.
 */
function captureTableChain(rows: CaptureRow[]) {
  let filtered = [...rows]
  const chain: Record<string, unknown> = {}
  const self = () => chain

  chain.select = vi.fn(self)
  chain.order = vi.fn(self)
  chain.limit = vi.fn(self)
  chain.gte = vi.fn(self)
  chain.lte = vi.fn(self)
  chain.neq = vi.fn((col: string, val: unknown) => {
    filtered = filtered.filter((r) => (r as unknown as Record<string, unknown>)[col] !== val)
    return chain
  })
  chain.eq = vi.fn((col: string, val: unknown) => {
    filtered = filtered.filter((r) => (r as unknown as Record<string, unknown>)[col] === val)
    return chain
  })
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    filtered = filtered.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]))
    return chain
  })
  chain.or = vi.fn((filter: string) => {
    // Only the capture-visibility disjunction is modeled: "visibility.eq.X,user_id.eq.Y".
    const clauses = filter.split(',').map((c) => c.split('.'))
    filtered = filtered.filter((r) =>
      clauses.some(([col, op, val]) => {
        const v = (r as unknown as Record<string, unknown>)[col]
        // The owner-out condition (migration 568) is "neq": a column the fixture lacks is not that value.
        return op === 'neq' ? String(v) !== val : v === val
      }),
    )
    return chain
  })
  chain.maybeSingle = vi.fn(async () => ({ data: filtered[0] ?? null, error: null }))
  chain.single = vi.fn(async () =>
    filtered[0]
      ? { data: filtered[0], error: null }
      : { data: null, error: { message: 'No rows found' } },
  )
  chain.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve({ data: filtered, error: null }).then(resolve)

  return chain
}

/** rpc double typed with its real (name, args) signature so mock.calls is indexable. */
function makeRpcMock() {
  return vi.fn(async (_name: string, _args?: Record<string, unknown>) => ({ data: [], error: null }))
}

function makeSupabase(rows: CaptureRow[] = ALL_CAPTURES, extra: Record<string, unknown> = {}) {
  const rpc = makeRpcMock()
  const from = vi.fn((table: string) => {
    if (table === 'captures') return captureTableChain(rows)
    if (extra[table]) return extra[table]
    // Anything else resolves empty so tools don't explode.
    return captureTableChain([])
  })
  return { from, rpc } as unknown as never
}

function tools(supabase: unknown, omitPrivateCaptures = false) {
  return createCaptureTools(USER_ID, supabase as never, WORKSPACE_ID, undefined, false, omitPrivateCaptures)
}

async function runListCaptures(supabase: unknown, omitPrivateCaptures = false) {
  const t = tools(supabase, omitPrivateCaptures)
  const parsed = (t.list_captures.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({})
  return t.list_captures.execute!(parsed as never, EXEC_OPTS)
}

describe('isCaptureVisible', () => {
  it('lets anyone see workspace captures', () => {
    expect(isCaptureVisible(PUBLIC_CAPTURE, USER_ID)).toBe(true)
    expect(isCaptureVisible(PUBLIC_CAPTURE, null)).toBe(true)
  })

  it('shows a private capture only to its creator', () => {
    expect(isCaptureVisible(MY_PRIVATE, USER_ID)).toBe(true)
    expect(isCaptureVisible(THEIR_PRIVATE, USER_ID)).toBe(false)
  })

  it('fails closed on a null requester and a missing row', () => {
    expect(isCaptureVisible(MY_PRIVATE, null)).toBe(false)
    expect(isCaptureVisible(null, USER_ID)).toBe(false)
  })
})

describe('applyCaptureVisibility', () => {
  // The eval fence runs FIRST and chains, so `neq` must return the builder
  // itself — a double that returned a sentinel here would break the
  // visibility call that follows it rather than the assertion under test.
  function visibilityQuery() {
    const q: Record<string, ReturnType<typeof vi.fn>> = {}
    Object.assign(q, {
      neq: vi.fn(() => q),
      or: vi.fn(() => q),
      eq: vi.fn(() => 'eq'),
    })
    return q
  }

  it('uses the or-disjunction for a real requester', () => {
    const q = visibilityQuery()
    expect(applyCaptureVisibility(q, USER_ID)).toBe(q)
    expect(q.or).toHaveBeenCalledWith(`visibility.eq.workspace,user_id.eq.${USER_ID}`)
    // …and never the requester's own call notes once they left the conversation (568's notes_owner_out).
    expect(q.or).toHaveBeenCalledWith(`notes_owner_out.neq.true,user_id.neq.${USER_ID}`)
    expect(q.eq).not.toHaveBeenCalled()
  })

  it('narrows to workspace-only when there is no requester', () => {
    const q = visibilityQuery()
    expect(applyCaptureVisibility(q, null)).toBe('eq')
    expect(q.eq).toHaveBeenCalledWith('visibility', 'workspace')
    expect(q.or).not.toHaveBeenCalled()
  })

  it('fences eval captures by default on both requester branches', () => {
    for (const requester of [USER_ID, null]) {
      const q = visibilityQuery()
      applyCaptureVisibility(q, requester)
      // `.neq('is_eval', true)`, never `.eq('is_eval', false)` — a row written
      // before migration 252 lands has a NULL here and must still be visible.
      expect(q.neq).toHaveBeenCalledWith('is_eval', true)
    }
  })

  it('skips the fence only when the Evals surface opts in', () => {
    const q = visibilityQuery()
    applyCaptureVisibility(q, USER_ID, true)
    expect(q.neq).not.toHaveBeenCalled()
  })
})

describe('list_captures', () => {
  it("excludes another user's private capture but keeps the requester's own", async () => {
    const result = (await runListCaptures(makeSupabase())) as {
      success: boolean
      captures: Array<{ id: string }>
    }
    expect(result.success).toBe(true)
    const ids = result.captures.map((c) => c.id)
    expect(ids).toContain(PUBLIC_CAPTURE.id)
    expect(ids).toContain(MY_PRIVATE.id)
    expect(ids).not.toContain(THEIR_PRIVATE.id)
  })

  it('excludes EVERY private capture — including the run-as user\'s own — when omitPrivateCaptures is set', async () => {
    const result = (await runListCaptures(makeSupabase(), true)) as {
      success: boolean
      captures: Array<{ id: string }>
    }
    expect(result.captures.map((c) => c.id)).toEqual([PUBLIC_CAPTURE.id])
  })
})

describe('list_recent_captures', () => {
  it('applies the visibility filter per workspace', async () => {
    const supabase = makeSupabase(ALL_CAPTURES, {
      member: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(async () => ({ data: [{ workspace: { id: WORKSPACE_ID, name: 'WS' } }], error: null })),
      },
    })
    const t = tools(supabase)
    const parsed = (t.list_recent_captures.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse(
      { cross_workspace: false },
    )
    const result = (await t.list_recent_captures.execute!(parsed as never, EXEC_OPTS)) as {
      captures: Array<{ id: string }>
    }
    const ids = result.captures.map((c) => c.id)
    expect(ids).toContain(MY_PRIVATE.id)
    expect(ids).not.toContain(THEIR_PRIVATE.id)
  })
})

describe('list_recent_captures — strictWorkspace', () => {
  it('never fans out to other workspaces in a run fenced to one', async () => {
    const OTHER_WS = capture({ id: 'cap-other-ws', workspace_id: 'ws-2' })
    const memberEq = vi.fn(async () => ({
      data: [{ workspace: { id: WORKSPACE_ID, name: 'WS' } }, { workspace: { id: 'ws-2', name: 'Other' } }],
      error: null,
    }))
    const supabase = makeSupabase([...ALL_CAPTURES, OTHER_WS], {
      member: { select: vi.fn().mockReturnThis(), eq: memberEq },
    })
    const t = createCaptureTools(USER_ID, supabase as never, WORKSPACE_ID, undefined, true, false)
    // cross_workspace defaults to true.
    const parsed = (t.list_recent_captures.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({})
    const result = (await t.list_recent_captures.execute!(parsed as never, EXEC_OPTS)) as {
      captures: Array<{ id: string }>
    }
    expect(result.captures.map((c) => c.id)).not.toContain(OTHER_WS.id)
    expect(memberEq).not.toHaveBeenCalled()
  })
})

describe('ID-based capture tools', () => {
  const runGetContent = async (captureId: string, omitPrivate = false) => {
    const t = tools(makeSupabase(), omitPrivate)
    const parsed = (t.get_capture_content.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      capture_id: captureId,
    })
    return (await t.get_capture_content.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      error?: string
      capture?: { id: string }
    }
  }

  it("denies another user's private capture with the plain not-found error", async () => {
    const result = await runGetContent(THEIR_PRIVATE.id)
    expect(result.success).toBe(false)
    // Same shape as a nonexistent id — never leaks that the capture exists.
    expect(result.error).toBe('Capture not found')
  })

  it("allows the creator to read their own private capture", async () => {
    const result = await runGetContent(MY_PRIVATE.id)
    expect(result.success).toBe(true)
    expect(result.capture?.id).toBe(MY_PRIVATE.id)
  })

  it('denies the run-as user their OWN private capture under omitPrivateCaptures', async () => {
    const result = await runGetContent(MY_PRIVATE.id, true)
    expect(result.success).toBe(false)
    expect(result.error).toBe('Capture not found')
  })

  it('still serves workspace captures under omitPrivateCaptures', async () => {
    const result = await runGetContent(PUBLIC_CAPTURE.id, true)
    expect(result.success).toBe(true)
  })

  it('gates get_capture_transcript, update_capture and archive_capture the same way', async () => {
    const t = tools(makeSupabase())
    const call = async (name: 'get_capture_transcript' | 'update_capture' | 'archive_capture') => {
      const toolDef = t[name]
      const parsed = (toolDef.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
        capture_id: THEIR_PRIVATE.id,
      })
      return (await toolDef.execute!(parsed as never, EXEC_OPTS)) as { success: boolean; error?: string }
    }
    for (const name of ['get_capture_transcript', 'update_capture', 'archive_capture'] as const) {
      const r = await call(name)
      expect(r.success, name).toBe(false)
      expect(r.error, name).toBe('Capture not found')
    }
  })

  it('gates get_capture_extractions on the parent capture', async () => {
    const t = tools(makeSupabase())
    const parsed = (
      t.get_capture_extractions.inputSchema as unknown as { parse: (v: unknown) => unknown }
    ).parse({ capture_id: THEIR_PRIVATE.id })
    const r = (await t.get_capture_extractions.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      error?: string
    }
    expect(r.success).toBe(false)
    expect(r.error).toBe('Capture not found')
  })
})

describe('search.ts RPC requester threading', () => {
  const runFind = async (omitPrivateCaptures: boolean) => {
    const rpc = makeRpcMock()
    const supabase = {
      from: vi.fn(() => captureTableChain([])),
      rpc,
      storage: { from: () => ({ createSignedUrl: vi.fn(async () => ({ data: null })) }) },
    }
    const t = createSearchTools(USER_ID, supabase as never, WORKSPACE_ID, omitPrivateCaptures)
    const parsed = (t.find.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      query: 'pricing',
      types: ['claim', 'capture', 'attachment'],
    })
    await t.find.execute!(parsed as never, EXEC_OPTS)
    return rpc
  }

  it('passes the user id to hybrid_search / hybrid_search_attachments for interactive runs', async () => {
    const rpc = await runFind(false)
    const hybrid = rpc.mock.calls.find((c) => c[0] === 'hybrid_search')
    expect(hybrid?.[1]).toMatchObject({ p_requesting_user_id: USER_ID })
    const attachments = rpc.mock.calls.find((c) => c[0] === 'hybrid_search_attachments')
    expect(attachments?.[1]).toMatchObject({ p_requesting_user_id: USER_ID })
  })

  it('passes null (fail closed) when omitPrivateCaptures is set', async () => {
    const rpc = await runFind(true)
    const hybrid = rpc.mock.calls.find((c) => c[0] === 'hybrid_search')
    expect(hybrid?.[1]).toMatchObject({ p_requesting_user_id: null })
    const attachments = rpc.mock.calls.find((c) => c[0] === 'hybrid_search_attachments')
    expect(attachments?.[1]).toMatchObject({ p_requesting_user_id: null })
  })

  it('threads the requester into unified_search and match_claims', async () => {
    const rpc = makeRpcMock()
    const supabase = { from: vi.fn(() => captureTableChain([])), rpc }
    const t = createSearchTools(USER_ID, supabase as never, WORKSPACE_ID, true)

    const searchArgs = (t.search.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      query: 'x',
      types: ['capture'],
    })
    await t.search.execute!(searchArgs as never, EXEC_OPTS)
    expect(rpc.mock.calls.find((c) => c[0] === 'unified_search')?.[1]).toMatchObject({
      p_requesting_user_id: null,
    })

    const deepArgs = (t.deep_search.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      query: 'x',
      types: ['claims'],
    })
    await t.deep_search.execute!(deepArgs as never, EXEC_OPTS)
    expect(rpc.mock.calls.find((c) => c[0] === 'match_claims')?.[1]).toMatchObject({
      p_requesting_user_id: null,
    })
  })

  it('leaves the rag_search RPC signature alone — it takes no requester param', async () => {
    const rpc = makeRpcMock()
    const supabase = {
      from: vi.fn(() => captureTableChain([])),
      rpc,
      storage: { from: () => ({ createSignedUrl: vi.fn(async () => ({ data: null })) }) },
    }
    const t = createSearchTools(USER_ID, supabase as never, WORKSPACE_ID, true)
    const parsed = (t.deep_search.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      query: 'x',
      types: ['captures'],
    })
    await t.deep_search.execute!(parsed as never, EXEC_OPTS)
    const rag = rpc.mock.calls.find((c) => c[0] === 'rag_search')
    expect(rag).toBeDefined()
    expect(rag?.[1]).not.toHaveProperty('p_requesting_user_id')
  })
})

describe('deep_search rag_search post-filter', () => {
  /**
   * rag_search is keyed on the CHUNK's user_id — the capture owner at index
   * time — so an unattended run "as" the creator gets that creator's own private
   * chunks straight back from the RPC. The tool must post-filter on the parent
   * capture's visibility, or verbatim transcript text launders into a
   * workspace-readable report. See docs/design-capture-visibility.md.
   */
  const CHUNKS = ALL_CAPTURES.map((c) => ({
    capture_id: c.id,
    chunk_text: `transcript of ${c.id}`,
    similarity: 0.9,
    capture_title: c.title,
  }))

  const runDeepSearch = async (omitPrivateCaptures: boolean) => {
    const supabase = {
      from: vi.fn(() => captureTableChain(ALL_CAPTURES)),
      rpc: vi.fn(async (name: string) =>
        name === 'rag_search' ? { data: CHUNKS, error: null } : { data: [], error: null },
      ),
      storage: { from: () => ({ createSignedUrl: vi.fn(async () => ({ data: null })) }) },
    }
    const t = createSearchTools(USER_ID, supabase as never, WORKSPACE_ID, omitPrivateCaptures)
    const parsed = (t.deep_search.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      query: 'x',
      types: ['captures'],
    })
    const res = (await t.deep_search.execute!(parsed as never, EXEC_OPTS)) as {
      captures?: Array<{ capture_id: string }>
    }
    return (res.captures ?? []).map((r) => r.capture_id)
  }

  it("drops the run-as user's OWN private chunks under omitPrivateCaptures", async () => {
    expect(await runDeepSearch(true)).toEqual([PUBLIC_CAPTURE.id])
  })

  it('leaves interactive runs unfiltered — the RPC is already caller-keyed there', async () => {
    const ids = await runDeepSearch(false)
    expect(ids).toContain(PUBLIC_CAPTURE.id)
    expect(ids).toContain(MY_PRIVATE.id)
  })
})

describe('get_action_suggestions', () => {
  /** Records the filters applied to `proposed_change` so we can assert the embed predicate. */
  function proposedChangeSupabase() {
    const orCalls: Array<[string, unknown]> = []
    const eqCalls: Array<[string, unknown]> = []
    const neqCalls: Array<[string, unknown, unknown]> = []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = vi.fn(self)
    chain.order = vi.fn(self)
    chain.range = vi.fn(self)
    chain.limit = vi.fn(self)
    chain.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push([col, val])
      return chain
    })
    chain.neq = vi.fn((col: string, val: unknown, opts?: unknown) => {
      neqCalls.push([col, val, opts])
      return chain
    })
    chain.or = vi.fn((filter: string, opts?: unknown) => {
      orCalls.push([filter, opts])
      return chain
    })
    chain.then = (resolve: (r: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve)

    const supabase = { from: vi.fn(() => chain), rpc: vi.fn() }
    return { supabase, orCalls, eqCalls, neqCalls }
  }

  const run = async (omitPrivateCaptures: boolean) => {
    const { supabase, orCalls, eqCalls, neqCalls } = proposedChangeSupabase()
    const t = createActionTools(USER_ID, supabase as never, WORKSPACE_ID, false, omitPrivateCaptures)
    const parsed = (t.get_action_suggestions.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse(
      {},
    )
    await t.get_action_suggestions.execute!(parsed as never, EXEC_OPTS)
    return { orCalls, eqCalls, neqCalls }
  }

  it('filters the main query and the pending_by_capture rollup on the embedded capture', async () => {
    const { orCalls } = await run(false)
    const visibilityOrs = orCalls.filter(([f]) => f.includes('visibility.eq.workspace'))
    // One for the paged query, one for the whole-queue rollup.
    expect(visibilityOrs).toHaveLength(2)
    for (const [filter, opts] of visibilityOrs) {
      expect(filter).toBe(`visibility.eq.workspace,user_id.eq.${USER_ID}`)
      expect(opts).toEqual({ referencedTable: 'capture' })
    }
  })

  it('narrows to workspace-visible captures only under omitPrivateCaptures', async () => {
    const { orCalls, eqCalls } = await run(true)
    expect(orCalls.filter(([f]) => f.includes('visibility'))).toHaveLength(0)
    expect(eqCalls.filter(([col, val]) => col === 'capture.visibility' && val === 'workspace')).toHaveLength(2)
  })

  it('fences eval captures on the embedded capture, on both queries and both modes', async () => {
    for (const omitPrivate of [false, true]) {
      const { neqCalls } = await run(omitPrivate)
      const evalFences = neqCalls.filter(([col]) => col === 'capture.is_eval')
      // The paged query and the whole-queue rollup each carry the fence; a
      // suggestion sourced from a mock call must never reach the review queue.
      expect(evalFences).toHaveLength(2)
      for (const [, val] of evalFences) expect(val).toBe(true)
    }
  })
})

describe('get_capture_extractions — stored confirmation', () => {
  it('reports each stored row with its real confirmation and leaves dismissed ones out', async () => {
    const actions = [
      { id: 'a-1', source_capture_id: PUBLIC_CAPTURE.id, workspace_id: WORKSPACE_ID, title: 'kept', confirmation: 'confirmed' },
      { id: 'a-2', source_capture_id: PUBLIC_CAPTURE.id, workspace_id: WORKSPACE_ID, title: 'open', confirmation: 'suggested' },
      { id: 'a-3', source_capture_id: PUBLIC_CAPTURE.id, workspace_id: WORKSPACE_ID, title: 'no', confirmation: 'dismissed' },
    ]
    const decisions = [
      { id: 'd-1', capture_id: PUBLIC_CAPTURE.id, content: 'suggested one', confirmation: 'suggested' },
      { id: 'd-2', capture_id: PUBLIC_CAPTURE.id, content: 'dismissed one', confirmation: 'dismissed' },
    ]
    const supabase = makeSupabase(ALL_CAPTURES, {
      actions: captureTableChain(actions as never),
      decision: captureTableChain(decisions as never),
    })
    const t = tools(supabase)
    const parsed = (
      t.get_capture_extractions.inputSchema as unknown as { parse: (v: unknown) => unknown }
    ).parse({ capture_id: PUBLIC_CAPTURE.id })
    const r = (await t.get_capture_extractions.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      actions: Array<{ id: string; confirmation: string }>
      decisions: Array<{ id: string; confirmation: string }>
      summary: Record<string, number>
    }

    expect(r.success).toBe(true)
    expect(r.actions.map((a) => [a.id, a.confirmation])).toEqual([
      ['a-1', 'confirmed'],
      ['a-2', 'suggested'],
    ])
    expect(r.decisions.map((d) => [d.id, d.confirmation])).toEqual([['d-1', 'suggested']])
    expect(r.summary).toMatchObject({
      total_actions: 2,
      confirmed_actions: 1,
      suggested_actions: 1,
      total_decisions: 1,
      suggested_decisions: 1,
    })
  })
})
