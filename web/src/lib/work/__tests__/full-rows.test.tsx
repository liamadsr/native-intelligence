// @vitest-environment jsdom
/**
 * The shared whole-row cache (src/lib/work/full-rows.ts). Pinned:
 *   • a read is keyed on the row's id, status and last beat: the same review
 *     is read once, and a review back after a revision (a new beat) is read
 *     again, not served the last cycle's row;
 *   • one entry per row: a row's new key drops its old one;
 *   • pruneFullRows drops a held review or question that no longer waits (or
 *     has left the open rows), and nothing while the open rows are unknown;
 *   • useFullReads reads whole rows too, once per key, with the run behind
 *     each (its parked question), sharing the reads the other hooks make;
 *   • at most FULL_ROWS_MAX rows held, the least recently shown going first;
 *   • a failed read is remembered for FULL_ROW_RETRY_MS: useFullRows doesn't
 *     ask again on every change of the rows on show, and asks once it's due.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LightWorkRow } from '@/lib/work/queries'
import type { WorkItem } from '@/lib/work/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  FULL_ROWS_MAX,
  FULL_ROW_RETRY_MS,
  __resetFullRowsForTests,
  fullRowFailed,
  fullRowKey,
  hasLandedFullRow,
  landedFullRow,
  loadFullRow,
  pruneFullRows,
  useFullReads,
  useFullRows,
  type FullRead,
} from '../full-rows'

function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    origin: 'loop',
    ai_team_member_id: 'writer',
    parent_id: null,
    root_id: null,
    flow_run_id: null,
    source: {},
    opened_at: null,
    needs: null,
    created_at: '2026-10-03T08:00:00.000Z',
    teammate: null,
    last_beat_at: '2026-10-03T09:00:00.000Z',
    ...over,
  }
}
const whole = (id: string, title: string) => ({ id, title, status: 'needs_review' }) as unknown as WorkItem

let fetchMock: ReturnType<typeof vi.fn>
/** Each read answers with the next title for its id; `fail` ids answer 500. */
function answer(titles: Record<string, string[]>, fail: Set<string> = new Set()) {
  fetchMock = vi.fn(async (url: string) => {
    const id = decodeURIComponent(String(url).split('/').pop()!)
    if (fail.has(id)) return new Response('{}', { status: 500 })
    const title = titles[id]?.shift() ?? `Item ${id}`
    return new Response(JSON.stringify({ item: whole(id, title) }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  __resetFullRowsForTests()
  answer({})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('loadFullRow', () => {
  it('reads a review once; the same review back after a revision (a new beat) is read again', async () => {
    answer({ r1: ['First draft', 'Revised draft'] })
    const first = light('r1')
    expect((await loadFullRow(first))?.title).toBe('First draft')
    expect((await loadFullRow({ ...first }))?.title).toBe('First draft')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Revision: it ran again (running, new beats), then waits again with a later beat.
    const again = light('r1', { last_beat_at: '2026-10-03T10:30:00.000Z' })
    expect(fullRowKey(again)).not.toBe(fullRowKey(first))
    expect((await loadFullRow(again))?.title).toBe('Revised draft')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // One entry per row: the last cycle's is gone.
    expect(hasLandedFullRow(fullRowKey(first))).toBe(false)
    expect(landedFullRow(fullRowKey(again))?.title).toBe('Revised draft')
  })

  it('a failed read is remembered for a minute, then asked again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'))
    answer({}, new Set(['r1']))
    const row = light('r1')
    expect(await loadFullRow(row)).toBeNull()
    expect(fullRowFailed(row)).toBe(true)
    expect(await loadFullRow(row)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + FULL_ROW_RETRY_MS)
    expect(fullRowFailed(row)).toBe(false)
    answer({ r1: ['Back'] })
    expect((await loadFullRow(row))?.title).toBe('Back')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('pruneFullRows', () => {
  it('drops a held review that left review or the open rows; keeps one still waiting; nothing while unknown', async () => {
    const r1 = light('r1')
    const r2 = light('r2')
    const r3 = light('r3')
    await Promise.all([loadFullRow(r1), loadFullRow(r2), loadFullRow(r3)])

    pruneFullRows(null)
    expect([r1, r2, r3].every((r) => hasLandedFullRow(fullRowKey(r)))).toBe(true)

    // r1 still waiting; r2 sent back for a revision (running); r3 settled (gone from the open rows).
    pruneFullRows([r1, { ...r2, status: 'running' }])
    expect(hasLandedFullRow(fullRowKey(r1))).toBe(true)
    expect(hasLandedFullRow(fullRowKey(r2))).toBe(false)
    expect(hasLandedFullRow(fullRowKey(r3))).toBe(false)
  })

  it('drops a held question once it is answered (running), keeps one still waiting', async () => {
    const q1 = light('q1', { status: 'needs_input' })
    const q2 = light('q2', { status: 'needs_input' })
    await Promise.all([loadFullRow(q1), loadFullRow(q2)])
    pruneFullRows([q1, { ...q2, status: 'running' }])
    expect(hasLandedFullRow(fullRowKey(q1))).toBe(true)
    expect(hasLandedFullRow(fullRowKey(q2))).toBe(false)
  })
})

describe('the cap', () => {
  it(`holds at most ${FULL_ROWS_MAX} rows, the least recently shown going first`, async () => {
    const rows = Array.from({ length: FULL_ROWS_MAX }, (_, i) => light(`r${i}`))
    await Promise.all(rows.map((r) => loadFullRow(r)))
    // r0 shown again: now the most recent.
    await loadFullRow(rows[0])
    await loadFullRow(light('extra'))
    expect(hasLandedFullRow(fullRowKey(rows[0]))).toBe(true)
    expect(hasLandedFullRow(fullRowKey(rows[1]))).toBe(false)
    expect(hasLandedFullRow(fullRowKey(light('extra')))).toBe(true)
  })
})

describe('useFullRows', () => {
  let container: HTMLDivElement
  let root: Root
  let seen: ReadonlyMap<string, WorkItem> = new Map()
  function Probe({ rows }: { rows: LightWorkRow[] }) {
    seen = useFullRows(rows)
    return null
  }
  beforeEach(() => {
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(() => act(() => root.unmount()))
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  }

  it('never re-reads a failed row on every change of the rows on show', async () => {
    answer({}, new Set(['bad']))
    await act(async () => root.render(h(Probe, { rows: [light('bad')] })))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(seen.has('bad')).toBe(false)

    // The rows on show change (another review arrives): only the new one is read.
    await act(async () => root.render(h(Probe, { rows: [light('bad'), light('good')] })))
    await settle()
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/account/activity/bad', '/api/account/activity/good'])
    expect([...seen.keys()]).toEqual(['good'])
  })

  it('reads a light row that carries its title (LIGHT_COLUMNS reads one); a whole row is itself', async () => {
    answer({ titled: ['Weekly Groom'] })
    const titled = { ...light('titled'), title: 'Weekly Groom', current_step: null }
    const pushed = { ...light('pushed'), title: 'Pushed', deliverables: [], result_summary: null } as unknown as LightWorkRow
    await act(async () => root.render(h(Probe, { rows: [titled, pushed] })))
    await settle()
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/account/activity/titled'])
    expect(seen.get('titled')?.title).toBe('Weekly Groom')
    expect(seen.get('pushed')).toBe(pushed)
  })
})

describe('useFullReads', () => {
  let container: HTMLDivElement
  let root: Root
  let seen: ReadonlyMap<string, FullRead> = new Map()
  function Probe({ rows }: { rows: Array<LightWorkRow | WorkItem> }) {
    seen = useFullReads(rows)
    return null
  }
  beforeEach(() => {
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(() => act(() => root.unmount()))
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  }

  it('reads a whole row too (a pushed row carries no run), once, keeping its run', async () => {
    const pending = { questions: [{ question: 'Which Acme contact?' }] }
    fetchMock = vi.fn(async (url: string) => {
      const id = decodeURIComponent(String(url).split('/').pop()!)
      const run = id === 'q1' ? { id: 'run-1', status: 'needs_input', pending_input: pending } : null
      return new Response(JSON.stringify({ item: { ...whole(id, `Item ${id}`), status: 'needs_input' }, run }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const pushed = { ...light('q1', { status: 'needs_input' }), title: 'Pushed' } as unknown as WorkItem
    await act(async () => root.render(h(Probe, { rows: [pushed, light('q2', { status: 'needs_input' })] })))
    await settle()
    expect(seen.get('q1')).toEqual({ item: expect.objectContaining({ id: 'q1' }), run: { id: 'run-1', status: 'needs_input', pending_input: pending } })
    expect(seen.get('q2')?.run).toBeNull()

    // Shown again: nothing read again (loadFullRow shares the same reads).
    await act(async () => root.render(h(Probe, { rows: [pushed] })))
    await settle()
    await loadFullRow(light('q2', { status: 'needs_input' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
