/**
 * Tests for the per-push destination params on the three push tools:
 *   push_action_to_{asana,jira,linear}  (and their dial8_-prefixed MCP twins)
 *
 * The tools are thin passthroughs — the push functions own every decision — so
 * what is asserted here is the two things a passthrough can still get wrong:
 *  - CALLING WITH NO DESTINATION PARAMS must reach the push with no `overrides`
 *    key at all, so an agent that just says "push ENG-42" gets exactly the
 *    behaviour it got before these params existed.
 *  - VALIDATION must run through the SAME parser the routes use, so a model that
 *    names a project without an issue type is told what to fix instead of being
 *    handed a Jira 400 it cannot read.
 *
 * The AI SDK passes every unset optional param through as an explicit
 * `undefined`, which is precisely why the first assertion needs to exist: a
 * naive spread would turn "the model chose nothing" into an overrides object
 * full of undefineds.
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
const WORKSPACE_ID = 'ws-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * Enough Supabase for the identifier→id lookup these tools never need here,
 * AND for the `resolveEntityWorkspace` call every push tool now makes before
 * pushing (workspace routing, see _shared.ts). Every test below pushes
 * `action_id: 'act-1'` with no prior read, so the double treats any `id`-keyed
 * lookup as "found, in the session workspace" (the fast path — `.eq('id',
 * ...).eq('workspace_id', ...).maybeSingle()`) and any other keyed lookup
 * (the `identifier` lookup) as a miss, matching the old double's behaviour.
 */
const supabase = {
  from: () => ({
    select: () => ({
      eq: (col1: string) => ({
        eq: () => ({
          maybeSingle: async () =>
            col1 === 'id' ? { data: { workspace_id: WORKSPACE_ID }, error: null } : { data: null, error: null },
        }),
        // resolveEntityWorkspace's cross-workspace slow path (single .eq then
        // .maybeSingle) — unreached here since the fast path above always
        // matches, but present so a chain shape change fails loudly rather
        // than throwing "not a function".
        maybeSingle: async () =>
          col1 === 'id' ? { data: { workspace_id: WORKSPACE_ID }, error: null } : { data: null, error: null },
      }),
    }),
  }),
} as never

const LINK = {
  id: 'link-1',
  external_url: 'https://example.test/x',
  external_title: 'Ship the thing',
}

/** The single tool under test, per provider. */
function toolFor(provider: 'asana' | 'jira' | 'linear') {
  if (provider === 'asana') {
    return createAsanaTools(USER_ID, supabase, WORKSPACE_ID).push_action_to_asana
  }
  if (provider === 'jira') {
    return createJiraTools(USER_ID, supabase, WORKSPACE_ID).push_action_to_jira
  }
  return createLinearTools(USER_ID, supabase, WORKSPACE_ID).push_action_to_linear
}

const PROVIDERS = [
  { name: 'asana', mock: hoistedPush.pushActionToAsana },
  { name: 'jira', mock: hoistedPush.pushActionToJira },
  { name: 'linear', mock: hoistedPush.pushActionToLinear },
] as const

/**
 * Run a tool with args, typed loosely — the tools return open result objects
 * whose success/error union is not worth reconstructing at every call site.
 */
async function run(
  provider: 'asana' | 'jira' | 'linear',
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const execute = toolFor(provider).execute!
  return (await execute(
    args as never,
    EXEC_OPTS,
  )) as unknown as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const { mock } of PROVIDERS) {
    mock.mockResolvedValue({ ok: true, link: LINK, created: true })
  }
})

// ---- The byte-compatibility guarantee --------------------------------------

describe.each(PROVIDERS)('push_action_to_$name — no destination params', ({ name, mock }) => {
  /** `toHaveBeenCalledWith` is EXACT — an `overrides: undefined` key fails it. */
  it('calls the push with NO overrides key', async () => {
    await run(name, { action_id: 'act-1' })
    expect(mock).toHaveBeenCalledWith({
      actionId: 'act-1',
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      supabase: expect.anything(),
    })
  })

  /**
   * The AI SDK hands unset optional params through as explicit undefineds, so
   * this is the shape the tool actually receives in production.
   */
  it('ignores explicitly-undefined destination params', async () => {
    await run(name, { action_id: 'act-1', title: undefined, assignee_id: undefined })
    expect(mock).toHaveBeenCalledWith({
      actionId: 'act-1',
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      supabase: expect.anything(),
    })
  })

  it('still reports the push result', async () => {
    const result = await run(name, { action_id: 'act-1' })
    expect(result).toMatchObject({ success: true, already_linked: false, action_id: 'act-1' })
  })
})

// ---- Threading -------------------------------------------------------------

describe('push_action_to_jira — destination params', () => {
  it('threads a valid override into the push', async () => {
    await run('jira', {
      action_id: 'act-1',
      project_id: '20000',
      issue_type_id: '20001',
      priority_id: '3',
      labels: ['infra'],
    })
    expect(hoistedPush.pushActionToJira).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: {
          project_id: '20000',
          issue_type_id: '20001',
          priority_id: '3',
          labels: ['infra'],
        },
      }),
    )
  })

  /**
   * The SAME dependent-field rule the route enforces, surfaced as a readable
   * tool error the model can act on rather than as a Jira 400.
   */
  it('reports the dependent-field rule as a tool error, without pushing', async () => {
    const result = await run('jira', { action_id: 'act-1', project_id: '20000' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/issue_type_id/)
    expect(hoistedPush.pushActionToJira).not.toHaveBeenCalled()
  })

  it('reports a malformed due_date without pushing', async () => {
    const result = await run('jira', { action_id: 'act-1', due_date: 'next tuesday' })
    expect(result.success).toBe(false)
    expect(hoistedPush.pushActionToJira).not.toHaveBeenCalled()
  })
})

describe('push_action_to_asana — destination params', () => {
  it('threads a valid override into the push', async () => {
    await run('asana', { action_id: 'act-1', project_gid: '222', due_on: '2026-09-09' })
    expect(hoistedPush.pushActionToAsana).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { project_gid: '222', due_on: '2026-09-09' } }),
    )
  })

  /** Asana has no native priority, so the schema does not offer one to invent. */
  it('does not expose a priority param', async () => {
    const shape = toolFor('asana').inputSchema as unknown as { shape?: Record<string, unknown> }
    expect(Object.keys(shape.shape ?? {})).not.toContain('priority')
  })
})

describe('push_action_to_linear — destination params', () => {
  it('threads a valid override into the push', async () => {
    await run('linear', { action_id: 'act-1', team_id: 'team-B', priority: 2 })
    expect(hoistedPush.pushActionToLinear).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { team_id: 'team-B', priority: 2 } }),
    )
  })

  /** 0 is "No priority" — a real choice, not an absence. */
  it('threads priority 0 rather than dropping it as falsy', async () => {
    await run('linear', { action_id: 'act-1', priority: 0 })
    expect(hoistedPush.pushActionToLinear).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { priority: 0 } }),
    )
  })

  /**
   * The state is DERIVED from the team server-side, so there is nothing for the
   * model to pick and no way for it to name another team's state.
   */
  it('does not expose a state param', async () => {
    const shape = toolFor('linear').inputSchema as unknown as { shape?: Record<string, unknown> }
    const keys = Object.keys(shape.shape ?? {})
    expect(keys).not.toContain('state_id')
    expect(keys).not.toContain('stateId')
  })
})
