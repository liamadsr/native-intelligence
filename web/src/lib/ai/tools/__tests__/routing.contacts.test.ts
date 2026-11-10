/**
 * Create-time workspace routing for `create_contact` (contacts.ts).
 *
 * `create_contact` is a ROOT create — there is no existing row to route by, so
 * it used to land wherever the session pointed. It now takes an optional
 * `workspace_id`, resolved through `resolveCreateWorkspace` (_shared.ts)
 * exactly like every other create-bearing factory. `update_contact` already
 * routed via `resolveEntityWorkspace` before this change and is untouched —
 * no coverage added here for it.
 *
 * What is pinned here:
 *   1. an explicit foreign workspace_id (a member) routes the insert AND every
 *      dependent lookup (the ownership member row, the HubSpot push, the
 *      enrichment dispatch) there — never a mix of the session and target ws;
 *   2. an explicit non-member workspace_id is the flat 'Workspace not found',
 *      and nothing is written;
 *   3. policy 'explicit' with >= 2 workspaces and no id refuses with
 *      `needs_workspace` + candidates, and writes nothing;
 *   4. policy 'session' with no id is byte-identical to before: the session
 *      workspace, with NOT ONE extra query for the resolution;
 *   5. under `strictWorkspace`, an explicit foreign id is not-found with NO
 *      membership probe issued at all.
 *
 * The Supabase double is a small in-memory engine (adapted from
 * actions.workspace-routing.test.ts): `.eq()` become real predicates over rows,
 * `.insert()` really appends, and every query is logged so "no query was
 * issued" is an assertion, not an assumption.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createContactTools } from '../contacts'

const hoisted = vi.hoisted(() => ({ inngestSend: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.inngestSend } }))

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Native Intelligence Marketing' },
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

/** One `member` row per workspace, shaped for every read the resolver + tool make. */
function memberRows(workspaceIds: string[]): Row[] {
  return workspaceIds.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id)!,
  }))
}

/**
 * Chainable table double. Filters accumulate as predicates and the write mode
 * (insert/update) is recorded, but nothing runs until a terminal method is
 * awaited — exactly like the real (lazy) query builder. This matters: the
 * tools call `.update(patch).eq(id).eq(ws)` — the `.eq()`s run AFTER
 * `.update()` syntactically, so an EAGER apply-on-`.update()` would patch
 * every row before the scoping filters ever attached.
 */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'insert' | 'update' = 'select'
  let patch: Row = {}
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
  chain.update = vi.fn((p: Row) => {
    log.push({ table, op: 'update', val: p })
    mode = 'update'
    patch = p
    return chain
  })

  /** Apply the accumulated filters (and the write, if any) exactly once. */
  const run = (): Row[] => {
    if (mode === 'insert') {
      const inserted = { id: `${table}-new`, ...insertRow }
      rows.push(inserted)
      return [inserted]
    }
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    if (mode === 'update') {
      for (const r of matched) Object.assign(r, patch)
    }
    return matched
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

function makeSupabase(opts: { memberOf: string[] }) {
  const members = memberRows(opts.memberOf)
  const contacts: Row[] = []
  const log: LogEntry[] = []
  const from = vi.fn((table: string) => {
    if (table === 'member') return tableChain('member', members, log)
    if (table === 'contact') return tableChain('contact', contacts, log)
    return tableChain(table, [], log)
  })
  return { supabase: { from } as never, contacts, log }
}

const tools = (supabase: never, strict = false, policy: 'session' | 'explicit' = 'session') =>
  createContactTools(USER_ID, supabase, WS_ACTIVE, strict, policy)

type ToolResult = {
  success: boolean
  error?: string
  error_type?: string
  message?: string
  contact?: { id?: string; email?: string | null; full_name?: string }
  workspace?: { id: string; name: string | null }
  candidates?: Array<{ id: string; name: string; is_active: boolean }>
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

beforeEach(() => {
  hoisted.inngestSend.mockReset()
  hoisted.inngestSend.mockResolvedValue({ ids: ['e'] })
})

describe('create_contact — explicit workspace_id, a member', () => {
  it('routes the insert AND every dependent dispatch to the target workspace', async () => {
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const res = await run(tools(supabase).create_contact, {
      full_name: 'Ada',
      email: 'ada@example.com',
      workspace_id: WS_OTHER,
    })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
    // The insert itself carries the target workspace.
    expect(contacts[0].workspace_id).toBe(WS_OTHER)
    // The ownership member lookup was scoped to the target, not the session.
    expect(log).toContainEqual({ table: 'member', op: 'eq', col: 'workspace_id', val: WS_OTHER })
    expect(log).not.toContainEqual({ table: 'member', op: 'eq', col: 'workspace_id', val: WS_ACTIVE })
    // The HubSpot push carries the target workspace, not the session one.
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/hubspot-push-contact',
      data: { contactId: 'contact-new', workspaceId: WS_OTHER },
    })
  })
})

describe('create_contact — explicit workspace_id, not a member', () => {
  it('is flat not-found and writes nothing', async () => {
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const res = await run(tools(supabase).create_contact, {
      full_name: 'Ada',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(contacts).toHaveLength(0)
    expect(log.some((e) => e.table === 'contact' && e.op === 'insert')).toBe(false)
  })
})

describe("create_contact — policy 'explicit', no workspace_id", () => {
  it('refuses with needs_workspace + candidates when there are >= 2 workspaces', async () => {
    const { supabase, contacts } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const res = await run(tools(supabase, false, 'explicit').create_contact, { full_name: 'Ada' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Native Intelligence Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
      { id: WS_THIRD, name: 'Personal', is_active: false },
    ])
    expect(contacts).toHaveLength(0)
  })
})

describe("create_contact — policy 'session', no workspace_id", () => {
  it('defaults to the session workspace with an unchanged call chain', async () => {
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const res = await run(tools(supabase, false, 'session').create_contact, {
      full_name: 'Ada',
      email: 'ada@example.com',
    })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
    expect(contacts[0].workspace_id).toBe(WS_ACTIVE)
    // resolveCreateWorkspace's session fast path issues no query of its own —
    // the only `member` eq is the tool's OWN pre-existing ownership lookup.
    const memberEqs = log.filter((e) => e.table === 'member' && e.op === 'eq' && e.col === 'workspace_id')
    expect(memberEqs).toEqual([{ table: 'member', op: 'eq', col: 'workspace_id', val: WS_ACTIVE }])
  })
})

describe('create_contact — strictWorkspace', () => {
  it('is not-found for an explicit foreign id, with NO membership probe', async () => {
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const res = await run(tools(supabase, true).create_contact, {
      full_name: 'Ada',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(contacts).toHaveLength(0)
    // No membership probe at all — a fenced run must not learn whether the
    // workspace exists or the user belongs to it.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})
