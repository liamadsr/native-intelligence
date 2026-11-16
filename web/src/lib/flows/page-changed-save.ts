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
import { PAGE_WATCH_MAX_PER_PERSON } from './page-watch/url'

/** Read a page once, as the watch pass would: lines to watch, or why not. */
export type WatchPageProbe = (url: string) => Promise<{ ok: true; lineCount: number } | { ok: false; reason: string }>

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
async function enabledWatchCount(service: SupabaseClient, args: { workspaceId: string; ownerUserId: string; flowId: string | null }): Promise<number | null> {
  try {
    let q = service
      .from('flow')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', args.workspaceId)
      .eq('created_by', args.ownerUserId)
      .eq('enabled', true)
      .eq('trigger_type', 'page_changed')
    if (args.flowId) q = q.neq('id', args.flowId)
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

/**
 * The limit alone, for a loop changing hands: null unless the loop is a page
 * watch that is on and `newOwnerUserId` already keeps the most switched on
 * (this loop left out of the count). The message names the new owner by
 * `who` ("You" when they are the caller).
 */
export async function pageWatchLimitProblem(
  service: SupabaseClient,
  args: { workspaceId: string; flowId: string; flow: { trigger_type?: string | null; enabled?: boolean | null }; newOwnerUserId: string; who?: string },
): Promise<PageWatchSaveProblem | null> {
  if (args.flow.trigger_type !== 'page_changed' || args.flow.enabled !== true) return null
  const count = await enabledWatchCount(service, { workspaceId: args.workspaceId, ownerUserId: args.newOwnerUserId, flowId: args.flowId })
  if (count === null || count < PAGE_WATCH_MAX_PER_PERSON) return null
  const who = args.who?.trim() || 'The new owner'
  const already = who === 'You' ? 'already watch' : 'already watches'
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
    next: PageWatchSide
    previous?: PageWatchSide | null
  },
  deps: { probe?: WatchPageProbe } = {},
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

  if (wasWatching && urlOf(previous?.config) === url) return null
  const probe = deps.probe ?? probeWatchPage
  let read: Awaited<ReturnType<WatchPageProbe>>
  try {
    read = await probe(url)
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
