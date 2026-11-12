/**
 * The work ledger's single source of truth (ACTIVITY-AND-REVIEW-DESIGN §3.1).
 *
 * One row in `tracked_job` per unit of background work, whatever executes it.
 * Everything that reads or writes the ledger imports its vocabulary from here —
 * the status sets below are the contract the recorder's CAS guards, the reaper,
 * the Activity route and (PR 2) the panel all share, the way
 * `src/lib/agent-run/types.ts` is the one home of the agent-run vocabulary.
 */

export type WorkStatus =
  | 'queued' // dispatched, not yet executing
  | 'running'
  | 'needs_input' // parked on a question the user must answer
  | 'needs_review' // finished; a deliverable is waiting on a human verb
  | 'waiting_on_child' // parked while a delegated child runs (step 13) — nobody's turn
  | 'done'
  | 'failed'
  | 'skipped'
  | 'canceled'

export const WORK_LIVE_STATUSES = ['queued', 'running', 'needs_input', 'waiting_on_child'] as const
export const WORK_NEEDS_YOU_STATUSES = ['needs_input', 'needs_review'] as const
export const WORK_TERMINAL_STATUSES = ['done', 'failed', 'skipped', 'canceled'] as const
/** Every status the recorder may transition OUT of. */
export const WORK_OPEN_STATUSES = ['queued', 'running', 'needs_input', 'needs_review', 'waiting_on_child'] as const

const LIVE: ReadonlySet<string> = new Set(WORK_LIVE_STATUSES)
const NEEDS_YOU: ReadonlySet<string> = new Set(WORK_NEEDS_YOU_STATUSES)
const TERMINAL: ReadonlySet<string> = new Set(WORK_TERMINAL_STATUSES)

export function isWorkLive(status: string): boolean {
  return LIVE.has(status)
}
export function workNeedsYou(status: string): boolean {
  return NEEDS_YOU.has(status)
}
export function isWorkTerminal(status: string): boolean {
  return TERMINAL.has(status)
}

/** Who is doing the work, for the row's chip. */
export type WorkActor = 'loop' | 'agent' | 'user' | 'system'

/**
 * How the work started (migration 280, CHECK-constrained): a person, a loop, an
 * unattended attempt the auto-attempt gate launched, or a delegation. The
 * surfaces mark `attempt` rows so an attempted draft never reads as one the
 * user asked for.
 */
export const WORK_ORIGINS = ['user', 'loop', 'attempt', 'delegation', 'chat'] as const
export type WorkOrigin = (typeof WORK_ORIGINS)[number]

export const WORK_DELIVERABLE_TYPES = [
  'email_draft',
  'document',
  'action',
  'capture',
  'contact',
  'company',
  'prospect_list',
  'pr',
  'attention_cards',
  'flow_run',
  'url',
  // A Studio video (migration 620) a finished export delivered: opens the
  // Studio on the video, and carries the export's download link (`url`).
  'studio_video',
] as const
export type WorkDeliverableType = (typeof WORK_DELIVERABLE_TYPES)[number]

export function isWorkDeliverableType(v: unknown): v is WorkDeliverableType {
  return typeof v === 'string' && (WORK_DELIVERABLE_TYPES as readonly string[]).includes(v)
}

/** A typed reference the UI routes to the entity's own surface, where the real
 *  verb (Send, Accept, Merge) lives. */
export interface WorkDeliverable {
  type: WorkDeliverableType
  /** Entity id, or the url itself for 'url' / 'pr'. */
  id: string
  label: string
  /** Defaults to the item's workspace (cross-workspace via openInWorkspace). */
  workspace_id?: string
  /** 'attention_cards': how many cards the run surfaced. */
  count?: number
  /** 'studio_video': the finished export's download link (an app path). */
  url?: string
  /** For generic entities. */
  entity_type?: string
  /** Stamped when the human acted on it on its own surface (sent the draft,
   *  merged the PR, accepted the card) — resolve.ts. */
  resolved_at?: string
}

export type WorkReviewVerb = 'review' | 'send' | 'approve' | 'check'

export type WorkNeeds =
  | { kind: 'input'; questions: unknown[] }
  | { kind: 'review'; verb: WorkReviewVerb; deliverable?: number }
  /** Parked on a delegated child (status 'waiting_on_child'): which item, and
   *  the role it was asked to play. `count` when it handed work to several. */
  | { kind: 'child'; work_item_id: string; role?: string; count?: number }

/** Free-form back-references (jsonb) so a new producer never needs a schema
 *  change to point at what it acted on. */
export interface WorkSource {
  capture_id?: string
  flow_id?: string
  flow_run_id?: string
  agent_run_id?: string
  action_id?: string
  proposal_ids?: string[]
  thread_ids?: string[]
  /** A quote_received loop's fire: the customer's quote (roadmap B1). */
  quote_id?: string
  /** The producer opted out of pushes for this item (recorder `mute()`). */
  quiet?: boolean
  /** Where a work run came from (B PR 4): the brief's source quote and capture. */
  provenance?: WorkProvenance
  /**
   * A loop's skill run parked its session (bots v3 Phase 4, migration 303:
   * `tracked_job_session`): Reply and Open in Native Intelligence on its item continue that
   * chat (lib/bots/item-run-chat.ts). Only the flag lives here; the handle is
   * server-only.
   */
  run_chat?: boolean
  /**
   * The row's teammate was routed to it (bots-v4 Phase 5, workTeammateId), for
   * attribution only: the run is the person's own, with no teammate of its
   * own. Its bot brings it to them, but a work run's chat is still the
   * person's own run's (item-run-chat.ts `own`), never the bot speaking.
   */
  teammate_routed?: boolean
  [k: string]: unknown
}

/**
 * Where a piece of agent work came from: the capture and the transcript quote
 * that asked for it (B PR 4). Written at the start (a person's Start or an
 * attempt) onto the ledger row's `source.provenance`; the work-run dispatcher
 * turns it into the brief's quote and capture excerpt.
 */
export interface WorkProvenance {
  captureId: string | null
  quote: string | null
}

export interface WorkStep {
  at: string
  text: string
}

/** The progress jsonb: per-kind counters plus the recorder's own step log. */
export interface WorkProgress {
  steps?: WorkStep[]
  done?: number
  total?: number
  /** How a needs_review item left "Needs you": reviewed, dismissed unread, or
   *  expired (the reaper closed it after WORK_REVIEW_TTL_DAYS). */
  review?: 'reviewed' | 'dismissed' | 'expired'
  [k: string]: unknown
}

/** A `tracked_job` row as the ledger reads it. */
export interface WorkItem {
  id: string
  workspace_id: string
  member_id: string
  kind: string
  title: string
  status: WorkStatus
  actor: WorkActor
  current_step: string | null
  progress: WorkProgress
  result_summary: string | null
  error_message: string | null
  skip_reason: string | null
  deliverables: WorkDeliverable[]
  needs: WorkNeeds | null
  source: WorkSource
  run_key: string | null
  agent_run_id: string | null
  flow_run_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  reviewed_at: string | null
  last_beat_at: string
  deadline_at: string | null
  /** The teammate that ran it (migration 280; stamped from row 4 on). */
  ai_team_member_id?: string | null
  /** The area it belongs to (migration 318, work-area.ts): its face is picked from it. Null: none. */
  area?: string | null
  /** How it started (migration 280, default 'user'). */
  origin?: WorkOrigin
  /** The delegation tree (migration 280): the item that handed this work over,
   *  the tree's root item, and the depth below it (root 0). */
  parent_id?: string | null
  root_id?: string | null
  depth?: number
  /** When the row's owner opened its detail panel since it last started
   *  waiting on them (migration 295); null = not opened since, so a waiting
   *  row is new and may make its teammate's bot call for you
   *  (agent-work-lanes.ts `notOpenedYet`). Stamped by PATCH
   *  /api/account/activity/[id] { action: 'opened' } when empty; cleared by
   *  the recorder on every move into needs_input / needs_review. */
  opened_at?: string | null
  /** The agent's plan for this job (migration 331, src/lib/work/plan.ts):
   *  `{ steps: [{ text, status }], updated_at }`, null until one is written.
   *  Its own column, never part of `progress` (the recorder rewrites that
   *  whole). Absent on a read that doesn't name it. */
  plan?: unknown
  /** That teammate, embedded by the ledger reads (queries.ts WORK_ITEM_SELECT).
   *  Absent on a realtime payload — the hooks carry it over from the row they
   *  already hold. */
  teammate?: WorkTeammate | null
}

/** Who ran a work item, as the surfaces name it. */
export interface WorkTeammate {
  id: string
  name: string
  is_system: boolean
  system_key: string | null
  /** Its work role, when it holds one (the entity tab's row names it). */
  role?: string | null
  /** The bot character it wears (migration 294), as stored: the marks draw it
   *  only when it names one of the characters. */
  bot_character?: string | null
}

/** How many step lines a row keeps (the detail panel's timeline). */
export const WORK_STEP_LOG_CAP = 30

/** How long a row may go without a beat before the reaper fails it. */
export interface WorkDeadlines {
  /** Dispatched but not started (an Inngest queue, a device that is offline). */
  queued: number
  /** Executing: LLM runs beat on every tool call, crons on every phase. */
  running: number
}

export const DEFAULT_WORK_DEADLINES: WorkDeadlines = {
  queued: 6 * 60 * 60 * 1000,
  running: 20 * 60 * 1000,
}

/** How long a needs_review item may wait before the reaper closes it as
 *  expired, so "Needs you" cannot grow without bound (design §9.2). */
export const WORK_REVIEW_TTL_DAYS = 14

/** How long a question (needs_input) may wait unanswered before the reaper
 *  gives it up, its run canceled (stale-questions.ts): as long as a review. */
export const WORK_INPUT_TTL_DAYS = 14

/** The kinds the loop pipeline and agent runs record. Free text in the DB —
 *  these constants only keep the producers and the feed spelling them alike. */
export const WORK_KINDS = {
  flowRun: 'flow_run',
  skillRun: 'skill_run',
  workRun: 'work_run',
  codingRun: 'coding_run',
  emailDrafts: 'email_drafts',
  extraction: 'extraction',
  triageReconcile: 'triage_reconcile',
  proposalAgeOut: 'proposal_age_out',
  /** Row 6 mirrors (plan 1.1): each run type's own row stays the source of
   *  truth; the ledger row is its Activity projection, keyed by run_key. */
  prospecting: 'prospecting',
  eval: 'eval',
  onboardingResearch: 'onboarding_research',
  /** Row 11 mirrors (plan 1.1, wave 2): one row per sequence enrolment, per
   *  requested enrichment (an Enrich click, the chat's enrich_contact), per
   *  HubSpot / mailbox initial import. */
  sequenceEnrolment: 'sequence_enrolment',
  crmEnrichment: 'crm_enrichment',
  crmImport: 'crm_import',
  emailImport: 'email_import',
  /** A finished (or failed) Studio export delivered to whoever asked (src/lib/studio/server/delivery.ts). */
  studioExport: 'studio_export',
} as const
