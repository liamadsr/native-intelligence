/**
 * The evals flywheel (docs/plans/always-on-agent.md §8; migration 349): every
 * bad agent turn becomes a candidate eval case. This file is the vocabulary:
 * the signals, the statuses, the evidence each signal carries, and the
 * clipping limits. Client-safe (no server imports).
 *
 *   capture  ─ a thumbs rating in chat (POST /api/account/chat/feedback), the
 *              sweep (chat turns that hit REPEATED_FAILURE or INPUT_INVALID,
 *              failed background jobs), the send path (a draft rewritten
 *              heavily) and the discard path (a draft dismissed, with its
 *              reason: src/lib/email/discard-drafts.ts) write
 *              `eval_candidate` rows (./record.ts).
 *   review   ─ /admin/evals: dismiss, or promote into a chat skill eval case
 *              (./case-draft.ts drafts it; the reviewer edits and saves it).
 *   export   ─ promoted cases go into src/lib/packs/skill-evals/cases/
 *              flywheel.json (scripts/eval-flywheel-import.ts), where the
 *              static test checks them in every build and the live runner
 *              replays them (scripts/skill-evals-changed.ts runs the cases of
 *              the skills a change touches).
 */

export const EVAL_CANDIDATE_SOURCES = ['thumbs_down', 'thumbs_up', 'repeated_failure', 'input_invalid', 'draft_rewrite', 'loop_failed', 'draft_dismissed'] as const
export type EvalCandidateSource = (typeof EVAL_CANDIDATE_SOURCES)[number]

export const EVAL_CANDIDATE_STATUSES = ['new', 'promoted', 'dismissed', 'exported'] as const
export type EvalCandidateStatus = (typeof EVAL_CANDIDATE_STATUSES)[number]

export type EvalCandidatePolarity = 'bad' | 'good'

/** A thumbs-up is the one good signal: it becomes a "keep doing this" case. */
export function polarityOf(source: EvalCandidateSource): EvalCandidatePolarity {
  return source === 'thumbs_up' ? 'good' : 'bad'
}

/** The table's and the evidence's limits (migration 349 checks the totals). */
export const FLYWHEEL_LIMITS = {
  request: 2000,
  reply: 1500,
  reason: 500,
  steps: 30,
  stepInput: 600,
  stepError: 300,
  logTail: 1500,
  error: 600,
  title: 200,
  evidenceBytes: 16000,
  caseDraftBytes: 8000,
  skillSlugs: 20,
  tools: 40,
} as const

/** One tool call of an agent turn, as the evidence keeps it. */
export interface TurnToolStep {
  /** The tool's name (`load_skill`, `list_actions`, an MCP tool…). */
  name: string
  /** The call's input as JSON, clipped to FLYWHEEL_LIMITS.stepInput characters. */
  input?: string
  /** False when the call errored or answered `success: false`. */
  ok: boolean
  /** Native Intelligence's error code when one was given (INPUT_INVALID, REPEATED_FAILURE, NOT_FOUND…). */
  code?: string
  /** The error text, clipped to FLYWHEEL_LIMITS.stepError. */
  error?: string
}

/** A chat turn: what the person asked and what the agent did. */
export interface ChatTurnEvidence {
  kind: 'chat_turn'
  /** The person's message that started the turn (text parts joined), clipped. */
  request: string
  /** The opening of the agent's reply (text parts joined), clipped. */
  reply?: string
  /** The turn's tool calls in order, at most FLYWHEEL_LIMITS.steps. */
  steps: TurnToolStep[]
  /** Skills the turn loaded (load_skill inputs), in order. */
  loads: string[]
  /** The assistant message's id (chat_messages.ui_message_id) and when it was written. */
  messageId: string
  at?: string
  /**
   * A live agent's nudge (a `say_to_user` row): pointers to rebuild its
   * moment later, never a copy of the meeting's words. The nudge's kind
   * (`ui_message.metadata.nudge_kind`), its capture
   * (`chat_conversations.capture_id`), when it was shown (the row's
   * `created_at`) and the person's goal for the call (`meeting_goal.id`,
   * migration 356) when they set one. Absent on any other turn.
   */
  nudge_kind?: string
  capture_id?: string
  nudge_at?: string
  meeting_goal_id?: string
  /** A thumbs-down nudge's quick reason chip (NUDGE_REASONS), countable by the learning step. */
  nudge_reason?: NudgeReason
}

/**
 * The quick reasons a person can pick on a thumbs-down nudge, rated after the
 * call on the capture page. Stored as `evidence.nudge_reason` (no column:
 * migration 349 has none for it), validated by the feedback route.
 */
export const NUDGE_REASONS = ['not_useful', 'repeated', 'wrong', 'too_late'] as const
export type NudgeReason = (typeof NUDGE_REASONS)[number]

/** Each reason's chip label, in display order. */
export const NUDGE_REASON_LABELS: Record<NudgeReason, string> = {
  not_useful: 'Not useful',
  repeated: 'Repeated',
  wrong: 'Wrong',
  too_late: 'Too late',
}

export function isNudgeReason(v: unknown): v is NudgeReason {
  return typeof v === 'string' && (NUDGE_REASONS as readonly string[]).includes(v)
}

/** A background job that failed: the ledger row's facts, never a transcript. */
export interface LoopRunEvidence {
  kind: 'loop_run'
  /** tracked_job.kind (work_run, flow_run, skill_run, helper…). */
  jobKind: string
  title?: string
  /** tracked_job.error_message, clipped. */
  error?: string
  /** The flow run's failed actions (flow_run.action_results), clipped. */
  flowErrors?: Array<{ action: string; error: string }>
  /** The end of agent_run.log_tail, clipped. */
  logTail?: string
  /** Pointers to reproduce it: the flow, the flow run, the agent run, the capture. */
  flowId?: string
  flowRunId?: string
  agentRunId?: string
  captureId?: string
  /** The skill the job ran, when it ran one (its slug). */
  skill?: string
  at?: string
}

/**
 * An agent draft the person rewrote heavily before sending. A score and
 * pointers only: Native Intelligence stores no mail, so neither the draft nor the sent text
 * is kept here; a reviewer reads the thread live.
 */
export interface DraftRewriteEvidence {
  kind: 'draft_rewrite'
  /** Word-level similarity of the sent text to the agent's draft, 0 (all new) to 1 (unchanged). */
  similarity: number
  /** Word counts before and after. */
  wordsBefore: number
  wordsAfter: number
  /** Where the draft came from (email_draft.metadata.origin). */
  origin: 'automatic' | 'chat' | 'unknown'
  /** The thread (a provider id) and its linked contact, to read it live. */
  providerThreadId?: string
  accountId?: string
  contactId?: string
  at?: string
}

/**
 * Why an agent draft was dismissed (GEN-1165), the labels the needs-reply gate
 * and the drafter learn from (GEN-1164; migration 442):
 *   no_reply_needed  nothing in the thread needed a reply (a receipt, a
 *                    notice, marketing, a calendar reply): the gate's false
 *                    positive;
 *   outdated         the moment passed (an event that is over, a thread
 *                    already handled);
 *   duplicate        another draft already answers the thread;
 *   bad_draft        a reply is owed, but this draft is wrong;
 *   other            anything else (the words go in the row's `reason`).
 */
export const DRAFT_DISMISS_REASONS = ['no_reply_needed', 'outdated', 'duplicate', 'bad_draft', 'other'] as const
export type DraftDismissReason = (typeof DRAFT_DISMISS_REASONS)[number]

export function isDraftDismissReason(v: unknown): v is DraftDismissReason {
  return typeof v === 'string' && (DRAFT_DISMISS_REASONS as readonly string[]).includes(v)
}

/**
 * An agent draft that was dismissed, and why. The reason and pointers only,
 * as a rewrite's: Native Intelligence stores no mail, so neither the draft nor the thread is
 * kept; a reviewer reads the thread live.
 */
export interface DraftDismissedEvidence {
  kind: 'draft_dismissed'
  reason: DraftDismissReason
  /** Where the draft came from (email_draft.metadata.origin, as draftOrigin names it). */
  origin: 'automatic' | 'chat' | 'unknown'
  /** Who dismissed it: the agent at the person's word, or the person's own click. */
  by: 'agent' | 'person'
  /** The domain the reply would have gone to ("reply2.squareup.com"): never an address. */
  recipientDomain?: string
  /** The thread (a provider id) and its mailbox, to read it live. */
  providerThreadId?: string
  accountId?: string
  at?: string
}

export type EvalCandidateEvidence = ChatTurnEvidence | LoopRunEvidence | DraftRewriteEvidence | DraftDismissedEvidence

/** One `eval_candidate` row as the app reads it. */
export interface EvalCandidateRow {
  id: string
  workspace_id: string
  user_id: string
  source: EvalCandidateSource
  polarity: EvalCandidatePolarity
  ref_type: string | null
  ref_id: string | null
  conversation_id: string | null
  skill_slugs: string[]
  tools: string[]
  reason: string | null
  evidence: EvalCandidateEvidence | Record<string, never>
  dedupe_key: string
  status: EvalCandidateStatus
  case_draft: Record<string, unknown> | null
  reviewed_by: string | null
  reviewed_at: string | null
  exported_at: string | null
  created_at: string
  updated_at: string
}

/** The dedupe keys every writer shares (unique per workspace and user). */
export const evalCandidateKey = {
  /** A rating changes in place: one row per message per person. */
  feedback: (messageId: string) => `feedback:${messageId}`,
  /** One row per message per failure code. */
  chatFailure: (messageId: string, code: 'REPEATED_FAILURE' | 'INPUT_INVALID') => `chat:${messageId}:${code}`,
  loop: (trackedJobId: string) => `job:${trackedJobId}`,
  draft: (draftId: string) => `draft:${draftId}`,
  /** One row per dismissed draft (its email_draft row id). */
  draftDismissed: (draftId: string) => `draft_dismissed:${draftId}`,
}

/** A heavy rewrite: the sent text keeps less than this share of the draft's words. */
export const DRAFT_REWRITE_SIMILARITY_MAX = 0.5
/** Below this many draft words a rewrite says little (a one-line reply). */
export const DRAFT_REWRITE_MIN_WORDS = 15

/** A promoted case as exported into the repository (src/lib/packs/skill-evals/cases/flywheel.json). */
export interface FlywheelCase {
  /** The candidate's id: an import never adds the same case twice. */
  candidateId: string
  /** The skill the case belongs to (its slug); 'instructions' for the core instructions. */
  skill: string
  source: EvalCandidateSource
  polarity: EvalCandidatePolarity
  /** When it was promoted (ISO). */
  promotedAt: string
  /** The case itself (src/lib/packs/skill-evals/types.ts SkillEvalCase). */
  case: Record<string, unknown>
}
