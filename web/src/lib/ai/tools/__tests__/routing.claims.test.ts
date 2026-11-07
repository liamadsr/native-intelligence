/**
 * Workspace routing for claims.ts:
 *   - create_claim is a ROOT create — no existing row to route by — and now
 *     takes an optional `workspace_id`, resolved through
 *     `resolveCreateWorkspace` (_shared.ts) exactly like every other
 *     create-bearing factory. targetWs replaces the active workspace for the
 *     insert AND every provenance lookup (sources[]/links[] entityInWorkspace
 *     checks), never leaving a check pinned to the session workspace.
 *   - link_entities / ingest_source / ingest_reference are converted MUTATES:
 *     each resolves its anchoring id (source_id / source_id / attachment_id)
 *     through `resolveEntityWorkspace` first, then runs its existing checks
 *     against THAT workspace. `confirm_claim` / `dismiss_claim` /
 *     `supersede_claim` / `get_claim` already routed before this change and
 *     are untouched — no coverage added here for them.
 *
 * What is pinned here (create_claim):
 *   1. an explicit foreign workspace_id (a member) routes the insert AND the
 *      sources[]/links[] entityInWorkspace checks to the target workspace;
 *   2. an explicit non-member workspace_id is the flat 'Workspace not found',
 *      and nothing is written;
 *   3. policy 'explicit' with >= 2 workspaces and no id refuses with
 *      `needs_workspace` + candidates, and writes nothing;
 *   4. policy 'session' with no id is byte-identical — the session workspace,
 *      with the SAME single `member` lookup as before (resolveMemberId's own,
 *      pre-existing one) and no extra query for the resolution itself;
 *   5. under `strictWorkspace`, an explicit foreign id is not-found with NO
 *      membership probe issued at all.
 *
 * What is pinned here (link_entities / ingest_source / ingest_reference):
 *   6. a foreign-but-member anchor id routes the write/dispatch to the
 *      workspace it actually lives in;
 *   7. under `strictWorkspace` the same anchor id is not-found and nothing is
 *      written or dispatched.
 *
 * The Supabase double is the same lazy tableChain used by the sibling
 * routing.*.test.ts files, generalized over several entity tables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'

vi.mock('@/lib/ai/embeddings', () => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}))
const { attachClaimProvenance } = vi.hoisted(() => ({
  attachClaimProvenance: vi.fn(async () => ({ errors: [] as string[] })),
}))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance }))
const hoisted = vi.hoisted(() => ({ inngestSend: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.inngestSend } }))

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Dial8 Marketing' },
  { id: WS_OTHER, name: 'Engineering' },
  { id: WS_THIRD, name: 'Personal' },
]

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown }

function memberRows(workspaceIds: string[]): Row[] {
  return workspaceIds.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id)!,
  }))
}

/**
 * Lazy chainable table double — see routing.contacts.test.ts's comment for
 * why the write mode is applied at run() time, not at `.insert()`/`.update()`
 * call time.
 */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'insert' = 'select'
  let insertRow: Row = {}

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.eq = vi.fn((col: string, val: unknown) => {
    log.push({ table, op: 'eq', col, val })
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.insert = vi.fn((row: Row) => {
    log.push({ table, op: 'insert', val: row })
    mode = 'insert'
    insertRow = row
    return chain
  })

  const run = (): Row[] => {
    if (mode === 'insert') {
      const inserted = { id: `${table}-new`, ...insertRow }
      rows.push(inserted)
      return [inserted]
    }
    return rows.filter((r) => preds.every((p) => p(r)))
  }

  chain.single = async () => {
    const matched = run()
    return matched.length === 1
      ? { data: matched[0], error: null }
      : { data: null, error: { message: 'no rows returned' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = run()
    return Promise.resolve({ data, error: null }).then(resolve)
  }
  return chain
}

/** `tables` seeds each named table's rows; anything else reads/writes empty. */
function makeSupabase(opts: { memberOf: string[]; tables?: Record<string, Row[]> }) {
  const members = memberRows(opts.memberOf)
  const claim: Row[] = []
  const claimChunks: Row[] = []
  const entityLink: Row[] = []
  const seeded = opts.tables ?? {}
  const store: Record<string, Row[]> = {
    ...seeded,
    member: members,
    claim,
    claim_chunks: claimChunks,
    entity_link: entityLink,
  }
  const log: LogEntry[] = []
  const from = vi.fn((table: string) => {
    if (!store[table]) store[table] = []
    return tableChain(table, store[table], log)
  })
  return { supabase: { from } as never, store, log }
}

type ToolResult = {
  success: boolean
  error?: string
  error_type?: string
  claim?: { id?: string }
  link?: { id?: string; source_type?: string } | null
  workspace?: { id: string; name: string | null }
  candidates?: Array<{ id: string; name: string; is_active: boolean }>
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

const tools = (
  supabase: never,
  strict = false,
  omitPrivate = false,
  policy: 'session' | 'explicit' = 'session',
) => createClaimTools(USER_ID, supabase, WS_ACTIVE, strict, omitPrivate, policy)

beforeEach(() => {
  hoisted.inngestSend.mockClear()
  attachClaimProvenance.mockClear()
})

// ─── create_claim — ROOT create ─────────────────────────────────────────────

describe('create_claim — explicit workspace_id, a member', () => {
  it('routes the insert AND the sources[] entityInWorkspace check to the target workspace', async () => {
    const { supabase, store, log } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: { captures: [{ id: 'cap-1', workspace_id: WS_OTHER }] },
    })
    const res = await run(tools(supabase).create_claim, {
      text: 'a fact',
      type: 'fact',
      sources: [{ source_type: 'capture', source_id: 'cap-1' }],
      workspace_id: WS_OTHER,
    })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
    expect(store.claim[0].workspace_id).toBe(WS_OTHER)
    // The provenance check ran against the TARGET workspace, not the session one.
    expect(log).toContainEqual({ table: 'captures', op: 'eq', col: 'workspace_id', val: WS_OTHER })
    expect(log).not.toContainEqual({ table: 'captures', op: 'eq', col: 'workspace_id', val: WS_ACTIVE })
  })
})

describe('create_claim — explicit workspace_id, not a member', () => {
  it('is flat not-found and writes nothing', async () => {
    const { supabase, store, log } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const res = await run(tools(supabase).create_claim, {
      text: 'a fact',
      type: 'fact',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(store.claim).toHaveLength(0)
    expect(log.some((e) => e.table === 'claim' && e.op === 'insert')).toBe(false)
  })
})

describe("create_claim — policy 'explicit', no workspace_id", () => {
  it('refuses with needs_workspace + candidates when there are >= 2 workspaces', async () => {
    const { supabase, store } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const res = await run(tools(supabase, false, false, 'explicit').create_claim, {
      text: 'a fact',
      type: 'fact',
    })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Dial8 Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
      { id: WS_THIRD, name: 'Personal', is_active: false },
    ])
    expect(store.claim).toHaveLength(0)
  })
})

describe("create_claim — policy 'session', no workspace_id", () => {
  it('defaults to the session workspace with an unchanged call chain', async () => {
    const { supabase, store, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const res = await run(tools(supabase, false, false, 'session').create_claim, {
      text: 'a fact',
      type: 'fact',
    })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
    expect(store.claim[0].workspace_id).toBe(WS_ACTIVE)
    // resolveCreateWorkspace's session fast path issues no query of its own —
    // the only `member` eq is resolveMemberId's SAME, pre-existing lookup.
    const memberEqs = log.filter((e) => e.table === 'member' && e.op === 'eq' && e.col === 'workspace_id')
    expect(memberEqs).toEqual([{ table: 'member', op: 'eq', col: 'workspace_id', val: WS_ACTIVE }])
  })
})

describe('create_claim — strictWorkspace', () => {
  it('is not-found for an explicit foreign id, with NO membership probe', async () => {
    const { supabase, store, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const res = await run(tools(supabase, true).create_claim, {
      text: 'a fact',
      type: 'fact',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(store.claim).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

// ─── link_entities — converted mutate ───────────────────────────────────────

describe('link_entities — routing', () => {
  it('routes a foreign-but-member anchor (source) to the workspace it actually lives in', async () => {
    const { supabase, store } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: {
        document: [{ id: 'doc-1', workspace_id: WS_OTHER }],
        actions: [{ id: 'act-1', workspace_id: WS_OTHER }],
      },
    })
    const res = await run(tools(supabase).link_entities, {
      source_type: 'document',
      source_id: 'doc-1',
      target_type: 'action',
      target_id: 'act-1',
    })

    expect(res.success).toBe(true)
    expect(store.entity_link[0].workspace_id).toBe(WS_OTHER)
  })

  it('is not-found under strictWorkspace for the same anchor, and never writes', async () => {
    const { supabase, store } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: {
        document: [{ id: 'doc-1', workspace_id: WS_OTHER }],
        actions: [{ id: 'act-1', workspace_id: WS_OTHER }],
      },
    })
    const res = await run(tools(supabase, true).link_entities, {
      source_type: 'document',
      source_id: 'doc-1',
      target_type: 'action',
      target_id: 'act-1',
    })

    expect(res).toEqual({
      success: false,
      error: 'document "doc-1" not found in this workspace',
    })
    expect(store.entity_link).toHaveLength(0)
  })
})

// ─── ingest_source — converted mutate ───────────────────────────────────────

describe('ingest_source — routing', () => {
  it('dispatches to the workspace the anchor source actually lives in', async () => {
    const { supabase } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: { document: [{ id: 'doc-1', workspace_id: WS_OTHER }] },
    })
    const res = await run(tools(supabase).ingest_source, {
      source_type: 'document',
      source_id: 'doc-1',
    })

    expect(res.success).toBe(true)
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'claim/extract-from-source',
      data: expect.objectContaining({ workspaceId: WS_OTHER, sourceId: 'doc-1' }),
    })
  })

  it('is not-found under strictWorkspace for the same anchor, and never dispatches', async () => {
    const { supabase } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: { document: [{ id: 'doc-1', workspace_id: WS_OTHER }] },
    })
    const res = await run(tools(supabase, true).ingest_source, {
      source_type: 'document',
      source_id: 'doc-1',
    })

    expect(res).toEqual({
      success: false,
      error: 'document "doc-1" not found in this workspace',
    })
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('never ingests the person’s Now file (migration 440): refused, nothing dispatched', async () => {
    const { supabase } = makeSupabase({
      memberOf: [WS_ACTIVE],
      tables: { document: [{ id: 'doc-now', workspace_id: WS_ACTIVE, kind: 'now' }] },
    })
    const res = await run(tools(supabase).ingest_source, { source_type: 'document', source_id: 'doc-now' })
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/Now file/) })
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })
})

// ─── ingest_reference — converted mutate ────────────────────────────────────

describe('ingest_reference — routing', () => {
  it('dispatches to the workspace the anchor attachment actually lives in', async () => {
    const { supabase } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: {
        attachments: [{ id: 'att-1', workspace_id: WS_OTHER, file_name: 'spec.pdf', mime_type: 'application/pdf' }],
      },
    })
    const res = await run(tools(supabase).ingest_reference, { attachment_id: 'att-1' })

    expect(res.success).toBe(true)
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'reference/ingest',
      data: { workspaceId: WS_OTHER, userId: USER_ID, attachmentId: 'att-1', projectId: null },
    })
  })

  it('is not-found under strictWorkspace for the same anchor, and never dispatches', async () => {
    const { supabase } = makeSupabase({
      memberOf: [WS_ACTIVE, WS_OTHER],
      tables: {
        attachments: [{ id: 'att-1', workspace_id: WS_OTHER, file_name: 'spec.pdf', mime_type: 'application/pdf' }],
      },
    })
    const res = await run(tools(supabase, true).ingest_reference, { attachment_id: 'att-1' })

    expect(res).toEqual({ success: false, error: 'Attachment not found in this workspace' })
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })
})
