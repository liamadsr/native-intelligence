import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import type { WatchMattersPick } from '@/lib/ai/decisions/tasks/watch-matters'
import type { PublicPage } from '@/lib/link-preview/safe-fetch'
import { PublicFetchError } from '@/lib/link-preview/safe-fetch'
import { memoryDb } from '@/test/memory-db'
import { ADDED_LINES_MAX, FINGERPRINT_READS } from '../diff'
import { JUDGE_HOLD_READS, PAGE_CHANGE_KEEP_DAYS, PAGE_WATCH_CONCURRENCY, PAGE_WATCH_MAX_FAILURES, runPageWatchPass, stoppedSentence, type JudgeWatch, type PageWatchDeps } from '../tick'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
const BOT = '44444444-4444-4444-8444-444444444444'
const FLOW = '55555555-5555-4555-8555-555555555555'
const URL_ = 'https://example.com/pricing?plan=pro'

const BASE = ['Example Widgets', 'Pricing', 'Starter $9 / month', 'Pro $29 / month', 'Questions? Write to us.', 'Last updated: Nov 14, 2026 09:30 UTC']

type Row = Record<string, unknown>

function flowRow(over: Row = {}): Row {
  return {
    id: FLOW,
    workspace_id: WS,
    name: 'Pro price watch',
    created_by: OWNER,
    ai_team_member_id: BOT,
    trigger_type: 'page_changed',
    trigger_config: { kind: 'page_changed', url: URL_, look_for: 'the price of the Pro plan' },
    enabled: true,
    next_run_at: '2026-11-15T09:00:00.000Z',
    ...over,
  }
}

function html(lines: string[]): PublicPage {
  const body = new TextEncoder().encode(`<html><body>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`)
  return { url: URL_, status: 200, contentType: 'text/html', charset: 'utf-8', body, truncated: false }
}

const accepted = (value: WatchMattersPick): DecisionResult<WatchMattersPick> => ({ status: 'accepted', value, inferenceId: 'inf-1', version: 'watch-matters-v1' })
const down: DecisionResult<WatchMattersPick> = { status: 'escalate', reason: 'deadline_exceeded' }

function setup(flows: Row[] = [flowRow()]) {
  const tables: Record<string, Row[]> = { flow: flows, flow_page_watch: [], flow_page_change: [], member: [{ id: 'member-1', workspace_id: WS, user_id: OWNER }] }
  const db = memoryDb(tables)
  let page: PublicPage | Error = html(BASE)
  const fetchPage = vi.fn(async () => {
    if (page instanceof Error) throw page
    return page
  })
  const judge = vi.fn<JudgeWatch>(async () => accepted('tell'))
  const send = vi.fn(async (_event: { name: string; id: string; data: Record<string, unknown> }) => ({ ids: ['e1'] }))
  const notify = vi.fn(async () => {})
  const deps: PageWatchDeps = { fetchPage, judge, send, notify, autonomyOff: async () => false, pausedWorkspaces: async () => [] }
  let clock = Date.parse('2026-11-15T09:05:00.000Z')
  /** One pass, then the clock moves past the next read so the loop is due again. */
  const tick = async (extra: Partial<PageWatchDeps> = {}) => {
    const out = await runPageWatchPass(db, new Date(clock), { ...deps, ...extra })
    clock += 16 * 60_000
    return out
  }
  return { tables, db, deps, fetchPage, judge, send, notify, tick, setPage: (p: PublicPage | Error) => (page = p) }
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
  // No log line ever names the person's address.
  for (const line of logs) expect(line).not.toContain('example.com/pricing')
})

describe('runPageWatchPass', () => {
  it('the first read only sets the baseline: nothing judged or fired, and the clock moves 15 minutes on', async () => {
    const t = setup()
    const out = await t.tick()
    expect(out).toMatchObject({ due: 1, baselines: 1, told: 0 })
    expect(t.judge).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
    expect(t.tables.flow[0].next_run_at).toBe('2026-11-15T09:20:00.000Z')
    const watch = t.tables.flow_page_watch[0]
    expect(watch).toMatchObject({ flow_id: FLOW, workspace_id: WS, url: URL_, line_count: BASE.length, failures: 0, last_error: null })
    // One remembered read: an array of hash arrays, newest first.
    expect(watch.fingerprints as string[][]).toHaveLength(1)
    expect((watch.fingerprints as string[][])[0]).toHaveLength(BASE.length)
    // The fingerprint holds hashes, never the page's text.
    expect(JSON.stringify(watch.fingerprints)).not.toContain('Pro')
  })

  it('a read whose only differences are noise or order is unchanged: no judge, no fire', async () => {
    const t = setup()
    await t.tick()
    t.setPage(html(['Pricing', 'Example Widgets', 'Pro $29 / month', 'Starter $9 / month', 'Questions? Write to us.', 'Last updated: Nov 15, 2026 10:45 UTC']))
    expect(await t.tick()).toMatchObject({ unchanged: 1, told: 0 })
    expect(t.judge).not.toHaveBeenCalled()
    expect(t.tables.flow_page_change).toHaveLength(0)
  })

  it('new lines that matter: the change is stored, the event emitted with its contract, and the next read is quiet', async () => {
    const t = setup()
    await t.tick()
    t.setPage(html([...BASE.slice(0, 3), 'Pro $39 / month', ...BASE.slice(4)]))
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.judge).toHaveBeenCalledWith(
      { lookFor: 'the price of the Pro plan', host: 'example.com', addedLines: ['Pro $39 / month'] },
      { userId: OWNER, workspaceId: WS, messageId: FLOW },
    )
    const change = t.tables.flow_page_change[0]
    expect(change).toMatchObject({ flow_id: FLOW, workspace_id: WS, url: URL_, added_lines: ['Pro $39 / month'] })
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.send.mock.calls[0][0]).toEqual({
      name: 'flow/page.changed',
      id: `page-change:${change.id}`,
      data: { workspace_id: WS, flow_id: FLOW, page_change_id: change.id, fired_at: '2026-11-15T09:21:00.000Z' },
    })
    expect(t.tables.flow_page_watch[0].changed_at).toBe('2026-11-15T09:21:00.000Z')
    expect(await t.tick()).toMatchObject({ unchanged: 1, told: 0 })
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('new lines Jev says to ignore: recorded, nothing stored or fired', async () => {
    const t = setup()
    await t.tick()
    t.judge.mockResolvedValue(accepted('ignore'))
    t.setPage(html([...BASE, 'Tip of the day: press K to search']))
    expect(await t.tick()).toMatchObject({ ignored: 1, told: 0 })
    expect(t.tables.flow_page_change).toHaveLength(0)
    expect(t.send).not.toHaveBeenCalled()
    expect(await t.tick()).toMatchObject({ unchanged: 1 })
  })

  it('Jev down: the first read tells, the next ones hold the lines and ask again, and a held change is told once Jev is back', async () => {
    const t = setup()
    await t.tick()
    t.judge.mockResolvedValue(down)
    t.setPage(html([...BASE, 'Team $99 / month']))
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_watch[0].judge_failures).toBe(1)

    t.setPage(html([...BASE, 'Team $99 / month', 'Enterprise: talk to us']))
    for (let i = 0; i < JUDGE_HOLD_READS; i += 1) expect(await t.tick()).toMatchObject({ judgeHeld: 1, told: 0 })
    expect(t.tables.flow_page_change).toHaveLength(1)
    expect(t.send).toHaveBeenCalledTimes(1)

    t.judge.mockResolvedValue(accepted('tell'))
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_change[1].added_lines).toEqual(['Enterprise: talk to us'])
    expect(t.tables.flow_page_watch[0].judge_failures).toBe(0)
  })

  it('Jev down for long: after the held reads it tells again, so an outage never swallows a change', async () => {
    const t = setup()
    await t.tick()
    t.judge.mockResolvedValue(down)
    t.setPage(html([...BASE, 'Team $99 / month']))
    await t.tick()
    t.setPage(html([...BASE, 'Team $99 / month', 'Enterprise: talk to us']))
    for (let i = 0; i < JUDGE_HOLD_READS; i += 1) await t.tick()
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_change).toHaveLength(2)
    expect(t.tables.flow_page_watch[0].judge_failures).toBe(1)
  })

  it('a failed emit loses nothing: the change row goes, the old fingerprint stays, and the next read tells', async () => {
    const t = setup()
    await t.tick()
    t.setPage(html([...BASE, 'Pro $39 / month']))
    t.send.mockRejectedValueOnce(new Error('event service down'))
    expect(await t.tick()).toMatchObject({ errored: 1, told: 0 })
    expect(t.tables.flow_page_change).toHaveLength(0)
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_change).toHaveLength(1)
    expect(t.send).toHaveBeenCalledTimes(2)
  })

  it(`failed reads count up with a plain reason; at ${PAGE_WATCH_MAX_FAILURES} in a row the loop is switched off and its owner told by its bot`, async () => {
    const t = setup()
    await t.tick()
    t.setPage(new PublicFetchError('timed out'))
    for (let i = 1; i < PAGE_WATCH_MAX_FAILURES; i += 1) {
      expect(await t.tick()).toMatchObject({ failed: 1 })
      expect(t.tables.flow_page_watch[0]).toMatchObject({ failures: i, last_error: 'The page took too long to answer.' })
    }
    expect(t.notify).not.toHaveBeenCalled()
    expect(await t.tick()).toMatchObject({ stopped: 1 })
    expect(t.tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    // Reset: switched back on, it starts from a fresh baseline and a fresh run of tries; why it stopped is kept.
    expect(t.tables.flow_page_watch[0]).toMatchObject({ fingerprints: [], failures: 0, judge_failures: 0, line_count: null, last_error: 'The page took too long to answer.' })
    expect(t.notify).toHaveBeenCalledTimes(1)
    const notice = (t.notify.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(notice).toMatchObject({ workspaceId: WS, flowId: FLOW, flowName: 'Pro price watch', ownerUserId: OWNER, teammateId: BOT })
    expect(notice.sentence).toBe(stoppedSentence('example.com', PAGE_WATCH_MAX_FAILURES, 'The page took too long to answer.'))
    expect(notice.sentence).not.toContain('pricing')
    // Switched off: no longer due.
    expect(await t.tick()).toMatchObject({ due: 0 })
    // Switched back on (the save path sets next_run_at): its first good read is a baseline, never a fire.
    t.tables.flow[0].enabled = true
    t.tables.flow[0].next_run_at = '2026-11-15T09:00:00.000Z'
    t.setPage(html([...BASE, 'Pro $45 / month']))
    expect(await t.tick()).toMatchObject({ baselines: 1, told: 0 })
  })

  it('a good read in between starts the failure count again', async () => {
    const t = setup()
    await t.tick()
    t.setPage(new PublicFetchError('timed out'))
    await t.tick()
    await t.tick()
    t.setPage(html(BASE))
    expect(await t.tick()).toMatchObject({ unchanged: 1 })
    expect(t.tables.flow_page_watch[0]).toMatchObject({ failures: 0, last_error: null })
  })

  it('a watch whose reads only failed so far takes its first good read as the baseline', async () => {
    const t = setup()
    t.setPage(new PublicFetchError('timed out'))
    await t.tick()
    t.setPage(html(BASE))
    expect(await t.tick()).toMatchObject({ baselines: 1, told: 0 })
  })

  it('a page the person changed starts a new baseline', async () => {
    const t = setup()
    await t.tick()
    t.tables.flow[0].trigger_config = { kind: 'page_changed', url: 'https://example.org/jobs', look_for: 'a new role' }
    t.setPage(html(['Jobs', 'Engineer', 'Designer', 'Writer', 'Analyst']))
    expect(await t.tick()).toMatchObject({ baselines: 1, told: 0 })
    expect(t.tables.flow_page_watch[0].url).toBe('https://example.org/jobs')
  })

  it('a page the person changed starts its failure count again, and the stop notice names the new page', async () => {
    const t = setup()
    await t.tick()
    t.setPage(new PublicFetchError('timed out'))
    for (let i = 1; i < PAGE_WATCH_MAX_FAILURES; i += 1) await t.tick()
    expect(t.tables.flow_page_watch[0].failures).toBe(PAGE_WATCH_MAX_FAILURES - 1)
    t.tables.flow[0].trigger_config = { kind: 'page_changed', url: 'https://example.org/jobs', look_for: 'a new role' }
    expect(await t.tick()).toMatchObject({ failed: 1, stopped: 0 })
    expect(t.tables.flow_page_watch[0]).toMatchObject({ url: 'https://example.org/jobs', failures: 1, fingerprints: [] })
    for (let i = 2; i <= PAGE_WATCH_MAX_FAILURES; i += 1) await t.tick()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(((t.notify.mock.calls[0] as unknown as [Record<string, string>])[0]).sentence).toContain('the page on example.org')
  })

  it('a 200 with almost no text (a robot check, a maintenance page) is a failed read and the baseline stays', async () => {
    const t = setup()
    await t.tick()
    const before = t.tables.flow_page_watch[0].fingerprints
    t.setPage(html(['Checking your browser', 'Please wait']))
    expect(await t.tick()).toMatchObject({ failed: 1, told: 0 })
    expect(t.tables.flow_page_watch[0]).toMatchObject({ failures: 1, fingerprints: before })
    expect(t.tables.flow_page_watch[0].last_error).toMatch(/almost no text/)
    t.setPage(html(BASE))
    expect(await t.tick()).toMatchObject({ unchanged: 1 })
    expect(t.judge).not.toHaveBeenCalled()
  })

  it('a read with under half the usual lines is a failed read and the baseline stays', async () => {
    const big = Array.from({ length: 20 }, (_, i) => `Item ${i}`)
    const t = setup()
    t.setPage(html(big))
    await t.tick()
    t.setPage(html([...big.slice(0, 8), 'Down for maintenance']))
    expect(await t.tick()).toMatchObject({ failed: 1, told: 0 })
    expect(t.tables.flow_page_watch[0].last_error).toMatch(/much less text/)
    expect(t.tables.flow_page_watch[0].line_count).toBe(20)
    t.setPage(html(big.slice(0, 12)))
    expect(await t.tick()).toMatchObject({ unchanged: 1 })
  })

  it(`remembers the last ${FINGERPRINT_READS} good reads, so a rotating block stops reading as new`, async () => {
    const t = setup()
    const withQuote = (q: string) => html([...BASE, q])
    t.setPage(withQuote('“Great widgets” said a customer'))
    await t.tick()
    t.judge.mockResolvedValue(accepted('ignore'))
    t.setPage(withQuote('“Fast shipping” said another'))
    expect(await t.tick()).toMatchObject({ ignored: 1 })
    // The first quote comes back: it was in a remembered read, so it is not news.
    t.setPage(withQuote('“Great widgets” said a customer'))
    expect(await t.tick()).toMatchObject({ unchanged: 1 })
    expect(t.judge).toHaveBeenCalledTimes(1)
    expect((t.tables.flow_page_watch[0].fingerprints as string[][]).length).toBe(3)
    // Past three reads it is forgotten, and reads as new again.
    t.setPage(html(BASE))
    await t.tick()
    await t.tick()
    await t.tick()
    t.setPage(withQuote('“Great widgets” said a customer'))
    expect(await t.tick()).toMatchObject({ ignored: 1 })
  })

  it('new lines past the cap are not swallowed: they come up on the next read', async () => {
    const t = setup()
    await t.tick()
    const openings = Array.from({ length: ADDED_LINES_MAX + 7 }, (_, i) => `Opening number ${i}`)
    t.setPage(html([...BASE, ...openings]))
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_change[0].added_lines).toEqual(openings.slice(0, ADDED_LINES_MAX))
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_change[1].added_lines).toEqual(openings.slice(ADDED_LINES_MAX))
    expect(await t.tick()).toMatchObject({ unchanged: 1 })
  })

  it('Jev busy (its circuit open) or a cancelled answer only holds the lines: asked again, never counted', async () => {
    const t = setup()
    await t.tick()
    t.setPage(html([...BASE, 'Pro $39 / month']))
    t.judge.mockResolvedValueOnce({ status: 'escalate', reason: 'temporarily_unavailable' })
    t.judge.mockResolvedValueOnce({ status: 'cancelled', reason: 'caller_cancelled' })
    expect(await t.tick()).toMatchObject({ judgeHeld: 1, told: 0 })
    expect(await t.tick()).toMatchObject({ judgeHeld: 1, told: 0 })
    expect(t.tables.flow_page_watch[0].judge_failures).toBe(0)
    t.judge.mockResolvedValueOnce(down)
    // The first real failure still tells (the busy holds did not count as one).
    expect(await t.tick()).toMatchObject({ told: 1 })
    expect(t.tables.flow_page_change[0].added_lines).toEqual(['Pro $39 / month'])
  })

  it(`prunes stored changes older than ${PAGE_CHANGE_KEEP_DAYS} days`, async () => {
    const t = setup([])
    const old = (i: number) => ({ id: `old-${i}`, flow_id: FLOW, workspace_id: WS, url: URL_, added_lines: ['x'], created_at: '2026-10-01T00:00:00.000Z' })
    t.tables.flow_page_change.push(old(1), old(2), { ...old(3), id: 'recent', created_at: '2026-11-10T00:00:00.000Z' })
    expect(await t.tick()).toMatchObject({ pruned: 2 })
    expect(t.tables.flow_page_change.map((r) => r.id)).toEqual(['recent'])
  })

  it('an address that is not public is never fetched: a failed read with a plain reason', async () => {
    const t = setup([flowRow({ trigger_config: { kind: 'page_changed', url: 'http://localhost:3000/admin', look_for: 'anything' } })])
    expect(await t.tick()).toMatchObject({ failed: 1 })
    expect(t.fetchPage).not.toHaveBeenCalled()
    expect(t.tables.flow_page_watch[0].last_error).toMatch(/private network/)
  })

  it('autonomy off: not claimed, not read, still due', async () => {
    const t = setup()
    expect(await t.tick({ autonomyOff: async () => true })).toMatchObject({ held: 1 })
    expect(t.fetchPage).not.toHaveBeenCalled()
    expect(t.tables.flow[0].next_run_at).toBe('2026-11-15T09:00:00.000Z')
  })

  it('paused workspaces are left out of the scan', async () => {
    const t = setup([flowRow(), flowRow({ id: '66666666-6666-4666-8666-666666666666', workspace_id: OTHER_WS })])
    const out = await t.tick({ pausedWorkspaces: async () => [OTHER_WS] })
    expect(out.due).toBe(1)
  })

  it('a loop not yet due, switched off, or of another trigger is not read', async () => {
    const t = setup([
      flowRow({ next_run_at: '2026-11-15T10:00:00.000Z' }),
      flowRow({ id: 'f2', enabled: false }),
      flowRow({ id: 'f3', trigger_type: 'schedule' }),
      flowRow({ id: 'f4', next_run_at: null }),
    ])
    expect(await t.tick()).toMatchObject({ due: 0 })
    expect(t.fetchPage).not.toHaveBeenCalled()
  })

  it('two passes at once read a loop once: the other loses the claim', async () => {
    const t = setup()
    const now = new Date('2026-11-15T09:05:00.000Z')
    const [a, b] = await Promise.all([runPageWatchPass(t.db, now, t.deps), runPageWatchPass(t.db, now, t.deps)])
    expect(a.lost + b.lost).toBe(1)
    expect(a.baselines + b.baselines).toBe(1)
    expect(t.fetchPage).toHaveBeenCalledTimes(1)
  })

  it('one bad row never stalls the rest, and the pass never throws', async () => {
    const other = '77777777-7777-4777-8777-777777777777'
    const t = setup([flowRow({ workspace_id: OTHER_WS, id: 'bad-flow' }), flowRow({ id: other })])
    const out = await t.tick({ autonomyOff: async (ws) => (ws === OTHER_WS ? Promise.reject(new Error('boom')) : false) })
    expect(out).toMatchObject({ due: 2, errored: 1, baselines: 1 })
  })

  it('reads at most the concurrency at once', async () => {
    const flows = Array.from({ length: 12 }, (_, i) => flowRow({ id: `flow-${i}` }))
    const t = setup(flows)
    let inFlight = 0
    let peak = 0
    t.fetchPage.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return html(BASE)
    })
    expect(await t.tick({ concurrency: 5 })).toMatchObject({ due: 12, baselines: 12 })
    expect(peak).toBeLessThanOrEqual(5)
    expect(PAGE_WATCH_CONCURRENCY).toBe(10)
    expect(peak).toBeGreaterThan(1)
  })

  it('a judge that throws is read as unable to judge (tells the first time)', async () => {
    const t = setup()
    await t.tick()
    t.judge.mockRejectedValue(new Error('network'))
    t.setPage(html([...BASE, 'Pro $39 / month']))
    expect(await t.tick()).toMatchObject({ told: 1 })
  })

  it('a loop with no owner, or whose owner left the workspace, is switched off without a read or a notice', async () => {
    for (const createdBy of [null, '99999999-9999-4999-8999-999999999999']) {
      const t = setup([flowRow({ created_by: createdBy })])
      expect(await t.tick()).toMatchObject({ orphaned: 1 })
      expect(t.tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
      expect(t.fetchPage).not.toHaveBeenCalled()
      expect(t.notify).not.toHaveBeenCalled()
    }
  })

  it('a failed membership read never switches a loop off', async () => {
    const t = setup()
    const db = new Proxy(t.db, {
      get(target, prop) {
        if (prop !== 'from') return Reflect.get(target, prop)
        return (table: string) => (table === 'member' ? { select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'down' } }) }) }) }) } : target.from(table))
      },
    })
    expect(await runPageWatchPass(db, new Date('2026-11-15T09:05:00.000Z'), t.deps)).toMatchObject({ baselines: 1, orphaned: 0 })
  })
})

describe('stoppedSentence', () => {
  it('names the site and our own reason, never page text', () => {
    expect(stoppedSentence('example.com', 8, 'There is no page at that address (it answered 404).')).toBe(
      'I stopped watching the page on example.com: it could not be read 8 times in a row (There is no page at that address (it answered 404)). Switch the loop back on once the page is working again.',
    )
    expect(stoppedSentence(null, 8, 'The page took too long to answer.')).toMatch(/^I stopped watching the page: /)
  })
})
