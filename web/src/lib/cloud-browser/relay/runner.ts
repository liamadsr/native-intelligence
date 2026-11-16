import { grantCovers, readApprovalGrant } from '@/lib/browser-agent/approval-grant'
import { blockedSiteForUrl, BrowserSiteBlockedError, cleanBlockedSites, siteBlockedMessage, siteForUrl } from '@/lib/browser-agent/blocked-sites'
import { browserTaskSchema, type BrowserTask } from '@/lib/browser-agent/task-contract'
import { executeBrowserTask, siteBlockedTaskResult } from '@/lib/browser-agent/task-executor'
import { parseNative } from '@/lib/browser-agent/page-reads'
import { WATCH_READ_COMMAND, WATCH_READ_MAX_CHARS, type WatchReadResult } from '@/lib/browser-agent/watch-read'
import type { CloudBrowser } from '../cdp/browser'
import { cloudTaskPorts, runCloudCommand } from '../cdp/commands'
import type { CloudPage } from '../cdp/page'
import { blockPage } from '../exit/block-page'
import type { ClaimedCommand, RelayClient, SiteMemory } from './client'
import type { ExitControl } from './exit-control'

/**
 * Run one claimed command on the sandbox's Chrome (docs/plans/cloud-browser.md,
 * C2): the cloud twin of the desktop relay's runOne (use-browser-command-relay.ts).
 * The checks and results are the desktop's; what the desktop does to show a
 * window is the live view's (C3), so it has no counterpart here.
 */

/** The driver version the decision route gates features on: frames and real input (v8). */
export const CONTROLLER_VERSION = 8
/** The navigation guard outlives a task's deadline by this much, so it never lapses while its last step settles. */
const GUARD_MARGIN_MS = 5000
/** The person has the browser (C3): the agent stops and says so; it never fights them for the mouse. */
const TAKEN_OVER = 'The user has taken over the browser, so the agent stopped. Wait until they hand it back, then try again.'
const takenOverResult = () => ({ status: 'cancelled' as const, reason: 'taken_over', message: TAKEN_OVER, steps: 0, elapsedMs: 0,
  timings: { snapshotMs: 0, settlingMs: 0, navigationMs: 0 }, trace: [] })
/** The Mac exit (C4): why a task stopped rather than go on from the cloud's own address, or at a site that forbids agents. */
const MAC_DROPPED = 'The user\'s Mac stopped carrying the browser\'s connection (it went to sleep or offline), so the agent stopped rather than go on from the cloud. Ask them to open their Mac with Native Intelligence running, then try again.'
const needsMacMessage = (site: string) => `${site} turns away browsers in the cloud, so this needs the user's Mac with Native Intelligence open. Tell them; don't try to get around it.`
const neverAutomateMessage = (site: string) => `${site} doesn't allow AI agents (its terms forbid them), so the agent never uses it. Tell the user to do this part on the site themselves.`
const stopResult = (reason: 'needs_your_mac' | 'never_automate', message: string) => ({ status: 'escalate' as const, reason, message, steps: 0, elapsedMs: 0,
  timings: { snapshotMs: 0, settlingMs: 0, navigationMs: 0 }, trace: [] })
const NO_MEMORY: SiteMemory = { needsHome: [], neverAutomate: [] }
const TAB_GONE =
  'That browser tab is closed, so the action did not run. Read the page again to get the current tab.'
/** Commands that change nothing and may be retried. */
const READ_COMMANDS = ['read_page', 'get_text', 'screenshot']
const RETRYABLE = /timed out|no result|mid-load|not present|empty/i

export interface RelayState {
  browser: CloudBrowser
  client: RelayClient
  /** The tab the agent last worked in: tasks continue there unless they name another. */
  agentPage: CloudPage | null
  /** The Mac exit (C4): where the browser's traffic leaves (exit-control.ts). Absent: always the cloud. */
  exit?: ExitControl
  /** A command is running. */
  busy?: boolean
}

/** A command's exit, pinned for it (C4): its mode, and whether the Mac's tunnel dropped under a `mac` one. */
interface PinnedExit {
  mode: 'mac' | 'cloud'
  dropped(): boolean
}

/** The agent's tab: the one it last used while it is open, else a new one. */
async function agentTab(state: RelayState): Promise<CloudPage> {
  if (state.agentPage && !state.agentPage.closed) return state.agentPage
  state.agentPage = await state.browser.openPage()
  return state.agentPage
}

export async function runClaimed(state: RelayState, cmd: ClaimedCommand, claimedSites: string[],
  driver: 'agent' | 'person' = 'agent', memory: SiteMemory = NO_MEMORY): Promise<void> {
  const { client } = state
  const req = cmd.request ?? {}
  // A page watch's read has its own answers (a watch waits out a take-over; it never fails on one).
  if (cmd.command === WATCH_READ_COMMAND) {
    await client.settle(cmd.id, 'completed', await watchRead(state, cmd, claimedSites, driver, memory), null)
    return
  }
  if (driver === 'person' && cmd.command !== 'open_window' && cmd.command !== 'close_window') {
    if (cmd.command === 'run_task') await client.settle(cmd.id, 'completed', takenOverResult(), null)
    else await client.settle(cmd.id, 'failed', null, TAKEN_OVER)
    return
  }
  // The server's list as of the claim; each task step refreshes it. Sites that forbid agents are guarded the same way.
  let serverSites = cleanBlockedSites(claimedSites)
  const neverAutomate = cleanBlockedSites(memory.neverAutomate)
  const sites = () => [...serverSites, ...neverAutomate.filter(site => !serverSites.includes(site))]
  const forbidden = (site: string | null) => !!site && neverAutomate.includes(site) && !serverSites.includes(site)

  if (cmd.command === 'open_window' || cmd.command === 'close_window') {
    // Showing the browser is the live view's job (C3), never the sandbox's.
    await client.settle(cmd.id, 'completed', { ok: true }, null)
    return
  }
  let task: BrowserTask | null = null
  if (cmd.command === 'run_task') {
    const parsed = browserTaskSchema.safeParse(req.task)
    if (!parsed.success) { await client.settle(cmd.id, 'failed', null, 'Invalid browser task'); return }
    task = parsed.data
    const startBlocked = blockedSiteForUrl(task.startUrl, sites())
    if (forbidden(startBlocked)) { await client.settle(cmd.id, 'completed', stopResult('never_automate', neverAutomateMessage(startBlocked!)), null); return }
    if (startBlocked) { await client.settle(cmd.id, 'completed', siteBlockedTaskResult(startBlocked), null); return }
  }
  const isRead = READ_COMMANDS.includes(cmd.command)
  const diagnosticRead = cmd.command === 'read_page' && (req.options as Record<string, unknown> | undefined)?.decision === true
  // A command for a tab that is gone never lands on another page instead (a replayed snapshot neither).
  const named = cmd.tab_id ? state.browser.list().find(page => page.targetId === cmd.tab_id) ?? null : null
  if (cmd.tab_id && !named && (!isRead || diagnosticRead)) { await client.settle(cmd.id, 'failed', null, TAB_GONE); return }
  let page = named ?? await agentTab(state).catch(() => null)
  if (!page) { await client.settle(cmd.id, 'failed', null, 'Could not open a browser tab to run the command against.'); return }

  // A tab showing a blocked site is never read or acted on. A task with a start page opens a tab of its own instead.
  const tabBlocked = blockedSiteForUrl(page.url, sites())
  if (tabBlocked) {
    if (!task) { await client.settle(cmd.id, 'denied', null, siteBlockedMessage(tabBlocked)); return }
    if (!task.startUrl) { await client.settle(cmd.id, 'completed', { ...siteBlockedTaskResult(tabBlocked), tabId: page.targetId }, null); return }
    page = await state.browser.openPage().catch(() => null)
    if (!page) { await client.settle(cmd.id, 'failed', null, 'Could not open a browser tab to run the command against.'); return }
  }
  state.agentPage = page

  // C4: the exit is pinned for the whole command. Through the Mac while its tunnel is up; else the cloud,
  // unless the site needs the Mac. A tunnel that drops under a `mac` command never turns into the cloud's address.
  const exit = state.exit
  const mode = exit?.choose() ?? 'cloud'
  const target = task ? task.startUrl ?? page.url : typeof req.url === 'string' ? req.url : page.url
  const needsHome = exit?.capable && mode === 'cloud' ? blockedSiteForUrl(target, memory.needsHome) : null
  if (needsHome) {
    if (task) await client.settle(cmd.id, 'completed', { ...stopResult('needs_your_mac', needsMacMessage(needsHome)), tabId: page.targetId }, null)
    else await client.settle(cmd.id, 'failed', null, needsMacMessage(needsHome))
    return
  }
  let dropped = false
  const offTunnel = exit && mode === 'mac' ? exit.onTunnel(up => { if (!up) dropped = true }) : () => {}
  try {
    await exit?.pin(mode)
    if (mode === 'mac' && exit && !exit.tunnelUp()) dropped = true
    const pinned: PinnedExit = { mode, dropped: () => dropped }
    if (task) return await runTask(state, cmd, task, page, sites, next => { serverSites = next }, memory, forbidden, pinned)
    await runDirect(state, cmd, page, sites, isRead)
  } finally {
    offTunnel()
    exit?.release()
  }
}

/** A watched page gets this long to load and show its text. */
const WATCH_READ_MS = 30_000
/** After the load, the text is read until two reads in a row are the same length (a page that fills itself in), at most this many times. */
const WATCH_SETTLE_READS = 6
const WATCH_SETTLE_EVERY_MS = 1000

/**
 * A page watch's read (browser-agent/watch-read.ts): the address opened in a
 * tab of its own, its visible text read, the tab closed. Nothing is clicked
 * or typed and no model is asked; the agent's own tab (state.agentPage) stays
 * as it was. The same rules as any command: nothing while the person drives,
 * never a blocked site or one that forbids agents (the start address, every
 * load on the way, and the page the text came from), and the Mac exit pinned
 * for the read, never falling back to the cloud's address under it.
 */
async function watchRead(state: RelayState, cmd: ClaimedCommand, claimedSites: string[], driver: 'agent' | 'person',
  memory: SiteMemory): Promise<WatchReadResult> {
  if (driver === 'person') return { ok: false, code: 'taken_over' }
  const url = typeof cmd.request?.url === 'string' ? cmd.request.url : ''
  if (!/^https?:\/\//i.test(url)) return { ok: false, code: 'load_failed' }
  const serverSites = cleanBlockedSites(claimedSites)
  const neverAutomate = cleanBlockedSites(memory.neverAutomate)
  const sites = [...serverSites, ...neverAutomate.filter(site => !serverSites.includes(site))]
  const stopFor = (site: string): WatchReadResult =>
    ({ ok: false, code: neverAutomate.includes(site) && !serverSites.includes(site) ? 'never_automate' : 'site_blocked', site })
  const startBlocked = blockedSiteForUrl(url, sites)
  if (startBlocked) return stopFor(startBlocked)

  const exit = state.exit
  const mode = exit?.choose() ?? 'cloud'
  const needsHome = exit?.capable && mode === 'cloud' ? blockedSiteForUrl(url, memory.needsHome) : null
  if (needsHome) return { ok: false, code: 'needs_your_mac', site: needsHome }
  let dropped = false
  const offTunnel = exit && mode === 'mac' ? exit.onTunnel(up => { if (!up) dropped = true }) : () => {}
  let page: CloudPage | null = null
  try {
    await exit?.pin(mode)
    if (mode === 'mac' && exit && !exit.tunnelUp()) return { ok: false, code: 'needs_your_mac' }
    page = await state.browser.openPage().catch(() => null)
    if (!page) return { ok: false, code: 'load_failed' }
    const deadline = Date.now() + WATCH_READ_MS
    const kept: { site: string | null } = { site: null }
    const offNotice = page.onNotice(notice => { if (notice.kind === 'agent-navigation-blocked') kept.site = notice.site })
    try {
      await page.setGuard(sites, WATCH_READ_MS + GUARD_MARGIN_MS)
      await page.navigate(url, new AbortController().signal, deadline).catch(() => {})
      let read: { url: string; text: string } | null = null
      for (let i = 0, last = -1; i < WATCH_SETTLE_READS && Date.now() < deadline && !page.closed; i++) {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, WATCH_SETTLE_EVERY_MS))
        let now: { url?: unknown; text?: unknown } | null = null
        try { now = parseNative(await page.getText(WATCH_READ_MAX_CHARS)) as { url?: unknown; text?: unknown } | null } catch { /* still loading */ }
        if (!now || typeof now.url !== 'string' || typeof now.text !== 'string') continue
        read = { url: now.url, text: now.text }
        if (now.text.length > 0 && now.text.length === last) break
        last = now.text.length
      }
      if (dropped) return { ok: false, code: 'needs_your_mac' }
      if (kept.site) return stopFor(kept.site)
      if (!read) return { ok: false, code: 'load_failed' }
      // The page reports its own address with its text: where the text came from, whatever it navigated to since.
      const landed = blockedSiteForUrl(read.url, sites)
      if (landed) return stopFor(landed)
      if (!/^https?:\/\//i.test(read.url)) return { ok: false, code: 'load_failed' }
      return { ok: true, url: read.url, text: read.text }
    } finally {
      offNotice()
    }
  } catch {
    return dropped ? { ok: false, code: 'needs_your_mac' } : { ok: false, code: 'load_failed' }
  } finally {
    if (page) {
      await page.setGuard([], 0).catch(() => {})
      await page.close()
    }
    offTunnel()
    exit?.release()
  }
}

async function runDirect(state: RelayState, cmd: ClaimedCommand, page: CloudPage, sites: () => string[], isRead: boolean): Promise<void> {
  const { client } = state
  const req = cmd.request ?? {}

  for (let attempt = 0, lastError = ''; ; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 800))
    try {
      await client.settle(cmd.id, 'completed', await runCloudCommand(page, cmd.command, req, sites()), null)
      return
    } catch (error) {
      if (error instanceof BrowserSiteBlockedError) { await client.settle(cmd.id, 'denied', null, siteBlockedMessage(error.site)); return }
      lastError = error instanceof Error ? error.message : String(error)
      // Only reads are safe to retry; a write may have partly applied.
      if (attempt >= 2 || !isRead || !RETRYABLE.test(lastError)) {
        await client.settle(cmd.id, 'failed', null, lastError || 'browser command failed')
        return
      }
    }
  }
}

async function runTask(state: RelayState, cmd: ClaimedCommand, task: BrowserTask, page: CloudPage,
  sites: () => string[], setSites: (sites: string[]) => void, _memory: SiteMemory, forbidden: (site: string | null) => boolean,
  pinned: PinnedExit): Promise<void> {
  const { client } = state
  const prepared = performance.now()
  const exit = state.exit
  const { mode } = pinned
  let stopped: { reason: 'needs_your_mac' | 'never_automate'; message: string } | null = null
  // Never on to the cloud's own address: a tunnel that drops under a `mac` task ends it.
  const lost = () => { if (pinned.dropped()) stopped ??= { reason: 'needs_your_mac', message: MAC_DROPPED }; return !!stopped }
  const deadline = Math.min(Date.parse(cmd.lease_expires_at ?? ''), Date.parse(cmd.claimed_at ?? '') + task.timeoutMs)
  if (!Number.isFinite(deadline) || deadline <= Date.now()) { await client.settle(cmd.id, 'failed', null, 'Task lease expired'); return }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
  // While the task drives the tab, loads into a blocked site are cancelled before they load.
  let guarded = ''
  const guard = () => {
    const key = sites().join('\n')
    if (key === guarded) return
    guarded = key
    void page.setGuard(sites(), deadline - Date.now() + GUARD_MARGIN_MS).catch(() => {})
  }
  guard()
  const ports = cloudTaskPorts(page, { signal: controller.signal, deadline, sites })
  // A replay the person approved may take the one step its grant names, once.
  let takenOver = false
  let grant = readApprovalGrant(cmd.request?.approvalGrant)
  let requested: string | null = null
  const approve = async (summary: string) => {
    if (grantCovers(grant, summary)) { grant = null; return true }
    // No dialog to ask in: raise a card for this step and stop; the person's Accept replays the task.
    if (!requested) requested = await client.requestApproval(cmd.id, summary, page.targetId).catch(() => null) ?? 'unavailable'
    return false
  }
  try {
    const setupMs = Math.max(0, Math.round(performance.now() - prepared))
    const result = await executeBrowserTask(task, {
      ...ports, signal: controller.signal, deadline,
      alive: () => !page.closed && !takenOver && !lost(),
      blockedSites: sites,
      approve,
      decide: async (observation, step, history, signal) => {
        // A page that turns the browser away: a site that forbids agents is never used again; on the cloud exit, a block means the site needs the Mac.
        const blocked = blockPage(observation)
        if (blocked === 'agent_ban' || (blocked === 'blocked' && exit?.capable && mode === 'cloud')) {
          void client.markSite(observation.url, blocked)
          const site = siteForUrl(observation.url) ?? 'This site'
          stopped = blocked === 'agent_ban' ? { reason: 'never_automate', message: neverAutomateMessage(site) } : { reason: 'needs_your_mac', message: needsMacMessage(site) }
          throw new Error(stopped.reason)
        }
        const { status, body } = await client.decide(cmd.id, { controllerVersion: CONTROLLER_VERSION, tabId: page.targetId,
          observation, step, history }, signal)
        // The server's current list caught a page on a blocked site.
        if (status === 409 && body?.error === 'site_blocked' && typeof body.blockedSite === 'string') throw new BrowserSiteBlockedError(body.blockedSite)
        if (status === 409 && body?.error === 'taken_over') { takenOver = true; throw new Error('taken_over') }
        if (status < 200 || status >= 300 || !body) throw new Error('Decision task unavailable')
        if (Array.isArray(body.blockedSites)) { setSites(cleanBlockedSites(body.blockedSites)); guard() }
        return body as unknown as Awaited<ReturnType<Parameters<typeof executeBrowserTask>[1]['decide']>>
      },
    })
    // The step waits on a card, not on a refusal: say so, so the chat tells the person where to look.
    const asked = requested && requested !== 'unavailable' && result.status === 'cancelled' && result.reason === 'approval_declined'
      ? { reason: 'approval_requested', approvalId: requested,
        message: 'This step needs the user\'s OK: an approval card is waiting for them. When they accept it, the task runs again and this step goes through. Tell them, and stop.' }
      : {}
    // A navigation into a site that forbids agents was cancelled like a blocked one: say which it was.
    const banned = result.reason === 'site_blocked' && forbidden(result.blockedSite ?? null) ? stopResult('never_automate', neverAutomateMessage(result.blockedSite!)) : null
    lost()
    const stop = stopped as { reason: 'needs_your_mac' | 'never_automate'; message: string } | null
    const ended = takenOver ? { status: 'cancelled' as const, reason: 'taken_over', message: TAKEN_OVER }
      : stop ? { status: 'escalate' as const, reason: stop.reason, message: stop.message }
      : banned ? { status: banned.status, reason: banned.reason, message: banned.message } : asked
    await client.settle(cmd.id, 'completed', { ...result, ...ended, exit: exit?.capable ? mode : undefined, tabId: page.targetId, telemetry: { version: 1, setupMs } }, null)
  } finally {
    clearTimeout(timeout)
    ports.stop()
    void page.setGuard([], 0).catch(() => {})
  }
}
