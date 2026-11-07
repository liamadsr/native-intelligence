/**
 * One teammate's work for its bot (bots-v4.md Phase 1a): only its rows, as
 * the caller's member in its workspace, its open rows however old and its
 * settled rows inside the window, newest first, de-duplicated, its handoff
 * trees whole, and its last finished row. And who the AI limit stopped.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'
import {
  WORK_ITEM_SELECT,
  listTeammateWork,
  listAiLimitedTeammates,
  readLastFinished,
  AI_LIMIT_LATER_READ,
} from '../queries'
import { laterSettled } from '../presentation'
import type { WorkItem } from '../types'

const DAY = 24 * 60 * 60 * 1000

function row(over: Record<string, unknown>) {
  return {
    id: String(over.id),
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'flow_run',
    title: 't',
    status: 'done',
    created_at: new Date(Date.now() - DAY).toISOString(),
    ...over,
  }
}

describe('WORK_ITEM_SELECT', () => {
  it('embeds who ran each row with the bot it wears (migration 294)', () => {
    const embed = WORK_ITEM_SELECT.match(/teammate:ai_team_member_id\(([^)]*)\)/)?.[1].split(/,\s*/)
    expect(embed).toEqual(['id', 'name', 'is_system', 'system_key', 'role', 'bot_character'])
  })
})

describe('listTeammateWork (a bot’s own work)', () => {
  const HOUR = 60 * 60 * 1000
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const since = () => new Date(Date.now() - 14 * DAY).toISOString()
  const scope = { teammateId: 'triage', workspaceId: 'w1', memberIds: ['m1'] }
  const mine = (over: Record<string, unknown>) => row({ ai_team_member_id: 'triage', ...over })

  it('reads only that teammate’s rows, as the caller’s member in its workspace: open rows however old, settled ones inside the window', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      mine({ id: 'old-review', status: 'needs_review', created_at: ago(30 * DAY) }),
      mine({ id: 'old-done', status: 'done', created_at: ago(30 * DAY), finished_at: ago(30 * DAY) }),
      mine({ id: 'recent-done', status: 'done', created_at: ago(2 * DAY), finished_at: ago(2 * DAY) }),
      mine({ id: 'live', status: 'running', created_at: ago(DAY) }),
      row({ id: 'writer', status: 'running', ai_team_member_id: 'writer', created_at: ago(HOUR) }),
      row({ id: 'no-teammate', status: 'running', created_at: ago(HOUR) }),
      mine({ id: 'other-member', status: 'running', member_id: 'm2', created_at: ago(HOUR) }),
      mine({ id: 'other-workspace', status: 'running', workspace_id: 'w2', created_at: ago(HOUR) }),
    ])
    const res = await listTeammateWork(fake as never, { ...scope, sinceIso: since() })
    expect(res.error).toBeNull()
    expect(res.items.map((i) => i.id)).toEqual(['live', 'recent-done', 'old-review'])
    // Every read names the caller's member and the teammate's workspace (the
    // member indexes, not every member's rows filtered by RLS after the scan).
    const reads = fake.calls.filter((c) => c.table === 'tracked_job')
    expect(reads.length).toBeGreaterThan(0)
    for (const c of reads) {
      expect(c.filters).toContainEqual(['member_id', ['m1']])
      expect(c.filters).toContainEqual(['workspace_id', 'w1'])
    }
    expect(new Set(fake.selects.filter((c) => c.table === 'tracked_job').map((c) => c.columns))).toEqual(new Set([WORK_ITEM_SELECT]))
  })

  it('reads each handoff tree it worked in whole, wherever it stands in it, and nothing else', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      // Triage's run handed work to Writer, who handed some to Researcher.
      mine({ id: 'tri-root', status: 'done', created_at: ago(6 * HOUR) }),
      row({ id: 'w-child', ai_team_member_id: 'writer', parent_id: 'tri-root', root_id: 'tri-root', created_at: ago(5 * HOUR) }),
      row({ id: 'r-grandchild', ai_team_member_id: 'researcher', parent_id: 'w-child', root_id: 'tri-root', created_at: ago(4 * HOUR) }),
      // Writer's run handed work to Triage and to Researcher.
      row({ id: 'w-root', ai_team_member_id: 'writer', status: 'waiting_on_child', created_at: ago(3 * HOUR) }),
      mine({ id: 'tri-child', status: 'running', parent_id: 'w-root', root_id: 'w-root', created_at: ago(2 * HOUR) }),
      row({ id: 'r-sibling', ai_team_member_id: 'researcher', status: 'needs_review', parent_id: 'w-root', root_id: 'w-root', created_at: ago(HOUR) }),
      // A tree Triage isn't in, and another member's row in Triage's tree.
      row({ id: 'w-other', ai_team_member_id: 'writer', created_at: ago(2 * HOUR) }),
      row({ id: 'r-other', ai_team_member_id: 'researcher', root_id: 'w-other', parent_id: 'w-other', created_at: ago(HOUR) }),
      row({ id: 'theirs', ai_team_member_id: 'researcher', member_id: 'm2', root_id: 'tri-root', parent_id: 'tri-root', created_at: ago(HOUR) }),
    ])
    const res = await listTeammateWork(fake as never, { ...scope, sinceIso: since() })
    expect(res.error).toBeNull()
    expect(res.items.map((i) => i.id)).toEqual(['r-sibling', 'tri-child', 'w-root', 'r-grandchild', 'w-child', 'tri-root'])
  })

  it('names its last finished row: the one that settled last, however long ago', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      // Started first, finished last.
      mine({ id: 'long', status: 'done', created_at: ago(3 * HOUR), finished_at: ago(HOUR) }),
      mine({ id: 'short', status: 'failed', created_at: ago(2 * HOUR), finished_at: ago(2 * HOUR) }),
      mine({ id: 'busy', status: 'running', created_at: ago(30 * 60 * 1000) }),
      row({ id: 'writer-later', status: 'done', ai_team_member_id: 'writer', created_at: ago(10 * 60 * 1000), finished_at: ago(5 * 60 * 1000) }),
    ])
    const res = await listTeammateWork(fake as never, { ...scope, sinceIso: since() })
    expect(res.lastFinished?.id).toBe('long')
    expect((await readLastFinished(fake as never, scope)).row?.id).toBe('long')

    // Nothing settled inside the window: the last it ever settled.
    const quiet = makeFakeSupabase()
    quiet.seed('tracked_job', [
      mine({ id: 'month-old', status: 'done', created_at: ago(30 * DAY), finished_at: ago(30 * DAY) }),
      mine({ id: 'waiting', status: 'needs_input', created_at: ago(DAY) }),
    ])
    const old = await listTeammateWork(quiet as never, { ...scope, sinceIso: since() })
    expect(old.items.map((i) => i.id)).toEqual(['waiting'])
    expect(old.lastFinished?.id).toBe('month-old')

    // Never finished anything; no member to read as.
    const fresh = makeFakeSupabase()
    fresh.seed('tracked_job', [mine({ id: 'first', status: 'running', created_at: ago(HOUR) })])
    expect((await listTeammateWork(fresh as never, { ...scope, sinceIso: since() })).lastFinished).toBeNull()
    expect(await readLastFinished(fresh as never, { ...scope, memberIds: [] })).toEqual({ row: null, error: null })
    expect(await listTeammateWork(fresh as never, { ...scope, memberIds: [], sinceIso: since() })).toEqual({ items: [], lastFinished: null, error: null })
  })

  it('names a run that started before ten others and settled after all of them, as the live bubble would (review of #616)', async () => {
    const fake = makeFakeSupabase()
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 3, h, m)).toISOString()
    const rows = [
      // Parked on a question all day: started at 00:00, answered, finished at 23:00.
      mine({ id: 'long', status: 'done', created_at: at(0), finished_at: at(23) }),
      // Ten quick runs after it, each done within the hour.
      ...Array.from({ length: 10 }, (_, i) => mine({ id: `quick-${i + 1}`, status: 'done', created_at: at(i + 1), finished_at: at(i + 1, 30) })),
    ]
    fake.seed('tracked_job', rows)
    // What the bubble holds live as that run settles (useBotWork: laterSettled over the pushes).
    const live = (rows as unknown as WorkItem[]).reduce<WorkItem | null>(laterSettled, null)
    expect(live?.id).toBe('long')
    expect((await readLastFinished(fake as never, scope)).row?.id).toBe('long')
    expect((await listTeammateWork(fake as never, { ...scope, sinceIso: since() })).lastFinished?.id).toBe('long')
  })

  it('names a settled row with no finish time when it’s the newest, and never an older one', async () => {
    const newest = makeFakeSupabase()
    newest.seed('tracked_job', [
      mine({ id: 'finished', status: 'done', created_at: ago(5 * HOUR), finished_at: ago(4 * HOUR) }),
      // Skipped as it started, with no finish time: it settled when it started.
      mine({ id: 'skipped-now', status: 'skipped', created_at: ago(HOUR), finished_at: null }),
    ])
    expect((await readLastFinished(newest as never, scope)).row?.id).toBe('skipped-now')

    const older = makeFakeSupabase()
    older.seed('tracked_job', [
      mine({ id: 'skipped-then', status: 'skipped', created_at: ago(6 * HOUR), finished_at: null }),
      mine({ id: 'finished', status: 'done', created_at: ago(5 * HOUR), finished_at: ago(4 * HOUR) }),
    ])
    expect((await readLastFinished(older as never, scope)).row?.id).toBe('finished')
  })

  it('reads its handoff trees whole however many rows they hold: page by page, never cut off at a cap (review of #616)', async () => {
    const fake = makeFakeSupabase()
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 3) + n * 60_000).toISOString()
    const rows: Record<string, unknown>[] = []
    // 150 runs of its in the window, each handing work to three teammates (450 handoffs).
    for (let i = 0; i < 150; i++) {
      rows.push(mine({ id: `t-${i}`, status: 'done', created_at: minute(i * 10), finished_at: minute(i * 10 + 5) }))
      for (const who of ['tm-res', 'tm-corr', 'tm-design']) {
        rows.push(row({ id: `t-${i}-${who}`, ai_team_member_id: who, parent_id: `t-${i}`, root_id: `t-${i}`, created_at: minute(i * 10 + 1) }))
      }
    }
    // And one run whose tree alone holds more than a page (1,200 handoffs).
    rows.push(mine({ id: 'big', status: 'done', created_at: minute(2000), finished_at: minute(2001) }))
    for (let j = 0; j < 1200; j++) {
      rows.push(row({ id: `big-${j}`, ai_team_member_id: 'tm-res', parent_id: 'big', root_id: 'big', created_at: minute(2002 + j) }))
    }
    fake.seed('tracked_job', rows)
    const res = await listTeammateWork(fake as never, { ...scope, sinceIso: minute(-1) })
    expect(res.error).toBeNull()
    const handoffs = res.items.filter((r) => r.ai_team_member_id !== 'triage')
    expect(handoffs).toHaveLength(450 + 1200)
    expect(new Set(handoffs.map((r) => r.id)).size).toBe(1650)
    // The big tree's chunk took two pages; the other trees' fitted one.
    const treeReads = fake.calls.filter((c) => c.table === 'tracked_job' && c.filters.some(([col]) => col === 'root_id'))
    expect(treeReads).toHaveLength(2)
  })

  /** The fake, failing every `tracked_job` read that filters on `column`. */
  function failingOn(fake: FakeSupabase, column: string) {
    return {
      ...fake,
      from: (table: string) => {
        const q = fake.from(table) as Record<string, (...args: unknown[]) => unknown>
        if (table !== 'tracked_job') return q
        let fails = false
        const realIn = q.in
        q.in = (col: unknown, values: unknown) => {
          if (col === column) fails = true
          realIn(col, values)
          return q
        }
        const realThen = q.then
        q.then = (resolve: unknown, reject: unknown) =>
          fails
            ? Promise.resolve({ data: null, error: { message: `${column} read failed` } }).then(
                resolve as (v: unknown) => unknown,
                reject as (e: unknown) => unknown,
              )
            : realThen(resolve, reject)
        return q
      },
    }
  }

  it('reports a failed read, its open rows’, its last finished’s or a tree’s, instead of a short answer', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      mine({ id: 'tri-root', status: 'done', created_at: ago(2 * HOUR), finished_at: ago(2 * HOUR) }),
      row({ id: 'w-child', ai_team_member_id: 'writer', root_id: 'tri-root', parent_id: 'tri-root', created_at: ago(HOUR) }),
    ])
    for (const [column, message] of [['status', 'status read failed'], ['root_id', 'root_id read failed']] as const) {
      const res = await listTeammateWork(failingOn(fake, column) as never, { ...scope, sinceIso: since() })
      expect(res).toEqual({ items: [], lastFinished: null, error: message })
    }
    expect(await readLastFinished(failingOn(fake, 'status') as never, scope)).toEqual({ row: null, error: 'status read failed' })
  })
})

// bots-v4 Phase 4b (review of #650): who the AI limit stopped, in two reads
// whatever the number of teammates.
describe('listAiLimitedTeammates', () => {
  const HOUR = 60 * 60 * 1000
  const NOW = new Date()
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
  const LIMIT = 'AI usage limit exceeded (plan limit) — skill run skipped'
  const scope = [{ memberId: 'm1', workspaceId: 'w1' }]
  const failed = (id: string, teammate: string, at: string) =>
    row({ id, status: 'failed', ai_team_member_id: teammate, error_message: LIMIT, created_at: at, finished_at: at })
  const laterReads = (fake: FakeSupabase) =>
    fake.calls.filter((c) => c.table === 'tracked_job' && c.filters.some(([col, v]) => col === 'ai_team_member_id' && Array.isArray(v)))

  it('reads the later runs of every stopped teammate in one request, and keeps those with none since their failure', async () => {
    const fake = makeFakeSupabase({ project: true })
    const teammates = ['a', 'b', 'c', 'd', 'e']
    fake.seed('tracked_job', [
      ...teammates.map((t, i) => failed(`f-${t}`, t, ago((i + 2) * HOUR))),
      // b and d ran since (d's run still going): awake.
      row({ id: 'b-later', ai_team_member_id: 'b', status: 'done', created_at: ago(HOUR), finished_at: ago(HOUR) }),
      row({ id: 'd-later', ai_team_member_id: 'd', status: 'running', created_at: ago(HOUR) }),
      // A run of e's from before its failure wakes nothing.
      row({ id: 'e-before', ai_team_member_id: 'e', status: 'done', created_at: ago(9 * HOUR), finished_at: ago(9 * HOUR) }),
    ])
    const stopped = await listAiLimitedTeammates(fake as never, { scope, now: NOW })
    expect(stopped.map((t) => t.teammate_id).sort()).toEqual(['a', 'c', 'e'])
    expect(laterReads(fake)).toHaveLength(1)
  })

  it('nobody stopped: no later-run read at all', async () => {
    const fake = makeFakeSupabase({ project: true })
    fake.seed('tracked_job', [row({ id: 'ok', ai_team_member_id: 'a', status: 'done', created_at: ago(HOUR) })])
    expect(await listAiLimitedTeammates(fake as never, { scope, now: NOW })).toEqual([])
    expect(laterReads(fake)).toHaveLength(0)
  })

  it('the limit’s own later failures aren’t a run that went through', async () => {
    const fake = makeFakeSupabase({ project: true })
    fake.seed('tracked_job', [failed('x-older', 'x', ago(5 * HOUR)), failed('x-newer', 'x', ago(3 * HOUR)), failed('y', 'y', ago(4 * HOUR))])
    const stopped = await listAiLimitedTeammates(fake as never, { scope, now: NOW })
    expect(stopped.map((t) => [t.teammate_id, t.at]).sort()).toEqual([
      ['x', ago(3 * HOUR)],
      ['y', ago(4 * HOUR)],
    ])
  })

  it('a full later-run read decides nobody it holds no run for: counted awake', async () => {
    const fake = makeFakeSupabase({ project: true })
    fake.seed('tracked_job', [
      failed('x', 'x', ago(5 * HOUR)),
      failed('y', 'y', ago(6 * HOUR)),
      ...Array.from({ length: AI_LIMIT_LATER_READ }, (_, i) =>
        row({ id: `y-ok-${i}`, ai_team_member_id: 'y', status: 'done', created_at: ago(4 * HOUR - i * 1000), finished_at: ago(4 * HOUR - i * 1000) }),
      ),
    ])
    expect(await listAiLimitedTeammates(fake as never, { scope, now: NOW })).toEqual([])
    // One short of full: x is told apart, and stays stopped.
    const short = makeFakeSupabase({ project: true })
    short.seed('tracked_job', [
      failed('x', 'x', ago(5 * HOUR)),
      failed('y', 'y', ago(6 * HOUR)),
      ...Array.from({ length: AI_LIMIT_LATER_READ - 1 }, (_, i) =>
        row({ id: `y-ok-${i}`, ai_team_member_id: 'y', status: 'done', created_at: ago(4 * HOUR - i * 1000), finished_at: ago(4 * HOUR - i * 1000) }),
      ),
    ])
    expect((await listAiLimitedTeammates(short as never, { scope, now: NOW })).map((t) => t.teammate_id)).toEqual(['x'])
  })
})
