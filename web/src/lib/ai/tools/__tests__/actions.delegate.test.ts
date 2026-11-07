/**
 * The action tools under decision 9 (the delegate model) and the promotion
 * guard (A4 slices 7 and 8):
 *
 *   - `delegate` on create_action / update_action / create_actions_batch: an
 *     agent the caller can SEE in the action's workspace (assignable, and on a
 *     team that isn't private or that the caller sits on) works the action;
 *     the person stays responsible, and with nobody named the caller is.
 *   - `rules.fileActionsAsSuggested`: an unattended run files every action as
 *     suggested, whatever the model passed.
 *   - `rules.reviewActionIds`: the run's own action is never completed by the
 *     agent; complete_action and update_action into Done move it to review.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createActionTools, LEAVE_FOR_PERSON, type ActionToolRules } from '../actions'
import { createDecisionTools } from '../decisions'

vi.mock('@/lib/proposed-changes/apply-engine', () => ({ applyChange: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const ME = 'user-me'
const WS = 'ws-1'
const WRITER = '0a0a0a0a-0000-4000-8000-000000000001'
const SECRET = '0a0a0a0a-0000-4000-8000-000000000002'
const BOT = '0a0a0a0a-0000-4000-8000-000000000003'
const FOREIGN = '0a0a0a0a-0000-4000-8000-000000000004'

const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/** `project`: a write's select returns the columns it names, as PostgREST does. */
function world(project = false): FakeSupabase {
  const fake = makeFakeSupabase({ defaults: { actions: { identifier: 'ENG-1' } }, project })
  fake.seed('member', [
    { id: 'mem-me', user_id: ME, workspace_id: WS, role: 'member' },
    { id: 'mem-2', user_id: 'user-2', workspace_id: WS, role: 'member' },
  ])
  fake.seed('workspace', [{ id: WS, name: 'Acme' }])
  fake.seed('team', [
    { id: 'team-1', workspace_id: WS, is_private: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'team-p', workspace_id: WS, is_private: true, created_at: '2026-02-01T00:00:00Z' },
    { id: 'team-x', workspace_id: 'ws-2', is_private: false, created_at: '2026-01-01T00:00:00Z' },
  ])
  fake.seed('workflow_state', [
    { id: 'st-todo', team_id: 'team-1', name: 'Todo', category: 'unstarted', is_default: true, sort_order: 0 },
    { id: 'st-doing', team_id: 'team-1', name: 'In Progress', category: 'started', is_default: false, sort_order: 1 },
    { id: 'st-done', team_id: 'team-1', name: 'Done', category: 'completed', is_default: false, sort_order: 2 },
  ])
  fake.seed('ai_team_member', [
    { id: WRITER, name: 'Writer', team_id: 'team-1', workspace_id: WS, is_system: false, fronts_only: false },
    { id: SECRET, name: 'Secret Agent', team_id: 'team-p', workspace_id: WS, is_system: false, fronts_only: false },
    { id: BOT, name: 'Ember', team_id: 'team-1', workspace_id: WS, is_system: false, fronts_only: true },
    { id: FOREIGN, name: 'Writer Two', team_id: 'team-x', workspace_id: 'ws-2', is_system: false, fronts_only: false },
  ])
  return fake
}

/**
 * The double, with `.single()` answering one row as PostgREST does (the
 * shared double hands a select's whole list to `.single()`; the action tools
 * read one row from it). No row is an error, also as PostgREST says.
 */
function client(fake: FakeSupabase): SupabaseClient {
  return {
    ...fake,
    from: (table: string) => {
      const b = fake.from(table) as Record<string, unknown>
      const wrap = (target: Record<string, unknown>): Record<string, unknown> =>
        new Proxy(target, {
          get(t, prop) {
            const v = t[prop as string]
            if (prop === 'single') {
              return async () => {
                const r = (await (v as () => Promise<{ data: unknown; error: unknown }>)()) as { data: unknown; error: unknown }
                if (!Array.isArray(r.data)) return r
                return r.data.length > 0 ? { ...r, data: r.data[0] } : { data: null, error: r.error ?? { code: 'PGRST116', message: 'no rows' } }
              }
            }
            if (typeof v === 'function' && prop !== 'then') {
              return (...args: unknown[]) => {
                const out = (v as (...a: unknown[]) => unknown).apply(t, args)
                return out && typeof out === 'object' && !(out instanceof Promise) ? wrap(out as Record<string, unknown>) : out
              }
            }
            return v
          },
        })
      return wrap(b)
    },
  } as unknown as SupabaseClient
}

function tools(fake: FakeSupabase, rules: ActionToolRules = {}) {
  return createActionTools(ME, client(fake), WS, true, false, 'session', undefined, rules)
}

type Out = Record<string, unknown>
const run = async (t: any, input: Record<string, unknown>): Promise<Out> => (await t.execute(input, EXEC)) as Out

describe('create_action — delegate', () => {
  it('delegates to an agent by name; with nobody named, the caller is the person responsible', async () => {
    const fake = world()
    const out = await run(tools(fake).create_action, { title: 'Draft the brief', delegate: 'writer' })
    expect(out.success).toBe(true)
    expect(out.delegate).toEqual({ id: WRITER, name: 'Writer' })
    expect(String(out.message)).toContain('delegated to Writer')
    const action = fake.rows('actions')[0]
    expect(action).toMatchObject({ assignee_ai_member_id: WRITER, assignee_id: 'mem-me', confirmation: 'confirmed' })
    expect(fake.rows('action_assignee')).toEqual([expect.objectContaining({ action_id: action.id, member_id: 'mem-me' })])
  })

  it('keeps the named person beside the delegate', async () => {
    const fake = world()
    await run(tools(fake).create_action, { title: 'Draft the brief', delegate: WRITER, assignee_id: 'mem-2' })
    expect(fake.rows('actions')[0]).toMatchObject({ assignee_ai_member_id: WRITER, assignee_id: 'mem-2' })
  })

  it.each([
    ['a private team’s agent the caller is not on', 'Secret Agent'],
    ['a loop’s work bot', BOT],
    ['another workspace’s agent', FOREIGN],
    ['a name nobody has', 'Nobody'],
  ])('refuses %s and files nothing', async (_label, ref) => {
    const fake = world()
    const out = await run(tools(fake).create_action, { title: 'Draft the brief', delegate: ref })
    expect(out.success).toBe(false)
    expect(String(out.error)).toMatch(/list_bot_work/)
    expect(fake.rows('actions')).toHaveLength(0)
  })

  it('sees a private team’s agent once the caller sits on that team', async () => {
    const fake = world()
    fake.seed('team_member', [{ team_id: 'team-p', member_id: 'mem-me' }])
    const out = await run(tools(fake).create_action, { title: 'Draft the brief', delegate: 'secret agent' })
    expect(out.success).toBe(true)
    expect(fake.rows('actions')[0].assignee_ai_member_id).toBe(SECRET)
  })
})

describe('the promotion guard (fileActionsAsSuggested)', () => {
  it('create_action files suggested on an unattended run, even when the model asked for confirmed', async () => {
    const fake = world()
    const out = await run(tools(fake, { fileActionsAsSuggested: true }).create_action, { title: 'Follow up with Acme', confirmation: 'confirmed' })
    expect(out.success).toBe(true)
    expect(fake.rows('actions')[0].confirmation).toBe('suggested')
    expect(String(out.message)).toContain('as a suggestion for the person to confirm')
  })

  it('an attended surface keeps the default confirmed', async () => {
    const fake = world()
    await run(tools(fake).create_action, { title: 'Follow up with Acme' })
    expect(fake.rows('actions')[0].confirmation).toBe('confirmed')
  })

  it('create_actions_batch files every row suggested; a bad delegate fails only its row', async () => {
    const fake = world()
    const out = await run(tools(fake, { fileActionsAsSuggested: true }).create_actions_batch, {
      actions: [
        { title: 'One', confirmation: 'confirmed', delegate: 'Writer' },
        { title: 'Two', delegate: 'Ember' },
        { title: 'Three' },
      ],
    })
    expect(out.created).toHaveLength(2)
    expect(out.failed).toEqual([expect.objectContaining({ title: 'Two' })])
    const rows = fake.rows('actions')
    expect(rows.map((r) => r.confirmation)).toEqual(['suggested', 'suggested'])
    expect(rows[0]).toMatchObject({ title: 'One', assignee_ai_member_id: WRITER, assignee_id: 'mem-me' })
    expect(rows[1].assignee_ai_member_id).toBeUndefined()
  })
})

describe('update_action — delegate', () => {
  function withAction(fake: FakeSupabase, extra: Record<string, unknown> = {}) {
    fake.seed('actions', [{ id: 'act-1', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-1', title: 'Write it', status_id: 'st-todo', ...extra }])
  }

  it('delegating an action nobody holds makes the caller responsible beside the agent', async () => {
    const fake = world()
    withAction(fake)
    const out = await run(tools(fake).update_action, { action_id: 'act-1', delegate: 'Writer' })
    expect(out.success).toBe(true)
    expect(fake.rows('actions')[0]).toMatchObject({ assignee_ai_member_id: WRITER, assignee_id: 'mem-me' })
    expect(fake.rows('action_assignee')).toEqual([expect.objectContaining({ action_id: 'act-1', member_id: 'mem-me' })])
  })

  it('delegating an action a person holds leaves that person', async () => {
    const fake = world()
    withAction(fake, { assignee_id: 'mem-2' })
    fake.seed('action_assignee', [{ action_id: 'act-1', member_id: 'mem-2' }])
    await run(tools(fake).update_action, { action_id: 'act-1', delegate: 'Writer' })
    expect(fake.rows('actions')[0]).toMatchObject({ assignee_ai_member_id: WRITER, assignee_id: 'mem-2' })
    expect(fake.rows('action_assignee')).toEqual([expect.objectContaining({ member_id: 'mem-2' })])
  })

  it("an empty delegate removes the agent and keeps the person", async () => {
    const fake = world()
    withAction(fake, { assignee_id: 'mem-2', assignee_ai_member_id: WRITER })
    const out = await run(tools(fake).update_action, { action_id: 'act-1', delegate: '' })
    expect(out.success).toBe(true)
    expect(fake.rows('actions')[0]).toMatchObject({ assignee_ai_member_id: null, assignee_id: 'mem-2' })
  })

  it('refuses an agent the caller cannot see, writing nothing', async () => {
    const fake = world()
    withAction(fake)
    const out = await run(tools(fake).update_action, { action_id: 'act-1', delegate: SECRET, title: 'Renamed' })
    expect(out.success).toBe(false)
    expect(fake.rows('actions')[0].title).toBe('Write it')
  })
})

describe('the run’s own action goes to review, never Done (reviewActionIds)', () => {
  function withAction(fake: FakeSupabase) {
    fake.seed('actions', [{ id: 'act-1', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-1', title: 'Write it', status_id: 'st-todo', agent_run_status: 'working' }])
  }

  it('complete_action on the run’s own action moves it to review', async () => {
    const fake = world()
    withAction(fake)
    const out = await run(tools(fake, { reviewActionIds: ['act-1'] }).complete_action, { action_id: 'act-1' })
    expect(out).toMatchObject({ success: true, review: true })
    expect(fake.rows('actions')[0]).toMatchObject({ status_id: 'st-doing', agent_run_status: 'working' }) // the run is still going: only the settle resets it
  })

  it('update_action into Done on the run’s own action goes to review; the other fields still write', async () => {
    const fake = world()
    withAction(fake)
    const out = await run(tools(fake, { reviewActionIds: ['act-1'] }).update_action, { action_id: 'act-1', status_name: 'Done', priority: 'high' })
    expect(out).toMatchObject({ success: true, review: true })
    expect(fake.rows('actions')[0]).toMatchObject({ status_id: 'st-doing', priority: 'high' })
  })

  it('update_action with toggle_complete alone still goes to review, not "Nothing to update"', async () => {
    const fake = world()
    withAction(fake)
    const out = await run(tools(fake, { reviewActionIds: ['act-1'] }).update_action, { action_id: 'act-1', toggle_complete: true })
    expect(out).toMatchObject({ success: true, review: true })
    expect(fake.rows('actions')[0].status_id).toBe('st-doing')
  })

  it('a move into a started state is left alone, and other actions complete as before', async () => {
    const fake = world()
    withAction(fake)
    fake.seed('actions', [{ id: 'act-2', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-2', title: 'Other', status_id: 'st-todo' }])
    const t = tools(fake, { reviewActionIds: ['act-1'] })
    await run(t.update_action, { action_id: 'act-1', status_name: 'In Progress' })
    expect(fake.rows('actions')[0].status_id).toBe('st-doing')
    const out = await run(t.complete_action, { action_id: 'act-2' })
    expect(out.success).toBe(true)
    expect(out.review).toBeUndefined()
    expect(fake.rows('actions')[1].status_id).toBe('st-done')
  })
})

describe('an unattended run never promotes a suggestion it made (unattended + filedByRun)', () => {
  const DEC_OWN = '0b0b0b0b-0000-4000-8000-000000000001'
  const DEC_MEETING = '0b0b0b0b-0000-4000-8000-000000000002'
  const PROP_OWN = '0c0c0c0c-0000-4000-8000-000000000001'
  const PROP_MEETING = '0c0c0c0c-0000-4000-8000-000000000002'
  const filed = new Set([DEC_OWN, PROP_OWN])
  const UNATTENDED: ActionToolRules = {
    unattended: true,
    fileActionsAsSuggested: true,
    filedByRun: async (ids) => new Set(ids.filter((id) => filed.has(id))),
  }

  function withSuggestions(fake: FakeSupabase) {
    fake.seed('actions', [{ id: 'act-s', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-3', title: 'Suggested', status_id: 'st-todo', confirmation: 'suggested' }])
    fake.seed('captures', [{ id: 'cap-1', workspace_id: WS, visibility: 'workspace', user_id: ME, is_eval: false }])
    fake.seed('decision', [
      { id: DEC_OWN, capture_id: 'cap-1', content: 'We ship Friday', confirmation: 'suggested' },
      { id: DEC_MEETING, capture_id: 'cap-1', content: 'Price stays', confirmation: 'suggested' },
    ])
  }
  const decisionTools = (fake: FakeSupabase, rules: ActionToolRules = {}) =>
    createDecisionTools(ME, client(fake), WS, true, 'session', false, rules)

  it('confirm_action is refused with the reason, and the action stays suggested', async () => {
    const fake = world()
    withSuggestions(fake)
    const out = await run(tools(fake, UNATTENDED).confirm_action, { action_id: 'act-s' })
    expect(out).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON', error: LEAVE_FOR_PERSON })
    expect(String(out.error)).toContain('Leave it for the person to confirm')
    expect(fake.rows('actions')[0].confirmation).toBe('suggested')
  })

  it('the person’s attended chat still confirms', async () => {
    const fake = world()
    withSuggestions(fake)
    const out = await run(tools(fake).confirm_action, { action_id: 'act-s' })
    expect(out.success).toBe(true)
    expect(fake.rows('actions')[0].confirmation).toBe('confirmed')
  })

  it('confirm_decision is refused outright on an unattended run, like confirm_action', async () => {
    const fake = world(true)
    withSuggestions(fake)
    const t = decisionTools(fake, UNATTENDED)
    expect(await run(t.confirm_decision, { decision_id: DEC_OWN })).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON' })
    expect(await run(t.confirm_decision, { decision_id: DEC_MEETING })).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON' })
    expect(fake.rows('decision').map((d) => d.confirmation)).toEqual(['suggested', 'suggested'])
  })

  it('attended, confirm_decision confirms as before', async () => {
    const fake = world(true)
    withSuggestions(fake)
    expect(await run(decisionTools(fake).confirm_decision, { decision_id: DEC_MEETING })).toMatchObject({ success: true })
  })

  it('fails closed: an unattended run that can’t say what it filed (no lookup, or a lookup that throws) refuses', async () => {
    const fake = world()
    withSuggestions(fake)
    const noLookup = await run(decisionTools(fake, { unattended: true }).confirm_all_decisions, { capture_id: 'cap-1' })
    expect(noLookup).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON' })
    const broken: ActionToolRules = { unattended: true, filedByRun: async () => { throw new Error('down') } }
    expect(await run(tools(fake, broken).accept_proposal, { proposal_id: PROP_MEETING })).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON' })
    expect(fake.rows('decision').map((d) => d.confirmation)).toEqual(['suggested', 'suggested'])
  })

  it('confirm_all_decisions confirms the others and leaves the run’s own for the person', async () => {
    const fake = world()
    withSuggestions(fake)
    const out = await run(decisionTools(fake, UNATTENDED).confirm_all_decisions, { capture_id: 'cap-1' })
    expect(out).toMatchObject({ success: true, confirmed_count: 1, left_for_person: 1 })
    expect(fake.rows('decision').map((d) => d.confirmation)).toEqual(['suggested', 'confirmed'])
  })

  it('confirm_all_decisions with only the run’s own pending is refused', async () => {
    const fake = world()
    withSuggestions(fake)
    fake.rows('decision')[1].confirmation = 'confirmed'
    const out = await run(decisionTools(fake, UNATTENDED).confirm_all_decisions, { capture_id: 'cap-1' })
    expect(out).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON' })
    expect(fake.rows('decision')[0].confirmation).toBe('suggested')
  })

  it('attended, confirm_all_decisions confirms every one as before', async () => {
    const fake = world()
    withSuggestions(fake)
    const out = await run(decisionTools(fake).confirm_all_decisions, { capture_id: 'cap-1' })
    expect(out).toMatchObject({ success: true, confirmed_count: 2 })
  })

  it('create_decision files suggested on an unattended run, even when asked for confirmed', async () => {
    const fake = world()
    withSuggestions(fake)
    await run(decisionTools(fake, UNATTENDED).create_decision, { capture_id: 'cap-1', content: 'Hire two', confirmation: 'confirmed' })
    expect(fake.rows('decision')[2]).toMatchObject({ content: 'Hire two', confirmation: 'suggested' })
  })

  it('accept_proposal refuses a proposal the run filed and lets the meeting’s through to the apply path', async () => {
    const fake = world()
    const t = tools(fake, UNATTENDED)
    expect(await run(t.accept_proposal, { proposal_id: PROP_OWN })).toMatchObject({ success: false, code: 'LEAVE_FOR_PERSON' })
    const batch = await run(t.accept_proposal, { proposal_ids: [PROP_OWN, PROP_MEETING] })
    const results = batch.results as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ proposal_id: PROP_OWN, code: 'LEAVE_FOR_PERSON' })
    // Not refused by the guard: it reaches the proposal lookup (none seeded here).
    expect(results[1]).toMatchObject({ proposal_id: PROP_MEETING, success: false })
    expect(results[1].code).toBeUndefined()
    expect(String(results[1].error)).toContain('Proposal not found')
  })
})

describe('read-back: the delegate comes back on the rows', () => {
  it('create_action answers the action with its delegate', async () => {
    const fake = world()
    const out = await run(tools(fake).create_action, { title: 'Draft the brief', delegate: 'Writer' })
    expect((out.action as Record<string, unknown>).assignee_ai_member_id).toBe(WRITER)
    expect((out.action as Record<string, unknown>).delegate).toMatchObject({ id: WRITER })
  })

  it('list_actions compact rows carry the delegate', async () => {
    const fake = world()
    fake.seed('actions', [
      {
        id: 'act-d', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-9', title: 'Delegated', status_id: 'st-todo',
        confirmation: 'confirmed', assignee_ai_member_id: WRITER, delegate_agent: { id: WRITER, name: 'Writer' }, parent_id: null,
      },
    ])
    const out = await run(tools(fake).list_actions, {})
    const row = (out.actions as Array<Record<string, unknown>>).find((a) => a.id === 'act-d')
    expect(row?.delegate).toEqual({ id: WRITER, name: 'Writer' })
  })
})
