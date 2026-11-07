/**
 * A job's plan (src/lib/work/plan.ts). Pins: the validator's rules (1–12
 * steps, 140 characters, known statuses, one in progress) and its errors; the
 * lenient display reader; the progress counts and badge; and the one writer:
 * it writes the `plan` column alone, fenced on the workspace and live rows,
 * and never `progress`.
 */
import { describe, it, expect } from 'vitest'
import {
  PLAN_MAX_STEPS,
  PLAN_STEP_MAX_CHARS,
  planBadge,
  planHasOpenSteps,
  planProgress,
  planReading,
  planStepLabel,
  planStepsFrom,
  setWorkPlan,
  validatePlanSteps,
} from '../plan'
import { makeFakeSupabase } from './fake-supabase'

const step = (text: string, status = 'pending') => ({ text, status })

describe('validatePlanSteps', () => {
  it('accepts a plan and tidies each step onto one line', () => {
    const r = validatePlanSteps([step('  Read the  thread\n', 'done'), step('Draft the reply', 'in_progress'), step('Send for review')])
    expect(r).toEqual({
      ok: true,
      steps: [
        { text: 'Read the thread', status: 'done' },
        { text: 'Draft the reply', status: 'in_progress' },
        { text: 'Send for review', status: 'pending' },
      ],
    })
  })

  it('refuses no list, an empty list and more than 12 steps', () => {
    expect(validatePlanSteps('nope').ok).toBe(false)
    expect(validatePlanSteps([]).ok).toBe(false)
    const many = Array.from({ length: PLAN_MAX_STEPS + 1 }, (_, i) => step(`Step ${i}`))
    const r = validatePlanSteps(many)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('at most 12 steps')
    expect(validatePlanSteps(many.slice(0, PLAN_MAX_STEPS)).ok).toBe(true)
  })

  it('refuses a blank, over-long or unknown-status step, naming the step', () => {
    const blank = validatePlanSteps([step('ok'), step('   ')])
    expect(blank.ok === false && blank.error).toBe('Step 2 needs its text.')
    expect(validatePlanSteps([step('x'.repeat(PLAN_STEP_MAX_CHARS))]).ok).toBe(true)
    const long = validatePlanSteps([step('x'.repeat(PLAN_STEP_MAX_CHARS + 1))])
    expect(long.ok === false && long.error).toContain('keep each step to 140')
    const bad = validatePlanSteps([step('a', 'blocked')])
    expect(bad.ok === false && bad.error).toContain("Step 1's status must be one of pending, in_progress, done, skipped")
    expect(validatePlanSteps([null]).ok).toBe(false)
  })

  it('allows at most one step in progress', () => {
    const r = validatePlanSteps([step('a', 'in_progress'), step('b', 'in_progress')])
    expect(r.ok === false && r.error).toContain('Only one step can be in_progress')
    expect(validatePlanSteps([step('a', 'done'), step('b', 'skipped')]).ok).toBe(true)
  })
})

describe('planStepsFrom', () => {
  it('reads the stored object, a tool output and a bare input list', () => {
    expect(planStepsFrom({ steps: [step('a', 'done')], updated_at: 'x' })).toEqual([{ text: 'a', status: 'done' }])
    expect(planStepsFrom([step('b')])).toEqual([{ text: 'b', status: 'pending' }])
  })

  it('drops malformed steps, clips long ones and is null when nothing reads', () => {
    const steps = planStepsFrom([step('ok'), { text: 3, status: 'done' }, step('a', 'weird'), step('y'.repeat(200))])
    expect(steps).toHaveLength(2)
    expect(steps![1].text).toHaveLength(PLAN_STEP_MAX_CHARS)
    expect(steps![1].text.endsWith('…')).toBe(true)
    expect(planStepsFrom(null)).toBeNull()
    expect(planStepsFrom({ steps: [] })).toBeNull()
    expect(planStepsFrom({ nope: true })).toBeNull()
  })
})

describe('progress', () => {
  const steps = [
    { text: 'a', status: 'done' as const },
    { text: 'b', status: 'skipped' as const },
    { text: 'c', status: 'in_progress' as const },
    { text: 'd', status: 'pending' as const },
  ]

  it('counts done and skipped as finished and names the step in progress', () => {
    expect(planProgress(steps)).toEqual({ finished: 2, total: 4, current: 'c' })
    expect(planBadge(steps)).toBe('2/4')
    expect(planHasOpenSteps(steps)).toBe(true)
    expect(planHasOpenSteps(steps.slice(0, 2))).toBe(false)
  })

  it('says which step an action’s job is on: the one in progress, else the next, never past the end', () => {
    expect(planStepLabel(steps)).toBe('step 3 of 4')
    expect(planStepLabel(steps.map((s) => (s.status === 'in_progress' ? { ...s, status: 'pending' as const } : s)))).toBe('step 3 of 4')
    expect(planStepLabel(steps.map((s) => ({ ...s, status: 'done' as const })))).toBe('step 4 of 4')
  })

  it('reads for the main agent: counts, the step now, and the steps when asked', () => {
    expect(planReading({ steps }, false)).toEqual({ done: 2, total: 4, now: 'c' })
    expect(planReading({ steps }, true)?.steps).toHaveLength(4)
    expect(planReading(null, true)).toBeNull()
  })
})

describe('setWorkPlan', () => {
  const NOW = new Date('2026-10-14T12:00:00.000Z')

  it('writes the plan column alone, on a live row of the workspace', async () => {
    const db = makeFakeSupabase()
    db.seed('tracked_job', [{ id: 'job-1', workspace_id: 'ws-1', status: 'running', progress: { steps: [{ at: 't', text: 'Started' }] } }])
    const payloads: Record<string, unknown>[] = []
    const client = {
      from: (table: string) => {
        const q = db.from(table) as { update: (p: Record<string, unknown>) => unknown }
        const update = q.update
        q.update = (p) => {
          payloads.push(p)
          return update(p)
        }
        return q
      },
    }
    const r = await setWorkPlan(client as never, { workspaceId: 'ws-1', workItemId: 'job-1', steps: [step('Read', 'in_progress')], now: NOW })
    expect(r).toEqual({ ok: true, plan: { steps: [{ text: 'Read', status: 'in_progress' }], updated_at: NOW.toISOString() } })
    const row = db.rows('tracked_job')[0]
    expect(row.plan).toEqual({ steps: [{ text: 'Read', status: 'in_progress' }], updated_at: NOW.toISOString() })
    // progress is untouched: the recorder's step log stands.
    expect(row.progress).toEqual({ steps: [{ at: 't', text: 'Started' }] })
    expect(payloads.map((p) => Object.keys(p))).toEqual([['plan']])
  })

  it('refuses an invalid plan without writing', async () => {
    const db = makeFakeSupabase()
    db.seed('tracked_job', [{ id: 'job-1', workspace_id: 'ws-1', status: 'running' }])
    const r = await setWorkPlan(db as never, { workspaceId: 'ws-1', workItemId: 'job-1', steps: [] })
    expect(r).toMatchObject({ ok: false, code: 'INPUT_INVALID' })
    expect(db.calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('leaves a settled row, or another workspace’s, as it was', async () => {
    const db = makeFakeSupabase()
    db.seed('tracked_job', [
      { id: 'job-1', workspace_id: 'ws-1', status: 'done', plan: null },
      { id: 'job-2', workspace_id: 'ws-2', status: 'running', plan: null },
    ])
    expect(await setWorkPlan(db as never, { workspaceId: 'ws-1', workItemId: 'job-1', steps: [step('a')] })).toMatchObject({
      ok: false,
      code: 'NOT_LIVE',
    })
    expect(await setWorkPlan(db as never, { workspaceId: 'ws-1', workItemId: 'job-2', steps: [step('a')] })).toMatchObject({
      ok: false,
      code: 'NOT_LIVE',
    })
    expect(db.rows('tracked_job').map((r) => r.plan)).toEqual([null, null])
  })
})
