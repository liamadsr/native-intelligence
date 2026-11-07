// @vitest-environment jsdom
/**
 * The presence client (src/lib/presence/client.ts) under fake timers: at most
 * one ping a minute under steady input, and a keepalive only while the page
 * is visible, focused and recently used; evaluations throttled to one per
 * 10 s; a seen only while the person is reading and only when newer; only the
 * desktop's main window asks for presence_state (and writes the state: other
 * desktop windows send seen-only pings), and a desktop without it falls back
 * to the web rule; the web never says anything but `active`; and
 * a stopped client leaves no listener or timer behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  desktop: false,
  label: null as string | null,
  reading: null as { idleSeconds: number; locked: boolean } | null,
  presenceState: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  getThisWebviewLabel: async () => env.label,
  presenceState: env.presenceState,
}))

const CONV = '11111111-2222-4333-8444-555555555555'
const OTHER_CONV = '99999999-2222-4333-8444-555555555555'
const T0 = Date.parse('2026-10-31T12:00:00.000Z')

let visibility: DocumentVisibilityState = 'visible'
let focused = true
let fetchMock: ReturnType<typeof vi.fn>
let client: typeof import('../client')
const stops: (() => void)[] = []

const input = () => window.dispatchEvent(new Event('pointerdown'))
const focusWindow = () => window.dispatchEvent(new Event('focus'))
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
/** Every POST's body, checking each went to the route as a keepalive fetch. */
const bodies = () =>
  fetchMock.mock.calls.map(([url, init]) => {
    expect(url).toBe('/api/presence')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).keepalive).toBe(true)
    return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
  })
const sendTimes: number[] = []

async function start(userId = 'user-1') {
  const stop = client.startPresence(userId)
  stops.push(stop)
  await advance(0)
  return stop
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.resetModules()
  client = await import('../client')
  env.desktop = false
  env.label = null
  env.reading = null
  env.presenceState.mockReset()
  env.presenceState.mockImplementation(async () => env.reading)
  visibility = 'visible'
  focused = true
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  sendTimes.length = 0
  fetchMock = vi.fn(async () => {
    sendTimes.push(Date.now())
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
})

afterEach(() => {
  while (stops.length) stops.pop()!()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the web rule', () => {
  it('says nothing before any input, however long the page sits visible and focused', async () => {
    await start()
    await advance(10 * 60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('at most one ping a minute under steady input: one now, then one every 4 minutes', async () => {
    await start()
    for (let t = 0; t < 10 * 60_000; t += 5_000) {
      input()
      await advance(5_000)
    }
    expect(sendTimes.map((t) => t - T0)).toEqual([60_000, 300_000, 540_000])
    for (let i = 1; i < sendTimes.length; i++) expect(sendTimes[i] - sendTimes[i - 1]).toBeGreaterThanOrEqual(60_000)
    expect(bodies().every((b) => b.surface === 'web' && b.state === 'active' && !('seen' in b))).toBe(true)
  })

  it('a keepalive needs input in the last 4 minutes', async () => {
    await start()
    input()
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // No input since: by the keepalive (4 min after the ping) it is 5 min old.
    await advance(10 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a keepalive needs the page visible', async () => {
    await start()
    input()
    await advance(60_000)
    setVisibility('hidden')
    for (let t = 0; t < 10 * 60_000; t += 5_000) {
      input()
      await advance(5_000)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a keepalive needs the page focused', async () => {
    focused = false
    await start()
    for (let t = 0; t < 10 * 60_000; t += 5_000) {
      input()
      await advance(5_000)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a focus counts as input and evaluates at once; a burst of triggers is one evaluation per 10 s', async () => {
    await start()
    await advance(30_000)
    focusWindow()
    await advance(0)
    expect(sendTimes.map((t) => t - T0)).toEqual([30_000])
    // A second focus 2 s later lands inside the throttle window: it runs once
    // at its end, and the keepalive isn't due, so nothing more is sent.
    await advance(2_000)
    focusWindow()
    setVisibility('visible')
    await advance(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a trigger inside the throttle window runs once at its end', async () => {
    await start()
    // The start evaluation ran at T0 with no input. A focus 2 s in waits for T0 + 10 s.
    await advance(2_000)
    focusWindow()
    await advance(7_000)
    expect(fetchMock).not.toHaveBeenCalled()
    await advance(1_000)
    expect(sendTimes.map((t) => t - T0)).toEqual([10_000])
  })

  it('never sends anything but active, through hiding, blurring and coming back', async () => {
    await start()
    for (let round = 0; round < 3; round++) {
      input()
      await advance(60_000)
      setVisibility('hidden')
      await advance(5 * 60_000)
      focused = false
      setVisibility('visible')
      await advance(60_000)
      focused = true
      focusWindow()
      await advance(5 * 60_000)
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    expect(new Set(bodies().map((b) => b.state))).toEqual(new Set(['active']))
  })

  it('an offline ping is retried at the next minute; a refused one waits out the keepalive', async () => {
    fetchMock.mockImplementationOnce(async () => {
      sendTimes.push(Date.now())
      throw new TypeError('Failed to fetch')
    })
    await start()
    for (let t = 0; t < 3 * 60_000; t += 5_000) {
      input()
      await advance(5_000)
    }
    expect(sendTimes.map((t) => t - T0)).toEqual([60_000, 120_000])

    // A 500 (migration 454 not applied yet) at the next keepalive, 6 min in:
    // the minutes after it send nothing more.
    sendTimes.length = 0
    fetchMock.mockImplementation(async () => {
      sendTimes.push(Date.now())
      return new Response('{}', { status: 500 })
    })
    for (let t = 0; t < 6 * 60_000; t += 5_000) {
      input()
      await advance(5_000)
    }
    expect(sendTimes.map((t) => t - T0)).toEqual([360_000])
  })
})

describe('the client id', () => {
  it('is kept in localStorage and reused', async () => {
    await start()
    input()
    await advance(60_000)
    const id = bodies()[0].clientId as string
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(localStorage.getItem(client.PRESENCE_CLIENT_ID_KEY)).toBe(id)
    expect(client.presenceClientId()).toBe(id)
  })

  it('reuses a stored id, and replaces an off-shape one', () => {
    localStorage.setItem(client.PRESENCE_CLIENT_ID_KEY, 'stored-id-1234')
    expect(client.presenceClientId()).toBe('stored-id-1234')
    localStorage.setItem(client.PRESENCE_CLIENT_ID_KEY, 'bad id!')
    const fresh = client.presenceClientId()
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(localStorage.getItem(client.PRESENCE_CLIENT_ID_KEY)).toBe(fresh)
  })

  it('lives in memory when storage throws, the same for the life of the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const a = client.presenceClientId()
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(client.presenceClientId()).toBe(a)
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('seen', () => {
  it('rides a ping while the person is reading, only when newer', async () => {
    await start()
    await advance(15_000)
    input()
    client.reportHomeView(CONV, T0 - 30_000)
    await advance(0)
    expect(bodies()).toEqual([
      { clientId: expect.any(String), surface: 'web', state: 'active', seen: { conversationId: CONV, through: new Date(T0 - 30_000).toISOString() } },
    ])
    // The same newest message: nothing more, the keepalive isn't due.
    await advance(20_000)
    input()
    client.reportHomeView(CONV, T0 - 30_000)
    await advance(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A newer message: sent, though the keepalive isn't due.
    input()
    client.reportHomeView(CONV, T0 + 25_000)
    await advance(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies()[1].seen).toEqual({ conversationId: CONV, through: new Date(T0 + 25_000).toISOString() })
  })

  it('at most one a 10 s, the newest when the window ends', async () => {
    await start()
    await advance(15_000)
    input()
    client.reportHomeView(CONV, Date.now() - 1_000)
    await advance(0)
    for (let i = 1; i <= 4; i++) {
      await advance(1_000)
      input()
      client.reportHomeView(CONV, Date.now())
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await advance(6_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies()[1].seen).toEqual({ conversationId: CONV, through: new Date(T0 + 19_000).toISOString() })
    expect(sendTimes[1] - sendTimes[0]).toBe(10_000)
  })

  it('not while the page is unfocused or hidden', async () => {
    await start()
    focused = false
    input()
    client.reportHomeView(CONV, T0)
    await advance(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
    focused = true
    visibility = 'hidden'
    input()
    await advance(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('not with input over 2 minutes old, though the page still counts as active', async () => {
    await start()
    input()
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await advance(90_000)
    client.reportHomeView(CONV, Date.now())
    await advance(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A focus is the person coming back: it counts as input, so it is read now.
    focusWindow()
    await advance(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies()[1].seen).toMatchObject({ conversationId: CONV })
  })

  it('a cleared view sends nothing; a cleared stale view does not clear a newer one', async () => {
    await start()
    const clearA = client.reportHomeView(CONV, T0 - 5_000)
    clearA()
    input()
    await advance(60_000)
    expect(bodies()[0]).not.toHaveProperty('seen')

    const clearB = client.reportHomeView(CONV, Date.now() - 1_000)
    client.reportHomeView(OTHER_CONV, Date.now() - 500)
    clearB()
    input()
    await advance(10_000)
    expect(bodies()[1].seen).toMatchObject({ conversationId: OTHER_CONV })
  })

  it('ignores a conversation id that is not a uuid (an unsaved chat)', async () => {
    await start()
    input()
    client.reportHomeView('local-draft', T0)
    await advance(60_000)
    expect(bodies()[0]).not.toHaveProperty('seen')
  })
})

describe('the desktop', () => {
  beforeEach(() => {
    env.desktop = true
  })

  it("main window: the Mac's reading, sent on a change and every 4 minutes while active, with no page input needed", async () => {
    env.label = 'main'
    env.reading = { idleSeconds: 2, locked: false }
    focused = false
    await start()
    expect(bodies()).toEqual([{ clientId: expect.any(String), surface: 'desktop', state: 'active' }])

    env.reading = { idleSeconds: 200, locked: false }
    await advance(60_000)
    env.reading = { idleSeconds: 260, locked: false }
    await advance(60_000)
    env.reading = { idleSeconds: 320, locked: true }
    await advance(60_000)
    env.reading = { idleSeconds: 380, locked: true }
    await advance(3 * 60_000)
    env.reading = { idleSeconds: 1, locked: false }
    await advance(60_000)
    expect(bodies().map((b) => b.state)).toEqual(['active', 'idle', 'locked', 'active'])

    await advance(4 * 60_000)
    expect(bodies().map((b) => b.state)).toEqual(['active', 'idle', 'locked', 'active', 'active'])
    expect(sendTimes.map((t) => t - T0)).toEqual([0, 60_000, 180_000, 420_000, 660_000])
    expect(env.presenceState).toHaveBeenCalled()
  })

  it('other windows never ask for presence_state and never write a state (main’s locked stands): only seen-only pings', async () => {
    env.label = 'workspace-1234'
    env.reading = { idleSeconds: 1, locked: false }
    await start()
    await advance(2 * 60_000)
    input()
    await advance(5 * 60_000)
    // Used, focused and visible, but no state: one row is shared, and main alone says active, idle or locked.
    expect(fetchMock).not.toHaveBeenCalled()
    input()
    client.reportHomeView(CONV, T0 + 7 * 60_000)
    // The evaluation throttle (10 s) runs it once its window ends.
    await advance(10_000)
    expect(bodies()).toEqual([{ clientId: expect.any(String), surface: 'desktop', seen: { conversationId: CONV, through: new Date(T0 + 7 * 60_000).toISOString() } }])
    // Only when newer.
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(env.presenceState).not.toHaveBeenCalled()
  })

  it('an older desktop without the command falls back to the web rule in the main window', async () => {
    env.label = 'main'
    env.reading = null
    await start()
    await advance(2 * 60_000)
    expect(fetchMock).not.toHaveBeenCalled()
    for (let t = 0; t < 6 * 60_000; t += 5_000) {
      input()
      await advance(5_000)
    }
    expect(bodies().map((b) => [b.surface, b.state])).toEqual([
      ['desktop', 'active'],
      ['desktop', 'active'],
    ])
    expect(sendTimes[1] - sendTimes[0]).toBe(240_000)
  })

  it("main window: the Mac being in use is not reading: no seen while Dial8 isn't focused", async () => {
    env.label = 'main'
    env.reading = { idleSeconds: 1, locked: false }
    focused = false
    await start()
    await advance(20_000)
    input()
    client.reportHomeView(CONV, T0 + 10_000)
    await advance(60_000)
    expect(bodies()).toEqual([{ clientId: expect.any(String), surface: 'desktop', state: 'active' }])
  })

  it('main window: a seen rides along with the reading', async () => {
    env.label = 'main'
    env.reading = { idleSeconds: 1, locked: false }
    await start()
    await advance(20_000)
    input()
    client.reportHomeView(CONV, T0 + 10_000)
    await advance(0)
    expect(bodies()[1]).toEqual({ clientId: expect.any(String), surface: 'desktop', state: 'active', seen: { conversationId: CONV, through: new Date(T0 + 10_000).toISOString() } })
  })
})

describe('lifecycle', () => {
  it('a stopped client leaves no timer and hears no event', async () => {
    const stop = await start()
    input()
    await advance(15_000)
    focusWindow()
    stop()
    expect(vi.getTimerCount()).toBe(0)
    focusWindow()
    input()
    client.reportHomeView(CONV, Date.now())
    await advance(10 * 60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starting again replaces the session: never two intervals', async () => {
    await start('user-1')
    await start('user-2')
    expect(vi.getTimerCount()).toBe(1)
    input()
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a stop from an old session does not stop the new one', async () => {
    const stopOld = await start('user-1')
    await start('user-1')
    stopOld()
    input()
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
