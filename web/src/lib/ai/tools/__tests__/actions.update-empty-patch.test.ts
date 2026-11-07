/**
 * update_action must never send PostgREST an empty PATCH (GEN-102).
 *
 * PostgREST answers `PATCH` with a `{}` body by skipping the UPDATE and
 * returning zero rows, so the `.select().single()` behind it failed with the
 * opaque "Cannot coerce the result to a single JSON object". Two MCP calls hit
 * that:
 *   1. a labels-only update — labels live in action_label, so there are no row
 *      columns to write. The labels WERE saved, but the tool reported failure;
 *   2. a call whose only argument is unrecognised (`status` for `status_name`)
 *      — the schema drops it, nothing changed, and the error said nothing useful.
 *
 * The Supabase double below reproduces PostgREST's empty-PATCH behaviour, so
 * reintroducing `.update({})` fails these tests the same way production did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createActionTools } from '../actions'

// Same shim the other actions suites use: importing actions.ts must not pull in
// the apply-engine's mcp-client imports, which don't load in a test env.
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: vi.fn(),
}))

const emitStatusChange = vi.hoisted(() => vi.fn())
vi.mock('@/lib/flows/emit-status-change', () => ({ emitStatusChange }))

const USER_ID = 'user-1'
const WS = 'ws-1'
const TEAM = 'team-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; val?: unknown }

const PGRST116 = {
  code: 'PGRST116',
  message: 'Cannot coerce the result to a single JSON object',
}

/**
 * Chainable table double: filters accumulate as predicates, writes apply to the
 * surviving rows. An `update({})` matches nothing and writes nothing — exactly
 * what PostgREST does with an empty PATCH body.
 */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'update' | 'delete' | 'insert' = 'select'
  let patch: Row = {}

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.order = vi.fn(pass)
  chain.limit = vi.fn(pass)
  chain.eq = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.update = vi.fn((p: Row) => {
    log.push({ table, op: 'update', val: p })
    mode = 'update'
    patch = p
    return chain
  })
  chain.delete = vi.fn(() => {
    log.push({ table, op: 'delete' })
    mode = 'delete'
    return chain
  })
  chain.insert = vi.fn((values: Row | Row[]) => {
    log.push({ table, op: 'insert', val: values })
    mode = 'insert'
    rows.push(...(Array.isArray(values) ? values : [values]))
    return chain
  })

  const run = (): Row[] => {
    if (mode === 'insert') return []
    if (mode === 'update' && Object.keys(patch).length === 0) return []
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    if (mode === 'update') {
      for (const r of matched) Object.assign(r, patch)
    } else if (mode === 'delete') {
      for (const r of matched) rows.splice(rows.indexOf(r), 1)
    }
    return matched
  }

  chain.single = async () => {
    const matched = run()
    return matched.length === 1 ? { data: matched[0], error: null } : { data: null, error: PGRST116 }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: run(), error: null }).then(resolve)
  return chain
}

const STATES: Row[] = [
  { id: 'state-backlog', team_id: TEAM, name: 'Backlog', category: 'backlog', sort_order: 0, is_default: true },
  { id: 'state-done', team_id: TEAM, name: 'Done', category: 'completed', sort_order: 1, is_default: false },
  { id: 'state-canceled', team_id: TEAM, name: 'Canceled', category: 'canceled', sort_order: 2, is_default: false },
]

let actionRow: Row
let tables: Record<string, Row[]>
let log: LogEntry[]

function makeSupabase() {
  const from = vi.fn((table: string) => tableChain(table, tables[table] ?? (tables[table] = []), log))
  return { from } as never
}

type ToolResult = {
  success: boolean
  error?: string
  action?: { identifier?: string; priority?: string }
}

async function updateAction(args: Record<string, unknown>): Promise<ToolResult> {
  const tools = createActionTools(USER_ID, makeSupabase(), WS, false)
  const t = tools.update_action as unknown as {
    execute: (a: unknown, o: unknown) => Promise<ToolResult>
  }
  return t.execute(args, EXEC_OPTS)
}

const actionWrites = () => log.filter((e) => e.table === 'actions' && e.op === 'update')
const labelsOf = (actionId: string) =>
  tables.action_label.filter((r) => r.action_id === actionId).map((r) => r.label_id)

beforeEach(() => {
  emitStatusChange.mockClear()
  actionRow = {
    id: 'a-1',
    workspace_id: WS,
    user_id: USER_ID,
    identifier: 'ENG-7',
    title: 'Ship the thing',
    status_id: 'state-backlog',
    team_id: TEAM,
    priority: 'none',
    parent_id: null,
    workflow_state: { id: 'state-backlog', name: 'Backlog', category: 'backlog', color: '#888' },
    project: null,
    milestone: null,
    cycle: null,
    labels: [],
  }
  tables = {
    actions: [actionRow],
    action_label: [{ action_id: 'a-1', label_id: 'label-old' }],
    workflow_state: STATES.map((s) => ({ ...s })),
  }
  log = []
})

describe('update_action — labels-only updates', () => {
  it('succeeds and saves the labels without sending an empty UPDATE', async () => {
    const res = await updateAction({ action_id: 'a-1', label_ids: ['label-bug'] })

    expect(res.success).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.action?.identifier).toBe('ENG-7')
    expect(labelsOf('a-1')).toEqual(['label-bug'])
    expect(actionWrites()).toHaveLength(0)
    expect(emitStatusChange).not.toHaveBeenCalled()
  })

  it('clears every label when passed an empty list', async () => {
    const res = await updateAction({ action_id: 'a-1', label_ids: [] })

    expect(res.success).toBe(true)
    expect(labelsOf('a-1')).toEqual([])
  })

  it('writes labels and row fields together when both are passed', async () => {
    const res = await updateAction({ action_id: 'a-1', label_ids: ['label-bug'], priority: 'low' })

    expect(res.success).toBe(true)
    expect(actionRow.priority).toBe('low')
    expect(labelsOf('a-1')).toEqual(['label-bug'])
    expect(actionWrites()).toHaveLength(1)
  })
})

describe('update_action — calls with nothing to change', () => {
  it('refuses a misnamed status argument, names status_name, and writes nothing', async () => {
    // What an agent sent in GEN-102. Through the MCP the schema strips the
    // unknown key; execute() ignores it the same way when called directly.
    const res = await updateAction({ action_id: 'a-1', status: 'Canceled' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/^Nothing to update/)
    expect(res.error).toContain('status_name')
    expect(res.error).not.toContain('Cannot coerce')
    expect(log.filter((e) => e.op !== 'select')).toEqual([])
    expect(actionRow.status_id).toBe('state-backlog')
    expect(labelsOf('a-1')).toEqual(['label-old'])
  })

  it('refuses toggle_complete explicitly when the team has no completed state', async () => {
    tables.workflow_state = tables.workflow_state.filter((s) => s.category !== 'completed')

    const res = await updateAction({ action_id: 'a-1', toggle_complete: true })

    expect(res).toEqual({ success: false, error: 'No completed workflow state found' })
    expect(actionWrites()).toHaveLength(0)
  })
})

describe('update_action — status changes are unchanged', () => {
  it('moves the action to Canceled by status_name and fires the status-change trigger', async () => {
    const res = await updateAction({ action_id: 'a-1', status_name: 'Canceled' })

    expect(res.success).toBe(true)
    expect(actionRow.status_id).toBe('state-canceled')
    expect(emitStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatusId: 'state-backlog', toStatusId: 'state-canceled', teamId: TEAM }),
    )
  })

  it('completes the action with toggle_complete', async () => {
    const res = await updateAction({ action_id: 'a-1', toggle_complete: true })

    expect(res.success).toBe(true)
    expect(actionRow.status_id).toBe('state-done')
  })
})
