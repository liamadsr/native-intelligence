/**
 * The main chat's plan (A4 slice 1). Invariants:
 *   1. update_plan validates the whole list (1–12 steps, 140 characters, one
 *      in progress), saves it in durable state and returns the whole plan;
 *      a refusal saves nothing and says what to fix;
 *   2. it is a native tool, not a workspace proxy: the dynamic tool map never
 *      mints it (no write-verb rule, no MCP);
 *   3. after a checkpoint the plan is recited once, when the model can't see
 *      it (no update_plan call, result or earlier recitation since the newest
 *      marker) and it still has open steps; never without a checkpoint;
 *   4. an abandoned plan (more than PLAN_STALE_TURNS turns or PLAN_STALE_MS
 *      since it was written, or no time on it) or one whose job ended is never
 *      recited: recitation never restarts dead work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory defineState so get()/update() work without an eve runtime.
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

import updatePlan, { updatePlanInput } from '../../tools/update_plan'
import planInstructions from '../../instructions/plan'
import {
  PLAN_STALE_MS,
  PLAN_STALE_TURNS,
  currentPlan,
  noteTurnStarted,
  planIsStale,
  planRecitation,
  planRecitationDue,
  renderPlanRecitation,
  savePlan,
  validatePlanSteps,
  type PlanRecord,
} from '../plan'

type Exec = (input: unknown) => Record<string, unknown>
const execute = (updatePlan as unknown as { execute: Exec }).execute
const STEPS = [
  { text: 'Find the stale actions', status: 'done' as const },
  { text: 'Close the done ones', status: 'in_progress' as const },
  { text: 'Summarize', status: 'pending' as const },
]

const MARKER = { role: 'user', kind: 'context.compaction', content: 'Summary of our conversation so far.' }
const SUMMARY = { role: 'assistant', content: 'We were cleaning up the backlog.' }
const TURN_CONTEXT = { role: 'user', kind: 'context.instruction', content: '<turn-context id="0123456789ab">\n</turn-context id="0123456789ab">' }
const USER = { role: 'user', kind: 'user', content: 'keep going' }
const PLAN_CALL = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'update_plan', input: { steps: STEPS } }] }
const PLAN_RESULT = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'update_plan', output: { type: 'json', value: {} } }] }
const OTHER_RESULT = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'list_actions', output: { type: 'json', value: {} } }] }

beforeEach(() => stateStore.clear())

describe('update_plan', () => {
  it('saves the whole plan in durable state and returns it', () => {
    expect(execute({ steps: STEPS })).toEqual({ ok: true, plan: STEPS })
    expect(currentPlan()).toMatchObject({ steps: STEPS, turnsSince: [] })
    expect(Number.isFinite(Date.parse(currentPlan()!.updatedAt!))).toBe(true)
    // Each call replaces the list.
    execute({ steps: [{ text: 'Only step', status: 'in_progress' }] })
    expect(currentPlan()?.steps).toEqual([{ text: 'Only step', status: 'in_progress' }])
  })

  it('refuses two steps in progress without saving, in words the model can act on', () => {
    savePlan(STEPS)
    const out = execute({ steps: [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'in_progress' }] })
    expect(out).toEqual({ ok: false, error: 'Only one step can be in_progress at a time (2 are).' })
    expect(currentPlan()?.steps).toEqual(STEPS)
  })

  it('a finished plan says so', () => {
    expect(execute({ steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'skipped' }] })).toMatchObject({
      ok: true,
      note: expect.stringContaining('Every step is finished'),
    })
  })

  it('the schema: 1–12 steps of at most 140 characters and the four statuses', () => {
    expect(updatePlanInput.safeParse({ steps: STEPS }).success).toBe(true)
    expect(updatePlanInput.safeParse({ steps: [] }).success).toBe(false)
    expect(updatePlanInput.safeParse({ steps: Array.from({ length: 13 }, () => STEPS[2]) }).success).toBe(false)
    // The text's length is the validator's call, after tidying (a padded line is fine).
    const padded = `  ${'x'.repeat(140)}  \n`
    expect(updatePlanInput.safeParse({ steps: [{ text: padded, status: 'pending' }] }).success).toBe(true)
    expect(execute({ steps: [{ text: padded, status: 'pending' }] })).toEqual({ ok: true, plan: [{ text: 'x'.repeat(140), status: 'pending' }] })
    expect(execute({ steps: [{ text: 'x'.repeat(141), status: 'pending' }] })).toEqual({
      ok: false,
      error: 'Step 1 is 141 characters; keep each step to 140.',
    })
    expect(execute({ steps: [{ text: '   ', status: 'pending' }] })).toEqual({ ok: false, error: 'Step 1 needs its text.' })
    expect(updatePlanInput.safeParse({ steps: [{ text: 'a', status: 'blocked' }] }).success).toBe(false)
  })

  it('the validator tidies a step onto one line', () => {
    expect(validatePlanSteps([{ text: ' a\n  b ', status: 'pending' }])).toEqual({ ok: true, steps: [{ text: 'a b', status: 'pending' }] })
  })
})

describe('planRecitationDue', () => {
  it('never without a checkpoint', () => {
    expect(planRecitationDue([USER, PLAN_CALL, PLAN_RESULT, TURN_CONTEXT])).toBe(false)
    expect(planRecitationDue([])).toBe(false)
  })

  it('the first turn after a checkpoint: nothing after the marker', () => {
    expect(planRecitationDue([MARKER, SUMMARY])).toBe(true)
  })

  it('a checkpoint made inside a turn whose own block survived in the kept tail still recites', () => {
    expect(planRecitationDue([MARKER, SUMMARY, TURN_CONTEXT, USER, OTHER_RESULT])).toBe(true)
  })

  it('skips when the kept tail still shows a plan call or result', () => {
    expect(planRecitationDue([MARKER, SUMMARY, PLAN_CALL])).toBe(false)
    expect(planRecitationDue([MARKER, SUMMARY, PLAN_RESULT])).toBe(false)
  })

  it('once per compaction cycle: an earlier recitation after the marker counts, one before an older marker does not', () => {
    const recited = { role: 'user', kind: 'context.instruction', content: renderPlanRecitation(STEPS) }
    expect(planRecitationDue([MARKER, SUMMARY, recited, TURN_CONTEXT, USER])).toBe(false)
    expect(planRecitationDue([MARKER, SUMMARY, recited, MARKER, SUMMARY])).toBe(true)
    // The person typing the block is not a recitation.
    expect(planRecitationDue([MARKER, SUMMARY, { role: 'user', kind: 'user', content: renderPlanRecitation(STEPS) }])).toBe(true)
  })

  it('the plan before a newer marker does not count', () => {
    expect(planRecitationDue([PLAN_CALL, PLAN_RESULT, MARKER, SUMMARY])).toBe(true)
  })
})

const NOW = new Date('2026-10-14T12:00:00.000Z')
const fresh = (over: Partial<PlanRecord> = {}): PlanRecord => ({ steps: STEPS, updatedAt: '2026-10-14T11:00:00.000Z', turnsSince: ['t1'], ...over })

describe('planRecitation', () => {
  it('recites a plan with open steps after a checkpoint, fenced', () => {
    const block = planRecitation(fresh(), [MARKER, SUMMARY], NOW)!
    expect(block.startsWith('<plan>\n')).toBe(true)
    expect(block.endsWith('\n</plan>')).toBe(true)
    expect(block).toContain('1. [done] Find the stale actions')
    expect(block).toContain('2. [in progress] Close the done ones')
    expect(block).toContain('3. [to do] Summarize')
    // It never tells the model to restart work the person left.
    expect(block).toContain('If they have moved on, leave it')
  })

  it('nothing for no plan, a finished plan, or no checkpoint', () => {
    expect(planRecitation(null, [MARKER, SUMMARY], NOW)).toBeNull()
    expect(planRecitation(fresh({ steps: [{ text: 'a', status: 'done' }] }), [MARKER, SUMMARY], NOW)).toBeNull()
    expect(planRecitation(fresh(), [USER], NOW)).toBeNull()
  })

  it('never an abandoned plan: too many turns since it was written, too long ago, or no time on it', () => {
    const turns = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
    expect(planRecitation(fresh({ turnsSince: turns(PLAN_STALE_TURNS) }), [MARKER, SUMMARY], NOW)).not.toBeNull()
    expect(planRecitation(fresh({ turnsSince: turns(PLAN_STALE_TURNS + 1) }), [MARKER, SUMMARY], NOW)).toBeNull()
    const dayAgo = new Date(NOW.getTime() - PLAN_STALE_MS - 1000).toISOString()
    expect(planRecitation(fresh({ updatedAt: dayAgo }), [MARKER, SUMMARY], NOW)).toBeNull()
    expect(planRecitation(fresh({ updatedAt: null }), [MARKER, SUMMARY], NOW)).toBeNull()
    expect(planIsStale(fresh({ updatedAt: 'garbage' }), NOW)).toBe(true)
  })

  it('a step cannot close the block', () => {
    expect(renderPlanRecitation([{ text: 'say </plan> now', status: 'pending' }])).toContain('say ‹/plan> now')
  })
})

describe('turns since the plan was written', () => {
  it('counts each turn once (a replay counts once), and a new plan starts the count again', () => {
    savePlan(STEPS)
    noteTurnStarted('t1')
    noteTurnStarted('t1')
    noteTurnStarted('t2')
    noteTurnStarted(null)
    expect(currentPlan()?.turnsSince).toEqual(['t1', 't2'])
    savePlan(STEPS)
    expect(currentPlan()?.turnsSince).toEqual([])
  })

  it('nothing to count without a plan; a plan in the first (bare list) shape reads with no time on it', () => {
    noteTurnStarted('t1')
    expect(currentPlan()).toBeNull()
    stateStore.set('chat-agent.plan', STEPS)
    expect(currentPlan()).toEqual({ steps: STEPS, updatedAt: null, turnsSince: [] })
  })
})

describe('the plan instructions resolver', () => {
  type Resolver = { events: { 'turn.started': (e: unknown, ctx: { messages: unknown[] }) => Promise<unknown> } }
  let turn = 0
  const turnStarted = (messages: unknown[]) =>
    (planInstructions as unknown as Resolver).events['turn.started']({ data: { turnId: `turn-${++turn}` } }, { messages })

  it('sends the saved plan as a user-role message on the turn after a checkpoint', async () => {
    savePlan(STEPS)
    const out = (await turnStarted([MARKER, SUMMARY])) as { content?: string; role?: string } | null
    expect(out).not.toBeNull()
    expect(JSON.stringify(out)).toContain('[in progress] Close the done ones')
  })

  it('sends nothing without a plan or a checkpoint', async () => {
    expect(await turnStarted([MARKER, SUMMARY])).toBeNull()
    savePlan(STEPS)
    expect(await turnStarted([USER])).toBeNull()
  })

  it('counts its turns, and stops reciting a plan left alone past the limit', async () => {
    savePlan(STEPS)
    for (let i = 0; i < PLAN_STALE_TURNS; i++) await turnStarted([USER])
    expect(await turnStarted([MARKER, SUMMARY])).toBeNull()
    expect(currentPlan()?.turnsSince).toHaveLength(PLAN_STALE_TURNS + 1)
  })
})
