import { AGENT_WORLD, agentRuntimeSource } from './agent-runtime'
import type { CdpParams, CdpTransport } from './connection'
import { decisionSnapshot, taskAction, type AgentFrames, type Point, type RuntimeInput } from './frames'
import { GUARD_NOTICE_DEDUPE_MS, guardBlocks, guardLease, type GuardLease } from './guard'

/**
 * One Chrome tab driven the way the desktop drives a WKWebView tab
 * (docs/plans/cloud-browser.md, C1): the agent runtime at document start in
 * every frame (out-of-process ones included) in the ni-agent isolated
 * world, decision snapshots and gated actions across frames (frames.ts), real
 * input, the navigation guard, and the reads the queue's commands use.
 *
 * Its world is found with Page.createIsolatedWorld, which returns the world
 * the document-start script made, so Runtime.enable (an automation tell) is
 * never used.
 */

export type PageNotice = { kind: 'agent-navigation-blocked'; site: string } | { kind: 'download-unsupported' }

type Frame = { id: string; parentId: string | null; sessionId: string; contextId: number | null; seq: number }
type Lifecycle = (frameId: string, loaderId: string, name: string) => void

/** The desktop's frame budget, MIN(1200, MAX(100, EVAL_TIMEOUT_MS / 2)): slow frames are left out well inside the task's 2 s read. */
export const FRAME_BUDGET_MS = 1200
/** The desktop keeps this many frame registrations per tab. */
export const MAX_READ_FRAMES = 32
const NAVIGATION_SETTLE_MS = 10_000
/** The desktop's EVAL_TIMEOUT_MS for one whole action: past it, the outcome is unknown and no input is sent. */
export const ACTION_TIMEOUT_MS = 15_000

const text = (value: unknown) => typeof value === 'string' ? value : ''
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export interface PageHost {
  conn: CdpTransport
  /** Route this session's events to the page (or stop). */
  register(sessionId: string, page: CloudPage | null): void
}

export class CloudPage {
  mainFrameId = ''
  url = ''
  closed = false
  /** Set for a popup: the page whose script or link opened it. */
  opener: CloudPage | null = null
  private frames = new Map<string, Frame>()
  private sessions = new Set<string>()
  private paths = new Map<string, string>()
  private lease: GuardLease | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | undefined
  private fetchOn = false
  private committed = false
  private frameSeq = 0
  private lastNotice = { site: '', at: 0 }
  private noticeListeners = new Set<(notice: PageNotice) => void>()
  private lifecycle = new Set<Lifecycle>()

  constructor(private host: PageHost, readonly targetId: string, readonly sessionId: string) {}

  private send<T extends CdpParams = CdpParams>(method: string, params: CdpParams = {}, sessionId = this.sessionId) {
    return this.host.conn.send<T>(method, params, sessionId)
  }

  /** Set up a session of this page (its own, or an out-of-process frame's), then let it run. */
  async attachSession(sessionId: string, waiting: boolean): Promise<void> {
    const root = sessionId === this.sessionId
    this.sessions.add(sessionId)
    this.host.register(sessionId, this)
    // A popup inherits its opener's guard; until that is in place it must not run.
    let guarded = !(root && this.lease)
    try {
      await Promise.all([
        this.send('Page.enable', {}, sessionId),
        ...(root ? [this.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)] : []),
        this.send('Page.addScriptToEvaluateOnNewDocument', { source: agentRuntimeSource(), worldName: AGENT_WORLD, runImmediately: true }, sessionId),
        // Out-of-process frames attach paused, so the runtime is in place before their first script runs.
        this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] }, sessionId),
        ...(root && this.lease ? [this.applyLease().then(() => { guarded = true })] : []),
      ])
      const { frameTree } = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, sessionId)
      this.addTree(frameTree, sessionId, root)
    } finally {
      // Never left paused: a target waiting for the debugger is a blank, frozen tab or frame.
      if (waiting && !guarded) await this.close()
      else if (waiting) await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
    }
  }

  /** Events for this page's sessions, routed by the browser. */
  handle(method: string, params: CdpParams, sessionId: string) {
    switch (method) {
      case 'Page.frameAttached': {
        const id = text(params.frameId)
        if (id && !this.frames.has(id)) this.frames.set(id, { id, parentId: text(params.parentFrameId) || null, sessionId, contextId: null, seq: ++this.frameSeq })
        return
      }
      case 'Page.frameNavigated': {
        const frame = params.frame as FrameInfo
        const existing = this.frames.get(frame.id)
        // A new document: the old one's frames are gone, whether or not Chrome said so.
        this.dropChildren(frame.id)
        this.frames.set(frame.id, { id: frame.id, parentId: frame.parentId ?? existing?.parentId ?? null, sessionId, contextId: null,
          seq: existing?.seq ?? ++this.frameSeq })
        if (!frame.parentId && sessionId === this.sessionId) {
          const previous = this.url
          const wasCommitted = this.committed
          this.mainFrameId = frame.id
          this.url = frame.url + (frame.urlFragment ?? '')
          if (this.url && this.url !== 'about:blank') this.committed = true
          this.paths.clear()
          // A page restored from the back/forward cache keeps its frames, and no event says so.
          if (params.type === 'BackForwardCacheRestore') void this.resyncFrames()
          // The guard's backstop for a load it never saw (no request: the back/forward cache).
          const site = guardBlocks(this.lease, this.url)
          if (site) void this.leaveBlocked(site, previous, wasCommitted)
        }
        return
      }
      case 'Page.navigatedWithinDocument':
        if (params.frameId === this.mainFrameId) this.url = text(params.url)
        return
      case 'Page.frameDetached': {
        const id = text(params.frameId)
        const frame = this.frames.get(id)
        // A frame moving to another process stays; its own session attaches next.
        if (params.reason === 'swap') { if (frame) frame.contextId = null }
        else this.dropFrame(id)
        return
      }
      case 'Page.lifecycleEvent':
        for (const listener of this.lifecycle) listener(text(params.frameId), text(params.loaderId), text(params.name))
        return
      case 'Fetch.requestPaused':
        void this.onRequestPaused(params)
        return
      case 'Target.attachedToTarget': {
        const child = text(params.sessionId)
        const info = params.targetInfo as { type?: string } | undefined
        if (info?.type === 'iframe') void this.attachSession(child, params.waitingForDebugger === true).catch(() => {})
        else void this.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {})
        return
      }
      case 'Target.detachedFromTarget': {
        const child = text(params.sessionId)
        this.sessions.delete(child)
        this.host.register(child, null)
        for (const frame of [...this.frames.values()]) if (frame.sessionId === child) this.frames.delete(frame.id)
        return
      }
    }
  }

  /** The root session went away (the tab closed or crashed). */
  detached() {
    this.closed = true
    clearTimeout(this.leaseTimer)
    for (const sessionId of this.sessions) this.host.register(sessionId, null)
    this.sessions.clear()
    this.frames.clear()
  }

  private addTree(node: FrameTree, sessionId: string, root: boolean, parentId: string | null = null) {
    const frame = node.frame
    const existing = this.frames.get(frame.id)
    this.frames.set(frame.id, { id: frame.id, parentId: frame.parentId ?? existing?.parentId ?? parentId, sessionId,
      contextId: existing?.sessionId === sessionId ? existing.contextId : null, seq: existing?.seq ?? ++this.frameSeq })
    if (root && !frame.parentId) {
      this.mainFrameId = frame.id
      this.url = frame.url + (frame.urlFragment ?? '')
      if (this.url && this.url !== 'about:blank') this.committed = true
    }
    for (const child of node.childFrames ?? []) this.addTree(child, sessionId, root, frame.id)
  }

  private dropFrame(id: string) {
    this.frames.delete(id)
    this.dropChildren(id)
  }

  private dropChildren(id: string) {
    for (const frame of [...this.frames.values()]) if (frame.parentId === id) this.dropFrame(frame.id)
  }

  /** Read every session's frame tree again (after a back/forward cache restore). */
  private async resyncFrames() {
    for (const sessionId of [...this.sessions]) {
      const result = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, sessionId).catch(() => null)
      if (result) this.addTree(result.frameTree, sessionId, sessionId === this.sessionId)
    }
  }

  private depth(frame: Frame): number {
    let depth = 0
    for (let parent = frame.parentId; parent && depth < 10; parent = this.frames.get(parent)?.parentId ?? null) depth++
    return depth
  }

  /** `expression`'s string result in a frame's agent world (null for any other result). Throws when the frame can't be read. */
  private async evaluate(frameId: string, expression: string, options: { gesture?: boolean } = {}): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const frame = this.frames.get(frameId)
      if (!frame || this.closed) throw new Error('frame gone')
      try {
        if (frame.contextId === null) {
          const world = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld',
            { frameId, worldName: AGENT_WORLD, grantUniveralAccess: false }, frame.sessionId).catch(error => {
            // A frame Chrome no longer has is forgotten (the desktop unregisters a frame it can't read).
            if (frameId !== this.mainFrameId && /no frame|not found/i.test((error as Error).message)) this.dropFrame(frameId)
            throw error
          })
          frame.contextId = world.executionContextId
        }
        // WebKit's evaluateJavaScript runs as a user gesture; an action's script must too (an el.click()
        // on a target=_blank link opens its tab). Reads don't, so a page can't borrow the activation.
        const result = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate',
          { expression, contextId: frame.contextId, returnByValue: true, ...(options.gesture ? { userGesture: true } : {}) }, frame.sessionId)
        if (result.exceptionDetails) throw new Error('agent eval failed')
        return typeof result.result?.value === 'string' ? result.result.value : null
      } catch (error) {
        // A navigation replaced the document: find its world again, once.
        if (attempt === 0 && /context/i.test((error as Error).message)) { frame.contextId = null; continue }
        throw error
      }
    }
  }

  private agentFrames(): AgentFrames<string> {
    // The newest frames, as the desktop keeps its most recent registrations; shallowest first.
    const children = [...this.frames.values()]
      .filter(frame => frame.id !== this.mainFrameId && this.sessions.has(frame.sessionId))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, MAX_READ_FRAMES)
      .map(frame => ({ frame, depth: this.depth(frame) }))
      .sort((a, b) => a.depth - b.depth || a.frame.seq - b.frame.seq)
      .map(({ frame }) => frame.id)
    return { main: this.mainFrameId, children, evaluate: (frame, expression, options) => this.evaluate(frame, expression, options) }
  }

  /** A task's decision snapshot: {"main":…,"frames":[…],"inputCapable":true}. */
  async decisionSnapshot(): Promise<string> {
    const result = await decisionSnapshot(this.agentFrames(), FRAME_BUDGET_MS, true)
    if (!result) throw new Error('agent runtime unavailable')
    this.paths = result.paths
    return result.json
  }

  /** One task action, gated across frames, with real input where the runtime asks for it. */
  async taskAction(request: Record<string, unknown>): Promise<string> {
    const deadline = finite(request.deadline) ? request.deadline : 0
    let abandoned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Past the bound the caller has its answer (the desktop's "eval timed out"): nothing it asked for may still land.
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abandoned = true; reject(new Error('eval timed out')) }, ACTION_TIMEOUT_MS)
    })
    const usable = () => !abandoned && !this.closed && !(deadline > 0 && Date.now() >= deadline)
    try {
      return await Promise.race([bound, taskAction(this.agentFrames(), this.paths, request,
        { inputCapable: true, deliver: (input, offset) => this.deliver(input, offset, usable) })])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Real input, as a person would produce it (send_input's twin). `usable` is checked just before it lands. */
  private async deliver(input: RuntimeInput, offset: Point, usable: () => boolean = () => true): Promise<boolean> {
    if (input.kind === 'click' && finite(input.x) && finite(input.y)) {
      const metrics = await this.send<LayoutMetrics>('Page.getLayoutMetrics')
      const layout = metrics.cssLayoutViewport, visual = metrics.cssVisualViewport
      // A pinch-zoomed view does not map the runtime's points 1:1: refuse, as for a point outside the view.
      // Page zoom needs nothing: Input takes CSS pixels of the main frame at any zoom (C1, verified at 125% and 175%).
      if (!layout || !visual || visual.scale !== 1) return false
      const x = input.x + offset.x, y = input.y + offset.y
      if (!(x >= 0 && y >= 0 && x < layout.clientWidth && y < layout.clientHeight)) return false
      const at = { x, y }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 })
      if (!usable()) return false
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 })
      return true
    }
    if (input.kind === 'key' && (input.key === 'Enter' || input.key === 'Escape')) {
      if (!usable()) return false
      const enter = input.key === 'Enter'
      const key = { key: input.key, code: input.key, windowsVirtualKeyCode: enter ? 13 : 27, nativeVirtualKeyCode: enter ? 13 : 27 }
      await this.send('Input.dispatchKeyEvent', enter ? { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' } : { type: 'rawKeyDown', ...key })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      return true
    }
    return false
  }

  /** Navigate once and wait for the new page's load: a timeout never retries against a possibly changed document. */
  navigate(url: string, signal: AbortSignal, deadline: number): Promise<void> {
    signal.throwIfAborted()
    if (this.closed || deadline <= Date.now()) return Promise.reject(new Error('Browser task unavailable'))
    return new Promise<void>((resolve, reject) => {
      let loaderId: string | null = null
      const loaded = new Set<string>()
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.lifecycle.delete(listener)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const listener: Lifecycle = (frameId, loader, name) => {
        if (frameId !== this.mainFrameId || name !== 'load') return
        loaded.add(loader)
        if (loader === loaderId) finish()
      }
      const onAbort = () => finish(new Error('Browser task cancelled'))
      const timer = setTimeout(() => finish(new Error('Browser navigation did not settle')),
        Math.max(1, Math.min(NAVIGATION_SETTLE_MS, deadline - Date.now())))
      this.lifecycle.add(listener)
      signal.addEventListener('abort', onAbort, { once: true })
      this.send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url }).then(result => {
        // Dispatched and over (a guard abort, a download, an unreachable site): settled, as on the
        // desktop. The task's next read decides; the guard's notice names a blocked site.
        if (result.errorText || !result.loaderId) return finish()
        loaderId = result.loaderId
        if (loaded.has(loaderId)) finish()
      }, () => finish(new Error('Browser navigation failed')))
    })
  }

  /** `window.__dial8Agent.<call>` in the main frame's agent world (agent_call's twin). */
  private async agentCall(call: string, missing = "{ok:false,error:'agent runtime not present'}", gesture = false): Promise<string> {
    const result = await this.evaluate(this.mainFrameId, `JSON.stringify(window.__dial8Agent ? window.__dial8Agent.${call} : ${missing})`, { gesture })
    return result ?? 'null'
  }

  /** read_page: the decision snapshot with frames, else the runtime's own snapshot with these options. */
  readPage(options: Record<string, unknown> = {}): Promise<string> {
    if (options.decision === true && options.frames === true) return this.decisionSnapshot()
    return this.agentCall(`snapshot(${JSON.stringify(options)})`, "{error:'agent runtime not present'}")
  }

  getText(maxChars = 50_000): Promise<string> { return this.agentCall(`getText(${Math.max(0, Math.floor(maxChars))})`) }
  click(ref: string): Promise<string> { return this.agentCall(`click(${JSON.stringify(ref)})`, undefined, true) }
  type(ref: string, value: string): Promise<string> { return this.agentCall(`type(${JSON.stringify(ref)},${JSON.stringify(value)})`, undefined, true) }

  /** A JPEG of the view as raw base64 (no data: prefix), at most `maxWidth` pixels wide (quality in (0, 1], default 0.7). */
  screenshot(options: ScreenshotOptions = {}): Promise<string> {
    return captureJpeg(this.host.conn, this.sessionId, options)
  }

  async goBack() { await this.history(-1) }
  async goForward() { await this.history(1) }
  async reload() { await this.send('Page.reload') }

  private async history(step: number) {
    const { currentIndex, entries } = await this.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory')
    const entry = entries[currentIndex + step]
    if (entry) await this.send('Page.navigateToHistoryEntry', { entryId: entry.id })
  }

  async close() { await this.host.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}) }

  // ── the navigation guard ─────────────────────────────────────────────────

  /** Each call replaces the last; no lease or no sites clears it (browser_set_agent_guard). */
  async setGuard(sites: readonly string[], leaseMs: number): Promise<void> {
    this.lease = guardLease(sites, leaseMs)
    await this.applyLease()
  }

  /** A popup is part of what the agent drives: same sites, same deadline as its opener. */
  inheritGuard(opener: CloudPage) { this.lease = opener.lease }

  private async applyLease() {
    clearTimeout(this.leaseTimer)
    if (this.lease) this.leaseTimer = setTimeout(() => { this.lease = null; void this.applyLease() }, Math.max(0, this.lease.until - Date.now()))
    await this.setFetch(this.lease !== null)
  }

  /**
   * Intercept main documents while guarded. A service worker would answer a navigation before
   * Fetch sees it, so workers are bypassed meanwhile; the bypass only applies with the Network
   * domain on (verified in a sandbox: without it the worker served a blocked page).
   */
  private async setFetch(on: boolean) {
    if (on === this.fetchOn || this.closed) return
    if (on) {
      await this.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 })
      await this.send('Network.setBypassServiceWorker', { bypass: true })
      await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] })
      this.fetchOn = true
    } else {
      this.fetchOn = false
      await this.send('Fetch.disable').catch(() => {})
      await this.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => {})
      await this.send('Network.disable').catch(() => {})
    }
  }

  private async onRequestPaused(params: CdpParams) {
    const requestId = text(params.requestId)
    const request = params.request as { url?: string } | undefined
    // Main frame only (a redirect is paused as its own request); subframes are left alone.
    const site = params.frameId === this.mainFrameId ? guardBlocks(this.lease, text(request?.url)) : null
    if (!site) { await this.send('Fetch.continueRequest', { requestId }).catch(() => {}); return }
    // Aborted, not failed: the tab stays on its page instead of showing an error page.
    await this.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {})
    // A popup into a blocked site never opens; its opener gets the notice. (A popup that opened
    // elsewhere and redirects into one stays, with its own notice, as on the desktop.)
    if (this.opener && !this.committed && !params.redirectedRequestId) { this.opener.blocked(site); await this.close(); return }
    this.blocked(site)
  }

  /** A blocked page committed without a request the guard saw: leave it at once (back where the page was, else blank). */
  private async leaveBlocked(site: string, previous: string, wasCommitted: boolean) {
    if (this.opener && !wasCommitted) { this.opener.blocked(site); await this.close(); return }
    this.blocked(site)
    const history = await this.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory').catch(() => null)
    const back = history?.entries.find((entry, i) => Math.abs(i - history.currentIndex) === 1 && entry.url === previous)
    if (back) await this.send('Page.navigateToHistoryEntry', { entryId: back.id }).catch(() => {})
    else await this.send('Page.navigate', { url: 'about:blank' }).catch(() => {})
  }

  private blocked(site: string) {
    const now = Date.now()
    if (this.lastNotice.site === site && now - this.lastNotice.at < GUARD_NOTICE_DEDUPE_MS) return
    this.lastNotice = { site, at: now }
    this.notify({ kind: 'agent-navigation-blocked', site })
  }

  notify(notice: PageNotice) { for (const listener of this.noticeListeners) listener(notice) }

  onNotice(listener: (notice: PageNotice) => void): () => void {
    this.noticeListeners.add(listener)
    return () => { this.noticeListeners.delete(listener) }
  }
}

type FrameInfo = { id: string; parentId?: string; url: string; urlFragment?: string }
type FrameTree = { frame: FrameInfo; childFrames?: FrameTree[] }
type LayoutMetrics = {
  cssLayoutViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
  cssVisualViewport?: { scale: number; zoom?: number }
}

export interface ScreenshotOptions { maxWidth?: number; quality?: number }

/** A JPEG of a page session's view as raw base64: shared by a driven page and a peek (browser.ts). */
export async function captureJpeg(conn: CdpTransport, sessionId: string, options: ScreenshotOptions = {}): Promise<string> {
  const quality = Math.round(100 * (options.quality && options.quality > 0 && options.quality <= 1 ? options.quality : 0.7))
  let clip: Record<string, number> | undefined
  if (options.maxWidth) {
    const layout = (await conn.send<LayoutMetrics>('Page.getLayoutMetrics', {}, sessionId)).cssLayoutViewport
    if (layout && layout.clientWidth > options.maxWidth)
      clip = { x: layout.pageX, y: layout.pageY, width: layout.clientWidth, height: layout.clientHeight, scale: options.maxWidth / layout.clientWidth }
  }
  const { data } = await conn.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality, ...(clip ? { clip } : {}) }, sessionId)
  return data
}
