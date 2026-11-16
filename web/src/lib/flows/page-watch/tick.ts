/**
 * The page watch pass: run by the server's cron every 5 minutes
 * (/api/cron/page-watch). It reads every due page_changed loop's page and
 * fires the loop only when something the person asked about appeared.
 *
 * Per due loop (enabled, trigger_type page_changed, next_run_at <= now):
 *
 *   1. Its workspace's autonomy is off: not claimed, not read. It stays due
 *      and is read on the first pass after autonomy is back on (the schedule
 *      pass's rule for one-time loops). Paused workspaces are left out of the
 *      scan, so held loops never take a due loop's place; the per-row check
 *      is the backstop.
 *   2. Claim it: compare-and-set next_run_at from the value read to now + 15
 *      minutes (/api/cron/flow-schedule's double-fire guard). Losing means
 *      another pass took it, so two passes running at once read a page once.
 *   3. Its owner is no longer a member of the workspace (or it has none):
 *      switched off, compare-and-set on the claim, with no notice (there is
 *      nobody to tell), rather than read for nobody forever.
 *   4. Read the page (./read-page.ts: the address checked again, the safe
 *      fetcher, usual ports only, lines of visible text; no model). A read
 *      with almost no text (fewer than PAGE_WATCH_MIN_LINES lines), or with
 *      under half the lines of the last good one, is a FAILED read: a robot
 *      check, a maintenance page or a shell. It leaves the remembered reads
 *      alone, so it can't wipe the baseline and make the next good read look
 *      all new.
 *   5. Compare with the remembered reads (./diff.ts). A watch remembers the
 *      hashes of its last FINGERPRINT_READS (3) good reads, newest first, as
 *      an array of hash arrays in flow_page_watch.fingerprints; a line seen in
 *      any of them is not news, so a rotating block (testimonials, related
 *      links) stops reading as new. The first read of a page (or of a page
 *      whose address the person changed, or of a watch just reset) only
 *      stores the baseline: it never fires. No new lines: the read is
 *      remembered and nothing else.
 *   6. New lines: Jev's `watch.matters` (live) says whether they show what
 *      the person asked for. `ignore`: remembered, nothing fired. `tell`: the
 *      change is stored (flow_page_change) and `flow/page.changed` emitted,
 *      which fires the loop (the dispatcher reads the change by its id).
 *      New lines past the 40 a change can carry are left out of the read
 *      that is remembered, so they come up on the next read.
 *
 * Nothing is lost on the way: a read is remembered only after its outcome is
 * settled. A failed insert or a failed emit leaves the remembered reads as
 * they were (and removes the stored change), so the same lines are found
 * again on the next read. When Jev can't judge (down, slow, unsure), the
 * first such read tells (fails open); the next JUDGE_HOLD_READS hold the
 * lines unjudged and ask again, and then it tells again, so an outage can't
 * flood a loop with runs and can't swallow a change. A busy answer
 * (`temporarily_unavailable`: Jev's circuit is open) or a cancelled one is
 * only a hold: asked again on the next read, never counted as a failure.
 *
 * A failed read counts toward failures and stores why (server-written plain
 * words, never page text). At PAGE_WATCH_MAX_FAILURES in a row the loop is
 * switched off (compare-and-set on what this pass claimed, so a person's edit
 * in between wins), the watch is reset (resetPageWatch), and its owner gets a
 * notice signed by the loop's bot, saying the watch stopped and why.
 *
 * A watch that asks for the person's browser (`read_with: 'browser'`, phase 2:
 * a page behind a sign-in, or one only a browser shows) is read there instead
 * (./read-browser.ts), every PAGE_WATCH_BROWSER_INTERVAL_MINUTES. Everything
 * after the read is the same. What differs:
 *   - One person's browser watches are read one after another, in one session
 *     on their browser, and at most PAGE_WATCH_BROWSER_PASS_LIMIT are taken up
 *     in a pass (a scan of their own, so neither kind crowds the other out), PAGE_WATCH_BROWSER_CONCURRENCY browsers at a time; the rest
 *     are not claimed and stay due for the next pass.
 *   - A read that could not be made NOW (the browser is at work for its
 *     person, they drive it, no slot is free, the site needs their Mac) is a
 *     SKIP: nothing is counted or stored, and the watch is due again in
 *     PAGE_WATCH_BROWSER_RETRY_MINUTES (at its usual interval when it is the
 *     Mac that is away). Only what the page did (it would not
 *     load, it asked for a sign-in, its site is off limits) is a failed read.
 *
 * Each pass also prunes stored changes older than PAGE_CHANGE_KEEP_DAYS, a
 * bounded number at a time.
 *
 * Never throws: one bad row is logged and counted, and the rest go on. Logs
 * name ids and outcomes, never the person's address or the page's text.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import type { WatchMattersInput, WatchMattersPick } from '@/lib/ai/decisions/tasks/watch-matters'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { agentPausedCache } from '@/lib/work/agent-paused'
import { resetPageWatch } from './changes'
import { diffLines, fingerprint, knownHashes, readSets, rememberRead } from './diff'
import { PAGE_WATCH_MIN_LINES } from './probe'
import { browserWatchSession, isSkippedRead, type BrowserWatchRead, type BrowserWatchSession } from './read-browser'
import { readWatchPage, type FetchPage } from './read-page'
import { normalizeWatchUrl, PAGE_WATCH_BROWSER_RETRY_MINUTES, PAGE_WATCH_LOOK_FOR_MAX, watchIntervalMinutes, watchReadsInBrowser } from './url'

/** Due loops read in one pass; the rest wait for the next (they stay due). */
export const PAGE_WATCH_PASS_LIMIT = 100
/** Pages read at once. */
export const PAGE_WATCH_CONCURRENCY = 10
/** Browser-read watches taken up in one pass; the rest stay due (a browser read can take a minute). */
export const PAGE_WATCH_BROWSER_PASS_LIMIT = 6
/** People's browsers read at once. */
export const PAGE_WATCH_BROWSER_CONCURRENCY = 2
/** Failed reads in a row that switch the loop off. */
export const PAGE_WATCH_MAX_FAILURES = 8
/** Reads in a row whose lines are held unjudged before the pass tells anyway. */
export const JUDGE_HOLD_READS = 3
/** Stored changes are kept this long (a loop's run reads its change within minutes). */
export const PAGE_CHANGE_KEEP_DAYS = 30
/** At most this many old changes are deleted in one pass. */
export const PAGE_CHANGE_PRUNE_LIMIT = 500
const PRUNE_CHUNK = 100

/** The escalations that only mean "not now": held and asked again, never counted as a failure. */
const BUSY_REASONS = new Set(['temporarily_unavailable'])

type Send = (event: { name: string; id: string; data: Record<string, unknown> }) => Promise<unknown>

/** Jev's watch.matters for one change; tests pass a stub. */
export type JudgeWatch = (
  input: WatchMattersInput,
  ctx: { userId: string; workspaceId: string; messageId: string },
) => Promise<DecisionResult<WatchMattersPick>>

/** The notice a stopped watch leaves its owner; tests pass a stub. */
export type NotifyStopped = (args: {
  supabase: SupabaseClient
  workspaceId: string
  flowId: string
  flowName: string
  ownerUserId: string | null
  teammateId: string | null
  sentence: string
}) => Promise<void>

export interface PageWatchDeps {
  fetchPage?: FetchPage
  /** A session on one person's browser, for their browser-read watches; tests pass a stub. */
  browserSession?: (ref: { userId: string; workspaceId: string }) => BrowserWatchSession
  judge?: JudgeWatch
  send?: Send
  notify?: NotifyStopped
  /** Whether a workspace's autonomy is off (the dispatcher's kill switch). */
  autonomyOff?: (workspaceId: string) => Promise<boolean>
  /** The workspaces whose autonomy is off, for the scan to leave out. */
  pausedWorkspaces?: () => Promise<string[]>
  limit?: number
  concurrency?: number
}

export interface PageWatchPassResult {
  due: number
  /** Not claimed: their workspace's autonomy is off. */
  held: number
  /** Another pass claimed them first. */
  lost: number
  baselines: number
  unchanged: number
  ignored: number
  told: number
  /** New lines kept unjudged (Jev could not answer, or was busy), asked again next read. */
  judgeHeld: number
  failed: number
  /** Browser reads not made now (the browser was busy, taken over, or needs the Mac): tried again soon, nothing counted. */
  skipped: number
  stopped: number
  /** Switched off: their owner is no longer a member of the workspace. */
  orphaned: number
  errored: number
  /** Stored changes past PAGE_CHANGE_KEEP_DAYS deleted this pass. */
  pruned: number
}

interface DueFlow {
  id: string
  workspace_id: string
  name: string | null
  created_by: string | null
  ai_team_member_id: string | null
  trigger_config: unknown
  next_run_at: string
}

interface WatchRow {
  url: string
  fingerprints: unknown
  line_count: number | null
  failures: number | null
  judge_failures: number | null
}

type Outcome = 'held' | 'lost' | 'baseline' | 'unchanged' | 'ignored' | 'told' | 'judgeHeld' | 'failed' | 'skipped' | 'stopped' | 'orphaned' | 'errored'

const OUTCOME_KEYS: Record<Outcome, keyof PageWatchPassResult> = {
  held: 'held', lost: 'lost', baseline: 'baselines', unchanged: 'unchanged', ignored: 'ignored', told: 'told',
  judgeHeld: 'judgeHeld', failed: 'failed', skipped: 'skipped', stopped: 'stopped', orphaned: 'orphaned', errored: 'errored',
}

const log = (flowId: string, outcome: string, detail?: string) =>
  console.log(`[page-watch] flow=${flowId} outcome=${outcome}${detail ? ` ${detail}` : ''}`)

/** The live decision: runDecision, imported when first asked (it is server-only and heavy). */
const judgeWithJev: JudgeWatch = async (input, ctx) => {
  const { runDecision } = await import('@/lib/ai/decisions/run-decision')
  return runDecision('watch.matters', input, { ...ctx, mode: 'enforce' })
}

const sendWithInngest: Send = async (event) => {
  const { inngest } = await import('@/lib/inngest/client')
  return inngest.send(event as never)
}

/** The stopped notice, through the loops' own path: signed by the loop's bot, to its owner. */
const notifyWithBot: NotifyStopped = async (args) => {
  if (!args.ownerUserId) return
  const { data: member } = await args.supabase
    .from('member')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.ownerUserId)
    .maybeSingle()
  const memberId = (member as { id?: string } | null)?.id
  if (!memberId) return
  const metadata = args.teammateId
    ? botNoticeMetadata({
        teammateId: args.teammateId,
        teammateName: await noticeTeammateName(args.supabase, args.workspaceId, args.teammateId),
        sentence: args.sentence,
      })
    : {}
  const copy = botNoticeCopy(metadata, { title: `Page watch stopped: ${args.flowName}`, body: args.sentence })
  const { createNotification } = await import('@/lib/notifications')
  await createNotification({
    workspaceId: args.workspaceId,
    recipientId: memberId,
    type: 'flow_run_output',
    title: copy.title,
    body: copy.body,
    targetType: 'flow',
    targetId: args.flowId,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  })
}

/** What the watch stopped notice says: written here, from the host and our own reason, never the page's text. Pure. */
export function stoppedSentence(host: string | null, failures: number, reason: string): string {
  const where = host ? `the page on ${host}` : 'the page'
  const why = reason.trim().replace(/\.$/, '')
  return `I stopped watching ${where}: it could not be read ${failures} times in a row (${why}). Switch the loop back on once the page is working again.`
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The workspaces whose autonomy is off (the schedule pass's read). Empty on a failed read: the per-row check holds them. */
async function readPausedWorkspaces(supabase: SupabaseClient): Promise<string[]> {
  try {
    const { data, error } = await supabase.from('workspace').select('id').eq('settings->agent_autonomy->>mode', 'off').limit(1000)
    if (error || !Array.isArray(data)) return []
    return (data as Array<{ id?: unknown }>).flatMap((r) => (typeof r.id === 'string' && /^[\w-]+$/.test(r.id) ? [r.id] : []))
  } catch {
    return []
  }
}

/**
 * Whether a person is still a member of a workspace, once per pair per pass:
 * true or false, or null when the read failed (then the watch is read as
 * usual: a passing outage never switches a loop off).
 */
function memberCache(supabase: SupabaseClient): (workspaceId: string, userId: string) => Promise<boolean | null> {
  const seen = new Map<string, Promise<boolean | null>>()
  return (workspaceId, userId) => {
    const key = `${workspaceId}:${userId}`
    let known = seen.get(key)
    if (!known) {
      known = (async () => {
        try {
          const { data, error } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).limit(1)
          if (error) return null
          return Array.isArray(data) && data.length > 0
        } catch {
          return null
        }
      })()
      seen.set(key, known)
    }
    return known
  }
}

/** Delete stored changes older than PAGE_CHANGE_KEEP_DAYS, at most PAGE_CHANGE_PRUNE_LIMIT. Never throws. */
async function pruneOldChanges(supabase: SupabaseClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PAGE_CHANGE_KEEP_DAYS * 24 * 60 * 60_000).toISOString()
  try {
    const { data, error } = await supabase
      .from('flow_page_change')
      .select('id')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(PAGE_CHANGE_PRUNE_LIMIT)
    if (error || !Array.isArray(data)) {
      if (error) console.error('[page-watch] prune scan failed:', error.message)
      return 0
    }
    const ids = (data as Array<{ id?: unknown }>).flatMap((r) => (typeof r.id === 'string' ? [r.id] : []))
    let pruned = 0
    for (let i = 0; i < ids.length; i += PRUNE_CHUNK) {
      const { error: deleteError } = await supabase.from('flow_page_change').delete().in('id', ids.slice(i, i + PRUNE_CHUNK))
      if (deleteError) {
        console.error('[page-watch] prune failed:', deleteError.message)
        break
      }
      pruned += Math.min(PRUNE_CHUNK, ids.length - i)
    }
    return pruned
  } catch (err) {
    console.error('[page-watch] prune failed:', err instanceof Error ? err.message : 'unknown')
    return 0
  }
}

/** Run `work` over `items`, at most `limit` at a time. */
async function eachBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await work(item)
    }
  })
  await Promise.all(lanes)
}

export async function runPageWatchPass(supabase: SupabaseClient, now: Date, deps: PageWatchDeps = {}): Promise<PageWatchPassResult> {
  const result: PageWatchPassResult = {
    due: 0, held: 0, lost: 0, baselines: 0, unchanged: 0, ignored: 0, told: 0, judgeHeld: 0, failed: 0, skipped: 0, stopped: 0, orphaned: 0, errored: 0, pruned: 0,
  }
  const nowIso = now.toISOString()

  result.pruned = await pruneOldChanges(supabase, now)

  // Two scans, so neither kind can crowd the other out: plain watches up to the pass limit, and the few
  // browser reads a pass takes up (longest due first; the rest are not claimed and stay due).
  let plain: DueFlow[]
  let inBrowser: DueFlow[]
  try {
    const paused = await (deps.pausedWorkspaces ?? (() => readPausedWorkspaces(supabase)))()
    const scan = (browser: boolean, limit: number) => {
      let q = supabase
        .from('flow')
        .select('id, workspace_id, name, created_by, ai_team_member_id, trigger_config, next_run_at')
        .eq('trigger_type', 'page_changed')
        .eq('enabled', true)
        .not('next_run_at', 'is', null)
        .lte('next_run_at', nowIso)
      q = browser ? q.eq('trigger_config->>read_with', 'browser') : q.or('trigger_config->>read_with.is.null,trigger_config->>read_with.neq.browser')
      if (paused.length) q = q.not('workspace_id', 'in', `(${paused.join(',')})`)
      return q.order('next_run_at', { ascending: true }).limit(limit)
    }
    const [plainScan, browserScan] = await Promise.all([scan(false, deps.limit ?? PAGE_WATCH_PASS_LIMIT), scan(true, PAGE_WATCH_BROWSER_PASS_LIMIT)])
    const error = plainScan.error ?? browserScan.error
    if (error) {
      console.error('[page-watch] due scan failed:', error.message)
      result.errored += 1
      return result
    }
    // Each kind is read its own way whatever a scan returned (a row is never read in a browser it did not ask for).
    plain = ((plainScan.data ?? []) as DueFlow[]).filter((flow) => !watchReadsInBrowser(flow.trigger_config))
    inBrowser = ((browserScan.data ?? []) as DueFlow[]).filter((flow) => watchReadsInBrowser(flow.trigger_config)).slice(0, PAGE_WATCH_BROWSER_PASS_LIMIT)
  } catch (err) {
    console.error('[page-watch] due scan failed:', err instanceof Error ? err.message : 'unknown')
    result.errored += 1
    return result
  }
  const due = [...plain, ...inBrowser]
  result.due = due.length

  const ctx = {
    nowIso,
    now,
    autonomyOff: deps.autonomyOff ?? agentPausedCache(supabase, 'flow_dispatch'),
    isMember: memberCache(supabase),
    deps,
  }
  const one = async (flow: DueFlow, session: BrowserWatchSession | null) => {
    let outcome: Outcome
    try {
      outcome = await watchOne(supabase, flow, ctx, session)
    } catch (err) {
      // One bad row must not stall the rest: it was claimed (or not) and is read again on its next turn.
      outcome = 'errored'
      log(flow.id, 'errored', `reason=${JSON.stringify(err instanceof Error ? err.message.slice(0, 120) : 'unknown')}`)
    }
    result[OUTCOME_KEYS[outcome]] += 1
  }

  // Browser-read watches are grouped by whose browser reads them.
  const byBrowser = new Map<string, DueFlow[]>()
  for (const flow of inBrowser) {
    const key = `${flow.created_by ?? ''}:${flow.workspace_id}`
    byBrowser.set(key, [...(byBrowser.get(key) ?? []), flow])
  }
  const openSession = deps.browserSession ?? ((ref: { userId: string; workspaceId: string }) => browserWatchSession(ref))

  await Promise.all([
    eachBounded(plain, deps.concurrency ?? PAGE_WATCH_CONCURRENCY, (flow) => one(flow, null)),
    eachBounded([...byBrowser.values()], PAGE_WATCH_BROWSER_CONCURRENCY, async (flows) => {
      // One session per person's browser, their watches one after another; no session for a loop with no owner (it is switched off before any read).
      const owner = flows[0].created_by
      const session = owner ? openSession({ userId: owner, workspaceId: flows[0].workspace_id }) : null
      try {
        for (const flow of flows) await one(flow, session ?? UNOWNED_SESSION)
      } finally {
        await session?.finish().catch(() => {})
      }
    }),
  ])
  return result
}

/** A browser watch with no owner never reaches a read (it is switched off first); this stands in so its path is the browser's. */
const UNOWNED_SESSION: BrowserWatchSession = {
  read: async () => ({ ok: false, skipped: 'unavailable', reason: 'Nobody owns this watch.' }),
  finish: async () => {},
}

/** Switch a loop off, only if it is still as this pass claimed it (a person's edit in between wins). */
async function switchOff(supabase: SupabaseClient, flow: DueFlow, claimedTo: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('flow')
    .update({ enabled: false, next_run_at: null })
    .eq('id', flow.id)
    .eq('workspace_id', flow.workspace_id)
    .eq('enabled', true)
    .eq('next_run_at', claimedTo)
    .select('id')
  if (error) log(flow.id, 'errored', 'step=switch_off')
  return !error && Array.isArray(data) && data.length > 0
}

async function watchOne(
  supabase: SupabaseClient,
  flow: DueFlow,
  ctx: {
    nowIso: string
    now: Date
    autonomyOff: (workspaceId: string) => Promise<boolean>
    isMember: (workspaceId: string, userId: string) => Promise<boolean | null>
    deps: PageWatchDeps
  },
  /** The session on the owner's browser when this watch is read there; null for a plain fetch. */
  session: BrowserWatchSession | null,
): Promise<Outcome> {
  const { nowIso, deps } = ctx
  if (await ctx.autonomyOff(flow.workspace_id)) return 'held'
  // A page read in the person's browser comes round less often than a fetched one.
  const nextIso = new Date(ctx.now.getTime() + watchIntervalMinutes(flow.trigger_config) * 60_000).toISOString()

  // Claim this read: next_run_at forward, only if it still holds what was read.
  const { data: won, error: claimError } = await supabase
    .from('flow')
    .update({ next_run_at: nextIso })
    .eq('id', flow.id)
    .eq('workspace_id', flow.workspace_id)
    .eq('enabled', true)
    .eq('next_run_at', flow.next_run_at)
    .select('id')
  if (claimError) {
    log(flow.id, 'errored', 'step=claim')
    return 'errored'
  }
  if (!won || won.length === 0) return 'lost'

  // Nobody to read it for: switched off, no notice (there is nobody to tell).
  const ownerIsMember = flow.created_by ? await ctx.isMember(flow.workspace_id, flow.created_by) : false
  if (ownerIsMember === false) {
    if (!(await switchOff(supabase, flow, nextIso))) return 'lost'
    await resetPageWatch(supabase, flow.id)
    log(flow.id, 'orphaned')
    return 'orphaned'
  }

  const cfg = (flow.trigger_config ?? {}) as { url?: unknown; look_for?: unknown }
  const url = normalizeWatchUrl(cfg.url)
  const lookFor = typeof cfg.look_for === 'string' ? cfg.look_for.trim().slice(0, PAGE_WATCH_LOOK_FOR_MAX) : ''
  // What the row records as the page: the normalized address, else what the loop holds (a bad one never reaches a fetch).
  const pageUrl = url instanceof Error ? String(cfg.url ?? '').trim().slice(0, 2048) || 'invalid' : url

  const { data: watchData, error: watchError } = await supabase
    .from('flow_page_watch')
    .select('url, fingerprints, line_count, failures, judge_failures')
    .eq('flow_id', flow.id)
    .eq('workspace_id', flow.workspace_id)
    .maybeSingle()
  if (watchError) {
    log(flow.id, 'errored', 'step=watch_read')
    return 'errored'
  }
  const watch = (watchData ?? null) as WatchRow | null
  const samePage = !!watch && watch.url === pageUrl
  const sets = samePage ? readSets(watch!.fingerprints) : []

  // The read itself. A bad address (a row written some other way) counts as a failed read, with its reason.
  const read: BrowserWatchRead = url instanceof Error
    ? { ok: false as const, reason: url.message }
    : !lookFor
      ? { ok: false as const, reason: 'The loop does not say what to look for on the page.' }
      : session
        ? await session.read(url)
        : await readWatchPage(url, { fetchPage: deps.fetchPage })
  if (isSkippedRead(read)) {
    // Not now: nothing is counted or stored. Due again soon, only if the loop is still as this pass claimed it;
    // a Mac that is away is asked again at the usual interval (finding that out wakes the browser each time).
    if (read.skipped !== 'mac_offline') {
      const retryIso = new Date(ctx.now.getTime() + PAGE_WATCH_BROWSER_RETRY_MINUTES * 60_000).toISOString()
      const { error: retryError } = await supabase
        .from('flow')
        .update({ next_run_at: retryIso })
        .eq('id', flow.id)
        .eq('workspace_id', flow.workspace_id)
        .eq('enabled', true)
        .eq('next_run_at', nextIso)
      if (retryError) log(flow.id, 'errored', 'step=retry_write')
    }
    log(flow.id, 'skipped', `why=${read.skipped}`)
    return 'skipped'
  }
  if (!read.ok) return failRead(supabase, flow, { pageUrl, watch, samePage, reason: read.reason, nowIso, nextIso, deps })
  const lines = read.lines
  // A robot check, a maintenance page or a shell answers 200 too: it is a failed read, and the baseline stays.
  if (lines.length < PAGE_WATCH_MIN_LINES) {
    return failRead(supabase, flow, { pageUrl, watch, samePage, reason: session
      ? 'The page showed almost no text in your browser this time.'
      : 'The page showed almost no text this time (a check for robots, a maintenance page, or a page that needs a browser).', nowIso, nextIso, deps })
  }
  const lastCount = samePage && sets.length ? watch!.line_count ?? 0 : 0
  if (lastCount > 0 && lines.length < lastCount / 2) {
    return failRead(supabase, flow, { pageUrl, watch, samePage, reason: 'The page showed much less text than usual this time.', nowIso, nextIso, deps })
  }
  const current = fingerprint(lines)

  const save = async (fields: Record<string, unknown>): Promise<boolean> => {
    const { error } = await supabase
      .from('flow_page_watch')
      .upsert({ flow_id: flow.id, workspace_id: flow.workspace_id, url: pageUrl, checked_at: nowIso, failures: 0, last_error: null, ...fields }, { onConflict: 'flow_id' })
    if (error) log(flow.id, 'errored', 'step=watch_write')
    return !error
  }

  // First read, another page, or a watch just reset (no reads remembered): the baseline only, never a fire.
  if (sets.length === 0) {
    if (!(await save({ fingerprints: rememberRead([], current), line_count: lines.length, judge_failures: 0 }))) return 'errored'
    log(flow.id, 'baseline', `lines=${lines.length}`)
    return 'baseline'
  }

  const { added, unreported } = diffLines(knownHashes(sets), lines)
  // What this read is remembered as: its lines, less the new ones a change could not carry (they come up next time).
  const skip = new Set(unreported)
  const remembered = rememberRead(sets, skip.size ? current.filter((h) => !skip.has(h)) : current)
  if (added.length === 0) {
    if (!(await save({ fingerprints: remembered, line_count: lines.length }))) return 'errored'
    return 'unchanged'
  }

  // New lines: does Jev say they are what the person asked about?
  const host = hostOf(pageUrl) ?? 'unknown'
  let verdict: DecisionResult<WatchMattersPick>
  try {
    verdict = await (deps.judge ?? judgeWithJev)({ lookFor, host, addedLines: added }, { userId: flow.created_by!, workspaceId: flow.workspace_id, messageId: flow.id })
  } catch (err) {
    verdict = { status: 'escalate', reason: err instanceof Error ? 'threw' : 'unknown' }
  }

  if (verdict.status === 'accepted' && verdict.value === 'ignore') {
    if (!(await save({ fingerprints: remembered, line_count: lines.length, changed_at: nowIso, judge_failures: 0 }))) return 'errored'
    log(flow.id, 'ignored', `added=${added.length}`)
    return 'ignored'
  }

  let judgeFailures = 0
  if (verdict.status === 'cancelled' || (verdict.status === 'escalate' && BUSY_REASONS.has(verdict.reason))) {
    // Busy, not broken: the lines wait for the next read, and nothing is counted.
    if (!(await save({ line_count: lines.length }))) return 'errored'
    log(flow.id, 'judge_busy', `reason=${verdict.reason} added=${added.length}`)
    return 'judgeHeld'
  }
  if (verdict.status !== 'accepted') {
    const before = Math.max(0, watch!.judge_failures ?? 0)
    // The first read Jev can't judge tells; the next JUDGE_HOLD_READS hold the lines and ask again; then it tells again.
    if (before > 0 && before <= JUDGE_HOLD_READS) {
      if (!(await save({ judge_failures: before + 1, line_count: lines.length }))) return 'errored'
      log(flow.id, 'judge_held', `reason=${verdict.reason} added=${added.length}`)
      return 'judgeHeld'
    }
    judgeFailures = 1
    log(flow.id, 'judge_failed_open', `reason=${verdict.reason}`)
  }

  // Tell: store the change, emit, and only then remember the read.
  const { data: inserted, error: insertError } = await supabase
    .from('flow_page_change')
    .insert({ flow_id: flow.id, workspace_id: flow.workspace_id, url: pageUrl, added_lines: added })
    .select('id')
    .single()
  const changeId = (inserted as { id?: string } | null)?.id
  if (insertError || !changeId) {
    log(flow.id, 'errored', 'step=change_insert')
    return 'errored'
  }
  try {
    await (deps.send ?? sendWithInngest)({
      name: 'flow/page.changed',
      id: `page-change:${changeId}`,
      data: { workspace_id: flow.workspace_id, flow_id: flow.id, page_change_id: changeId, fired_at: nowIso },
    })
  } catch (err) {
    // Not lost: the change row goes, the remembered reads stay, and the same lines are found on the next read.
    log(flow.id, 'errored', `step=emit reason=${JSON.stringify(err instanceof Error ? err.message.slice(0, 120) : 'unknown')}`)
    const { error: undoError } = await supabase.from('flow_page_change').delete().eq('id', changeId).eq('workspace_id', flow.workspace_id)
    if (undoError) log(flow.id, 'errored', 'step=change_undo')
    return 'errored'
  }
  if (!(await save({ fingerprints: remembered, line_count: lines.length, changed_at: nowIso, judge_failures: judgeFailures }))) {
    // The event went: the next read may find the same lines and tell again (a repeat beats a loss).
    return 'told'
  }
  log(flow.id, 'told', `added=${added.length} change=${changeId}`)
  return 'told'
}

async function failRead(
  supabase: SupabaseClient,
  flow: DueFlow,
  args: { pageUrl: string; watch: WatchRow | null; samePage: boolean; reason: string; nowIso: string; nextIso: string; deps: PageWatchDeps },
): Promise<Outcome> {
  // A new page starts its count (and its remembered reads) from nothing: the old page's failures are not its own.
  const failures = (args.samePage ? Math.max(0, args.watch?.failures ?? 0) : 0) + 1
  const reason = args.reason.slice(0, 300)
  const { error } = await supabase.from('flow_page_watch').upsert(
    {
      flow_id: flow.id,
      workspace_id: flow.workspace_id,
      url: args.pageUrl,
      ...(args.samePage ? {} : { fingerprints: [], line_count: null, judge_failures: 0 }),
      checked_at: args.nowIso,
      failures,
      last_error: reason,
    },
    { onConflict: 'flow_id' },
  )
  if (error) log(flow.id, 'errored', 'step=failure_write')
  log(flow.id, 'read_failed', `failures=${failures} reason=${JSON.stringify(reason)}`)
  if (failures < PAGE_WATCH_MAX_FAILURES) return 'failed'

  if (!(await switchOff(supabase, flow, args.nextIso))) return 'failed'
  // Switched back on later, it starts again from a fresh baseline and a fresh run of tries.
  await resetPageWatch(supabase, flow.id)
  try {
    await (args.deps.notify ?? notifyWithBot)({
      supabase,
      workspaceId: flow.workspace_id,
      flowId: flow.id,
      flowName: flow.name?.trim() || 'a loop',
      ownerUserId: flow.created_by,
      teammateId: flow.ai_team_member_id,
      sentence: stoppedSentence(hostOf(args.pageUrl), failures, reason),
    })
  } catch (err) {
    log(flow.id, 'errored', `step=notice reason=${JSON.stringify(err instanceof Error ? err.message.slice(0, 120) : 'unknown')}`)
  }
  log(flow.id, 'stopped', `failures=${failures}`)
  return 'stopped'
}
