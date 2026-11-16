/**
 * The watch pass for pages read in the person's browser (phase 2): the same
 * pass as tick.test.ts covers, with the read made through a session on the
 * owner's browser (a stand-in here), its own clock, and skips that count
 * for nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import type { WatchMattersPick } from '@/lib/ai/decisions/tasks/watch-matters'
import { memoryDb } from '@/test/memory-db'
import type { BrowserWatchRead, BrowserWatchSession } from '../read-browser'
import { PAGE_WATCH_BROWSER_CONCURRENCY, PAGE_WATCH_BROWSER_PASS_LIMIT, PAGE_WATCH_MAX_FAILURES, runPageWatchPass, type JudgeWatch, type PageWatchDeps } from '../tick'

const WS = '11111111-1111-4111-8111-111111111111'
const OWNER = '33333333-3333-4333-8333-333333333333'
const OTHER = '66666666-6666-4666-8666-666666666666'
const FLOW = '55555555-5555-4555-8555-555555555555'
const URL_ = 'https://app.example.com/orders'
const BASE = ['Orders', 'Open: 4', 'Fernhill Studio', 'Order 1041 | Packed', 'Order 1042 | Waiting', 'Order 1043 | Waiting']

type Row = Record<string, unknown>

function flowRow(over: Row = {}): Row {
  return {
    id: FLOW, workspace_id: WS, name: 'Orders watch', created_by: OWNER, ai_team_member_id: null,
    trigger_type: 'page_changed',
    trigger_config: { kind: 'page_changed', url: URL_, look_for: 'a new order', read_with: 'browser' },
    enabled: true, next_run_at: '2026-11-16T09:00:00.000Z', ...over,
  }
}

const accepted = (value: WatchMattersPick): DecisionResult<WatchMattersPick> => ({ status: 'accepted', value, inferenceId: 'inf-1', version: 'watch-matters-v1' })

function setup(flows: Row[] = [flowRow()]) {
  const tables: Record<string, Row[]> = {
    flow: flows, flow_page_watch: [], flow_page_change: [],
    member: [{ id: 'member-1', workspace_id: WS, user_id: OWNER }, { id: 'member-2', workspace_id: WS, user_id: OTHER }],
  }
  const db = memoryDb(tables)
  let answer: BrowserWatchRead = { ok: true, lines: BASE }
  const sessions: Array<{ ref: { userId: string; workspaceId: string }; reads: string[]; finished: number }> = []
  const browserSession = vi.fn((ref: { userId: string; workspaceId: string }): BrowserWatchSession => {
    const record = { ref, reads: [] as string[], finished: 0 }
    sessions.push(record)
    return { read: async (url) => { record.reads.push(url); return answer }, finish: async () => { record.finished += 1 } }
  })
  const fetchPage = vi.fn(async () => { throw new Error('a browser watch is never fetched') })
  const judge = vi.fn<JudgeWatch>(async () => accepted('tell'))
  const send = vi.fn(async (_event: { name: string; id: string; data: Record<string, unknown> }) => ({ ids: ['e1'] }))
  const notify = vi.fn(async () => {})
  const deps: PageWatchDeps = { fetchPage, browserSession, judge, send, notify, autonomyOff: async () => false, pausedWorkspaces: async () => [] }
  let clock = Date.parse('2026-11-16T09:05:00.000Z')
  const tick = async (advanceMinutes = 31) => {
    const out = await runPageWatchPass(db, new Date(clock), deps)
    clock += advanceMinutes * 60_000
    return out
  }
  return { tables, deps, tick, sessions, browserSession, fetchPage, judge, send, notify, setAnswer: (a: BrowserWatchRead) => (answer = a) }
}

let logs: string[] = []
beforeEach(() => {
  logs = []
  for (const level of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')))
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const line of logs) expect(line).not.toContain('app.example.com/orders')
})

describe('runPageWatchPass, read in the person\'s browser', () => {
  it('reads in the owner\'s browser, never by a fetch: a baseline first, due again in 30 minutes, the session ended', async () => {
    const t = setup()
    expect(await t.tick()).toMatchObject({ due: 1, baselines: 1 })
    expect(t.browserSession).toHaveBeenCalledWith({ userId: OWNER, workspaceId: WS })
    expect(t.sessions[0]).toMatchObject({ reads: [URL_], finished: 1 })
    expect(t.fetchPage).not.toHaveBeenCalled()
    expect(t.tables.flow[0].next_run_at).toBe('2026-11-16T09:35:00.000Z')
    expect(t.tables.flow_page_watch[0]).toMatchObject({ url: URL_, line_count: BASE.length, failures: 0 })
  })

  it('a new line that matters fires the loop exactly as a fetched page\'s does', async () => {
    const t = setup()
    await t.tick()
    t.setAnswer({ ok: true, lines: [...BASE, 'Order 1044 | New'] })
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.judge).toHaveBeenCalledWith({ lookFor: 'a new order', host: 'app.example.com', addedLines: ['Order 1044 | New'] }, { userId: OWNER, workspaceId: WS, messageId: FLOW })
    expect(t.tables.flow_page_change[0]).toMatchObject({ flow_id: FLOW, added_lines: ['Order 1044 | New'] })
    expect(t.send.mock.calls[0][0]).toMatchObject({ name: 'flow/page.changed', data: { flow_id: FLOW } })
  })

  it('a read that can\'t be made now is skipped: due again in 10 minutes, and nothing is counted, stored or told', async () => {
    const t = setup()
    await t.tick()
    const before = structuredClone(t.tables.flow_page_watch[0])
    for (const skipped of ['busy', 'in_use', 'taken_over', 'unavailable', 'busy'] as const) {
      t.setAnswer({ ok: false, skipped, reason: 'Not now.' })
      expect(await t.tick()).toMatchObject({ skipped: 1, failed: 0, stopped: 0 })
    }
    expect(t.tables.flow_page_watch[0]).toEqual(before)
    expect(t.tables.flow[0]).toMatchObject({ enabled: true })
    // The baseline at 09:05, then five skipped passes 31 minutes apart, the last at 11:40: due again 10 minutes after it.
    expect(t.tables.flow[0].next_run_at).toBe('2026-11-16T11:50:00.000Z')
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.judge).not.toHaveBeenCalled()
  })

  it(`what the page did is a failed read: a sign-out counts up, and at ${PAGE_WATCH_MAX_FAILURES} the loop stops and its owner is told why`, async () => {
    const t = setup()
    await t.tick()
    t.setAnswer({ ok: false, reason: 'The page sent your browser to a sign-in page. Sign in to the site in your agent\'s browser.' })
    for (let i = 1; i < PAGE_WATCH_MAX_FAILURES; i++) expect(await t.tick()).toMatchObject({ failed: 1 })
    expect(t.tables.flow_page_watch[0]).toMatchObject({ failures: PAGE_WATCH_MAX_FAILURES - 1, last_error: expect.stringContaining('sign-in page') })
    expect(await t.tick()).toMatchObject({ stopped: 1 })
    expect(t.tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ sentence: expect.stringContaining('sign-in page') }))
  })

  it('a page that shows almost nothing in the browser is a failed read with its own words', async () => {
    const t = setup()
    await t.tick()
    t.setAnswer({ ok: true, lines: ['Loading'] })
    expect(await t.tick()).toMatchObject({ failed: 1 })
    expect(t.tables.flow_page_watch[0].last_error).toBe('The page showed almost no text in your browser this time.')
  })

  it('one session per person\'s browser: their watches are read one after another, and another person\'s in a session of their own', async () => {
    const t = setup([
      flowRow({ id: 'a-1' }),
      flowRow({ id: 'a-2', trigger_config: { kind: 'page_changed', url: 'https://app.example.com/invoices', look_for: 'a new invoice', read_with: 'browser' } }),
      flowRow({ id: 'b-1', created_by: OTHER }),
    ])
    expect(await t.tick()).toMatchObject({ due: 3, baselines: 3 })
    expect(t.sessions).toHaveLength(2)
    const mine = t.sessions.find((s) => s.ref.userId === OWNER)!
    expect(mine.reads).toEqual([URL_, 'https://app.example.com/invoices'])
    expect(mine.finished).toBe(1)
    expect(t.sessions.find((s) => s.ref.userId === OTHER)).toMatchObject({ reads: [URL_], finished: 1 })
    expect(PAGE_WATCH_BROWSER_CONCURRENCY).toBe(2)
  })

  it(`takes up at most ${PAGE_WATCH_BROWSER_PASS_LIMIT} browser reads in a pass; the rest are not claimed and stay due`, async () => {
    const flows = Array.from({ length: PAGE_WATCH_BROWSER_PASS_LIMIT + 3 }, (_, i) =>
      flowRow({ id: `flow-${i}`, next_run_at: `2026-11-16T08:${String(10 + i).padStart(2, '0')}:00.000Z` }))
    const t = setup(flows)
    const out = await t.tick()
    expect(out).toMatchObject({ due: PAGE_WATCH_BROWSER_PASS_LIMIT, baselines: PAGE_WATCH_BROWSER_PASS_LIMIT })
    const left = t.tables.flow.filter((f) => String(f.next_run_at).startsWith('2026-11-16T08:'))
    // The longest due went first.
    expect(left.map((f) => f.id)).toEqual(['flow-6', 'flow-7', 'flow-8'])
  })

  it('browser watches never crowd plain ones out of a pass: each kind has a scan of its own', async () => {
    const browser = Array.from({ length: 10 }, (_, i) => flowRow({ id: `browser-${i}`, next_run_at: '2026-11-16T07:00:00.000Z' }))
    const plain = flowRow({ id: 'plain', next_run_at: '2026-11-16T09:04:00.000Z', trigger_config: { kind: 'page_changed', url: 'https://example.com/pricing', look_for: 'the price' } })
    const t = setup([...browser, plain])
    // Even with a pass limit of one, the plain watch (due last) is read.
    const out = await runPageWatchPass(memoryDb(t.tables), new Date('2026-11-16T09:05:00.000Z'), { ...t.deps, limit: 1 })
    expect(out.due).toBe(1 + PAGE_WATCH_BROWSER_PASS_LIMIT)
    expect(t.fetchPage).toHaveBeenCalledTimes(1)
  })

  it('a Mac that is away is asked again at the usual interval, not every 10 minutes (finding out wakes the browser)', async () => {
    const t = setup()
    t.setAnswer({ ok: false, skipped: 'mac_offline', reason: 'Not now.' })
    expect(await t.tick()).toMatchObject({ skipped: 1 })
    expect(t.tables.flow[0].next_run_at).toBe('2026-11-16T09:35:00.000Z')
  })

  it('plain and browser watches run in the same pass, each read its own way', async () => {
    const t = setup([flowRow(), flowRow({ id: 'plain', trigger_config: { kind: 'page_changed', url: 'https://example.com/pricing', look_for: 'the price' } })])
    const out = await t.tick()
    // The plain one's fetch stand-in throws, which is a failed read; the browser one sets its baseline.
    expect(out).toMatchObject({ due: 2, baselines: 1, failed: 1 })
    expect(t.fetchPage).toHaveBeenCalledTimes(1)
    expect(t.tables.flow.find((f) => f.id === 'plain')!.next_run_at).toBe('2026-11-16T09:20:00.000Z')
  })

  it('a browser watch whose owner left is switched off without a session being opened on anyone\'s browser', async () => {
    const t = setup([flowRow({ created_by: '77777777-7777-4777-8777-777777777777' }), flowRow({ id: 'nobody', created_by: null })])
    expect(await t.tick()).toMatchObject({ orphaned: 2 })
    expect(t.sessions.flatMap((s) => s.reads)).toEqual([])
  })
})
