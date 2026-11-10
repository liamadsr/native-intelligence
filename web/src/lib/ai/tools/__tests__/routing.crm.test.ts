/**
 * Workspace routing for crm.ts's converted mutate: `update_crm_contact` now
 * resolves `contact_id` through `resolveEntityWorkspace` before writing,
 * exactly like `update_contact` (contacts.ts) already did. crm.ts has no
 * create tool, so there is no create-time routing to cover here — see
 * routing.contacts.test.ts / routing.companies.test.ts / routing.claims.test.ts
 * for that half of the protocol.
 *
 * What is pinned here:
 *   1. a foreign-but-member contact_id routes the update to the workspace it
 *      actually lives in;
 *   2. under `strictWorkspace` the same id is not-found and the update never
 *      runs;
 *   3. an in-workspace id is unaffected (byte-identical to before).
 *
 * The Supabase double is the same lazy tableChain used by the sibling
 * routing.*.test.ts files: filters accumulate as predicates and nothing runs
 * until a terminal method is awaited, matching the real (lazy) query builder.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCrmTools } from '../crm'

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown }

/** Same lazy chain double as routing.contacts.test.ts — see its comment. */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'update' = 'select'
  let patch: Row = {}

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.eq = vi.fn((col: string, val: unknown) => {
    log.push({ table, op: 'eq', col, val })
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.update = vi.fn((p: Row) => {
    log.push({ table, op: 'update', val: p })
    mode = 'update'
    patch = p
    return chain
  })

  const run = (): Row[] => {
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

function makeSupabase(opts: { memberOf: string[]; contacts: Row[]; hidden?: string[] }) {
  const members = opts.memberOf.map((id) => ({ id: `member-${id}`, user_id: USER_ID, workspace_id: id }))
  const contacts = opts.contacts
  const log: LogEntry[] = []
  const from = vi.fn((table: string) => {
    if (table === 'member') return tableChain('member', members, log)
    if (table === 'contact') return tableChain('contact', contacts, log)
    return tableChain(table, [], log)
  })
  // contact_visible_to / contact_editable_by: every contact is visible unless
  // listed in `hidden`. No edit grant (512's entity_edit_granted) reaches anyone.
  const rpc = vi.fn(async (fn: string, args: { p_contact_id: string }) => ({
    data: fn === 'entity_edit_granted' ? false : !(opts.hidden ?? []).includes(args.p_contact_id),
    error: null,
  }))
  return { supabase: { from, rpc } as never, contacts, log }
}

const tools = (supabase: never, strict = false) => createCrmTools(USER_ID, supabase, WS_ACTIVE, false, strict)

type ToolResult = {
  success: boolean
  error?: string
  contact?: { full_name?: string; relationship_type?: string }
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

describe('update_crm_contact — routing', () => {
  it('routes a foreign-but-member contact_id to the workspace it actually lives in', async () => {
    const foreign = { id: 'ct-1', workspace_id: WS_OTHER, full_name: 'Ada', relationship_type: 'lead' }
    const { supabase, contacts } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER], contacts: [foreign] })
    const res = await run(tools(supabase).update_crm_contact, {
      contact_id: 'ct-1',
      relationship_type: 'customer',
    })

    expect(res.success).toBe(true)
    expect(res.contact?.relationship_type).toBe('customer')
    expect(contacts[0].relationship_type).toBe('customer')
  })

  it('is not-found under strictWorkspace for the same foreign id, and never writes', async () => {
    const foreign = { id: 'ct-1', workspace_id: WS_OTHER, full_name: 'Ada', relationship_type: 'lead' }
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER], contacts: [foreign] })
    const res = await run(tools(supabase, true).update_crm_contact, {
      contact_id: 'ct-1',
      relationship_type: 'customer',
    })

    expect(res).toEqual({ success: false, error: 'Contact not found' })
    expect(contacts[0].relationship_type).toBe('lead')
    expect(log.some((e) => e.table === 'contact' && e.op === 'update')).toBe(false)
  })

  it('is unaffected for an in-workspace contact_id (no member probe, no fan-out)', async () => {
    const local = { id: 'ct-2', workspace_id: WS_ACTIVE, full_name: 'Bea', relationship_type: 'lead' }
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER], contacts: [local] })
    const res = await run(tools(supabase).update_crm_contact, {
      contact_id: 'ct-2',
      relationship_type: 'customer',
    })

    expect(res.success).toBe(true)
    expect(contacts[0].relationship_type).toBe('customer')
    // resolveEntityWorkspace's fast path succeeds in the active workspace —
    // the slow-path membership probe is never issued.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('is not-found for a nonexistent contact_id', async () => {
    const { supabase } = makeSupabase({ memberOf: [WS_ACTIVE], contacts: [] })
    const res = await run(tools(supabase).update_crm_contact, {
      contact_id: 'nope',
      relationship_type: 'customer',
    })

    expect(res).toEqual({ success: false, error: 'Contact not found' })
  })

  it("refuses another member's private contact (contact_visible_to false) and never writes", async () => {
    const priv = { id: 'ct-3', workspace_id: WS_ACTIVE, full_name: 'Cy', relationship_type: 'lead' }
    const { supabase, contacts, log } = makeSupabase({ memberOf: [WS_ACTIVE], contacts: [priv], hidden: ['ct-3'] })
    const res = await run(tools(supabase).update_crm_contact, {
      contact_id: 'ct-3',
      relationship_type: 'customer',
    })

    expect(res).toEqual({ success: false, error: 'Contact not found' })
    expect(contacts[0].relationship_type).toBe('lead')
    expect(log.some((e) => e.table === 'contact' && e.op === 'update')).toBe(false)
  })
})
