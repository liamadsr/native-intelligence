/**
 * Workspace routing for the three push tools: push_action_to_{asana,jira,linear}.
 *
 * Each tool takes an action_id (or identifier) and pushes it through the
 * WORKSPACE'S connected integration (Asana project / Jira project / Linear
 * team). Before this fix, the push always loaded that config for the SESSION
 * workspace, so a foreign-but-member action_id either read "Action not found"
 * (the push function's own `.eq('workspace_id', sessionWs)` never matched) or,
 * worse, would have pushed through the WRONG tenant's connection had the ids
 * happened to collide. The fix: resolve the ACTION's own workspace first
 * (`resolveEntityWorkspace`), and load the integration config for THAT
 * workspace, never the session's.
 *
 * Mirrors the mock style in push-overrides.test.ts (mocked push functions) and
 * actions.workspace-routing.test.ts (a small in-memory `actions`/`member`
 * table double, so a routing bug would genuinely read/write the wrong rows).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

const hoistedPush = vi.hoisted(() => ({
  pushActionToAsana: vi.fn(),
  pushActionToJira: vi.fn(),
  pushActionToLinear: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-push', () => ({ pushActionToAsana: hoistedPush.pushActionToAsana }))
vi.mock('@/lib/tasks/jira-push', () => ({ pushActionToJira: hoistedPush.pushActionToJira }))
vi.mock('@/lib/tasks/linear-push', () => ({ pushActionToLinear: hoistedPush.pushActionToLinear }))

const { createAsanaTools } = await import('../asana')
const { createJiraTools } = await import('../jira')
const { createLinearTools } = await import('../linear')

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; col: string; val: unknown }

/** Same small in-memory engine as actions.workspace-routing.test.ts: eq()
 *  accumulates predicates, maybeSingle() applies them. */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn((col: string, val: unknown) => {
    log.push({ table, col, val })
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.maybeSingle = async () => {
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    return { data: matched[0] ?? null, error: null }
  }
  return chain
}

function makeSupabase(opts: { actions: Row[]; memberOf: string[] }) {
  const members = opts.memberOf.map((id) => ({ id: `member-${id}`, user_id: USER_ID, workspace_id: id }))
  const log: LogEntry[] = []
  const from = vi.fn((table: string) => {
    if (table === 'actions') return tableChain('actions', opts.actions, log)
    if (table === 'member') return tableChain('member', members, log)
    return tableChain(table, [], log)
  })
  return { supabase: { from } as never, log }
}

const LOCAL_ACTION = { id: 'a-local', workspace_id: WS_ACTIVE }
const FOREIGN_ACTION = { id: 'a-foreign', workspace_id: WS_OTHER }

const LINK = { id: 'link-1', external_url: 'https://example.test/x', external_title: 'Ship the thing' }

const PROVIDERS = [
  { name: 'asana' as const, factory: createAsanaTools, tool: 'push_action_to_asana', mock: hoistedPush.pushActionToAsana },
  { name: 'jira' as const, factory: createJiraTools, tool: 'push_action_to_jira', mock: hoistedPush.pushActionToJira },
  { name: 'linear' as const, factory: createLinearTools, tool: 'push_action_to_linear', mock: hoistedPush.pushActionToLinear },
]

beforeEach(() => {
  vi.clearAllMocks()
  for (const { mock } of PROVIDERS) mock.mockResolvedValue({ ok: true, link: LINK, created: true })
})

describe.each(PROVIDERS)('$tool — workspace routing', ({ factory, tool, mock }) => {
  it('routes a foreign-but-member action_id to ITS OWN workspace — the integration config loads for that workspace', async () => {
    const { supabase } = makeSupabase({
      actions: [LOCAL_ACTION, FOREIGN_ACTION],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = factory(USER_ID, supabase, WS_ACTIVE) as Record<string, { execute?: unknown }>
    const execute = tools[tool].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>
    const res = await execute({ action_id: 'a-foreign' }, EXEC_OPTS)

    expect(res).toMatchObject({ success: true })
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'a-foreign', workspaceId: WS_OTHER, userId: USER_ID }),
    )
  })

  it('leaves an in-workspace action_id pushing through the session workspace, unchanged', async () => {
    const { supabase } = makeSupabase({ actions: [LOCAL_ACTION], memberOf: [WS_ACTIVE] })
    const tools = factory(USER_ID, supabase, WS_ACTIVE) as Record<string, { execute?: unknown }>
    const execute = tools[tool].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>
    await execute({ action_id: 'a-local' }, EXEC_OPTS)

    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'a-local', workspaceId: WS_ACTIVE }),
    )
  })

  it('is not-found (and never calls the push) for an action_id nobody can resolve', async () => {
    const { supabase } = makeSupabase({ actions: [LOCAL_ACTION], memberOf: [WS_ACTIVE] })
    const tools = factory(USER_ID, supabase, WS_ACTIVE) as Record<string, { execute?: unknown }>
    const execute = tools[tool].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>
    const res = await execute({ action_id: 'does-not-exist' }, EXEC_OPTS)

    expect(res).toEqual({ success: false, error: 'Action not found', code: 'action_not_found' })
    expect(mock).not.toHaveBeenCalled()
  })

  it('under strictWorkspace, a foreign-but-member action_id is not-found with NO member probe', async () => {
    const { supabase, log } = makeSupabase({
      actions: [LOCAL_ACTION, FOREIGN_ACTION],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const strictWorkspace = true
    const tools = factory(USER_ID, supabase, WS_ACTIVE, strictWorkspace) as Record<string, { execute?: unknown }>
    const execute = tools[tool].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>
    const res = await execute({ action_id: 'a-foreign' }, EXEC_OPTS)

    expect(res).toEqual({ success: false, error: 'Action not found', code: 'action_not_found' })
    expect(mock).not.toHaveBeenCalled()
    // The fenced run must not learn the id exists in another workspace at all.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})
