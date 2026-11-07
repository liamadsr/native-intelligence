/**
 * How the Agents page (plan Part 5 row 7) reads the work feed: who each row
 * belongs to, which rows a roster entry or the workspace filter keeps, which
 * cancel route a row's Stop calls, and how an attempt is marked. Pure, so the
 * page's rules are unit-tested once here.
 *
 * Every row belongs to an OWNER:
 *   - the teammate stamped on it (`ai_team_member_id`), or
 *   - with none, its LANE: the kind of work, named for itself ("Sequences",
 *     "CRM import", "Email import"). A row with no teammate is never shown as
 *     "You": the person started it, but the work is the lane's.
 *
 * Since bots-v4 Phase 5 every AI run comes from a bot (system-teammates.ts
 * workTeammateId: prospecting, evals, onboarding research, enrichment, a
 * person's own coding, work and loop runs), and imports come from the
 * Assistant too. Work with no bot the viewer can reach (an older row, a
 * deleted bot's, one behind a private team) is the workspace's Assistant's,
 * the rule in bot-owner.ts, applied where the rows and cards are read (the
 * shared source, the routes), so every function here reads its answer off
 * `ai_team_member_id` and the card's payload without knowing it. What still
 * has a lane: sequence sends, which keep the Sequences page and no bot, and
 * any work in a workspace with no Assistant known (named by its kind,
 * kindLabel, until it ages out of the feed's window).
 */
import { kindLabel, partitionWorkTrees, settledAt, type PartitionedTrees } from './presentation'
import { isWorkLive, workNeedsYou, type WorkItem } from './types'
import { buildWorkForest, foldsIntoRoot, rowsOf, statusLookup } from './tree'
import { localAgentSessionIdOf } from '@/lib/local-agent/transcript-view'

/** The lanes that run without a teammate and have their own name and mark: the non-AI kinds (bots-v4 Phase 5). */
export const WORK_LANE_LABELS: Record<string, string> = {
  sequence_enrolment: 'Sequences',
  crm_import: 'CRM import',
  email_import: 'Email import',
}

export type WorkOwner =
  | { type: 'teammate'; key: string; id: string; name: string }
  | { type: 'lane'; key: string; kind: string; label: string }

const LANE_KEY_PREFIX = 'lane:'

export function laneLabel(kind: string): string {
  return WORK_LANE_LABELS[kind] ?? kindLabel(kind)
}

export function ownerOf(item: Pick<WorkItem, 'kind' | 'ai_team_member_id' | 'teammate'>): WorkOwner {
  const id = item.ai_team_member_id ?? null
  if (id) return { type: 'teammate', key: `tm:${id}`, id, name: item.teammate?.name?.trim() || 'Teammate' }
  return { type: 'lane', key: `${LANE_KEY_PREFIX}${item.kind}`, kind: item.kind, label: laneLabel(item.kind) }
}

export function teammateKey(id: string): string {
  return `tm:${id}`
}

/**
 * The roster entries the owner filter keeps; null or empty = everyone. A SET:
 * one bot stands for every teammate wearing its face, across workspaces, so a
 * bot's click filters the page to all of them (open-teammate.ts). A roster
 * click still selects one entry.
 */
export type OwnerKeys = ReadonlySet<string> | null

/** Whether the filter narrows to some owners at all. */
export function filtersOwners(keys: OwnerKeys): keys is ReadonlySet<string> {
  return !!keys && keys.size > 0
}

/** The page's two filters: the workspace ("This workspace", null = all) and the roster entries. */
export interface AgentWorkFilter {
  workspaceId: string | null
  ownerKeys: OwnerKeys
}

export function keepItem(item: WorkItem, filter: AgentWorkFilter): boolean {
  if (filter.workspaceId && item.workspace_id !== filter.workspaceId) return false
  if (filtersOwners(filter.ownerKeys) && !filter.ownerKeys.has(ownerOf(item).key)) return false
  return true
}

/** What a card's owners are read from: the ledger rows the surface holds. */
export type CardOwnerRow = Pick<WorkItem, 'kind' | 'ai_team_member_id' | 'teammate' | 'flow_run_id'>

/** A pending attention card, as far as its owners go (an AttentionItem is one). */
export interface OwnedCard {
  id: string
  source_flow_run_id: string | null
  payload?: {
    assignee_ai_member_id?: string | null
    raised_by_ai_member_id?: string | null
    /** The run's ledger row and loop, stamped at insert (bots v3 1a): its batch (lib/bots/batch.ts). */
    work_item_id?: string | null
    flow_id?: string | null
    /**
     * Its workspace's Assistant, set where the card is read when nothing names
     * the bot that raised it (bot-owner.ts withCardOwner): the owner when no
     * run row of the card's names one. Never stored.
     */
    fallback_owner_ai_member_id?: string | null
  } | null
}

/**
 * The owners of a pending attention card, for the roster filter and the bots:
 * whoever raised it (bots-v4.md decision 9: a card belongs to the bot that
 * raised it). Who raised it is read first off the card itself
 * (`payload.raised_by_ai_member_id`, stamped when the card is inserted; bots v3
 * 1a), else off the run that wrote it (its ledger row, matched on
 * `source_flow_run_id`: a teammate, or a lane for a run with none). The
 * teammate a card proposes for the work (`payload.assignee_ai_member_id`: a
 * work proposal's, or an action's agent assignee) never owns it, so one card
 * never calls from two bots: it only mentions it (cardMentions), and its page
 * shows the card read-only. A card that names no one and whose run row isn't
 * held is its workspace's Assistant's (`payload.fallback_owner_ai_member_id`,
 * set where cards are read: bot-owner.ts withCardOwner), and has no owner only
 * in a workspace with no Assistant known.
 */
export function cardOwnerKeys(
  card: Pick<OwnedCard, 'source_flow_run_id' | 'payload'>,
  items: readonly CardOwnerRow[],
): string[] {
  const raisedBy = card.payload?.raised_by_ai_member_id
  if (typeof raisedBy === 'string' && raisedBy) return [teammateKey(raisedBy)]
  if (card.source_flow_run_id) {
    const row = items.find((it) => it.flow_run_id === card.source_flow_run_id)
    if (row) return [ownerOf(row).key]
  }
  const fallback = card.payload?.fallback_owner_ai_member_id
  if (typeof fallback === 'string' && fallback) return [teammateKey(fallback)]
  return []
}

/**
 * The teammates a pending card names without owning it (bots-v4.md decision
 * 9): the one it proposes for the work (`payload.assignee_ai_member_id`),
 * unless that teammate is also the one that raised it. Its bot's page shows
 * the card read-only ("From Triage"), with no dot and no count: settling it is
 * the raiser's. Teammate ids (not keys).
 */
export function cardMentions(
  card: Pick<OwnedCard, 'source_flow_run_id' | 'payload'>,
  items: readonly CardOwnerRow[],
): string[] {
  const proposed = card.payload?.assignee_ai_member_id
  if (typeof proposed !== 'string' || !proposed) return []
  return cardOwnerKeys(card, items).includes(teammateKey(proposed)) ? [] : [proposed]
}

export function keepCard(
  card: { workspace_id: string; source_flow_run_id: string | null; payload?: OwnedCard['payload'] },
  items: readonly CardOwnerRow[],
  filter: AgentWorkFilter,
): boolean {
  if (filter.workspaceId && card.workspace_id !== filter.workspaceId) return false
  const keys = filter.ownerKeys
  if (filtersOwners(keys) && !cardOwnerKeys(card, items).some((k) => keys.has(k))) return false
  return true
}

/**
 * The cancel route a live row's Stop calls, or null when nothing can stop it:
 * an agent run through its action's route (or the run's own when it has no
 * action), a prospecting run or an eval run through theirs, and a local
 * agent's turn through its session's (the session stops on the Mac; local
 * agents contract G). The caller sends the row's own workspace as
 * `x-workspace-id`: the page spans workspaces, and the routes resolve the
 * workspace from that header (the local agent's is the person's own).
 */
export function stopRouteOf(item: Pick<WorkItem, 'status' | 'kind' | 'agent_run_id' | 'source'>): string | null {
  if (!isWorkLive(item.status)) return null
  if (item.kind === 'local_agent') {
    const sessionId = localAgentSessionIdOf(item)
    return sessionId ? `/api/local-agent/sessions/${sessionId}/stop` : null
  }
  const source = item.source ?? {}
  if (item.agent_run_id) {
    return typeof source.action_id === 'string' && source.action_id
      ? `/api/account/actions/${source.action_id}/agent-runs/${item.agent_run_id}/cancel`
      : `/api/account/agent-runs/${item.agent_run_id}/cancel`
  }
  if (item.kind === 'prospecting' && typeof source.prospecting_run_id === 'string' && source.prospecting_run_id) {
    return `/api/account/prospecting/runs/${source.prospecting_run_id}/cancel`
  }
  if (item.kind === 'eval' && typeof source.eval_run_id === 'string' && source.eval_run_id) {
    return `/api/account/evals/runs/${source.eval_run_id}/cancel`
  }
  return null
}

/** An unattended attempt (migration 280 `origin`). */
export function isAttempt(item: Pick<WorkItem, 'origin'>): boolean {
  return item.origin === 'attempt'
}

/** How a reviewed item left "Needs you", for the Recent row's mark. */
export function reviewOutcome(item: Pick<WorkItem, 'progress'>): 'reviewed' | 'dismissed' | 'expired' | null {
  const r = item.progress?.review
  return r === 'reviewed' || r === 'dismissed' || r === 'expired' ? r : null
}

export interface OwnerCounts {
  running: number
  /** Rows waiting on the user plus the pending cards the owner has in the deck. */
  needsYou: number
  /**
   * What may make the owner's bot call for you (bot-characters.md Step 3):
   * the ids of its waiting rows not opened yet (`notOpenedYet`), and of its
   * pending cards. Row ids and card ids, in that order; they never collide
   * (both are uuids, from two tables).
   */
  beckoning: string[]
  /**
   * Of `beckoning`, the rows parked on a question (needs_input): they ask in
   * the chat (P13), so they never light the bot's dot (hasDot). The bubble
   * still lists them. Absent: none.
   */
  asking?: string[]
}

/** Whether the owner's bot shows its dot: something new from it that isn't a question (those ask in the chat, P13). */
export function hasDot(c: OwnerCounts | undefined): boolean {
  return !!c && c.beckoning.length > (c.asking?.length ?? 0)
}

/** What the roster's numbers read off a ledger row (a full feed row or a light one). */
export type CountRow = Pick<
  WorkItem,
  'id' | 'kind' | 'status' | 'root_id' | 'ai_team_member_id' | 'teammate' | 'source' | 'flow_run_id' | 'opened_at'
>

/**
 * The "unopened" filter (bot-characters.md Step 3, item 4): a waiting row is
 * new until its owner opens its panel, which stamps `tracked_job.opened_at`
 * (migration 295; the panel calls PATCH /api/account/activity/[id] { action:
 * 'opened' }), and new again each time it starts waiting on them (the
 * recorder clears the stamp on every move into needs_input / needs_review).
 * Both the light and the full answer carry the column, and the realtime
 * UPDATE carries the stamp and the clear, so the bot stops, or calls again, at
 * once. Cards are never "opened": a pending card is new until it is settled.
 */
export function notOpenedYet(item: Pick<CountRow, 'opened_at'>): boolean {
  return !item.opened_at
}

/**
 * Whether a waiting row may make its teammate's bot call for you: it hasn't
 * been opened since it last started waiting (`notOpenedYet`). Every waiting
 * row may (the email drafting pass finishes `done`, and waits on no one).
 */
export function mayBeckon(item: Pick<CountRow, 'opened_at'>): boolean {
  return notOpenedYet(item)
}

/**
 * Per owner: rows executing now, what is waiting on the user, and what may
 * make its bot call for you (the roster's numbers, and the bots').
 *
 * `needsYou` is what the "Needs you" lane counts with that roster entry
 * selected, counted the way the deck merges its two queues (rail-cards.ts
 * `mergeRailCards`): each waiting row once, except a handoff reviewed with its
 * root (row 14), plus each pending card `cardOwnerKeys` gives the owner. The
 * deck never de-duplicates a run against its cards, and needs not: a verdict
 * run settles `done` (flow-results.ts `reviewFor`), its cards being the review,
 * so a loop run and its "N cards for you" are only ever its N cards. A card
 * counts for the one that raised it only (decision 9: a teammate it proposes
 * for the work counts nothing for it, cardMentions); a card with no owner
 * (only in a workspace with no Assistant known: bot-owner.ts) counts for no one.
 * Each row counts for its own owner, and under a roster filter the lane lists
 * only the waiting rows whose own owner is the one selected
 * (`partitionForOwner`), so the two always agree, handoff trees included.
 *
 * `cards` is the pending queue (useAttentionItems holds only pending cards).
 * `lookup` is where cards find the run that wrote them: every row the surface
 * holds, including the ones pending cards point at outside the feed.
 */
export function countByOwner(
  items: readonly CountRow[],
  cards: readonly OwnedCard[] = [],
  lookup: readonly CardOwnerRow[] = items,
): Map<string, OwnerCounts> {
  const out = new Map<string, OwnerCounts>()
  const at = (key: string): OwnerCounts => {
    let c = out.get(key)
    if (!c) {
      c = { running: 0, needsYou: 0, beckoning: [] }
      out.set(key, c)
    }
    return c
  }
  const rootStatus = statusLookup(items)
  for (const item of items) {
    const c = at(ownerOf(item).key)
    if (workNeedsYou(item.status)) {
      if (foldsIntoRoot(item, rootStatus)) continue
      c.needsYou += 1
      if (mayBeckon(item)) {
        c.beckoning.push(item.id)
        if (item.status === 'needs_input') (c.asking ??= []).push(item.id)
      }
    } else if (isWorkLive(item.status)) c.running += 1
  }
  for (const card of cards) {
    for (const key of cardOwnerKeys(card, lookup)) {
      const c = at(key)
      c.needsYou += 1
      c.beckoning.push(card.id)
    }
  }
  return out
}

/**
 * What is new for a SET of owners (one bot stands for every teammate wearing
 * its face): the union of their `beckoning`, each id once (a card two of them
 * share is one thing waiting), in the order the owners are named. countByOwner
 * stays per owner; a set's answer is read off its map here.
 */
export function beckoningFor(counts: ReadonlyMap<string, OwnerCounts>, ownerKeys: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of ownerKeys) {
    for (const id of counts.get(key)?.beckoning ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * The rows cards look their run up in: the feed plus the rows pending cards
 * point at outside it (the route's `card_rows`), each once.
 */
export function cardLookupRows<T extends { id: string }>(items: readonly T[], cardRows: readonly T[]): T[] {
  if (cardRows.length === 0) return items as T[]
  const have = new Set(items.map((it) => it.id))
  return [...items, ...cardRows.filter((r) => !have.has(r.id))]
}

/**
 * The page's lanes under its filter (row 14). With no roster entry selected,
 * `partitionWorkTrees`. With some selected (`items` already holds every tree
 * any of their rows are in), Running now and Recent keep those trees whole, so
 * a teammate's handoff shows with the work it was part of, but Needs you lists
 * only the entries whose OWN row is a selected owner's: the lane counts what
 * those entries' "N waiting" count (`countByOwner`). Another owner's waiting
 * root, kept for a selected owner's rows under it, moves to Running now when
 * anything in its tree runs, else to Recent, so those rows stay on the page.
 */
export function partitionForOwner(items: readonly WorkItem[], ownerKeys: OwnerKeys): PartitionedTrees {
  const out = partitionWorkTrees(items)
  if (!filtersOwners(ownerKeys)) return out
  const roots = new Set(buildWorkForest(items).map((t) => t.item.id))
  const needsYou: PartitionedTrees['needsYou'] = []
  for (const tree of out.needsYou) {
    if (ownerKeys.has(ownerOf(tree.item).key)) needsYou.push(tree)
    // A handoff listed on its own is also in its root's tree: dropping it here hides nothing.
    else if (roots.has(tree.item.id)) (rowsOf(tree).some((it) => isWorkLive(it.status)) ? out.running : out.recent).push(tree)
  }
  const newest = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
  out.running.sort((a, b) => newest(a.item.started_at ?? a.item.created_at, b.item.started_at ?? b.item.created_at))
  out.recent.sort((a, b) => newest(settledAt(a.item), settledAt(b.item)))
  return { ...out, needsYou }
}

/**
 * The roster's lane entries (named lanes first): the lanes present in the
 * feed, plus every lane `keys` names. Pass the counts' keys, so a lane counted
 * only through a pending card whose run is outside the feed (`card_rows`)
 * still has an entry to show its number on.
 */
export function lanesIn(
  items: readonly Pick<WorkItem, 'kind' | 'ai_team_member_id' | 'teammate'>[],
  keys: Iterable<string> = [],
): Array<{ key: string; kind: string; label: string }> {
  const seen = new Map<string, { key: string; kind: string; label: string }>()
  for (const item of items) {
    const owner = ownerOf(item)
    if (owner.type === 'lane' && !seen.has(owner.key)) seen.set(owner.key, { key: owner.key, kind: owner.kind, label: owner.label })
  }
  for (const key of keys) {
    if (!key.startsWith(LANE_KEY_PREFIX) || seen.has(key)) continue
    const kind = key.slice(LANE_KEY_PREFIX.length)
    seen.set(key, { key, kind, label: laneLabel(kind) })
  }
  const named = (kind: string) => (kind in WORK_LANE_LABELS ? 0 : 1)
  return [...seen.values()].sort((a, b) => named(a.kind) - named(b.kind) || a.label.localeCompare(b.label))
}
