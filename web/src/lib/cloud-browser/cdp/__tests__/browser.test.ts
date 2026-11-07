/**
 * The cloud browser over one connection (src/lib/cloud-browser/cdp/browser.ts),
 * against a fake connection: downloads refused, new pages attached paused,
 * the agent's own tab claimed whichever event comes first, a popup set up
 * with its opener's guard before it runs, and a tab the person opened let go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudBrowser } from '../browser'
import { fakeCdp, flush } from './fake-cdp'

const pageTree = (id: string, url = 'about:blank') => ({ frameTree: { frame: { id, url } } })
const attached = (targetId: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId, targetInfo: { targetId, type: 'page', ...extra }, waitingForDebugger: true })

/** `attach`: when Chrome reports the new tab, relative to createTarget's answer (it sends the event first). */
function setup(attach: 'before' | 'after' | 'never' = 'before') {
  const conn: ReturnType<typeof fakeCdp> = fakeCdp(async (method, _params, sessionId) => {
    if (method === 'Target.createTarget') {
      if (attach === 'before') conn.emit('Target.attachedToTarget', attached('tab-1', 's-tab'))
      if (attach === 'after') setTimeout(() => conn.emit('Target.attachedToTarget', attached('tab-1', 's-tab')), 5)
      return { targetId: 'tab-1' }
    }
    if (method === 'Page.getFrameTree') return pageTree(sessionId === 's-popup' ? 'popup' : 'tab-1')
    return {}
  })
  return conn
}

afterEach(() => { vi.useRealTimers() })

describe('CloudBrowser', () => {
  it('refuses downloads and attaches new pages paused', async () => {
    const conn = setup()
    await CloudBrowser.over(conn)
    expect(conn.calls[0]).toMatchObject({ method: 'Browser.setDownloadBehavior', params: { behavior: 'deny', eventsEnabled: true } })
    expect(conn.calls[1]).toMatchObject({ method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] } })
    expect(conn.calls.every(call => call.sessionId === undefined)).toBe(true)
  })

  it('claims its own tab whether the attach comes before or after createTarget answers', async () => {
    const before = setup('before')
    const browser = await CloudBrowser.over(before)
    const early = await browser.openPage()
    expect(early.sessionId).toBe('s-tab')
    expect(before.methods('s-tab')).toContain('Runtime.runIfWaitingForDebugger')
    expect(before.methods()).not.toContain('Target.detachFromTarget')

    const after = setup('after')
    const other = await CloudBrowser.over(after)
    expect((await other.openPage()).targetId).toBe('tab-1')
    expect(other.list()).toHaveLength(1)
  })

  it('attaches to its tab directly when no attach event comes', async () => {
    const conn = setup('never')
    const browser = await CloudBrowser.over(conn)
    conn.send.mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      conn.calls.push({ method, params, sessionId })
      if (method === 'Target.createTarget') return { targetId: 'tab-1' }
      if (method === 'Target.attachToTarget') return { sessionId: 's-direct' }
      if (method === 'Page.getFrameTree') return pageTree('tab-1')
      return {}
    })
    expect((await browser.openPage()).sessionId).toBe('s-direct')
  })

  it('sets a popup up with its opener guard before it runs, and reports it', async () => {
    const conn = setup()
    const browser = await CloudBrowser.over(conn)
    const page = await browser.openPage()
    await page.setGuard(['linkedin.com'], 60_000)
    const opened: string[] = []
    browser.onPage(popup => opened.push(popup.targetId))
    conn.emit('Target.attachedToTarget', attached('popup', 's-popup', { openerId: 'tab-1' }))
    await flush(); await flush(); await flush()
    const methods = conn.methods('s-popup')
    expect(methods).toContain('Fetch.enable')
    expect(methods.indexOf('Fetch.enable')).toBeLessThan(methods.indexOf('Runtime.runIfWaitingForDebugger'))
    expect(opened).toEqual(['popup'])
    expect(browser.list().find(entry => entry.targetId === 'popup')?.opener).toBe(page)
  })

  it('lets a tab it does not drive run at once, and stops watching it', async () => {
    const conn = setup()
    await CloudBrowser.over(conn)
    conn.emit('Target.attachedToTarget', attached('persons-tab', 's-person'))
    await flush()
    expect(conn.methods('s-person')).toEqual(['Runtime.runIfWaitingForDebugger'])
    expect(conn.calls.at(-1)).toMatchObject({ method: 'Target.detachFromTarget', params: { sessionId: 's-person' } })
  })

  it('drives a tab that already exists, keeping the session its own attach makes, once however many ask', async () => {
    const conn: ReturnType<typeof fakeCdp> = fakeCdp(method => {
      if (method === 'Target.attachToTarget') {
        // Chrome reports the attach before it answers.
        conn.emit('Target.attachedToTarget', { sessionId: 's-restored', targetInfo: { targetId: 'restored', type: 'page' }, waitingForDebugger: false })
        return { sessionId: 's-restored' }
      }
      if (method === 'Page.getFrameTree') return pageTree('restored', 'https://example.com/')
      return {}
    })
    const browser = await CloudBrowser.over(conn)
    const [first, second] = await Promise.all([browser.attachPage('restored'), browser.attachPage('restored')])
    await flush()
    expect(first).toBe(second)
    expect(conn.methods().filter(method => method === 'Target.attachToTarget')).toHaveLength(1)
    expect(conn.methods()).not.toContain('Target.detachFromTarget')
    expect(browser.list()).toEqual([first])
  })

  it('peeks at a tab it does not drive without taking it: no runtime, nothing adopted, detached after', async () => {
    const conn: ReturnType<typeof fakeCdp> = fakeCdp(method => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'devtools', type: 'page', url: 'devtools://x' }, { targetId: 'persons', type: 'page', url: 'https://example.com/' }] }
      if (method === 'Target.attachToTarget') {
        conn.emit('Target.attachedToTarget', { sessionId: 's-peek', targetInfo: { targetId: 'persons', type: 'page' }, waitingForDebugger: false })
        return { sessionId: 's-peek' }
      }
      if (method === 'Page.captureScreenshot') return { data: 'jpeg-base64' }
      return {}
    })
    const browser = await CloudBrowser.over(conn)
    expect(await browser.peek({ quality: 0.6 })).toBe('jpeg-base64')
    await flush()
    expect(conn.calls.find(call => call.method === 'Target.attachToTarget')?.params).toMatchObject({ targetId: 'persons' })
    expect(conn.methods('s-peek')).toEqual(['Page.captureScreenshot'])
    expect(conn.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params)).toEqual([{ sessionId: 's-peek' }])
    expect(browser.list()).toEqual([])
  })

  it('holds a new tab only while its own openPage awaits createTarget', async () => {
    let answer = (_value: unknown) => {}
    const conn: ReturnType<typeof fakeCdp> = fakeCdp(method => {
      if (method === 'Target.createTarget') return new Promise(resolve => { answer = resolve })
      if (method === 'Page.getFrameTree') return pageTree('tab-1')
      return {}
    })
    const browser = await CloudBrowser.over(conn)
    const pending = browser.openPage()
    await flush()
    conn.emit('Target.attachedToTarget', attached('persons-tab', 's-person'))
    conn.emit('Target.attachedToTarget', attached('tab-1', 's-tab'))
    await flush()
    expect(conn.methods('s-person')).toEqual([])
    answer({ targetId: 'tab-1' })
    expect((await pending).sessionId).toBe('s-tab')
    await flush()
    expect(conn.methods('s-person')).toEqual(['Runtime.runIfWaitingForDebugger'])
  })

  it('routes events by session, tells a page about its downloads, and forgets a closed tab', async () => {
    const conn = setup()
    const browser = await CloudBrowser.over(conn)
    const page = await browser.openPage()
    const notices: unknown[] = []
    page.onNotice(notice => notices.push(notice))
    conn.emit('Page.frameNavigated', { frame: { id: 'tab-1', url: 'https://example.com/' } }, 's-tab')
    conn.emit('Page.frameNavigated', { frame: { id: 'tab-1', url: 'https://elsewhere.test/' } }, 's-unknown')
    expect(page.url).toBe('https://example.com/')
    conn.emit('Browser.downloadWillBegin', { frameId: 'tab-1', guid: 'g', url: 'https://example.com/file.bin' })
    expect(notices).toEqual([{ kind: 'download-unsupported' }])
    conn.emit('Target.detachedFromTarget', { sessionId: 's-tab' })
    expect(page.closed).toBe(true)
    expect(browser.list()).toEqual([])
  })
})
