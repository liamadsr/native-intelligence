/**
 * Workspace routing for companies.ts: create-time routing on `create_company`
 * (a ROOT create) and the converted mutate `update_company`.
 *
 * `create_company` now takes an optional `workspace_id`, resolved through
 * `resolveCreateWorkspace` (_shared.ts) exactly like every other
 * create-bearing factory. `update_company` now resolves `company_id` through
 * `resolveEntityWorkspace` before writing, exactly like `update_contact`
 * (contacts.ts) already did.
 *
 * What is pinned here:
 *   1. create_company: an explicit foreign workspace_id (a member) routes the
 *      insert there; a non-member is the flat 'Workspace not found' with no
 *      insert; policy 'explicit' with >= 2 workspaces and no id refuses with
 *      `needs_workspace` + candidates; policy 'session' with no id is
 *      byte-identical — the session workspace, no extra query; strictWorkspace
 *      + an explicit foreign id is not-found with NO membership probe;
 *   2. update_company: a foreign-but-member company_id routes the update
 *      there; under strictWorkspace the same id is not-found and the update
 *      never runs.
 *
 * The Supabase double mirrors routing.contacts.test.ts's lazy tableChain:
 * filters accumulate as predicates and nothing runs until a terminal method
 * is awaited, matching the real (lazy) query builder.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCompanyTools } from '../companies'

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

function memberRows(workspaceIds: string[]): Row[] {
  return workspaceIds.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id)!,
  }))
}

/** Same lazy chain double as routing.contacts.test.ts — see its comment. */
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

function makeSupabase(opts: { memberOf: string[]; companies?: Row[] }) {
  const members = memberRows(opts.memberOf)
  const companies = opts.companies ?? []
  const log: LogEntry[] = []
  const from = vi.fn((table: string) => {
    if (table === 'member') return tableChain('member', members, log)
    if (table === 'company') return tableChain('company', companies, log)
    return tableChain(table, [], log)
  })
  return { supabase: { from } as never, companies, log }
}

const tools = (supabase: never, strict = false, policy: 'session' | 'explicit' = 'session') =>
  createCompanyTools(USER_ID, supabase, WS_ACTIVE, strict, policy)

type ToolResult = {
  success: boolean
  error?: string
  error_type?: string
  company?: { id?: string; name?: string; workspace_id?: string }
  workspace?: { id: string; name: string | null }
  candidates?: Array<{ id: string; name: string; is_active: boolean }>
  updated_fields?: string[]
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

// ─── create_company ─────────────────────────────────────────────────────────

describe('create_company — explicit workspace_id, a member', () => {
  it('routes the insert to the target workspace', async () => {
    const { supabase, companies } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const res = await run(tools(supabase).create_company, { name: 'Vanta', workspace_id: WS_OTHER })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
    expect(companies[0].workspace_id).toBe(WS_OTHER)
  })
})

describe('create_company — explicit workspace_id, not a member', () => {
  it('is flat not-found and writes nothing', async () => {
    const { supabase, companies, log } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const res = await run(tools(supabase).create_company, { name: 'Vanta', workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(companies).toHaveLength(0)
    expect(log.some((e) => e.table === 'company' && e.op === 'insert')).toBe(false)
  })
})

describe("create_company — policy 'explicit', no workspace_id", () => {
  it('refuses with needs_workspace + candidates when there are >= 2 workspaces', async () => {
    const { supabase, companies } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const res = await run(tools(supabase, false, 'explicit').create_company, { name: 'Vanta' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Native Intelligence Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
      { id: WS_THIRD, name: 'Personal', is_active: false },
    ])
    expect(companies).toHaveLength(0)
  })
})

describe("create_company — policy 'session', no workspace_id", () => {
  it('defaults to the session workspace with NOT ONE extra query', async () => {
    const { supabase, companies, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const res = await run(tools(supabase, false, 'session').create_company, { name: 'Vanta' })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
    expect(companies[0].workspace_id).toBe(WS_ACTIVE)
    // The session fast path resolves with zero queries; create_company itself
    // has no other lookup, so NOTHING should have touched `member`.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

describe('create_company — strictWorkspace', () => {
  it('is not-found for an explicit foreign id, with NO membership probe', async () => {
    const { supabase, companies, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const res = await run(tools(supabase, true).create_company, { name: 'Vanta', workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(companies).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

// ─── update_company ─────────────────────────────────────────────────────────

describe('update_company — routing', () => {
  it('routes a foreign-but-member company_id to the workspace it actually lives in', async () => {
    const foreign = { id: 'co-1', workspace_id: WS_OTHER, name: 'Vanta', domain: 'vanta.com', industry: 'Compliance' }
    const { supabase, companies } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER], companies: [foreign] })
    const res = await run(tools(supabase).update_company, { company_id: 'co-1', industry: 'Security' })

    expect(res.success).toBe(true)
    expect(res.company?.workspace_id ?? companies[0].workspace_id).toBe(WS_OTHER)
    expect(companies[0].industry).toBe('Security')
  })

  it('is not-found under strictWorkspace for the same foreign id, and never writes', async () => {
    const foreign = { id: 'co-1', workspace_id: WS_OTHER, name: 'Vanta', domain: 'vanta.com', industry: 'Compliance' }
    const { supabase, companies, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER], companies: [foreign] })
    const res = await run(tools(supabase, true).update_company, { company_id: 'co-1', industry: 'Security' })

    expect(res).toEqual({ success: false, error: 'Company not found' })
    expect(companies[0].industry).toBe('Compliance')
    expect(log.some((e) => e.table === 'company' && e.op === 'update')).toBe(false)
  })

  it('is not-found for a nonexistent company_id', async () => {
    const { supabase } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const res = await run(tools(supabase).update_company, { company_id: 'nope', industry: 'Security' })

    expect(res).toEqual({ success: false, error: 'Company not found' })
  })
})
