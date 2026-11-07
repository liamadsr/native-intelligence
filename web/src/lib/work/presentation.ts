/**
 * How a work item reads on screen (ACTIVITY-AND-REVIEW-DESIGN §4.1-4.2): the
 * section it belongs to, its one-line status, the verb each deliverable
 * implies. Pure, so the Activity dialog and the detail panel share one
 * vocabulary and the copy is unit-tested rather than re-derived per surface.
 */
import {
  isWorkLive,
  isWorkTerminal,
  workNeedsYou,
  type WorkDeliverable,
  type WorkDeliverableType,
  type WorkItem,
  type WorkReviewVerb,
  type WorkStatus,
  type WorkStep,
} from './types'
import { WORK_ROLE_LABELS, isWorkRole } from './roles'
import { buildWorkForest, descendantsOf, foldsIntoRoot, statusLookup, type WorkTree } from './tree'

export const WORK_KIND_LABELS: Record<string, string> = {
  flow_run: 'Loop',
  skill_run: 'Skill run',
  work_run: 'Work run',
  coding_run: 'Coding run',
  email_drafts: 'Email assistant',
  extraction: 'Extraction',
  triage_reconcile: 'Triage reconcile',
  proposal_age_out: 'Age-out sweep',
  prospecting: 'Prospecting',
  eval: 'Eval run',
  onboarding_research: 'Onboarding research',
  sequence_enrolment: 'Sequence',
  crm_enrichment: 'Enrichment',
  crm_import: 'CRM import',
  email_import: 'Email import',
  local_agent: 'Local agent',
}

export function kindLabel(kind: string): string {
  return WORK_KIND_LABELS[kind] ?? kind.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** "Triage · Loop": who ran it, then what kind of work — or the kind alone
 *  when no teammate is stamped (a person's own run, a user-built loop), and
 *  the name alone when it already says the kind ("Extraction", not
 *  "Extraction · Extraction"). */
export function kindLine(item: Pick<WorkItem, 'kind' | 'teammate'>): string {
  const who = item.teammate?.name?.trim()
  const kind = kindLabel(item.kind)
  if (!who) return kind
  return who.toLowerCase() === kind.toLowerCase() ? who : `${who} · ${kind}`
}

export const WORK_STATUS_TEXT: Record<WorkStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs your answer',
  needs_review: 'Ready to review',
  waiting_on_child: 'Waiting on a teammate',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  canceled: 'Canceled',
}

export const REVIEW_VERB_TEXT: Record<WorkReviewVerb, string> = {
  review: 'Review',
  send: 'Send',
  approve: 'Approve',
  check: 'Check',
}

export type WorkSection = 'needs_you' | 'running' | 'recent'

export function sectionOf(item: Pick<WorkItem, 'status'>): WorkSection {
  if (workNeedsYou(item.status)) return 'needs_you'
  if (isWorkLive(item.status)) return 'running'
  return 'recent'
}

/** When a waiting item started waiting: the park (last beat) for a question,
 *  the finish for a review. Oldest first is the "Needs you" order. */
export function waitingSince(item: Pick<WorkItem, 'status' | 'finished_at' | 'last_beat_at' | 'created_at'>): string {
  if (item.status === 'needs_review') return item.finished_at ?? item.last_beat_at ?? item.created_at
  return item.last_beat_at ?? item.created_at
}

/** When a settled item settled, for the Recent order and its timestamp. */
export function settledAt(item: Pick<WorkItem, 'finished_at' | 'created_at'>): string {
  return item.finished_at ?? item.created_at
}

/**
 * A teammate's last finished row, given one more row: `row` when it has
 * settled and settled later than `current` (settledAt), or is a newer copy of
 * `current` itself; `current` otherwise (a tie keeps it). A row that hasn't
 * settled never replaces anything: a settled row never moves back to an open
 * status (the recorder only moves out of the open ones).
 */
export function laterSettled<T extends Pick<WorkItem, 'id' | 'status' | 'finished_at' | 'created_at'>>(
  current: T | null,
  row: T,
): T | null {
  if (!isWorkTerminal(row.status)) return current
  if (!current || row.id === current.id) return row
  return settledAt(row) > settledAt(current) ? row : current
}

const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export interface PartitionedWork {
  /** Oldest first — what has waited longest is on top. */
  needsYou: WorkItem[]
  /** Newest first. */
  running: WorkItem[]
  /** Newest first by settle time. */
  recent: WorkItem[]
}

export function partitionWork(items: readonly WorkItem[]): PartitionedWork {
  const out: PartitionedWork = { needsYou: [], running: [], recent: [] }
  for (const item of items) {
    const section = sectionOf(item)
    if (section === 'needs_you') out.needsYou.push(item)
    else out[section].push(item)
  }
  out.needsYou.sort((a, b) => asc(waitingSince(a), waitingSince(b)))
  out.running.sort((a, b) => desc(a.started_at ?? a.created_at, b.started_at ?? b.created_at))
  out.recent.sort((a, b) => desc(settledAt(a), settledAt(b)))
  return out
}

/** The lanes over work TREES (row 14): a handoff sits under the row that
 *  handed it over, in that row's lane. */
export interface PartitionedTrees {
  /** Oldest first. Includes, on their own, handoffs that need the person and
   *  are not reviewed with their root (see `foldsIntoRoot`). */
  needsYou: WorkTree[]
  /** Newest first. */
  running: WorkTree[]
  /** Newest first by settle time. */
  recent: WorkTree[]
}

/**
 * `partitionWork` for trees. A root decides its tree's lane. A handoff that
 * needs the person and does not fold into its root (a question from a child
 * while its root works; a child's review after its root settled some other
 * way) is also listed in Needs you on its own, so nothing that waits on the
 * person hides under a row in another lane.
 */
export function partitionWorkTrees(items: readonly WorkItem[]): PartitionedTrees {
  const out: PartitionedTrees = { needsYou: [], running: [], recent: [] }
  const lookup = statusLookup(items)
  for (const tree of buildWorkForest(items)) {
    const section = sectionOf(tree.item)
    if (section === 'needs_you') out.needsYou.push(tree)
    else out[section].push(tree)
    for (const child of descendantsOf(tree)) {
      if (!workNeedsYou(child.status) || foldsIntoRoot(child, lookup)) continue
      out.needsYou.push({ item: child, children: [] })
    }
  }
  out.needsYou.sort((a, b) => asc(waitingSince(a.item), waitingSince(b.item)))
  out.running.sort((a, b) => desc(a.item.started_at ?? a.item.created_at, b.item.started_at ?? b.item.created_at))
  out.recent.sort((a, b) => desc(settledAt(a.item), settledAt(b.item)))
  return out
}

const NOUNS: Record<WorkDeliverableType, [string, string]> = {
  email_draft: ['draft', 'drafts'],
  document: ['document', 'documents'],
  action: ['action', 'actions'],
  capture: ['capture', 'captures'],
  contact: ['contact', 'contacts'],
  company: ['company', 'companies'],
  prospect_list: ['prospect list', 'prospect lists'],
  pr: ['pull request', 'pull requests'],
  attention_cards: ['card', 'cards'],
  flow_run: ['run', 'runs'],
  url: ['link', 'links'],
}

export function deliverableNoun(type: WorkDeliverableType, n: number): string {
  const [one, many] = NOUNS[type] ?? ['item', 'items']
  return n === 1 ? one : many
}

/** The deliverables still waiting on the user (unresolved). */
export function pendingDeliverables(item: Pick<WorkItem, 'deliverables'>): WorkDeliverable[] {
  return (item.deliverables ?? []).filter((d) => !d.resolved_at)
}

/**
 * The output a delivered item opens to (Liam, 10-15: "it should go to the
 * output and not to the process"): the deliverable its review names
 * (`needs.deliverable`, when that one still waits), else the first that
 * still waits, which is the one a teammate's report names. Null: nothing
 * to open, so the item (its run's chat) opens instead.
 */
export function primaryDeliverable(item: Pick<WorkItem, 'deliverables' | 'needs'>): WorkDeliverable | null {
  const all = item.deliverables ?? []
  const named = item.needs?.kind === 'review' && typeof item.needs.deliverable === 'number' ? all[item.needs.deliverable] : undefined
  if (named && !named.resolved_at) return named
  return pendingDeliverables(item)[0] ?? null
}

/** "Review 2 drafts", "Check 1 document", "Approve 1 pull request". */
export function reviewLine(item: Pick<WorkItem, 'needs' | 'deliverables'>): string {
  const verb = item.needs?.kind === 'review' ? REVIEW_VERB_TEXT[item.needs.verb] : 'Review'
  const pending = pendingDeliverables(item)
  if (pending.length === 0) return `${verb} the result`
  const counts = new Map<WorkDeliverableType, number>()
  for (const d of pending) counts.set(d.type, (counts.get(d.type) ?? 0) + (d.type === 'attention_cards' ? (d.count ?? 1) : 1))
  const parts = [...counts.entries()].map(([type, n]) => `${n} ${deliverableNoun(type, n)}`)
  return `${verb} ${parts.join(', ')}`
}

/** The row's second line — the one thing to know about the item right now. */
export function itemLine(
  item: Pick<WorkItem, 'status' | 'current_step' | 'result_summary' | 'error_message' | 'skip_reason' | 'needs' | 'deliverables'>,
): string {
  switch (item.status) {
    case 'needs_input':
      return 'Waiting on your answer'
    case 'needs_review':
      return reviewLine(item)
    case 'waiting_on_child': {
      const needs = item.needs?.kind === 'child' ? item.needs : undefined
      if (needs?.count && needs.count > 1) return `Waiting on ${needs.count} teammates`
      const role = needs?.role
      return role ? `Waiting on ${isWorkRole(role) ? WORK_ROLE_LABELS[role] : role}` : 'Waiting on a teammate'
    }
    case 'queued':
      return item.current_step || 'Queued'
    case 'running':
      return item.current_step || 'Starting'
    case 'done':
      return item.result_summary || 'Done'
    case 'failed':
      return item.error_message || 'Failed'
    case 'skipped':
      return item.skip_reason || 'Skipped'
    case 'canceled':
      return item.error_message || 'Canceled'
  }
}

/** The AI usage limit block reads as "paused", not "failed" — the loop is
 *  alive, the plan ran out. Same marker the legacy feed keyed on. */
const USAGE_LIMIT_RE = /usage limit/i
export function isPausedFailure(item: Pick<WorkItem, 'status' | 'error_message'>): boolean {
  return item.status === 'failed' && USAGE_LIMIT_RE.test(item.error_message ?? '')
}

/**
 * How long a run the AI usage limit stopped keeps its bot asleep: 48 hours,
 * as the Agents page's "Loops are paused" banner (its bot's page,
 * lib/bots/bot-page.ts; the crew, lib/bots/crew-state.ts; the light read,
 * queries.ts listAiLimitedTeammates).
 */
export const AI_LIMIT_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * Whether a run made something for you beside cards (a batch's): filed
 * actions, a document, drafts, records. The light read keeps a done run's row
 * for that (queries.ts listRecentDoneWork).
 */
export function madeSomethingBeyondCards(deliverables: readonly Pick<WorkDeliverable, 'type'>[] | null | undefined): boolean {
  return (deliverables ?? []).some((d) => d.type !== 'attention_cards')
}

/** The verb a deliverable row carries (the real verb — Send, Merge, Accept —
 *  lives on the deliverable's own surface; this is the way there). */
export function deliverableVerb(d: WorkDeliverable): string {
  switch (d.type) {
    case 'email_draft':
      return d.resolved_at ? 'Open draft' : 'Review draft'
    case 'document':
      return 'Open document'
    case 'action':
      return 'Open action'
    case 'capture':
      return 'Open capture'
    case 'contact':
      return 'Open contact'
    case 'company':
      return 'Open company'
    case 'prospect_list':
      return 'Open list'
    case 'pr':
      return 'Open pull request'
    case 'attention_cards': {
      const n = d.count ?? 1
      return `See ${n} ${deliverableNoun('attention_cards', n)}`
    }
    case 'flow_run':
      return 'Open run'
    case 'url':
      return 'Open link'
  }
}

export function stepTimeline(item: Pick<WorkItem, 'progress'>): WorkStep[] {
  const steps = item.progress?.steps
  return Array.isArray(steps) ? steps : []
}

/** "12s", "3m 20s", "1h 04m" — elapsed between two instants. */
export function durationText(fromIso: string | null, toIso: string | null = null): string {
  const from = fromIso ? Date.parse(fromIso) : NaN
  if (!Number.isFinite(from)) return ''
  const to = toIso ? Date.parse(toIso) : Date.now()
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** "now", "4m", "3h", "2d", else a short date. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  const then = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(then)) return ''
  const min = Math.round((now - then) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
