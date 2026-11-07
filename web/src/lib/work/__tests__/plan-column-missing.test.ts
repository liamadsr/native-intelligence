/**
 * A database without migration 331 (no `tracked_job.plan`): the light reads
 * and the main agent's own-row read name `plan`, and PostgREST refuses such a
 * select (42703). Each read is made again without the column, the process
 * remembers it is missing (later reads leave it out at once), the rows come
 * back with no plan, and setWorkPlan answers NOT_AVAILABLE instead of failing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { MISSING, withoutColumn } from './plan-column-fake'
import {
  isMissingPlanColumnError,
  readWithPlanFallback,
  resetPlanColumnMemo,
  setWorkPlan,
  withoutPlanColumn,
} from '../plan'
import { LIGHT_WORK_ITEM_SELECT, listOpenWorkInWorkspaces, listRecentDoneWork } from '../queries'

const NOW = new Date('2026-10-14T12:00:00.000Z')

beforeEach(() => resetPlanColumnMemo())

describe('the plan column helpers', () => {
  it('recognises the missing-column error, and only for plan', () => {
    expect(isMissingPlanColumnError(MISSING)).toBe(true)
    expect(isMissingPlanColumnError({ code: '42703', message: 'column tracked_job.opened_at does not exist' })).toBe(false)
    expect(isMissingPlanColumnError({ code: 'PGRST204', message: "Could not find the 'plan' column of 'tracked_job' in the schema cache" })).toBe(true)
    expect(isMissingPlanColumnError(null)).toBe(false)
  })

  it('takes plan out of a select, wherever it sits', () => {
    expect(withoutPlanColumn('id, source, plan, created_at')).toBe('id, source, created_at')
    expect(withoutPlanColumn('id, area, plan')).toBe('id, area')
    expect(withoutPlanColumn('plan, id')).toBe('id')
    expect(withoutPlanColumn('id, planner')).toBe('id, planner')
    expect(withoutPlanColumn(LIGHT_WORK_ITEM_SELECT)).not.toMatch(/\bplan\b/)
    // The Agents widget's label and step stay in the fallback read.
    expect(withoutPlanColumn(LIGHT_WORK_ITEM_SELECT)).toMatch(/\btitle, current_step\b/)
  })

  it('retries once without plan, then remembers for the process', async () => {
    const seen: string[] = []
    const run = async (columns: string) => {
      seen.push(columns)
      return /\bplan\b/.test(columns) ? { data: null, error: MISSING } : { data: [1], error: null }
    }
    expect(await readWithPlanFallback('id, plan', run)).toEqual({ data: [1], error: null })
    expect(await readWithPlanFallback('id, plan', run)).toEqual({ data: [1], error: null })
    expect(seen).toEqual(['id, plan', 'id', 'id'])
  })

  it('another error is not retried', async () => {
    const err = { code: '57014', message: 'timeout' }
    let calls = 0
    const out = await readWithPlanFallback('id, plan', async () => {
      calls++
      return { data: null, error: err }
    })
    expect(out.error).toBe(err)
    expect(calls).toBe(1)
  })
})

describe('without migration 331', () => {
  function seeded() {
    const db = makeFakeSupabase()
    db.seed('tracked_job', [
      { id: 'job-1', workspace_id: 'ws-1', member_id: 'm1', kind: 'work_run', status: 'running', created_at: '2026-10-14T11:00:00.000Z', source: {} },
      {
        id: 'job-2',
        workspace_id: 'ws-1',
        member_id: 'm1',
        kind: 'work_run',
        status: 'done',
        ai_team_member_id: 'tm-1',
        opened_at: null,
        deliverables: [{ type: 'document', id: 'doc-1', label: 'Doc' }],
        created_at: '2026-10-14T10:00:00.000Z',
        finished_at: '2026-10-14T10:30:00.000Z',
        source: {},
      },
    ])
    return db
  }

  it('the light read still returns its rows, with no plan', async () => {
    const { client, selects } = withoutColumn(seeded())
    const res = await listOpenWorkInWorkspaces(client as never, { workspaceIds: ['ws-1'] })
    expect(res.error).toBeNull()
    expect(res.items.map((r) => r.id)).toEqual(['job-1'])
    expect(selects.map((s) => /\bplan\b/.test(s))).toEqual([true, false])
    // Remembered: the next read leaves it out at once.
    await listOpenWorkInWorkspaces(client as never, { workspaceIds: ['ws-1'] })
    expect(selects.slice(2).map((s) => /\bplan\b/.test(s))).toEqual([false])
  })

  it('the done read still returns its rows', async () => {
    const { client } = withoutColumn(seeded())
    const rows = await listRecentDoneWork(client as never, { scope: [{ memberId: 'm1', workspaceId: 'ws-1' }], now: NOW })
    expect(rows.map((r) => r.id)).toEqual(['job-2'])
  })

  it('setWorkPlan answers NOT_AVAILABLE, and keeps answering it without another write', async () => {
    const db = seeded()
    const { client } = withoutColumn(db)
    const steps = [{ text: 'Read', status: 'in_progress' }]
    const first = await setWorkPlan(client as never, { workspaceId: 'ws-1', workItemId: 'job-1', steps })
    expect(first).toMatchObject({ ok: false, code: 'NOT_AVAILABLE' })
    const second = await setWorkPlan(db as never, { workspaceId: 'ws-1', workItemId: 'job-1', steps })
    expect(second).toMatchObject({ ok: false, code: 'NOT_AVAILABLE' })
    expect(db.rows('tracked_job')[0].plan).toBeUndefined()
  })
})
