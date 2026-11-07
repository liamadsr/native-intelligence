/**
 * Workspace routing for the decision mutates — routed through the CAPTURE.
 *
 * `decision` has no workspace_id column (migration 025). A decision hangs off
 * `captures.capture_id` and inherits that row's tenant, so the capture is the
 * only thing there is to route by: confirm / dismiss / confirm-all resolve the
 * owning capture with `resolveEntityWorkspace` and re-run the visibility check
 * IN the workspace that resolves, never in the session's.
 *
 * What is pinned here:
 *   1. a decision on a capture in ANOTHER workspace the user belongs to is now
 *      actionable there, instead of reading as not-found because the session
 *      pointed elsewhere;
 *   2. the write is re-pinned to that capture (`capture_id`), which is the only
 *      tenant predicate a decision row can carry;
 *   3. a teammate's PRIVATE capture, a capture in a workspace the user has
 *      left, and a nonexistent id all produce the SAME 'Decision not found' —
 *      the reply never says which id failed or where it lives;
 *   4. under `strictWorkspace` a foreign capture is not-found and nothing is
 *      written;
 *   5. a teammate's WORKSPACE-VISIBLE capture is the workspace's meeting: its
 *      decisions are listed and actionable by any member (RLS on `decision`,
 *      migration 223), while `omitPrivateCaptures` hides even the caller's own
 *      private capture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createDecisionTools } from '../decisions'

// Hoisted so the claim mirror's workspace — the third id create_decision has to
// route — is assertable, not just stubbed.
const { mockEmitDecisionClaim } = vi.hoisted(() => ({ mockEmitDecisionClaim: vi.fn(async () => {}) }))
vi.mock('@/lib/ai/emit-decision-claim', () => ({ emitDecisionClaim: mockEmitDecisionClaim }))

const USER_ID = 'user-1'
const OTHER_USER = 'user-2'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'

const EXEC_OPTS = {
  toolCallId: 'c1',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown }

function tableChain(table: string, rows: Row[], log: LogEntry[], nextId: () => string) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'update' | 'insert' = 'select'
  let patch: Row = {}
  let inserted: Row[] = []

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.order = vi.fn(pass)
  chain.limit = vi.fn(pass)
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
  chain.insert = vi.fn((payload: Row) => {
    log.push({ table, op: 'insert', val: payload })
    mode = 'insert'
    inserted = [{ id: nextId(), created_at: '2026-01-01T00:00:00.000Z', ...payload }]
    return chain
  })

  const run = (): Row[] => {
    if (mode === 'insert') {
      rows.push(...inserted)
      return inserted
    }
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    if (mode === 'update') for (const r of matched) Object.assign(r, patch)
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
    return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
  }
  return chain
}

function makeDb(seed: Record<string, Row[]> = {}, memberOf: string[] = [WS_ACTIVE, WS_OTHER]) {
  const tables: Record<string, Row[]> = {
    member: memberOf.map((id) => ({ id: `member-${id}`, user_id: USER_ID, workspace_id: id })),
    captures: [],
    decision: [],
    ...seed,
  }
  const log: LogEntry[] = []
  let seq = 0
  const from = vi.fn((table: string) => {
    tables[table] ??= []
    return tableChain(table, tables[table], log, () => `${table}-${++seq}`)
  })
  return { supabase: { from } as never, tables, log }
}

const tools = (supabase: never, strict = false, omitPrivate = false) =>
  createDecisionTools(USER_ID, supabase, WS_ACTIVE, strict, 'session', omitPrivate)

type ToolResult = {
  success: boolean
  error?: string
  message?: string
  confirmed_count?: number
  workspace?: { id: string; name: string | null }
  decision?: Record<string, unknown>
}

beforeEach(() => {
  mockEmitDecisionClaim.mockClear()
})

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

/** A capture in `ws`, owned by `owner`, holding two suggested decisions. */
function seedWith(ws: string, owner = USER_ID, visibility: 'workspace' | 'private' = 'workspace') {
  return {
    captures: [{ id: 'cap-1', workspace_id: ws, user_id: owner, visibility }],
    decision: [
      { id: 'dec-1', capture_id: 'cap-1', content: 'Ship on Friday', confirmation: 'suggested' },
      { id: 'dec-2', capture_id: 'cap-1', content: 'Hold the price', confirmation: 'suggested' },
    ],
  }
}

describe('create_decision — the PARENT-ANCHORED create, routed by its capture', () => {
  it('creates on a foreign-but-member capture, with the project, member and claim resolved THERE', async () => {
    const { supabase, tables } = makeDb({
      ...seedWith(WS_OTHER),
      projects: [
        { id: 'proj-other', workspace_id: WS_OTHER },
        { id: 'proj-session', workspace_id: WS_ACTIVE },
      ],
    })
    const res = await run(tools(supabase).create_decision, {
      capture_id: 'cap-1',
      content: 'Ship on Friday',
      project_id: 'proj-other',
    })

    expect(res.success).toBe(true)
    const row = tables.decision.find((d) => d.id !== 'dec-1' && d.id !== 'dec-2')!
    expect(row.capture_id).toBe('cap-1')
    expect(row.project_id).toBe('proj-other')
    // member ids are workspace-scoped: the session workspace's row would be a
    // cross-tenant decided_by.
    expect(row.decided_by).toBe(`member-${WS_OTHER}`)
    // The knowledge-graph mirror belongs in the same workspace as the decision.
    expect(mockEmitDecisionClaim).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_OTHER }))
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('refuses a project from the SESSION workspace on a routed create', async () => {
    const { supabase, tables } = makeDb({
      ...seedWith(WS_OTHER),
      projects: [{ id: 'proj-session', workspace_id: WS_ACTIVE }],
    })
    const before = tables.decision.length
    const res = await run(tools(supabase).create_decision, {
      capture_id: 'cap-1',
      content: 'Ship on Friday',
      project_id: 'proj-session',
    })

    expect(res).toEqual({ success: false, error: 'Project not found' })
    expect(tables.decision).toHaveLength(before)
    expect(mockEmitDecisionClaim).not.toHaveBeenCalled()
  })

  it('is not-found under strictWorkspace, and inserts nothing', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER))
    const before = tables.decision.length
    const res = await run(tools(supabase, true).create_decision, {
      capture_id: 'cap-1',
      content: 'Ship on Friday',
    })

    expect(res).toEqual({ success: false, error: 'Capture not found' })
    expect(tables.decision).toHaveLength(before)
    expect(mockEmitDecisionClaim).not.toHaveBeenCalled()
  })

  it("keeps the privacy gate: a teammate's private capture is still not-found", async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER, OTHER_USER, 'private'))
    const before = tables.decision.length
    const res = await run(tools(supabase).create_decision, { capture_id: 'cap-1', content: 'x' })

    expect(res).toEqual({ success: false, error: 'Capture not found' })
    expect(tables.decision).toHaveLength(before)
  })

  it('still creates against a capture in the session workspace', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_ACTIVE))
    const res = await run(tools(supabase).create_decision, { capture_id: 'cap-1', content: 'Ship on Friday' })

    expect(res.success).toBe(true)
    expect(tables.decision.find((d) => d.id !== 'dec-1' && d.id !== 'dec-2')!.decided_by).toBe(`member-${WS_ACTIVE}`)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
  })
})

describe('confirm_decision — routed by the owning capture', () => {
  it('confirms a decision whose capture lives in another member workspace', async () => {
    const { supabase, tables, log } = makeDb(seedWith(WS_OTHER))
    const res = await run(tools(supabase).confirm_decision, { decision_id: 'dec-1' })

    expect(res.success).toBe(true)
    expect(tables.decision[0].confirmation).toBe('confirmed')
    // The ownership re-check ran in the capture's workspace, not the session's.
    expect(log.filter((e) => e.table === 'captures' && e.col === 'workspace_id').map((e) => e.val)).toEqual([
      WS_ACTIVE,
      WS_OTHER,
    ])
    // …and the write carried the capture as its tenant predicate.
    expect(log.some((e) => e.table === 'decision' && e.col === 'capture_id' && e.val === 'cap-1')).toBe(true)
  })

  it('still confirms an in-session-workspace decision', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_ACTIVE))
    const res = await run(tools(supabase).confirm_decision, { decision_id: 'dec-1' })

    expect(res.success).toBe(true)
    expect(tables.decision[0].confirmation).toBe('confirmed')
  })

  it('is not-found under strictWorkspace, and writes nothing', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER))
    const res = await run(tools(supabase, true).confirm_decision, { decision_id: 'dec-1' })

    expect(res).toEqual({ success: false, error: 'Decision not found' })
    expect(tables.decision[0].confirmation).toBe('suggested')
  })

  it("is not-found for a teammate's private capture, in the same words", async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER, OTHER_USER, 'private'))
    const res = await run(tools(supabase).confirm_decision, { decision_id: 'dec-1' })

    expect(res).toEqual({ success: false, error: 'Decision not found' })
    expect(tables.decision[0].confirmation).toBe('suggested')
  })

  it('is not-found for a capture in a workspace the user does not belong to', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER), [WS_ACTIVE])
    const res = await run(tools(supabase).confirm_decision, { decision_id: 'dec-1' })

    expect(res).toEqual({ success: false, error: 'Decision not found' })
    expect(tables.decision[0].confirmation).toBe('suggested')
  })
})

describe('dismiss_decision — same route, same refusals', () => {
  it('dismisses a decision on a foreign-but-member capture', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER))
    const res = await run(tools(supabase).dismiss_decision, { decision_id: 'dec-2' })

    expect(res.success).toBe(true)
    expect(tables.decision.find((d) => d.id === 'dec-2')!.confirmation).toBe('dismissed')
    // Its sibling is untouched — the write was pinned to one decision.
    expect(tables.decision.find((d) => d.id === 'dec-1')!.confirmation).toBe('suggested')
  })

  it('is not-found under strictWorkspace and leaves the decision suggested', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER))
    const res = await run(tools(supabase, true).dismiss_decision, { decision_id: 'dec-2' })

    expect(res).toEqual({ success: false, error: 'Decision not found' })
    expect(tables.decision.find((d) => d.id === 'dec-2')!.confirmation).toBe('suggested')
  })
})

describe('confirm_all_decisions — routed by the capture it is given', () => {
  it('confirms every suggested decision on a foreign-but-member capture', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER))
    const res = await run(tools(supabase).confirm_all_decisions, { capture_id: 'cap-1' })

    expect(res.success).toBe(true)
    expect(res.confirmed_count).toBe(2)
    expect(tables.decision.every((d) => d.confirmation === 'confirmed')).toBe(true)
  })

  it('keeps the capture-shaped not-found under strictWorkspace', async () => {
    const { supabase, tables } = makeDb(seedWith(WS_OTHER))
    const res = await run(tools(supabase, true).confirm_all_decisions, { capture_id: 'cap-1' })

    expect(res).toEqual({ success: false, error: 'Capture not found' })
    expect(tables.decision.every((d) => d.confirmation === 'suggested')).toBe(true)
  })
})

describe("decisions on a teammate's capture — visibility, not ownership", () => {
  it("lists the decisions on a teammate's workspace-visible capture", async () => {
    const { supabase } = makeDb(seedWith(WS_ACTIVE, OTHER_USER))
    const res = (await run(tools(supabase).list_decisions, { capture_id: 'cap-1' })) as ToolResult & {
      decisions?: Array<{ id: string }>
    }

    expect(res.success).toBe(true)
    expect(res.decisions?.map((d) => d.id)).toEqual(['dec-1', 'dec-2'])
  })

  it("does not list the decisions on a teammate's private capture", async () => {
    const { supabase } = makeDb(seedWith(WS_ACTIVE, OTHER_USER, 'private'))
    const res = await run(tools(supabase).list_decisions, { capture_id: 'cap-1' })

    expect(res).toEqual({ success: false, error: 'Capture not found' })
  })

  it("still lists the decisions on the caller's own private capture", async () => {
    const { supabase } = makeDb(seedWith(WS_ACTIVE, USER_ID, 'private'))
    const res = await run(tools(supabase).list_decisions, { capture_id: 'cap-1' })

    expect(res.success).toBe(true)
  })

  it("hides even the caller's own private capture when private captures are omitted", async () => {
    const { supabase } = makeDb(seedWith(WS_ACTIVE, USER_ID, 'private'))
    const res = await run(tools(supabase, false, true).list_decisions, { capture_id: 'cap-1' })

    expect(res).toEqual({ success: false, error: 'Capture not found' })
  })

  it("confirms a decision on a teammate's workspace-visible capture", async () => {
    const { supabase, tables } = makeDb(seedWith(WS_ACTIVE, OTHER_USER))
    const res = await run(tools(supabase).confirm_decision, { decision_id: 'dec-1' })

    expect(res.success).toBe(true)
    expect(tables.decision[0].confirmation).toBe('confirmed')
  })

  it("creates a decision on a teammate's workspace-visible capture", async () => {
    const { supabase, tables } = makeDb(seedWith(WS_ACTIVE, OTHER_USER))
    const res = await run(tools(supabase).create_decision, { capture_id: 'cap-1', content: 'Ship on Friday' })

    expect(res.success).toBe(true)
    expect(tables.decision).toHaveLength(3)
  })
})
