/**
 * One cloud tab over CDP (src/lib/cloud-browser/cdp/page.ts), against a fake
 * connection:
 *  - set-up: the runtime at document start in the dial8-agent world, frames
 *    attached paused, never Runtime.enable;
 *  - the agent world found with createIsolatedWorld (once per document);
 *  - out-of-process frames read through their own session;
 *  - real input refused off the view or under pinch zoom;
 *  - navigation settles on its own load; the guard cancels main-frame loads
 *    into a blocked site with one notice, and a blocked popup never opens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudPage } from '../page'
import { fakeCdp, flush } from './fake-cdp'

const tree = (id: string, url: string, children: unknown[] = []) => ({ frameTree: { frame: { id, url }, childFrames: children } })
const viewport = { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 }, cssVisualViewport: { scale: 1, zoom: 1 } }

function setup(answers: Record<string, unknown | ((params: Record<string, unknown>, sessionId?: string) => unknown)> = {}) {
  let contexts = 0
  const conn = fakeCdp((method, params, sessionId) => {
    const answer = answers[method]
    if (typeof answer === 'function') return answer(params, sessionId)
    if (answer !== undefined) return answer
    if (method === 'Page.getFrameTree') return tree('top', 'https://example.com/')
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ++contexts }
    if (method === 'Page.getLayoutMetrics') return viewport
    return {}
  })
  const register = vi.fn()
  const page = new CloudPage({ conn, register }, 'target-1', 'root')
  return { conn, page, register }
}

afterEach(() => { vi.useRealTimers() })

describe('attachSession', () => {
  it('puts the runtime in every frame at document start, in its own world, before the page runs', async () => {
    const { conn, page, register } = setup()
    await page.attachSession('root', true)
    const methods = conn.methods('root')
    expect(methods).toEqual(['Page.enable', 'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
      'Target.setAutoAttach', 'Page.getFrameTree', 'Runtime.runIfWaitingForDebugger'])
    const script = conn.calls.find(call => call.method === 'Page.addScriptToEvaluateOnNewDocument')!.params
    expect(script).toMatchObject({ worldName: 'dial8-agent', runImmediately: true })
    expect(String(script.source)).toContain('window.__dial8Agent')
    expect(conn.calls.find(call => call.method === 'Target.setAutoAttach')!.params)
      .toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] })
    expect(conn.calls.some(call => call.method === 'Runtime.enable')).toBe(false)
    expect(register).toHaveBeenCalledWith('root', page)
    expect(page.mainFrameId).toBe('top')
    expect(page.url).toBe('https://example.com/')
  })
})

describe('reads', () => {
  it('finds the agent world once per document, and again after a navigation', async () => {
    const { conn, page } = setup({ 'Runtime.evaluate': { result: { value: '{"elements":[],"observationId":1}' } } })
    await page.attachSession('root', false)
    await page.decisionSnapshot()
    await page.decisionSnapshot()
    expect(conn.methods().filter(method => method === 'Page.createIsolatedWorld')).toHaveLength(1)
    page.handle('Page.frameNavigated', { frame: { id: 'top', url: 'https://example.com/next' } }, 'root')
    await page.decisionSnapshot()
    expect(conn.methods().filter(method => method === 'Page.createIsolatedWorld')).toHaveLength(2)
    expect(conn.calls.filter(call => call.method === 'Runtime.evaluate').map(call => call.params.contextId)).toEqual([1, 1, 2])
  })

  it('finds the world again once when its context went away mid-read', async () => {
    let first = true
    const { conn, page } = setup({ 'Runtime.evaluate': () => {
      if (first) { first = false; return new Error('Runtime.evaluate: Cannot find context with specified id') }
      return { result: { value: '{"elements":[],"observationId":1}' } }
    } })
    await page.attachSession('root', false)
    expect(JSON.parse(await page.decisionSnapshot()).main).toEqual({ elements: [], observationId: 1 })
    expect(conn.methods().filter(method => method === 'Page.createIsolatedWorld')).toHaveLength(2)
  })

  it('reads an out-of-process frame through its own session, and lets other targets run', async () => {
    const { conn, page, register } = setup({
      'Page.getFrameTree': (_params: unknown, sessionId?: string) => sessionId === 'child'
        ? { frameTree: { frame: { id: 'remote', parentId: 'top', url: 'https://widget.test/' } } } : tree('top', 'https://example.com/'),
      'Runtime.evaluate': (_params: unknown, sessionId?: string) => ({ result: { value: sessionId === 'child'
        ? '{"elements":[],"observationId":2,"framePath":[0]}' : '{"elements":[],"observationId":1}' } }),
    })
    await page.attachSession('root', false)
    page.handle('Page.frameAttached', { frameId: 'remote', parentFrameId: 'top' }, 'root')
    page.handle('Page.frameDetached', { frameId: 'remote', reason: 'swap' }, 'root')
    page.handle('Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe', targetId: 'remote' }, waitingForDebugger: true }, 'root')
    page.handle('Target.attachedToTarget', { sessionId: 'worker', targetInfo: { type: 'worker' }, waitingForDebugger: true }, 'root')
    await flush(); await flush()
    expect(register).toHaveBeenCalledWith('child', page)
    expect(conn.methods('child')).toContain('Runtime.runIfWaitingForDebugger')
    expect(conn.methods('worker')).toEqual(['Runtime.runIfWaitingForDebugger'])
    const snapshot = JSON.parse(await page.decisionSnapshot())
    expect(snapshot.frames).toEqual([{ elements: [], observationId: 2, framePath: [0] }])
    expect(conn.calls.find(call => call.method === 'Page.createIsolatedWorld' && call.sessionId === 'child')!.params.frameId).toBe('remote')

    page.handle('Target.detachedFromTarget', { sessionId: 'child' }, 'root')
    expect(register).toHaveBeenCalledWith('child', null)
    expect(JSON.parse(await page.decisionSnapshot()).frames).toEqual([])
  })
})

describe('real input', () => {
  const clickAt = (x: number, y: number) => ({ 'Runtime.evaluate': { result: { value: `{"ok":true,"input":{"kind":"click","x":${x},"y":${y}}}` } } })

  it('clicks where the runtime says, in CSS pixels of the view', async () => {
    const { conn, page } = setup(clickAt(100, 200))
    await page.attachSession('root', false)
    expect(await page.taskAction({ operation: 'click', ref: 'e1', deadline: Date.now() + 5000 })).toBe('{"ok":true}')
    const input = conn.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params)
    expect(input.map(event => event.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(input.every(event => event.x === 100 && event.y === 200)).toBe(true)
  })

  it('refuses a point outside the view, or a pinch-zoomed view: an unknown outcome, never a click', async () => {
    for (const [answers, label] of [[clickAt(900, 10), 'off the view'],
      [{ ...clickAt(10, 10), 'Page.getLayoutMetrics': { ...viewport, cssVisualViewport: { scale: 2 } } }, 'pinch zoom']] as const) {
      const { conn, page } = setup(answers)
      await page.attachSession('root', false)
      expect(JSON.parse(await page.taskAction({ operation: 'click', deadline: Date.now() + 5000 })), label).toEqual({ ok: false, code: 'write_outcome_unknown' })
      expect(conn.methods()).not.toContain('Input.dispatchMouseEvent')
    }
  })

  it('presses Enter with its text and Escape without', async () => {
    for (const key of ['Enter', 'Escape']) {
      const { conn, page } = setup({ 'Runtime.evaluate': { result: { value: `{"ok":true,"input":{"kind":"key","key":"${key}"}}` } } })
      await page.attachSession('root', false)
      await page.taskAction({ operation: 'press_key', deadline: Date.now() + 5000 })
      const events = conn.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.params)
      expect(events.map(event => event.type)).toEqual(key === 'Enter' ? ['keyDown', 'keyUp'] : ['rawKeyDown', 'keyUp'])
      expect(events[0].text).toBe(key === 'Enter' ? '\r' : undefined)
    }
  })
})

describe('navigate', () => {
  it('settles on its own load, not an earlier one', async () => {
    const { page } = setup({ 'Page.navigate': { loaderId: 'L2' } })
    await page.attachSession('root', false)
    let settled = false
    const pending = page.navigate('https://example.com/next', new AbortController().signal, Date.now() + 5000).then(() => { settled = true })
    await flush()
    page.handle('Page.lifecycleEvent', { frameId: 'top', loaderId: 'L1', name: 'load' }, 'root')
    page.handle('Page.lifecycleEvent', { frameId: 'top', loaderId: 'L2', name: 'DOMContentLoaded' }, 'root')
    await flush()
    expect(settled).toBe(false)
    page.handle('Page.lifecycleEvent', { frameId: 'top', loaderId: 'L2', name: 'load' }, 'root')
    await pending
    expect(settled).toBe(true)
  })

  it('settles when the navigation is over without a load (a guard abort, a download), as on the desktop', async () => {
    const aborted = setup({ 'Page.navigate': { errorText: 'net::ERR_ABORTED', loaderId: 'L' } })
    await aborted.page.attachSession('root', false)
    await expect(aborted.page.navigate('https://redirects-into-blocked.test/', new AbortController().signal, Date.now() + 5000)).resolves.toBeUndefined()
  })

  it('fails, times out and cancels with the desktop messages', async () => {
    const failed = setup({ 'Page.navigate': new Error('Page.navigate: connection closed') })
    await failed.page.attachSession('root', false)
    await expect(failed.page.navigate('https://nowhere.test/', new AbortController().signal, Date.now() + 5000)).rejects.toThrow('Browser navigation failed')

    vi.useFakeTimers()
    const slow = setup({ 'Page.navigate': { loaderId: 'L' } })
    await slow.page.attachSession('root', false)
    const timedOut = expect(slow.page.navigate('https://example.com/', new AbortController().signal, Date.now() + 60_000)).rejects.toThrow('did not settle')
    await vi.advanceTimersByTimeAsync(10_001)
    await timedOut

    const controller = new AbortController()
    const cancelled = expect(slow.page.navigate('https://example.com/', controller.signal, Date.now() + 60_000)).rejects.toThrow('Browser task cancelled')
    controller.abort()
    await cancelled
  })
})

describe('the navigation guard', () => {
  const paused = (url: string, frameId = 'top', requestId = 'r1') => ({ requestId, frameId, resourceType: 'Document', request: { url } })

  it('cancels a main-frame load into a blocked site, keeps the page, and says so once', async () => {
    const { conn, page } = setup()
    await page.attachSession('root', false)
    const notices: unknown[] = []
    page.onNotice(notice => notices.push(notice))
    await page.setGuard(['LinkedIn.com'], 60_000)
    expect(conn.calls.find(call => call.method === 'Fetch.enable')!.params).toEqual({ patterns: [{ resourceType: 'Document', requestStage: 'Request' }] })
    page.handle('Fetch.requestPaused', paused('https://www.linkedin.com/feed'), 'root')
    page.handle('Fetch.requestPaused', paused('https://www.linkedin.com/feed', 'top', 'r2'), 'root')
    page.handle('Fetch.requestPaused', paused('https://www.linkedin.com/widget', 'child-frame', 'r3'), 'root')
    page.handle('Fetch.requestPaused', paused('https://example.com/', 'top', 'r4'), 'root')
    await flush()
    expect(conn.calls.filter(call => call.method === 'Fetch.failRequest').map(call => call.params))
      .toEqual([{ requestId: 'r1', errorReason: 'Aborted' }, { requestId: 'r2', errorReason: 'Aborted' }])
    expect(conn.calls.filter(call => call.method === 'Fetch.continueRequest').map(call => call.params.requestId)).toEqual(['r3', 'r4'])
    expect(notices).toEqual([{ kind: 'agent-navigation-blocked', site: 'linkedin.com' }])
  })

  it('ends with its lease, or when cleared', async () => {
    vi.useFakeTimers()
    const { conn, page } = setup()
    await page.attachSession('root', false)
    await page.setGuard(['linkedin.com'], 1000)
    await vi.advanceTimersByTimeAsync(1001)
    expect(conn.methods()).toContain('Fetch.disable')
    page.handle('Fetch.requestPaused', paused('https://linkedin.com/'), 'root')
    await vi.advanceTimersByTimeAsync(1)
    expect(conn.methods()).not.toContain('Fetch.failRequest')

    await page.setGuard(['linkedin.com'], 60_000)
    await page.setGuard([], 60_000)
    expect(conn.methods().filter(method => method === 'Fetch.disable')).toHaveLength(2)
  })

  it('a popup into a blocked site never opens: the opener gets the notice', async () => {
    const opener = setup().page
    const notices: unknown[] = []
    opener.onNotice(notice => notices.push(notice))
    await opener.setGuard(['linkedin.com'], 60_000)
    const { conn, page } = setup({ 'Page.getFrameTree': tree('popup', 'about:blank') })
    page.opener = opener
    page.inheritGuard(opener)
    await page.attachSession('root', true)
    expect(conn.methods().indexOf('Fetch.enable')).toBeLessThan(conn.methods().indexOf('Runtime.runIfWaitingForDebugger'))
    page.handle('Fetch.requestPaused', paused('https://www.linkedin.com/jobs', 'popup'), 'root')
    await flush(); await flush()
    expect(notices).toEqual([{ kind: 'agent-navigation-blocked', site: 'linkedin.com' }])
    expect(conn.calls.find(call => call.method === 'Target.closeTarget')!.params).toEqual({ targetId: 'target-1' })
  })
})

describe('review fixes', () => {
  const readsOf = (conn: ReturnType<typeof setup>['conn']) =>
    conn.calls.filter(call => call.method === 'Page.createIsolatedWorld').map(call => call.params.frameId)

  it('forgets the old document’s frames on a new main document, and re-reads them after a back/forward restore', async () => {
    const { conn, page } = setup({ 'Runtime.evaluate': { result: { value: '{"elements":[],"observationId":1}' } } })
    await page.attachSession('root', false)
    page.handle('Page.frameAttached', { frameId: 'ad', parentFrameId: 'top' }, 'root')
    page.handle('Page.frameNavigated', { frame: { id: 'top', url: 'https://example.com/next' } }, 'root')
    await page.decisionSnapshot()
    expect(readsOf(conn)).toEqual(['top'])

    conn.calls.length = 0
    conn.send.mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      conn.calls.push({ method, params, sessionId })
      if (method === 'Page.getFrameTree') return tree('top', 'https://example.com/', [{ frame: { id: 'kept', parentId: 'top', url: 'https://example.com/w' } }])
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 }
      if (method === 'Runtime.evaluate') return { result: { value: '{"elements":[],"observationId":1}' } }
      return {}
    })
    page.handle('Page.frameNavigated', { frame: { id: 'top', url: 'https://example.com/' }, type: 'BackForwardCacheRestore' }, 'root')
    await flush()
    await page.decisionSnapshot()
    expect(readsOf(conn)).toContain('kept')
  })

  it('forgets a frame Chrome no longer has', async () => {
    const { conn, page } = setup({
      'Page.createIsolatedWorld': (params: Record<string, unknown>) => params.frameId === 'gone' ? new Error('Page.createIsolatedWorld: No frame for given id found') : { executionContextId: 1 },
      'Runtime.evaluate': { result: { value: '{"elements":[],"observationId":1}' } },
    })
    await page.attachSession('root', false)
    page.handle('Page.frameAttached', { frameId: 'gone', parentFrameId: 'top' }, 'root')
    await page.decisionSnapshot()
    await page.decisionSnapshot()
    expect(readsOf(conn).filter(id => id === 'gone')).toHaveLength(1)
  })

  it('reads the newest 32 frames', async () => {
    const { conn, page } = setup({ 'Runtime.evaluate': { result: { value: '{"elements":[],"observationId":1}' } } })
    await page.attachSession('root', false)
    for (let i = 0; i < 40; i++) page.handle('Page.frameAttached', { frameId: `f${i}`, parentFrameId: 'top' }, 'root')
    await page.decisionSnapshot()
    const read = readsOf(conn).filter(id => id !== 'top')
    expect(read).toHaveLength(32)
    expect(read).not.toContain('f0')
    expect(read).toContain('f39')
  })

  it('bypasses service workers while guarded, and a failed enable is retried, not taken as on', async () => {
    let fail = true
    const { conn, page } = setup({ 'Fetch.enable': () => fail ? new Error('Fetch.enable: timed out') : {} })
    await page.attachSession('root', false)
    await expect(page.setGuard(['linkedin.com'], 60_000)).rejects.toThrow('timed out')
    fail = false
    await page.setGuard(['linkedin.com'], 60_000)
    expect(conn.methods().filter(method => method === 'Fetch.enable')).toHaveLength(2)
    expect(conn.calls.filter(call => call.method === 'Network.setBypassServiceWorker').map(call => call.params.bypass)).toEqual([true, true])
    await page.setGuard([], 0)
    expect(conn.calls.filter(call => call.method === 'Network.setBypassServiceWorker').map(call => call.params.bypass)).toEqual([true, true, false])
    // The bypass applies only with the Network domain on.
    const methods = conn.methods()
    expect(methods.indexOf('Network.enable')).toBeLessThan(methods.indexOf('Network.setBypassServiceWorker'))
    expect(methods.at(-1)).toBe('Network.disable')
  })

  it('leaves a blocked page that committed without a request (the back/forward cache), back where it was', async () => {
    const { conn, page } = setup({ 'Page.getNavigationHistory': { currentIndex: 1, entries: [{ id: 10, url: 'https://example.com/' }, { id: 11, url: 'https://www.linkedin.com/feed' }] } })
    await page.attachSession('root', false)
    const notices: unknown[] = []
    page.onNotice(notice => notices.push(notice))
    await page.setGuard(['linkedin.com'], 60_000)
    page.handle('Page.frameNavigated', { frame: { id: 'top', url: 'https://www.linkedin.com/feed' }, type: 'BackForwardCacheRestore' }, 'root')
    await flush(); await flush()
    expect(notices).toEqual([{ kind: 'agent-navigation-blocked', site: 'linkedin.com' }])
    expect(conn.calls.find(call => call.method === 'Page.navigateToHistoryEntry')!.params).toEqual({ entryId: 10 })
  })

  it('never leaves a target paused: a failed set-up still resumes it, and an unguarded popup is closed instead', async () => {
    const plain = setup({ 'Page.getFrameTree': new Error('Page.getFrameTree: timed out') })
    await expect(plain.page.attachSession('root', true)).rejects.toThrow()
    expect(plain.conn.methods().at(-1)).toBe('Runtime.runIfWaitingForDebugger')

    const opener = setup().page
    await opener.setGuard(['linkedin.com'], 60_000)
    const popup = setup({ 'Fetch.enable': new Error('Fetch.enable: timed out') })
    popup.page.opener = opener
    popup.page.inheritGuard(opener)
    await expect(popup.page.attachSession('root', true)).rejects.toThrow()
    expect(popup.conn.methods()).not.toContain('Runtime.runIfWaitingForDebugger')
    expect(popup.conn.methods()).toContain('Target.closeTarget')
  })

  it('runs an action’s script as a user gesture, never a read’s', async () => {
    const { conn, page } = setup({ 'Runtime.evaluate': { result: { value: '{"ok":true}' } } })
    await page.attachSession('root', false)
    await page.decisionSnapshot()
    await page.getText()
    await page.taskAction({ operation: 'click', deadline: Date.now() + 5000 })
    await page.click('e1')
    expect(conn.calls.filter(call => call.method === 'Runtime.evaluate').map(call => call.params.userGesture === true)).toEqual([false, false, true, true])
  })

  it('bounds a whole action, and no input lands once the caller has its answer', async () => {
    vi.useFakeTimers()
    let release = () => {}
    const { conn, page } = setup({ 'Runtime.evaluate': () => new Promise(resolve => {
      release = () => resolve({ result: { value: '{"ok":true,"input":{"kind":"click","x":10,"y":10}}' } })
    }) })
    await page.attachSession('root', false)
    const action = expect(page.taskAction({ operation: 'click', deadline: Date.now() + 60_000 })).rejects.toThrow('eval timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await action
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(conn.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params.type)).not.toContain('mousePressed')
  })

  it('keeps a popup that opened elsewhere and redirects into a blocked site, with its own notice', async () => {
    const opener = setup().page
    const openerNotices: unknown[] = []
    opener.onNotice(notice => openerNotices.push(notice))
    await opener.setGuard(['linkedin.com'], 60_000)
    const { conn, page } = setup({ 'Page.getFrameTree': tree('popup', 'about:blank') })
    page.opener = opener
    page.inheritGuard(opener)
    await page.attachSession('root', true)
    const own: unknown[] = []
    page.onNotice(notice => own.push(notice))
    page.handle('Fetch.requestPaused', { requestId: 'r2', redirectedRequestId: 'r1', frameId: 'popup', resourceType: 'Document',
      request: { url: 'https://www.linkedin.com/jobs' } }, 'root')
    await flush(); await flush()
    expect(own).toEqual([{ kind: 'agent-navigation-blocked', site: 'linkedin.com' }])
    expect(openerNotices).toEqual([])
    expect(conn.methods()).not.toContain('Target.closeTarget')
  })

  it('a popup’s inherited guard ends with its opener’s lease', async () => {
    vi.useFakeTimers()
    const opener = setup().page
    await opener.setGuard(['linkedin.com'], 1000)
    const { conn, page } = setup({ 'Page.getFrameTree': tree('popup', 'about:blank') })
    page.opener = opener
    page.inheritGuard(opener)
    await page.attachSession('root', true)
    await vi.advanceTimersByTimeAsync(1001)
    expect(conn.methods()).toContain('Fetch.disable')
  })
})
