/**
 * A watched page read in the person's own cloud browser (page watches, phase
 * 2): for a page behind a sign-in, or one that only shows its content in a
 * browser. The watch's owner is signed in there, so the read sees what they
 * see. No model is involved and nothing is clicked or typed: one
 * `watch_read` command (browser-agent/watch-read.ts) opens the address in a
 * tab of its own, takes its visible text and closes the tab.
 *
 * A read is made through a SESSION, one per person and workspace per pass,
 * because their watches share one browser:
 *
 *   - It never gets in a person's way. A browser its owner drives (Take
 *     over), or one with a command in flight or a step waiting on an approval,
 *     is left alone. A browser that sleeps is woken only as a background
 *     start (cloud-browser/host.ts): nobody else's browser gives way for it,
 *     and it leaves a slot free. Any of these is a SKIP, not a failure: the
 *     watch is tried again a little later and nothing counts against it.
 *   - Our own trouble is a skip too (the browser would not start, the relay
 *     did not answer in time, a list could not be read): a watch is never
 *     switched off for what the page did not do.
 *   - What the page did is a failure, with a plain reason: it did not load,
 *     it sent the browser to a sign-in page (the person is signed out), or its
 *     site is one the agent may not use (blocked by the person, or one whose
 *     terms forbid agents).
 *   - A browser this session woke goes back to sleep when the session ends
 *     (`finish`), unless someone used it meanwhile. The session notes the
 *     browser's activity stamp right after each thing it did itself (the
 *     start, each command's settle); any other use since (a live view's ping,
 *     an agent's command, a take-over) moves the stamp, and then the browser
 *     is left up. The stop itself is the idle sweep's compare-and-set on that
 *     same stamp. One it found running is left running.
 *
 * The text a read brings back is the person's own signed-in page. The
 * command's stored result is cleared as soon as it is read. Logs name
 * outcomes, never the address or the text.
 */
import 'server-only'
import { blockedSiteForUrl } from '@/lib/browser-agent/blocked-sites'
import { parseWatchReadResult, WATCH_READ_COMMAND, WATCH_READ_MAX_CHARS } from '@/lib/browser-agent/watch-read'
import type { WatchRead } from './read-page'
import { plainTextToLines } from './text'
import { browserWatchRefusal, landedOnSignIn, normalizeWatchUrl } from './url'

/** Why a read was not made now. Nothing counts against the watch. */
export type BrowserSkip =
  /** No browser slot free without making someone give way. */
  | 'busy'
  /** The person's browser is at work for them (a command in flight, or a step waiting on their approval). */
  | 'in_use'
  /** The person drives the browser themselves. */
  | 'taken_over'
  /** The site answers only through the person's Mac, and it is not connected. */
  | 'mac_offline'
  /** Our own trouble: the browser did not start, or did not answer in time. */
  | 'unavailable'

export type BrowserWatchRead = WatchRead | { ok: false; skipped: BrowserSkip; reason: string }

export function isSkippedRead(read: BrowserWatchRead): read is { ok: false; skipped: BrowserSkip; reason: string } {
  return !read.ok && 'skipped' in read
}

const SKIP_REASONS: Record<BrowserSkip, string> = {
  busy: 'All browsers were in use.',
  in_use: 'Your browser was busy with other work.',
  taken_over: 'You were using the browser yourself.',
  mac_offline: 'This site only answers through your Mac, and it was not connected.',
  unavailable: 'Your browser could not be reached just now.',
}
const skip = (why: BrowserSkip): BrowserWatchRead => ({ ok: false, skipped: why, reason: SKIP_REASONS[why] })

/** How long one read waits for its command to settle once the browser is up. */
export const BROWSER_READ_WAIT_MS = 60_000
const POLL_EVERY_MS = 500

export interface BrowserRef {
  userId: string
  workspaceId: string
}

/** The browser as the session needs to know it. */
export interface BrowserState {
  status: 'starting' | 'running' | 'stopping' | 'stopped'
  driver: 'agent' | 'person'
  last_active_at: string
}

/** What a session touches outside itself; tests pass stubs. */
export interface BrowserWatchPorts {
  /** The sites the agent may not use for this person: their own list plus the app's own. Throws when unreadable. */
  blockedSites(userId: string): Promise<string[]>
  /** The sites whose terms forbid agents, for this person. Throws when unreadable. */
  neverAutomate(userId: string): Promise<string[]>
  /** The browser's row now; null when the person has never had one. */
  browser(ref: BrowserRef): Promise<BrowserState | null>
  /** Whether the browser is at work for its person (a command in flight, a pending approval). */
  inUse(ref: BrowserRef): Promise<boolean>
  /** Bring the browser up as a background start. Rejects with a busy error when no slot is free. */
  ensure(ref: BrowserRef): Promise<void>
  isBusy(error: unknown): boolean
  enqueue(ref: BrowserRef, url: string): Promise<string>
  /** The command's row; null when it is gone. */
  command(ref: BrowserRef, id: string): Promise<{ status: string; result: unknown } | null>
  /** Fail a command the session stopped waiting for, claimed or not, so a late settle stores nothing. */
  abandon(ref: BrowserRef, id: string): Promise<void>
  /** Clear a settled command's stored result (the page's text). */
  clear(ref: BrowserRef, id: string): Promise<void>
  /** Put a browser this session woke back to sleep, only if it is still as `seen`. */
  sleep(ref: BrowserRef, seen: BrowserState): Promise<void>
  wait(ms: number): Promise<void>
  now(): number
}

const TERMINAL = new Set(['completed', 'failed', 'denied', 'expired', 'cancelled'])

/** The live ports: the cloud browser's host, store and command queue. Imported when first used (they are heavy and server-only). */
export function liveBrowserWatchPorts(): BrowserWatchPorts {
  const service = async () => (await import('@/lib/supabase/service')).getServiceClient()
  return {
    blockedSites: async (userId) => {
      const { loadAgentBlockedSites } = await import('@/lib/browser-agent/blocked-sites-server')
      return loadAgentBlockedSites(await service(), userId)
    },
    neverAutomate: async (userId) => (await (await import('@/lib/cloud-browser/site-memory')).readSiteMemory(userId)).neverAutomate,
    browser: async (ref) => {
      const row = await (await import('@/lib/cloud-browser/store')).readRow(ref)
      return row ? { status: row.status, driver: row.driver, last_active_at: row.last_active_at } : null
    },
    inUse: async (ref) => (await (await import('@/lib/cloud-browser/store')).browsersInUse([ref])).size > 0,
    ensure: async (ref) => {
      await (await import('@/lib/cloud-browser/host')).ensureCloudBrowser(ref, { background: true })
    },
    isBusy: (error) => !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'BROWSERS_BUSY',
    enqueue: async (ref, url) => {
      const { enqueueBrowserCommand } = await import('@/lib/browser-agent/queue')
      return enqueueBrowserCommand({ userId: ref.userId, workspaceId: ref.workspaceId, command: WATCH_READ_COMMAND, request: { url, maxChars: WATCH_READ_MAX_CHARS } })
    },
    command: async (ref, id) => {
      const { readBrowserCommand } = await import('@/lib/browser-agent/queue')
      const row = await readBrowserCommand(ref.userId, id)
      return row ? { status: String(row.status), result: row.result } : null
    },
    abandon: async (ref, id) => {
      // From waiting or claimed: the relay's settle is refused on a row already ended, so the page's text is never stored late.
      await (await service()).from('browser_command_queue')
        .update({ status: 'failed', result: null, error_message: 'The page watch stopped waiting for the browser.', finished_at: new Date().toISOString() })
        .eq('id', id).eq('user_id', ref.userId).eq('workspace_id', ref.workspaceId).in('status', ['waiting_for_device', 'claimed', 'running'])
    },
    clear: async (ref, id) => {
      await (await service()).from('browser_command_queue').update({ result: null }).eq('id', id).eq('user_id', ref.userId).eq('workspace_id', ref.workspaceId)
    },
    sleep: async (ref, seen) => {
      const [{ stopCloudBrowser }, store] = await Promise.all([import('@/lib/cloud-browser/host'), import('@/lib/cloud-browser/store')])
      const row = await store.readRow(ref)
      // Only the browser exactly as the session left it: any use since (a command, a viewer, an ensure) moved its activity.
      if (!row || row.status !== 'running' || row.driver !== 'agent' || row.last_active_at !== seen.last_active_at) return
      await stopCloudBrowser(ref, 'idle', { ...row, reason: 'idle' })
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

export interface BrowserWatchSession {
  /** Read one page. Never throws. */
  read(rawUrl: string): Promise<BrowserWatchRead>
  /** End the session: a browser it woke goes back to sleep if nobody used it since. Never throws. */
  finish(): Promise<void>
}

const log = (outcome: string, detail?: string) => console.log(`[page-watch] browser outcome=${outcome}${detail ? ` ${detail}` : ''}`)

/**
 * A session on one person's browser. Its first read decides whether the
 * browser may be used at all (not driven by the person, not at work, a slot
 * to wake it in); a skip there is every later read's answer too, so a busy
 * browser is asked once per pass, not once per watch.
 */
export function browserWatchSession(ref: BrowserRef, ports: BrowserWatchPorts = liveBrowserWatchPorts(), opts: { waitMs?: number } = {}): BrowserWatchSession {
  const waitMs = opts.waitMs ?? BROWSER_READ_WAIT_MS
  let opened: 'no' | 'yes' | BrowserSkip = 'no'
  let woke = false
  /** The browser's activity stamp right after the session's own last touch; null when it could not be read (then it is never put to sleep). */
  let ownStamp: string | null = null
  const noteOwnTouch = async () => {
    try {
      ownStamp = (await ports.browser(ref))?.last_active_at ?? null
    } catch {
      ownStamp = null
    }
  }
  let lists: { blocked: string[]; never: string[] } | null = null

  async function open(): Promise<BrowserSkip | null> {
    if (opened === 'yes') return null
    if (opened !== 'no') return opened
    const settle = (why: BrowserSkip) => { opened = why; return why }
    let before: BrowserState | null
    try {
      before = await ports.browser(ref)
      if (before?.status === 'running' || before?.status === 'starting') {
        if (before.driver === 'person') return settle('taken_over')
        if (await ports.inUse(ref)) return settle('in_use')
      }
    } catch {
      return settle('unavailable')
    }
    try {
      await ports.ensure(ref)
    } catch (error) {
      return settle(ports.isBusy(error) ? 'busy' : 'unavailable')
    }
    // Woken by this session unless it was already up (or coming up for someone) when the session looked.
    woke = !before || before.status === 'stopped' || before.status === 'stopping'
    if (woke) await noteOwnTouch()
    opened = 'yes'
    return null
  }

  async function readOnce(url: string): Promise<BrowserWatchRead> {
    let id: string
    try {
      id = await ports.enqueue(ref, url)
    } catch {
      return skip('unavailable')
    }
    const deadline = ports.now() + waitMs
    let row: { status: string; result: unknown } | null = null
    while (ports.now() < deadline) {
      await ports.wait(POLL_EVERY_MS)
      try {
        row = await ports.command(ref, id)
      } catch {
        row = null
      }
      if (row && TERMINAL.has(row.status)) break
    }
    if (!row || !TERMINAL.has(row.status)) {
      await ports.abandon(ref, id).catch(() => {})
      return skip('unavailable')
    }
    // The page's text is not kept in the queue once it is read.
    await ports.clear(ref, id).catch(() => {})
    if (woke) await noteOwnTouch()
    const result = row.status === 'completed' ? parseWatchReadResult(row.result) : null
    // Failed, expired, or an answer this build does not know (an older relay): ours to fix, not the page's.
    if (!result) return skip('unavailable')
    if (!result.ok) {
      if (result.code === 'taken_over') return skip('taken_over')
      if (result.code === 'needs_your_mac') return skip('mac_offline')
      if (result.code === 'site_blocked') return { ok: false, reason: blockedReason(result.site) }
      if (result.code === 'never_automate') return { ok: false, reason: neverReason(result.site) }
      return { ok: false, reason: 'The page did not load in your browser.' }
    }
    // A redirect into a social network's signed-in pages is refused like a start there.
    const refused = browserWatchRefusal(result.url)
    if (refused) return { ok: false, reason: refused }
    if (landedOnSignIn(url, result.url)) {
      return { ok: false, reason: 'The page sent your browser to a sign-in page. Sign in to the site in your agent\'s browser (open its computer and take over), and it will be read again.' }
    }
    return { ok: true, lines: plainTextToLines(result.text) }
  }

  return {
    async read(rawUrl) {
      try {
        const url = normalizeWatchUrl(rawUrl)
        if (url instanceof Error) return { ok: false, reason: url.message }
        const refused = browserWatchRefusal(url)
        if (refused) return { ok: false, reason: refused }
        // An unreadable list is never an empty one: the read waits.
        try {
          lists ??= { blocked: await ports.blockedSites(ref.userId), never: await ports.neverAutomate(ref.userId) }
        } catch {
          return skip('unavailable')
        }
        const never = blockedSiteForUrl(url, lists.never.filter((site) => !lists!.blocked.includes(site)))
        if (never) return { ok: false, reason: neverReason(never) }
        const blocked = blockedSiteForUrl(url, lists.blocked)
        if (blocked) return { ok: false, reason: blockedReason(blocked) }
        const stopped = await open()
        if (stopped) {
          log('skipped', `why=${stopped}`)
          return skip(stopped)
        }
        const read = await readOnce(url)
        if (isSkippedRead(read)) {
          log('skipped', `why=${read.skipped}`)
          // The person took the browser mid-pass: the rest of this pass's reads wait too.
          if (read.skipped === 'taken_over') opened = 'taken_over'
        }
        return read
      } catch {
        return skip('unavailable')
      }
    },
    async finish() {
      if (!woke) return
      woke = false
      try {
        const seen = await ports.browser(ref)
        if (!seen || seen.status !== 'running' || seen.driver !== 'agent') return
        // Touched by anyone since the session's own last touch: someone is using it.
        if (!ownStamp || seen.last_active_at !== ownStamp) return
        if (await ports.inUse(ref)) return
        await ports.sleep(ref, seen)
        log('slept')
      } catch {
        // The idle sweep stops it after its usual idle time.
      }
    },
  }
}

function blockedReason(site: string | undefined): string {
  return site
    ? `You blocked your agent on ${site}, so it can't be read in your browser. Unblock it under Blocked sites in your agent's computer, or switch this watch off.`
    : 'The page led to a site you blocked your agent on, so it was not read.'
}

function neverReason(site: string | undefined): string {
  return `${site ?? 'This site'} does not allow AI agents, so it can't be watched in your browser.`
}
