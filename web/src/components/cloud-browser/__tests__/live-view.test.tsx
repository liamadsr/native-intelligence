// @vitest-environment jsdom
/**
 * The live view (src/components/cloud-browser/live-view.tsx) with a stand-in
 * hub and noVNC: the token is the socket's first message, noVNC takes the
 * socket only on the hub's `ok`, then `go`; view-only until Take over, which
 * sets the driver and reconnects with input; a drop reconnects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeSocket {
  static all: FakeSocket[] = []
  sent: unknown[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  send(data: unknown) { this.sent.push(data) }
  onclose: ((event: { code: number }) => void) | null = null
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  say(data: string) { this.onmessage?.({ data }) }
  shut(code: number) { this.readyState = 3; this.onclose?.({ code }) }
}
class FakeRfb extends EventTarget {
  static all: FakeRfb[] = []
  viewOnly = false
  scaleViewport = false
  resizeSession = true
  focusOnClick = true
  keys: [number, string | null, boolean | undefined][] = []
  constructor(readonly target: HTMLElement, readonly channel: FakeSocket) { super(); FakeRfb.all.push(this) }
  sendKey(keysym: number, code: string | null, down?: boolean) { this.keys.push([keysym, code, down]) }
  clipboardPasteFrom() {}
  focus() {}
  disconnect() {}
}

const tickets = vi.hoisted(() => ({ next: [] as unknown[], asked: [] as [string, boolean][], driver: vi.fn(async (_driver: string) => true) }))
vi.mock('@/lib/cloud-browser/computer-client', async (original) => {
  const real = await original<typeof import('@/lib/cloud-browser/computer-client')>()
  return {
    ...real,
    liveViewTicket: async (mode: string, wake = true) => { tickets.asked.push([mode, wake]); return tickets.next.shift() ?? { state: 'error', message: 'none left' } },
    setDriver: tickets.driver,
  }
})

import { __setRfbLoaderForTests, CloudBrowserLiveView } from '../live-view'
import { __resetComputerForTests, closeLiveView, getComputer, hideLiveView, openLiveView } from '@/lib/cloud-browser/computer-client'

const ticket = (control: boolean) => ({ state: 'running', token: `token-${control}`, viewerUrl: 'wss://hub.test/viewer', thumbnailUrl: 'https://hub.test/thumbnail', control, driver: control ? 'person' : 'agent' })
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }

let root: Root
let host: HTMLElement
beforeEach(() => {
  FakeSocket.all = []
  FakeRfb.all = []
  tickets.next = []
  tickets.asked = []
  tickets.driver.mockClear()
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1 }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  __setRfbLoaderForTests(async () => FakeRfb as never)
  __resetComputerForTests()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  closeLiveView()
  vi.unstubAllGlobals()
})

describe('the live view', () => {
  it('sends the token first, hands noVNC the socket only on ok, then says go', async () => {
    tickets.next = [ticket(false)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    const socket = FakeSocket.all[0]
    expect(socket.url).toBe('wss://hub.test/viewer')
    act(() => socket.open())
    expect(socket.sent).toEqual(['token-false'])
    expect(FakeRfb.all).toHaveLength(0)
    act(() => socket.say(JSON.stringify({ ok: true, control: false })))
    expect(FakeRfb.all).toHaveLength(1)
    expect(FakeRfb.all[0]).toMatchObject({ viewOnly: true, scaleViewport: true, resizeSession: false })
    expect(socket.sent).toEqual(['token-false', 'go'])
    expect(document.querySelector('[data-live-view-take-over]')).not.toBeNull()
  })

  it('takes over: sets the driver, reconnects with input, and offers to hand back', async () => {
    tickets.next = [ticket(false), ticket(true)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    act(() => { FakeSocket.all[0].open(); FakeSocket.all[0].say(JSON.stringify({ ok: true, control: false })) })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-live-view-take-over]')!.click() })
    await flush()
    expect(tickets.driver).toHaveBeenCalledWith('person')
    const second = FakeSocket.all[1]
    act(() => { second.open(); second.say(JSON.stringify({ ok: true, control: true })) })
    expect(FakeRfb.all[1].viewOnly).toBe(false)
    expect(document.querySelector('[data-live-view-hand-back]')).not.toBeNull()
  })

  it('says why when the browser can’t be reached, and tries again on demand', async () => {
    tickets.next = [{ state: 'error', message: 'Your browser could not start. Try again in a moment.' }, ticket(false)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    expect(document.body.textContent).toContain('Your browser could not start')
    await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Try again')!.click() })
    await flush()
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('connects again after a drop without waking the browser, and says when it sleeps', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      tickets.next = [ticket(false), { state: 'asleep' }]
      act(() => root.render(<CloudBrowserLiveView />))
      act(() => openLiveView())
      await flush()
      act(() => { FakeSocket.all[0].open(); FakeSocket.all[0].say(JSON.stringify({ ok: true, control: false })) })
      act(() => { FakeRfb.all[0].dispatchEvent(new Event('disconnect')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
      await flush()
      expect(tickets.asked).toEqual([['view', true], ['view', false]])
      expect(document.body.textContent).toContain('Your browser is asleep.')
      expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Wake')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when the hub turns it away before noVNC takes the socket', async () => {
    tickets.next = [ticket(false)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    act(() => { FakeSocket.all[0].open(); FakeSocket.all[0].shut(4429) })
    expect(document.body.textContent).toContain('Too many windows are watching your browser')
  })

  it('hands back when the person closes it while driving, but the agent’s hide never ends their session', async () => {
    tickets.next = [ticket(false), ticket(true)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    act(() => { FakeSocket.all[0].open(); FakeSocket.all[0].say(JSON.stringify({ ok: true, control: false })) })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-live-view-take-over]')!.click() })
    await flush()
    act(() => { FakeSocket.all[1].open(); FakeSocket.all[1].say(JSON.stringify({ ok: true, control: true })) })
    // The real store learns the driver from the server; the stand-in setDriver doesn't, so say it here.
    act(() => { (getComputer() as { driver: string }).driver = 'person' })
    act(() => hideLiveView())
    expect(getComputer().viewOpen).toBe(true)
    const fetched = vi.mocked(fetch)
    fetched.mockClear()
    act(() => closeLiveView())
    expect(getComputer().viewOpen).toBe(false)
    expect(fetched.mock.calls.map(([url, init]) => [url, init?.body])).toContainEqual(['/api/account/browser/driver', JSON.stringify({ driver: 'agent' })])
  })

  it('sends ⌘-shortcuts as Ctrl-shortcuts, and never ⌘ itself', async () => {
    tickets.next = [ticket(false), ticket(true)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    act(() => { FakeSocket.all[0].open(); FakeSocket.all[0].say(JSON.stringify({ ok: true, control: false })) })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-live-view-take-over]')!.click() })
    await flush()
    act(() => { FakeSocket.all[1].open(); FakeSocket.all[1].say(JSON.stringify({ ok: true, control: true })) })
    const screen = document.querySelector<HTMLElement>('[data-live-view-screen]')!
    screen.tabIndex = 0
    screen.focus()
    const reached: string[] = []
    screen.addEventListener('keydown', e => reached.push(e.key))
    const press = (key: string, code: string, metaKey: boolean) => screen.dispatchEvent(new KeyboardEvent('keydown', { key, code, metaKey, bubbles: true, cancelable: true }))
    act(() => { press('Meta', 'MetaLeft', true); press('c', 'KeyC', true) })
    expect(reached).toEqual([])
    expect(FakeRfb.all[1].keys).toEqual([[0xffe3, 'ControlLeft', true], [0x63, 'KeyC', true], [0x63, 'KeyC', false], [0xffe3, 'ControlLeft', false]])
  })

  it('renders nothing while closed', () => {
    act(() => root.render(<CloudBrowserLiveView />))
    expect(document.querySelector('[data-cloud-browser-live-view]')).toBeNull()
  })
})

describe('the blocked sites panel', () => {
  it('opens over the screen from the header, its list loaded only then', async () => {
    tickets.next = [ticket(false)]
    act(() => root.render(<CloudBrowserLiveView />))
    act(() => openLiveView())
    await flush()
    const fetched = vi.mocked(fetch)
    expect(fetched.mock.calls.some(([url]) => String(url).includes('blocked-sites'))).toBe(false)
    act(() => document.querySelector<HTMLButtonElement>('[data-live-view-blocked-sites]')!.click())
    await flush()
    expect(document.querySelector('[role="dialog"][aria-label="Agent site access"]')).not.toBeNull()
    expect(fetched.mock.calls.some(([url]) => String(url).includes('/api/account/browser/blocked-sites'))).toBe(true)
  })
})
