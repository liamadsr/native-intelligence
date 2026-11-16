/**
 * The save-time checks of a page watch (a page_changed loop), in one place for
 * every writer of a flow row: the REST routes (POST /api/account/flows, PATCH
 * /api/account/flows/[id]) and chat's create_flow / update_flow. One helper so
 * the two doors cannot drift apart.
 *
 *   - THE LIMIT. One person keeps at most PAGE_WATCH_MAX_PER_PERSON page
 *     watches switched on in a workspace (counted by the loop's owner,
 *     flow.created_by, who it runs as). Each one is a page read every 15
 *     minutes, so the cap guards cost: like the event cap, a count that
 *     cannot be read lets the save through rather than refusing a person for
 *     a transient failure.
 *   - THE PROBE. A page saved switched on with a new or changed address, or
 *     switched on again, is read once now, the way the watch pass will read
 *     it (probeWatchPage). A page that shows its content only in a browser, or
 *     that cannot be read at all, is refused with the probe's own reason, so
 *     the person hears it at setup instead of waiting on a watch that never
 *     sees anything. A loop saved off is not read: it is read when it is
 *     switched on.
 *
 *   - IN THE PERSON'S BROWSER (`read_with: 'browser'`, phase 2). Such a watch
 *     wakes a browser at every read, so fewer may be kept
 *     (PAGE_WATCH_BROWSER_MAX_PER_PERSON, within the limit above), and its
 *     probe is a read in the owner's browser (read-browser.ts). When that read
 *     can't be made now (their browser is at work, no slot is free), the save
 *     goes through unchecked: the first read of the pass is the check, and a
 *     page that can't be read there is said by the watch's own failures.
 *
 * Every other trigger, and a page watch saved off, passes untouched (and no
 * query is made). The probe is injectable so tests never touch the network.
 *
 * THE BASELINE. After a save lands, a watch switched on, or whose trigger
 * was written with a change (it became a page watch, or its address or what
 * to look for changed), forgets what it last saw (resetPageWatch), so its
 * next read takes a fresh baseline instead of reporting every line that
 * appeared while it was off or watching something else as new
 * (pageWatchAfterSave). The editor re-sends the trigger on every save, so a
 * trigger re-saved unchanged (a rename) keeps it. A brand-new loop has no
 * baseline to forget.
 *
 * A hand-over (transfer_flow_owner, request_flow_takeover) moves a watch that
 * is on to a new owner without switching anything: pageWatchLimitProblem
 * holds the NEW owner to the same limit there (the page is not read again:
 * it does not change).
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resetPageWatch } from './page-watch/changes'
import { probeWatchPage } from './page-watch/probe'
import { browserWatchSession, isSkippedRead } from './page-watch/read-browser'
import { PAGE_WATCH_BROWSER_MAX_PER_PERSON, PAGE_WATCH_MAX_PER_PERSON, PAGE_WATCH_MIN_LINES, watchReadsInBrowser } from './page-watch/url'

/** Read a page once, as the watch pass would: lines to watch, or why not. */
export type WatchPageProbe = (url: string) => Promise<{ ok: true; lineCount: number } | { ok: false; reason: string }>

/**
 * The same for a page read in its owner's browser. `unchecked`: the read
 * could not be made now (not the page's doing), so the save goes through and
 * the pass's first read is the check.
 */
export type WatchPageBrowserProbe = (
  url: string,
  owner: { userId: string; workspaceId: string },
) => Promise<{ ok: true; lineCount: number } | { ok: true; unchecked: true } | { ok: false; reason: string }>

/** A save waits this long for the browser's read before it goes through unchecked. */
const BROWSER_PROBE_WAIT_MS = 45_000

/** The live browser probe: one session, one read, and the browser put back to sleep if the probe woke it. */
export const probeWatchPageInBrowser: WatchPageBrowserProbe = async (url, owner) => {
  const session = browserWatchSession(owner, undefined, { waitMs: BROWSER_PROBE_WAIT_MS })
  try {
    const read = await session.read(url)
    if (isSkippedRead(read)) return { ok: true, unchecked: true }
    if (!read.ok) return read
    if (read.lines.length < PAGE_WATCH_MIN_LINES) return { ok: false, reason: 'The page showed almost no text in your browser.' }
    return { ok: true, lineCount: read.lines.length }
  } finally {
    await session.finish()
  }
}

/** Why a page watch can't be saved as asked: a stable code, the field to fix, and one plain sentence for the person. */
export interface PageWatchSaveProblem {
  code: 'PAGE_WATCH_LIMIT' | 'PAGE_UNREADABLE'
  field: 'enabled' | 'trigger.url'
  message: string
}

/** A loop's trigger and switch, before or after the save. */
export interface PageWatchSide {
  triggerType: string | null | undefined
  config: unknown
  enabled: boolean
}

function urlOf(config: unknown): string | null {
  const url = (config as { url?: unknown } | null | undefined)?.url
  return typeof url === 'string' && url ? url : null
}

/** How many page watches this person keeps switched on in the workspace, leaving out `flowId`. Null when it can't be read. */
async function enabledWatchCount(service: SupabaseClient, args: { workspaceId: string; ownerUserId: string; flowId: string | null; inBrowser?: boolean }): Promise<number | null> {
  try {
    let q = service
      .from('flow')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', args.workspaceId)
      .eq('created_by', args.ownerUserId)
      .eq('enabled', true)
      .eq('trigger_type', 'page_changed')
    if (args.flowId) q = q.neq('id', args.flowId)
    if (args.inBrowser) q = q.eq('trigger_config->>read_with', 'browser')
    const { count, error } = await q
    if (error) return null
    return count ?? 0
  } catch {
    return null
  }
}

const limitProblem = (): PageWatchSaveProblem => ({
  code: 'PAGE_WATCH_LIMIT',
  field: 'enabled',
  message: `You already watch ${PAGE_WATCH_MAX_PER_PERSON} pages, the most one person can keep switched on here. Switch one of them off first, then switch this one on.`,
})

const browserLimitProblem = (): PageWatchSaveProblem => ({
  code: 'PAGE_WATCH_LIMIT',
  field: 'enabled',
  message: `You already watch ${PAGE_WATCH_BROWSER_MAX_PER_PERSON} pages in your browser, the most one person can keep switched on here. Switch one of them off first, then switch this one on.`,
})

/**
 * The limit alone, for a loop changing hands: null unless the loop is a page
 * watch that is on and `newOwnerUserId` already keeps the most switched on
 * (this loop left out of the count). The message names the new owner by
 * `who` ("You" when they are the caller).
 */
export async function pageWatchLimitProblem(
  service: SupabaseClient,
  args: { workspaceId: string; flowId: string; flow: { trigger_type?: string | null; enabled?: boolean | null; trigger_config?: unknown }; newOwnerUserId: string; who?: string },
): Promise<PageWatchSaveProblem | null> {
  if (args.flow.trigger_type !== 'page_changed' || args.flow.enabled !== true) return null
  const who = args.who?.trim() || 'The new owner'
  const already = who === 'You' ? 'already watch' : 'already watches'
  // A watch read in a browser moves to the NEW owner's browser, and counts toward their smaller limit there.
  if (watchReadsInBrowser(args.flow.trigger_config)) {
    const inBrowser = await enabledWatchCount(service, { workspaceId: args.workspaceId, ownerUserId: args.newOwnerUserId, flowId: args.flowId, inBrowser: true })
    if (inBrowser !== null && inBrowser >= PAGE_WATCH_BROWSER_MAX_PER_PERSON) {
      const whose = who === 'You' ? 'your browser' : 'their browser'
      return {
        code: 'PAGE_WATCH_LIMIT',
        field: 'enabled',
        message: `${who} ${already} ${PAGE_WATCH_BROWSER_MAX_PER_PERSON} pages in ${whose}, the most one person can keep switched on here, so this page watch did not change hands. Switch one of their watches off first, or switch this one off before handing it over.`,
      }
    }
  }
  const count = await enabledWatchCount(service, { workspaceId: args.workspaceId, ownerUserId: args.newOwnerUserId, flowId: args.flowId })
  if (count === null || count < PAGE_WATCH_MAX_PER_PERSON) return null
  return {
    code: 'PAGE_WATCH_LIMIT',
    field: 'enabled',
    message: `${who} ${already} ${PAGE_WATCH_MAX_PER_PERSON} pages, the most one person can keep switched on here, so this page watch did not change hands. Switch one of their watches off first, or switch this one off before handing it over.`,
  }
}

/**
 * Null when the save may go ahead; else what to tell the person. `next` is the
 * loop as it will be stored (its trigger after validation, its switch after
 * every other rule of the save); `previous` the stored row for an update (null
 * for a new loop).
 */
export async function pageWatchSaveProblem(
  service: SupabaseClient,
  args: {
    workspaceId: string
    ownerUserId: string
    /** The loop being updated (left out of the count), or null for a new one. */
    flowId: string | null
    /** Who is saving. Someone other than the owner never starts a read in the owner's browser, or hears what it found. */
    savedByUserId?: string | null
    next: PageWatchSide
    previous?: PageWatchSide | null
  },
  deps: { probe?: WatchPageProbe; browserProbe?: WatchPageBrowserProbe } = {},
): Promise<PageWatchSaveProblem | null> {
  const { next, previous } = args
  if (next.triggerType !== 'page_changed' || !next.enabled) return null
  const url = urlOf(next.config)
  // The validator already refused a page watch without an address; nothing to read here.
  if (!url) return null

  // Already a page watch that is on: it is counted, and its page was read when it went on.
  const wasWatching = previous?.triggerType === 'page_changed' && previous.enabled
  if (!wasWatching) {
    const count = await enabledWatchCount(service, { workspaceId: args.workspaceId, ownerUserId: args.ownerUserId, flowId: args.flowId })
    if (count !== null && count >= PAGE_WATCH_MAX_PER_PERSON) return limitProblem()
  }
  const inBrowser = watchReadsInBrowser(next.config)
  const wasInBrowser = !!wasWatching && watchReadsInBrowser(previous?.config)
  if (inBrowser && !wasInBrowser) {
    const count = await enabledWatchCount(service, { workspaceId: args.workspaceId, ownerUserId: args.ownerUserId, flowId: args.flowId, inBrowser: true })
    if (count !== null && count >= PAGE_WATCH_BROWSER_MAX_PER_PERSON) return browserLimitProblem()
  }

  // The same page read the same way as before: it was read when it went on.
  if (wasWatching && urlOf(previous?.config) === url && wasInBrowser === inBrowser) return null
  // Another member's save: the owner's browser is not read for them (what it finds there is the owner's to know). The pass's first read is the check.
  if (inBrowser && args.savedByUserId && args.savedByUserId !== args.ownerUserId) return null
  let read: { ok: true } | { ok: false; reason: string }
  try {
    read = inBrowser
      ? await (deps.browserProbe ?? probeWatchPageInBrowser)(url, { userId: args.ownerUserId, workspaceId: args.workspaceId })
      : await (deps.probe ?? probeWatchPage)(url)
  } catch {
    read = { ok: false, reason: 'It could not be read just now. Try again in a minute.' }
  }
  if (read.ok) return null
  return { code: 'PAGE_UNREADABLE', field: 'trigger.url', message: `That page can't be watched: ${read.reason}` }
}

/**
 * Whether a save of an existing loop must forget its page watch's baseline:
 * it is a page watch after the save, and the save switched it on, made it a
 * page watch, or changed its address or what to look for. Pure. A switch-off,
 * or the same trigger re-saved, keeps it.
 */
export function pageWatchNeedsReset(previous: PageWatchSide | null | undefined, next: PageWatchSide): boolean {
  if (next.triggerType !== 'page_changed') return false
  if (!previous || previous.triggerType !== 'page_changed') return true
  if (next.enabled && !previous.enabled) return true
  // Read another way (a fetch's text and a browser's differ line by line): a fresh baseline, or every line would read as new.
  if (watchReadsInBrowser(previous.config) !== watchReadsInBrowser(next.config)) return true
  return urlOf(previous.config) !== urlOf(next.config) || lookForOf(previous.config) !== lookForOf(next.config)
}

function lookForOf(config: unknown): string | null {
  const lookFor = (config as { look_for?: unknown } | null | undefined)?.look_for
  return typeof lookFor === 'string' ? lookFor : null
}

/**
 * Run after an existing loop's save has landed (never before: a refused save
 * keeps its baseline): forgets the page watch's baseline when
 * pageWatchNeedsReset says so. resetPageWatch never throws.
 */
export async function pageWatchAfterSave(
  service: SupabaseClient,
  args: { flowId: string; previous: PageWatchSide | null | undefined; next: PageWatchSide },
  deps: { reset?: (supabase: SupabaseClient, flowId: string) => Promise<void> } = {},
): Promise<boolean> {
  if (!pageWatchNeedsReset(args.previous, args.next)) return false
  await (deps.reset ?? resetPageWatch)(service, args.flowId)
  return true
}

/**
 * Run after a page watch read in its owner's browser has changed hands: what
 * it remembered and what it stored came from the OLD owner's signed-in pages.
 * The stored changes go (the new owner can read a loop's changes) and the
 * baseline is forgotten, so the new owner's first read, in their own browser,
 * starts fresh instead of reading every line as new. A plain watch keeps
 * both: its page is public. Never throws.
 */
export async function pageWatchAfterHandOver(
  service: SupabaseClient,
  args: { workspaceId: string; flowId: string; flow: { trigger_type?: string | null; trigger_config?: unknown } },
  deps: { reset?: (supabase: SupabaseClient, flowId: string) => Promise<void> } = {},
): Promise<boolean> {
  if (args.flow.trigger_type !== 'page_changed' || !watchReadsInBrowser(args.flow.trigger_config)) return false
  try {
    const { error } = await service.from('flow_page_change').delete().eq('flow_id', args.flowId).eq('workspace_id', args.workspaceId)
    if (error) console.error('[page-watch] hand-over cleanup failed:', error.message)
  } catch (err) {
    console.error('[page-watch] hand-over cleanup failed:', err instanceof Error ? err.message : 'unknown')
  }
  await (deps.reset ?? resetPageWatch)(service, args.flowId)
  return true
}
