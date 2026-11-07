/**
 * Read side of the work ledger: what the bots read.
 *
 * Reads run on whatever client the caller holds — the session client from an
 * account route (RLS: the owning member's rows) or the service client from a
 * cron. Callers pass the member ids they are allowed to see; nothing here widens
 * a scope on its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WORK_LIVE_STATUSES,
  WORK_NEEDS_YOU_STATUSES,
  WORK_TERMINAL_STATUSES,
  type WorkItem,
} from './types'
import { AI_LIMIT_WINDOW_MS, isPausedFailure, laterSettled, madeSomethingBeyondCards, settledAt } from './presentation'
import { treeRootId } from './tree'
import { readWithPlanFallback } from './plan'

/** Statuses the feed always shows regardless of the time window. */
const ALWAYS_SHOWN = [...new Set([...WORK_LIVE_STATUSES, ...WORK_NEEDS_YOU_STATUSES])]

/** How far back the feed reaches for settled rows. */
export const WORK_FEED_WINDOW_DAYS = 14

/** Row cap per query — the feed is a recent-history surface, not an archive. */
const FEED_LIMIT = 300

/**
 * A ledger row as the surfaces read it: the whole row plus WHO ran it — the
 * teammate the writers stamp (row 4: a loop's system teammate; a work run's
 * teammate from B PR 4), with the bot it wears (migration 294). Read on the
 * caller's client, so a teammate its RLS hides (a private team's) embeds as
 * null and the row simply names no one.
 */
export const WORK_ITEM_SELECT = '*, teammate:ai_team_member_id(id, name, is_system, system_key, role, bot_character)'

/**
 * Whose work a per-teammate read covers: one teammate, in its workspace, as
 * the caller's member there (`memberIds`: the caller's own member row). The
 * caller checks the teammate first (visible, reachable); nothing here widens
 * that.
 */
export interface TeammateScope {
  teammateId: string
  workspaceId: string
  memberIds: string[]
  /**
   * For the workspace's Assistant (bot-owner.ts): its own rows AND every row
   * no other bot the caller can reach holds, the rows the owner rule gives it
   * (no teammate, a deleted bot's, one behind a private team), except the
   * kinds that keep no bot (sequence sends). `otherTeammateIds`: the
   * teammates the caller can reach in the workspace. The caller still names
   * the rows with their owner (withBotOwners) before handing them on.
   */
  unowned?: { otherTeammateIds: readonly string[]; kindsWithoutBot: readonly string[] }
}

const TEAMMATE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `query` narrowed to the scope's teammate's rows (and, for the Assistant, the rows nobody reachable holds: `unowned`). */
function ownedByTeammate<Q extends {
  eq: (column: string, value: string) => Q
  not: (column: string, operator: string, value: string) => Q
  or: (filters: string) => Q
}>(query: Q, scope: TeammateScope): Q {
  const unowned = scope.unowned
  if (!unowned) return query.eq('ai_team_member_id', scope.teammateId)
  const kinds = unowned.kindsWithoutBot.filter((k) => /^[a-z_]+$/.test(k))
  const narrowed = kinds.length > 0 ? query.not('kind', 'in', `(${kinds.join(',')})`) : query
  // Only ids that are uuids are spliced into the filter (they come from the teammate reads).
  const others = [...new Set(unowned.otherTeammateIds)].filter((id) => id !== scope.teammateId && TEAMMATE_UUID.test(id))
  return others.length > 0 ? narrowed.or(`ai_team_member_id.is.null,ai_team_member_id.not.in.(${others.join(',')})`) : narrowed
}

/** Ids per `in` list on a handoff tree read, so the URL stays short (as CARD_RUN_CHUNK). */
const TREE_CHUNK = 200
/**
 * Rows per page of a handoff tree read: PostgREST's own row cap (max-rows,
 * 1000 on Supabase, as CARD_RUNS_READ), so a page that comes back short is
 * the last one.
 */
const TREE_PAGE = 1000

/**
 * A per-teammate read's rows: the caller's own member ids in the teammate's
 * workspace. `tracked_job` SELECT is owner-only (migration
 * 170), so the caller's own rows are what come back either way; naming the
 * member lets the planner start from the member indexes (migration 272)
 * rather than read every member's rows of a teammate that works for all of
 * them (Triage, Extraction) off migration 280's (workspace_id,
 * ai_team_member_id, created_at) index and drop them by RLS after the scan.
 */
function teammateScoped(supabase: SupabaseClient, scope: TeammateScope) {
  return supabase
    .from('tracked_job')
    .select(WORK_ITEM_SELECT)
    .in('member_id', scope.memberIds)
    .eq('workspace_id', scope.workspaceId)
}

/**
 * A teammate's last finished row: the one that settled last (settledAt: when
 * it finished, else when it started), however long ago, not only inside the
 * feed's window. Null when it never finished anything. The bubble's "Last
 * finished" (bots-v4.md Phase 1a), and part of listTeammateWork's answer.
 *
 * Two one-row reads, side by side: its settled row that finished last, and
 * its newest settled row by start (the index's order). The first catches a
 * run that started long before the others and finished after them (one
 * parked on a question for days); the second, a settled row with no finish
 * time, which the first leaves out. The row that settled last is always one
 * of the two: any other row with no finish time started no later than the
 * newest, so it settled no later than that one did.
 */
export async function readLastFinished(
  supabase: SupabaseClient,
  scope: TeammateScope,
): Promise<{ row: WorkItem | null; error: string | null }> {
  if (scope.memberIds.length === 0) return { row: null, error: null }
  const settled = () => ownedByTeammate(teammateScoped(supabase, scope), scope).in('status', [...WORK_TERMINAL_STATUSES])
  const [byFinish, byStart] = await Promise.all([
    settled().not('finished_at', 'is', null).order('finished_at', { ascending: false }).limit(1),
    settled().order('created_at', { ascending: false }).limit(1),
  ])
  const error = byFinish.error?.message ?? byStart.error?.message ?? null
  if (error) return { row: null, error }
  const rows = [...(byFinish.data ?? []), ...(byStart.data ?? [])] as WorkItem[]
  return { row: rows.reduce<WorkItem | null>(laterSettled, null), error: null }
}

/**
 * Every row of the given handoff trees (by `root_id`) in the scope, page by
 * page until a page comes back short, so a tree is never cut off by a cap.
 */
async function readTreeRows(
  supabase: SupabaseClient,
  scope: TeammateScope,
  treeIds: string[],
): Promise<{ rows: WorkItem[]; error: string | null }> {
  const rows: WorkItem[] = []
  for (let from = 0; ; from += TREE_PAGE) {
    const { data, error } = await teammateScoped(supabase, scope)
      .in('root_id', treeIds)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + TREE_PAGE - 1)
    if (error) return { rows: [], error: error.message }
    const page = (data ?? []) as WorkItem[]
    rows.push(...page)
    if (page.length < TREE_PAGE) return { rows, error: null }
  }
}

/**
 * One teammate's work for its bot (bots-v4.md, "A bot's page"; GET
 * /api/account/agent-work?teammate=): two queries narrowed to the teammate,
 * each capped and merged newest first: its open rows however old, and every
 * row it STARTED inside the window. The window is by
 * `created_at` (when the run started): a run that started before it and
 * settled inside it isn't in it. Then the other
 * rows of every handoff tree those rows are in, read by `root_id` (what was
 * handed on in the tree, and the run at its root) and paged, so a handoff
 * reads whole wherever the teammate stands in it; and its last finished row
 * (readLastFinished).
 *
 * Server code calls it as the route does: check the teammate first (visible
 * under RLS, reachable under the private-team rule), then pass the caller's
 * member id in its workspace. A failed read is an error, never a short
 * answer.
 */
export async function listTeammateWork(
  supabase: SupabaseClient,
  args: TeammateScope & { sinceIso: string },
): Promise<{ items: WorkItem[]; lastFinished: WorkItem | null; error: string | null }> {
  if (args.memberIds.length === 0) return { items: [], lastFinished: null, error: null }
  const mine = () => ownedByTeammate(teammateScoped(supabase, args), args)
  const [openRes, recentRes, last] = await Promise.all([
    mine().in('status', ALWAYS_SHOWN).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    mine().gte('created_at', args.sinceIso).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    readLastFinished(supabase, args),
  ])
  const error = openRes.error?.message ?? recentRes.error?.message ?? last.error
  if (error) return { items: [], lastFinished: null, error }
  const own = mergeFeed(openRes.data, recentRes.data)

  // The trees its rows are in: every row below each one's root, and the roots
  // it doesn't hold (its handoff sits under another teammate's run). A chunk's
  // ids are unique rows, so its roots fit in one read.
  const held = new Set(own.map((r) => r.id))
  const treeIds = [...new Set(own.map(treeRootId))]
  const rootIds = [...new Set(own.flatMap((r) => (r.root_id && !held.has(r.root_id) ? [r.root_id] : [])))]
  const [trees, roots] = await Promise.all([
    Promise.all(chunked(treeIds, TREE_CHUNK).map((ids) => readTreeRows(supabase, args, ids))),
    Promise.all(chunked(rootIds, TREE_CHUNK).map((ids) => teammateScoped(supabase, args).in('id', ids).limit(TREE_CHUNK))),
  ])
  const treeError = trees.find((t) => t.error)?.error ?? roots.find((r) => r.error)?.error?.message ?? null
  if (treeError) return { items: [], lastFinished: null, error: treeError }
  const handedOn = [...trees.flatMap((t) => t.rows), ...roots.flatMap((r) => (r.data ?? []) as WorkItem[])]
  return { items: mergeFeed(own, handedOn), lastFinished: last.row, error: null }
}

/** `list` in runs of at most `size`. */
function chunked<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * The columns every light read takes, and the teammate embed as the feed's.
 * `title` and `current_step` (both one short line) are what the chat's Agents
 * widget labels a live row with (chat-widgets.tsx, A4 slice 6). `plan` stays
 * away from the list's end-of-string so withoutPlanColumn still drops it.
 */
const LIGHT_COLUMNS =
  'id, workspace_id, member_id, kind, status, origin, ai_team_member_id, parent_id, root_id, flow_run_id, agent_run_id, source, plan, created_at, title, current_step'
const TEAMMATE_EMBED = 'teammate:ai_team_member_id(id, name, is_system, system_key, role, bot_character)'

/**
 * A ledger row as the always-on counts read it (GET /api/account/agent-work
 * ?light=1): who owns it, whether it runs or waits, where it sits in its
 * handoff tree, the run a card points at, the agent run behind a work run
 * (`agent_run_id`: where a bot's bubble continues that run's chat,
 * lib/bots/item-run-chat.ts), `source` (its `run_chat`), `needs`
 * (what a waiting row asks: with its status, the bots tell one time it waits
 * on you from the next, teammate-bots.ts `episodeKey`) and `opened_at` (a row
 * opened since it last started waiting on you is not new, so its bot stops
 * calling for it: migration 295) and `last_beat_at` (a `running` row that
 * stopped beating long ago keeps no bot on screen: lib/bots/app-presence.ts
 * runningFaces) and `plan` (the agent's checklist, small: a running row's
 * "3/5" badge, migration 331), `title` and `current_step` (one line each:
 * the Agents widget's label and step) — no progress or deliverables. The
 * teammate embed as the feed's. Naming `opened_at` makes this read fail on a
 * database without migration 295, and `plan` (every light read, LIGHT_COLUMNS)
 * on one without migration 331.
 */
export const LIGHT_WORK_ITEM_SELECT = `${LIGHT_COLUMNS}, needs, opened_at, last_beat_at, ${TEAMMATE_EMBED}`

/**
 * A pending card's run row (listPendingCardRows): the light columns with
 * `opened_at`. A card finds its owner on that row, and a run's cards fold into
 * one batch whose peek stays until the run is opened (bots v3 1b: the run's
 * `opened_at`; a card itself is new until it is settled). On a database
 * without migration 295 the read is made again without it
 * (CARD_RUN_ROW_SELECT_BEFORE_295), so the card rows still name every
 * card's owner there.
 */
export const CARD_RUN_ROW_SELECT = `${LIGHT_COLUMNS}, opened_at, ${TEAMMATE_EMBED}`
/** CARD_RUN_ROW_SELECT for a database without migration 295. */
export const CARD_RUN_ROW_SELECT_BEFORE_295 = `${LIGHT_COLUMNS}, ${TEAMMATE_EMBED}`

export type LightWorkRow = Pick<
  WorkItem,
  | 'id'
  | 'workspace_id'
  | 'member_id'
  | 'kind'
  | 'status'
  | 'origin'
  | 'ai_team_member_id'
  | 'parent_id'
  | 'root_id'
  | 'flow_run_id'
  | 'source'
  | 'plan'
  | 'needs'
  | 'opened_at'
  | 'created_at'
  | 'teammate'
> & {
  /** Its title and step line (LIGHT_COLUMNS reads them); optional, so a row built without them reads as untitled. */
  title?: string | null
  current_step?: string | null
  /** The agent run behind it (LIGHT_COLUMNS reads it); optional, so a row built without it reads as having none. */
  agent_run_id?: string | null
  /** Its last beat (LIGHT_WORK_ITEM_SELECT reads it); optional, so a row built without it reads as alive. */
  last_beat_at?: string | null
}

/** A pending card's run row, as CARD_RUN_ROW_SELECT reads it. */
export type CardRunRow = Omit<LightWorkRow, 'needs' | 'opened_at' | 'last_beat_at'> & {
  /** When the run was opened (bots v3 1b: its batch stops peeking); optional, a row built without it reads as unopened. */
  opened_at?: string | null
}

/**
 * The light feed: only the open rows (live or waiting on the user), in light
 * columns, scoped by workspace, not by member — everything
 * the per-teammate counts read (a settled row counts for nothing, and a
 * handoff's live or waiting root is open itself). A failed read is an error.
 *
 * `memberIds`: a SERVICE client caller's fence (the main agent's reads,
 * src/lib/bots/bot-work-server.ts): the caller's own member rows, so the read
 * returns what the session client's owner-only RLS would. The route's session
 * client leaves it out.
 */
export async function listOpenWorkInWorkspaces(
  supabase: SupabaseClient,
  args: { workspaceIds: string[]; memberIds?: readonly string[] },
): Promise<{ items: LightWorkRow[]; error: string | null }> {
  if (args.workspaceIds.length === 0 || args.memberIds?.length === 0) return { items: [], error: null }
  // Without migration 331 the read is made again without `plan` (readWithPlanFallback).
  const { data, error } = await readWithPlanFallback(LIGHT_WORK_ITEM_SELECT, (columns) => {
    let q = supabase.from('tracked_job').select(columns).in('workspace_id', args.workspaceIds)
    if (args.memberIds) q = q.in('member_id', [...args.memberIds])
    return q.in('status', ALWAYS_SHOWN).order('created_at', { ascending: false }).limit(FEED_LIMIT)
  })
  if (error) return { items: [], error: error.message }
  return { items: (data ?? []) as unknown as LightWorkRow[], error: null }
}

/** Whose rows a light read's member-scoped reads cover: the caller's member row in each workspace. */
export type LightScope = ReadonlyArray<{ memberId: string; workspaceId: string }>

/**
 * How long after it finished a run that finished `done` with something made
 * stays in the light read (bots v3 1b's done tier): the window the light read
 * keeps its done rows for.
 */
export const LIGHT_DONE_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * How far back by START the light read looks for those done rows: an index
 * range on (member_id, status, created_at) (migration 272), not every done row
 * the caller ever had. A run that started before it and finished inside the
 * last day (one parked on a question for days) isn't read: its peek still
 * shows when it settled while Dial8 was open (its push is held whole).
 */
export const LIGHT_DONE_STARTED_WINDOW_MS = 2 * LIGHT_DONE_WINDOW_MS
/**
 * At most this many done rows are kept, newest first: more than a day of peeks
 * (each bot peeks with its newest, and "+N more"). One weighs about 1 KB with
 * its deliverables (DEV, 2026-10-07; PROD's heaviest user, 46 KB for 50), so
 * this keeps the light read well under its 150 KB bar.
 */
export const LIGHT_DONE_LIMIT = 50
/**
 * How many are read to keep LIGHT_DONE_LIMIT of them: the read leaves out the
 * runs that made nothing (`deliverables` = `[]`), but "made something beside
 * cards" (madeSomethingBeyondCards) is only checked here, so a busy run of
 * card-only verdicts mustn't crowd out an older drafting pass. Cards-only rows
 * are what's left to filter (PROD's heaviest user: 86 unopened done rows in
 * the window, before the empty ones were left out).
 */
export const LIGHT_DONE_READ = 150

/**
 * A done row as the light read keeps it (bots-v4 Phase 4b, "What the shared
 * source keeps loading"): the light columns with what a "done" peek needs and
 * LIGHT_COLUMNS lacks, `deliverables` (what it made, and so what it says),
 * `finished_at` (how recent: DONE_PEEK_MAX_AGE_MS), plus `needs` and
 * `opened_at`, as LIGHT_WORK_ITEM_SELECT has them (`title`, its line, is in
 * LIGHT_COLUMNS).
 */
export const LIGHT_DONE_WORK_ITEM_SELECT = `${LIGHT_COLUMNS}, needs, opened_at, finished_at, deliverables, ${TEAMMATE_EMBED}`

export type LightDoneRow = LightWorkRow & Pick<WorkItem, 'finished_at' | 'title' | 'deliverables'>

/**
 * The caller's runs that finished `done` with something made (beside cards:
 * madeSomethingBeyondCards) in the last LIGHT_DONE_WINDOW_MS and weren't
 * opened, each a teammate's, newest first, at most LIGHT_DONE_LIMIT
 * (LIGHT_DONE_WORK_ITEM_SELECT): the rows a "done" peek speaks for, so it
 * survives a reload. The runs that made nothing are left out by the read;
 * up to LIGHT_DONE_READ are read, and the cards-only ones dropped here, before
 * the cap, so an older drafting pass behind a burst of verdicts is still kept.
 * Read as the caller's member in each workspace, like
 * listTeammateWork: `tracked_job` SELECT is owner-only (migration 170), so the
 * rows are the same either way, and naming the member lets the planner range
 * over (member_id, status, created_at) instead of every done row the
 * workspaces ever had. A done peek is the caller's own news, so it stays
 * member-scoped the day the SELECT policy widens. Fail-soft: a failed read is
 * no rows (no done peeks until the next load), never a failed light read.
 */
export async function listRecentDoneWork(
  supabase: SupabaseClient,
  args: { scope: LightScope; now: Date },
): Promise<LightDoneRow[]> {
  if (args.scope.length === 0) return []
  const finishedSince = args.now.getTime() - LIGHT_DONE_WINDOW_MS
  const finishedSinceIso = new Date(finishedSince).toISOString()
  const startedSinceIso = new Date(args.now.getTime() - LIGHT_DONE_STARTED_WINDOW_MS).toISOString()
  try {
    const { data, error } = await readWithPlanFallback(LIGHT_DONE_WORK_ITEM_SELECT, (columns) =>
      supabase
        .from('tracked_job')
        .select(columns)
        .in('member_id', [...new Set(args.scope.map((s) => s.memberId))])
        .in('workspace_id', [...new Set(args.scope.map((s) => s.workspaceId))])
        .eq('status', 'done')
        .gte('created_at', startedSinceIso)
        .not('ai_team_member_id', 'is', null)
        .is('opened_at', null)
        // jsonb `<> '[]'`: the runs that made nothing at all aren't read.
        .neq('deliverables', '[]')
        .or(`finished_at.gte.${finishedSinceIso},finished_at.is.null`)
        .order('created_at', { ascending: false })
        .limit(LIGHT_DONE_READ),
    )
    if (error) throw new Error(error.message)
    return ((data ?? []) as unknown as LightDoneRow[])
      .filter((row) => {
        // Timestamps compared as times: Postgres writes `+00:00`, the bound is `Z`.
        const at = Date.parse(settledAt(row))
        return Number.isFinite(at) && at >= finishedSince && madeSomethingBeyondCards(row.deliverables)
      })
      .slice(0, LIGHT_DONE_LIMIT)
  } catch (err) {
    console.error('[work] listRecentDoneWork failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/** The usage-limit failures read per light read: PostgREST's own row cap. */
const AI_LIMIT_FAILURES_READ = 1000
/** The later runs read for every stopped teammate at once: PostgREST's own row cap. */
export const AI_LIMIT_LATER_READ = 1000

/** A teammate the AI usage limit stopped (its newest run in the window failed on it), and since when. */
export interface AiLimitedTeammate {
  teammate_id: string
  workspace_id: string
  /** When that run settled (when it finished, else when it started). */
  at: string
}

type FailureRow = Pick<WorkItem, 'ai_team_member_id' | 'workspace_id' | 'member_id' | 'status' | 'error_message' | 'finished_at' | 'created_at'>

/**
 * The teammates the AI usage limit has stopped, for their bots' sleep
 * (bots-v4 Phase 4b, "Asleep from the AI limit"; the ledger's usage-limit
 * failures, isPausedFailure): those whose newest run (by start) in the last
 * AI_LIMIT_WINDOW_MS failed on the limit. A later run of any kind clears it:
 * one running makes the bot work anyway, and one that settled any other way
 * means the limit no longer stops it. That's the bot's page's rule
 * (bot-page.ts stoppedByAiLimit over its last finished row) read for every
 * teammate at once, without a `DISTINCT ON`.
 *
 * Two reads, as the caller's member in each workspace (owner-only RLS, as
 * listRecentDoneWork):
 *   1. the usage-limit failures in the window, newest first, so each
 *      teammate's first is its newest;
 *   2. only when there are some (none, most of the time): ONE read of the runs
 *      those teammates started since the earliest of them that weren't
 *      stopped by the limit, newest first (AI_LIMIT_LATER_READ), compared
 *      here: a teammate with a run of its own started after its failure is
 *      awake. One request whatever the number of teammates, even when the
 *      plan limit has stopped every one of them. Should that read come back
 *      full, a teammate it holds no later run for is counted awake (it can't
 *      be told, and a thousand runs since says the limit isn't stopping things).
 * Covers whatever the ledger records, loops and the rest. A failed read is
 * none (the bots stay awake), never a failed light read.
 */
export async function listAiLimitedTeammates(
  supabase: SupabaseClient,
  args: { scope: LightScope; now: Date },
): Promise<AiLimitedTeammate[]> {
  if (args.scope.length === 0) return []
  const since = args.now.getTime() - AI_LIMIT_WINDOW_MS
  try {
    const { data, error } = await supabase
      .from('tracked_job')
      .select('ai_team_member_id, workspace_id, member_id, status, error_message, finished_at, created_at')
      .in('member_id', [...new Set(args.scope.map((s) => s.memberId))])
      .in('workspace_id', [...new Set(args.scope.map((s) => s.workspaceId))])
      .eq('status', 'failed')
      .gte('created_at', new Date(since).toISOString())
      .not('ai_team_member_id', 'is', null)
      .ilike('error_message', '%usage limit%')
      .order('created_at', { ascending: false })
      .limit(AI_LIMIT_FAILURES_READ)
    if (error) throw new Error(error.message)
    const newest = new Map<string, FailureRow>()
    for (const row of (data ?? []) as FailureRow[]) {
      if (!row.ai_team_member_id || !isPausedFailure(row)) continue
      const key = `${row.workspace_id}:${row.ai_team_member_id}`
      if (!newest.has(key)) newest.set(key, row)
    }
    const stopped = [...newest.values()]
    if (stopped.length === 0) return []
    const time = (iso: string) => Date.parse(iso)
    const earliest = stopped.reduce((a, b) => (time(b.created_at) < time(a.created_at) ? b : a))
    const { data: laterData, error: laterError } = await supabase
      .from('tracked_job')
      .select('ai_team_member_id, workspace_id, created_at')
      .in('member_id', [...new Set(stopped.map((r) => r.member_id))])
      .in('workspace_id', [...new Set(stopped.map((r) => r.workspace_id))])
      .in('ai_team_member_id', [...new Set(stopped.map((r) => r.ai_team_member_id as string))])
      .gt('created_at', earliest.created_at)
      // Not the limit's own failures: those aren't a run that went through.
      .or('status.neq.failed,error_message.is.null,error_message.not.ilike.*usage limit*')
      .order('created_at', { ascending: false })
      .limit(AI_LIMIT_LATER_READ)
    if (laterError) throw new Error(laterError.message)
    const later = (laterData ?? []) as Array<Pick<WorkItem, 'ai_team_member_id' | 'workspace_id' | 'created_at'>>
    const full = later.length >= AI_LIMIT_LATER_READ
    const out: AiLimitedTeammate[] = []
    for (const row of stopped) {
      const failedAt = time(row.created_at)
      const woke = later.some(
        (l) => l.ai_team_member_id === row.ai_team_member_id && l.workspace_id === row.workspace_id && time(l.created_at) > failedAt,
      )
      if (woke || full) continue
      const at = settledAt(row)
      const settled = time(at)
      if (!Number.isFinite(settled) || settled < since) continue
      out.push({ teammate_id: row.ai_team_member_id as string, workspace_id: row.workspace_id, at })
    }
    return out
  } catch (err) {
    console.error('[work] listAiLimitedTeammates failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * A bound on the pending cards read for their runs, not a page: every pending,
 * unexpired card the caller has is read (PROD, 2026-09-30: the one user with
 * pending cards had 12, from 7 runs). It is PostgREST's own row cap.
 */
const CARD_RUNS_READ = 1000
/** Run ids per `tracked_job` read, so the `in` list stays a short URL. */
const CARD_RUN_CHUNK = 200

/**
 * The rows the caller's pending attention cards point at (`source_flow_run_id`
 * → `tracked_job.flow_run_id`), in light columns with `opened_at`
 * (CARD_RUN_ROW_SELECT): where a card finds its owner. A verdict run settles
 * `done` once its cards are out, so its row is usually outside the open rows,
 * and can be outside the feed's window too.
 * EVERY pending, unexpired card (RLS: the caller's own), not the attention
 * route's newest 50: the client can hold more than 50 (cards arrive live), and
 * light and full must find the same owners for all of them. Fail-soft: a
 * failed read is no rows, and a card with no row simply has no owner yet.
 *
 * `memberIds`: a SERVICE client caller's fence, as listOpenWorkInWorkspaces'
 * (the caller's own member rows, on both the cards and their rows).
 */
export async function listPendingCardRows(
  supabase: SupabaseClient,
  args: { workspaceIds: string[]; nowIso: string; memberIds?: readonly string[] },
): Promise<CardRunRow[]> {
  if (args.workspaceIds.length === 0 || args.memberIds?.length === 0) return []
  const memberIds = args.memberIds ? [...args.memberIds] : null
  try {
    let cardsRead = supabase
      .from('attention_item')
      .select('source_flow_run_id')
      .eq('status', 'pending')
      .in('workspace_id', args.workspaceIds)
    if (memberIds) cardsRead = cardsRead.in('member_id', memberIds)
    const { data: cards, error: cardsError } = await cardsRead
      .or(`expires_at.is.null,expires_at.gt.${args.nowIso}`)
      .limit(CARD_RUNS_READ)
    if (cardsError) throw new Error(cardsError.message)
    const runIds = [
      ...new Set(
        ((cards ?? []) as Array<{ source_flow_run_id: string | null }>)
          .map((c) => c.source_flow_run_id)
          .filter((id): id is string => !!id),
      ),
    ]
    const rows: CardRunRow[] = []
    // A database without migration 295 has no `opened_at`: read without it
    // there, so every card still finds its owner (its batch then peeks until
    // dismissed: bots v3 1b).
    let select = CARD_RUN_ROW_SELECT
    for (let i = 0; i < runIds.length; i += CARD_RUN_CHUNK) {
      const chunk = runIds.slice(i, i + CARD_RUN_CHUNK)
      const read = (select: string) =>
        readWithPlanFallback(select, (columns) => {
          const q = supabase.from('tracked_job').select(columns).in('workspace_id', args.workspaceIds)
          return (memberIds ? q.in('member_id', memberIds) : q).in('flow_run_id', chunk).limit(CARD_RUNS_READ)
        })
      let { data, error } = await read(select)
      if (error && select === CARD_RUN_ROW_SELECT && /opened_at/.test(error.message ?? '')) {
        select = CARD_RUN_ROW_SELECT_BEFORE_295
        ;({ data, error } = await read(select))
      }
      if (error) throw new Error(error.message)
      rows.push(...((data ?? []) as unknown as CardRunRow[]))
    }
    return rows
  } catch (err) {
    console.error('[work] listPendingCardRows failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Open rows then recent rows, de-duplicated by id, newest first. */
function mergeFeed(open: unknown[] | null, recent: unknown[] | null): WorkItem[] {
  const seen = new Set<string>()
  const out: WorkItem[] = []
  for (const row of [...((open ?? []) as WorkItem[]), ...((recent ?? []) as WorkItem[])]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  return out
}
