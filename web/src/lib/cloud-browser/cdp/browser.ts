import { CdpConnection, type CdpParams, type CdpTransport } from './connection'
import { captureJpeg, CloudPage, type PageHost, type ScreenshotOptions } from './page'

/**
 * The cloud browser's Chrome over one CDP connection (docs/plans/cloud-browser.md,
 * C1): the pages the agent drives, the popups they open, and the browser-wide
 * rules the desktop has today.
 * - Downloads are refused (the desktop's "download-unsupported").
 * - New pages attach paused, so a popup is set up (the runtime, its opener's
 *   guard) before it loads anything. A popup becomes a new tab, as on the
 *   desktop; the task keeps driving its own page.
 * - A page this connection doesn't drive (a tab the person opened) is let go
 *   at once.
 */

/** Page and frame events a CloudPage handles, routed by session. */
const PAGE_EVENTS = ['Page.frameAttached', 'Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameDetached',
  'Page.lifecycleEvent', 'Fetch.requestPaused', 'Target.attachedToTarget', 'Target.detachedFromTarget']
/** How long openPage waits for its tab's attach event before attaching to it directly. */
const CLAIM_MS = 1000

type Parked = { sessionId: string; waiting: boolean; timer: ReturnType<typeof setTimeout> }

export class CloudBrowser {
  private pages = new Map<string, CloudPage>()
  private bySession = new Map<string, CloudPage>()
  private claims = new Map<string, (page: CloudPage) => void>()
  private parked = new Map<string, Parked>()
  /** openPage calls waiting for Target.createTarget: only then can an unknown new page be the agent's. */
  private creating = 0
  /** Tabs attachPage is attaching (one attach each, however many ask): their attach event is its own, never a page to let go. */
  private attaching = new Map<string, Promise<CloudPage>>()
  /** Tabs a peek has attached for a moment: never adopted, never let go by onPageAttached. */
  private peeking = new Set<string>()
  private pageListeners = new Set<(page: CloudPage) => void>()
  private readonly host: PageHost

  private constructor(readonly conn: CdpTransport) {
    this.host = { conn, register: (sessionId, page) => { if (page) this.bySession.set(sessionId, page); else this.bySession.delete(sessionId) } }
    for (const method of PAGE_EVENTS) {
      conn.on(method, (params, sessionId) => {
        if (sessionId) { this.bySession.get(sessionId)?.handle(method, params, sessionId); return }
        if (method === 'Target.attachedToTarget') void this.onPageAttached(params)
        if (method === 'Target.detachedFromTarget') this.onPageDetached(params)
      })
    }
    conn.on('Browser.downloadWillBegin', params => {
      for (const page of this.pages.values()) if (page.mainFrameId === params.frameId) page.notify({ kind: 'download-unsupported' })
    })
  }

  static async connect(endpoint: number | string = 9222): Promise<CloudBrowser> {
    return CloudBrowser.over(await CdpConnection.connect(endpoint))
  }

  /** Set up the browser-wide rules on an open connection. */
  static async over(conn: CdpTransport): Promise<CloudBrowser> {
    const browser = new CloudBrowser(conn)
    await browser.conn.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true })
    await browser.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] })
    return browser
  }

  /** The pages this connection drives (tabs it opened or attached, and their popups). */
  list(): CloudPage[] { return [...this.pages.values()].filter(page => !page.closed) }

  onPage(listener: (page: CloudPage) => void): () => void {
    this.pageListeners.add(listener)
    return () => { this.pageListeners.delete(listener) }
  }

  /** A new tab for the agent. */
  async openPage(): Promise<CloudPage> {
    this.creating++
    let targetId: string
    try {
      targetId = (await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId
    } finally {
      this.creating--
    }
    const parked = this.parked.get(targetId)
    if (parked) { this.releaseParked(targetId); return this.adopt(targetId, parked.sessionId, parked.waiting, null) }
    this.releaseParked()
    return new Promise<CloudPage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.claims.delete(targetId)
        // Not auto-attached (an older Chrome): attach to it directly.
        this.attachPage(targetId).then(resolve, reject)
      }, CLAIM_MS)
      this.claims.set(targetId, page => { clearTimeout(timer); resolve(page) })
    })
  }

  /** Drive a tab that already exists (the person's, or one restored with the profile). */
  async attachPage(targetId: string): Promise<CloudPage> {
    const existing = this.pages.get(targetId)
    if (existing && !existing.closed) return existing
    const inflight = this.attaching.get(targetId)
    if (inflight) return inflight
    // Recorded before the attach is sent: its event may come before its answer.
    const attach = Promise.resolve()
      .then(() => this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }))
      .then(({ sessionId }) => this.adopt(targetId, sessionId, false, null))
    this.attaching.set(targetId, attach)
    try {
      return await attach
    } finally {
      this.attaching.delete(targetId)
    }
  }

  /**
   * A JPEG of what Chrome shows, for the computer card: the agent's tab when
   * this connection drives one, else the browser's own first page, looked at
   * without driving it (attached for the capture only: no agent runtime, no
   * guard, nothing adopted). Null when Chrome has no page.
   */
  async peek(options: ScreenshotOptions = {}): Promise<string | null> {
    const driven = this.list()[0]
    if (driven) return driven.screenshot(options)
    const { targetInfos } = await this.conn.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')
    const page = targetInfos.find(target => target.type === 'page' && !/^(chrome|devtools|chrome-untrusted):/.test(target.url))
    if (!page) return null
    this.peeking.add(page.targetId)
    try {
      const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })
      try {
        return await captureJpeg(this.conn, sessionId, options)
      } finally {
        await this.conn.send('Target.detachFromTarget', { sessionId }).catch(() => {})
      }
    } finally {
      this.peeking.delete(page.targetId)
    }
  }

  close() { this.conn.close() }

  private async adopt(targetId: string, sessionId: string, waiting: boolean, opener: CloudPage | null): Promise<CloudPage> {
    const page = new CloudPage(this.host, targetId, sessionId)
    this.pages.set(targetId, page)
    if (opener) { page.opener = opener; page.inheritGuard(opener) }
    await page.attachSession(sessionId, waiting)
    for (const listener of this.pageListeners) listener(page)
    return page
  }

  private async onPageAttached(params: CdpParams) {
    const sessionId = String(params.sessionId ?? '')
    const info = params.targetInfo as { targetId: string; type?: string; openerId?: string } | undefined
    if (!info || info.type !== 'page' || this.attaching.has(info.targetId) || this.peeking.has(info.targetId)) return
    const waiting = params.waitingForDebugger === true
    const opener = info.openerId ? this.pages.get(info.openerId) : undefined
    const claim = this.claims.get(info.targetId)
    if (claim || (opener && !opener.closed)) {
      this.claims.delete(info.targetId)
      const page = await this.adopt(info.targetId, sessionId, waiting, opener ?? null).catch(() => null)
      if (page) claim?.(page)
      return
    }
    // Not ours. A tab the person opened runs at once; only while openPage awaits createTarget
    // might it be the agent's, so it waits for that answer (and at most CLAIM_MS).
    const release = () => this.let(info.targetId, sessionId)
    if (this.creating === 0) { release(); return }
    this.parked.set(info.targetId, { sessionId, waiting, timer: setTimeout(release, CLAIM_MS) })
  }

  /** Let a page this connection doesn't drive run, and stop watching it. */
  private let(targetId: string, sessionId: string) {
    const parked = this.parked.get(targetId)
    if (parked) { clearTimeout(parked.timer); this.parked.delete(targetId) }
    void this.conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      .then(() => this.conn.send('Target.detachFromTarget', { sessionId })).catch(() => {})
  }

  /** Stop holding parked pages: `keep` (the one openPage claims) is adopted, the rest released once no openPage is pending. */
  private releaseParked(keep?: string) {
    if (keep) {
      const parked = this.parked.get(keep)
      if (parked) { clearTimeout(parked.timer); this.parked.delete(keep) }
    }
    if (this.creating > 0) return
    for (const [targetId, parked] of [...this.parked]) this.let(targetId, parked.sessionId)
  }

  private onPageDetached(params: CdpParams) {
    const page = this.bySession.get(String(params.sessionId ?? ''))
    if (!page || page.sessionId !== params.sessionId) return
    page.detached()
    this.pages.delete(page.targetId)
  }
}
