import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserWatchSession, isSkippedRead, type BrowserState, type BrowserWatchPorts } from '../read-browser'

const REF = { userId: '33333333-3333-4333-8333-333333333333', workspaceId: '11111111-1111-4111-8111-111111111111' }
const URL_ = 'https://app.example.com/orders'
const TEXT = ['Orders', 'Open: 4', 'Fernhill Studio', 'Order 1041 | Packed', 'Order 1042 | Waiting'].join('\n')

const row = (over: Partial<BrowserState> = {}): BrowserState => ({ status: 'running', driver: 'agent', last_active_at: '2026-11-16T09:00:00.000Z', ...over })

function setup(over: Partial<BrowserWatchPorts> = {}, start: BrowserState | null = row({ status: 'stopped' })) {
  let state = start
  let clock = 0
  const calls: string[] = []
  let result: { status: string; result: unknown } | null = { status: 'completed', result: { ok: true, url: URL_, text: TEXT } }
  const ports: BrowserWatchPorts = {
    blockedSites: vi.fn(async () => ['nativeintelligence.dev', 'blocked.example']),
    neverAutomate: vi.fn(async () => ['amazon.com']),
    browser: vi.fn(async () => state),
    inUse: vi.fn(async () => false),
    ensure: vi.fn(async () => { calls.push('ensure'); state = row({ last_active_at: '2026-11-16T09:01:00.000Z' }) }),
    isBusy: (error) => (error as { code?: string } | null)?.code === 'BROWSERS_BUSY',
    enqueue: vi.fn(async (_ref, url) => { calls.push(`enqueue ${url}`); return 'cmd-1' }),
    command: vi.fn(async () => result),
    abandon: vi.fn(async () => { calls.push('abandon') }),
    clear: vi.fn(async () => { calls.push('clear') }),
    sleep: vi.fn(async () => { calls.push('sleep') }),
    wait: async (ms) => { clock += ms },
    now: () => clock,
    ...over,
  }
  return { ports, calls, setResult: (r: typeof result) => (result = r), setState: (s: BrowserState | null) => (state = s) }
}

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  // No log line names the address or the page's text.
  for (const line of logs) {
    expect(line).not.toContain('app.example.com')
    expect(line).not.toContain('Order 1041')
  }
})

describe('browserWatchSession', () => {
  it('wakes a sleeping browser as a background start, reads the page as lines, clears the stored text, and puts the browser back to sleep', async () => {
    const t = setup()
    const session = browserWatchSession(REF, t.ports)
    const read = await session.read(URL_)
    expect(read).toEqual({ ok: true, lines: ['Orders', 'Open: 4', 'Fernhill Studio', 'Order 1041 | Packed', 'Order 1042 | Waiting'] })
    expect(t.calls).toEqual(['ensure', `enqueue ${URL_}`, 'clear'])
    await session.finish()
    expect(t.calls.at(-1)).toBe('sleep')
    // Once: a second finish does nothing.
    await session.finish()
    expect(t.calls.filter((c) => c === 'sleep')).toHaveLength(1)
  })

  it('a browser found running is used and left running', async () => {
    const t = setup({}, row())
    const session = browserWatchSession(REF, t.ports)
    expect((await session.read(URL_)).ok).toBe(true)
    await session.finish()
    expect(t.ports.sleep).not.toHaveBeenCalled()
  })

  it('a browser this session woke stays up when someone used it meanwhile', async () => {
    // In use at finish (the person's agent queued a command): not put to sleep.
    const t = setup({ inUse: vi.fn(async () => true) }, row({ status: 'stopped' }))
    const session = browserWatchSession(REF, t.ports)
    expect((await session.read(URL_)).ok).toBe(true)
    await session.finish()
    expect(t.ports.sleep).not.toHaveBeenCalled()
    // And when the person took it over.
    const u = setup()
    const other = browserWatchSession(REF, u.ports)
    await other.read(URL_)
    u.setState(row({ driver: 'person' }))
    await other.finish()
    expect(u.ports.sleep).not.toHaveBeenCalled()
  })

  it('a browser someone touched after the session\'s own last use is left up: a live view\'s ping, an agent\'s finished command', async () => {
    const t = setup()
    const session = browserWatchSession(REF, t.ports)
    expect((await session.read(URL_)).ok).toBe(true)
    // Nothing in flight at finish, but the activity stamp moved since the session's own read settled.
    t.setState(row({ last_active_at: '2026-11-16T09:01:40.000Z' }))
    await session.finish()
    expect(t.ports.sleep).not.toHaveBeenCalled()
  })

  it('a redirect into a social network\'s signed-in pages is refused like a start there', async () => {
    const t = setup()
    t.setResult({ status: 'completed', result: { ok: true, url: 'https://www.linkedin.com/feed/', text: 'Feed\nA\nB\nC\nD' } })
    expect(await browserWatchSession(REF, t.ports).read('https://short.example/abc')).toEqual({ ok: false, reason: expect.stringContaining('linkedin.com does not allow') })
  })

  it('a browser that is starting for its person with a command queued is not joined', async () => {
    const t = setup({ inUse: vi.fn(async () => true) }, row({ status: 'starting' }))
    expect(await browserWatchSession(REF, t.ports).read(URL_)).toMatchObject({ skipped: 'in_use' })
    expect(t.calls).toEqual([])
  })

  it('never gets in the way: a browser its person drives, or one at work, is skipped without a start or a command', async () => {
    const driven = setup({}, row({ driver: 'person' }))
    const a = await browserWatchSession(REF, driven.ports).read(URL_)
    expect(a).toMatchObject({ ok: false, skipped: 'taken_over' })
    expect(driven.calls).toEqual([])

    const working = setup({ inUse: vi.fn(async () => true) }, row())
    const b = await browserWatchSession(REF, working.ports).read(URL_)
    expect(b).toMatchObject({ ok: false, skipped: 'in_use' })
    expect(working.calls).toEqual([])
  })

  it('no free slot is a skip, asked once per session: later reads get the same answer without another start', async () => {
    const ensure = vi.fn(async () => { throw Object.assign(new Error('All browsers are in use right now.'), { code: 'BROWSERS_BUSY' }) })
    const t = setup({ ensure })
    const session = browserWatchSession(REF, t.ports)
    expect(await session.read(URL_)).toMatchObject({ ok: false, skipped: 'busy' })
    expect(await session.read('https://app.example.com/invoices')).toMatchObject({ ok: false, skipped: 'busy' })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(t.ports.enqueue).not.toHaveBeenCalled()
    await session.finish()
    expect(t.ports.sleep).not.toHaveBeenCalled()
  })

  it('our own trouble is a skip, never a failed read: a start that fails, a command nobody settles, an answer it does not know', async () => {
    const failing = setup({ ensure: vi.fn(async () => { throw new Error('cloud browser start failed') }) })
    expect(await browserWatchSession(REF, failing.ports).read(URL_)).toMatchObject({ ok: false, skipped: 'unavailable' })

    const silent = setup()
    silent.setResult({ status: 'waiting_for_device', result: null })
    expect(await browserWatchSession(REF, silent.ports, { waitMs: 2000 }).read(URL_)).toMatchObject({ ok: false, skipped: 'unavailable' })
    expect(silent.calls).toContain('abandon')

    for (const row_ of [{ status: 'failed', result: null }, { status: 'expired', result: null }, { status: 'completed', result: { url: URL_, text: 'Hi' } }]) {
      const odd = setup()
      odd.setResult(row_)
      const read = await browserWatchSession(REF, odd.ports).read(URL_)
      expect(isSkippedRead(read) && read.skipped).toBe('unavailable')
    }
  })

  it('the relay\'s own stops: a take-over and a Mac that is away are skips; a blocked site, a site that forbids agents and a page that did not load are failed reads', async () => {
    const answer = async (result: unknown) => {
      const t = setup()
      t.setResult({ status: 'completed', result })
      return browserWatchSession(REF, t.ports).read(URL_)
    }
    expect(await answer({ ok: false, code: 'taken_over' })).toMatchObject({ skipped: 'taken_over' })
    expect(await answer({ ok: false, code: 'needs_your_mac', site: 'example.com' })).toMatchObject({ skipped: 'mac_offline' })
    const blocked = await answer({ ok: false, code: 'site_blocked', site: 'tracker.example' })
    expect(blocked).toEqual({ ok: false, reason: expect.stringContaining('You blocked your agent on tracker.example') })
    const never = await answer({ ok: false, code: 'never_automate', site: 'shop.example' })
    expect(never).toEqual({ ok: false, reason: 'shop.example does not allow AI agents, so it can\'t be watched in your browser.' })
    expect(await answer({ ok: false, code: 'load_failed' })).toEqual({ ok: false, reason: 'The page did not load in your browser.' })
  })

  it('a page that sent the browser to a sign-in page is a failed read that says to sign in', async () => {
    const t = setup()
    t.setResult({ status: 'completed', result: { ok: true, url: 'https://app.example.com/login?next=%2Forders', text: 'Sign in\nEmail\nPassword\nForgot?\nHelp' } })
    const read = await browserWatchSession(REF, t.ports).read(URL_)
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('sign-in page') })
  })

  it('a site the person blocked, one that forbids agents, and a social network are refused before the browser is touched', async () => {
    const t = setup()
    const session = browserWatchSession(REF, t.ports)
    expect(await session.read('https://www.blocked.example/inbox')).toEqual({ ok: false, reason: expect.stringContaining('You blocked your agent on blocked.example') })
    expect(await session.read('https://www.amazon.com/orders')).toEqual({ ok: false, reason: expect.stringContaining('amazon.com does not allow AI agents') })
    expect(await session.read('https://www.linkedin.com/messaging/')).toEqual({ ok: false, reason: expect.stringContaining('linkedin.com does not allow') })
    expect(await session.read('http://10.0.0.8/admin')).toMatchObject({ ok: false, reason: expect.stringContaining('private network') })
    expect(t.calls).toEqual([])
  })

  it('a blocked list that can\'t be read is never taken as empty: the read waits', async () => {
    const t = setup({ blockedSites: vi.fn(async () => { throw new Error('blocked sites unavailable') }) })
    expect(await browserWatchSession(REF, t.ports).read(URL_)).toMatchObject({ ok: false, skipped: 'unavailable' })
    expect(t.calls).toEqual([])
  })

  it('a person who takes the browser mid-pass stops the rest of the session\'s reads', async () => {
    const t = setup({}, row())
    t.setResult({ status: 'completed', result: { ok: false, code: 'taken_over' } })
    const session = browserWatchSession(REF, t.ports)
    expect(await session.read(URL_)).toMatchObject({ skipped: 'taken_over' })
    expect(await session.read('https://app.example.com/invoices')).toMatchObject({ skipped: 'taken_over' })
    expect(t.ports.enqueue).toHaveBeenCalledTimes(1)
  })
})
