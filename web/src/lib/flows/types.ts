/**
 * Shared types for the Flows feature.
 *
 * The DB stores trigger_config, actions, and flow_run.action_results as jsonb
 * so the shape here IS the contract. Any read of those columns should go
 * through the validators in queries.ts (validateActions / validateCondition /
 * toPublicFlow), which sanitize the shape and return a typed object.
 *
 * Model (migration 132): one trigger -> an ORDERED list of N actions
 * (http_post | run_skill), each with an optional AND/OR condition on the
 * triggering entity.
 */

import type { EntityTypeSubset } from '@/lib/knowledge/entity-registry'
import type { RunVerdict } from './verdict-apply'
import type { OutputConnector, PostSurface } from './output-connectors'

export type FlowTriggerType =
  | 'entity_status_change'
  | 'capture_processed'
  | 'pr_status_changed'
  | 'schedule'
  | 'calendar_event'
  | 'quote_received'
  | 'email_received'
  | 'chat_message'
  | 'document_created'

/** The event triggers that fire for one flow OWNER's own items (their mail, a channel they read, a document they see). */
export const OWNER_EVENT_TRIGGER_TYPES = ['email_received', 'chat_message', 'document_created'] as const
export type OwnerEventTriggerType = (typeof OWNER_EVENT_TRIGGER_TYPES)[number]

/** One of the owner's event triggers (their mail, chat, documents). */
export function isOwnerEventTrigger(triggerType: unknown): triggerType is OwnerEventTriggerType {
  return typeof triggerType === 'string' && (OWNER_EVENT_TRIGGER_TYPES as readonly string[]).includes(triggerType)
}

/**
 * Whether `userId` may read this loop's runs and what they produced (flow_run
 * rows, their step results and output previews). A loop on the owner's event
 * triggers summarizes the owner's own mail, DMs or documents: only its owner
 * (created_by) reads its runs. Every other loop's runs are the workspace's,
 * as before. The same rule as migration 640's flow_run read policy, for the
 * reads that run on the service role.
 */
export function canReadFlowRuns(flow: { trigger_type?: unknown; created_by?: string | null } | null | undefined, userId: string | null | undefined): boolean {
  if (!flow) return false
  if (!isOwnerEventTrigger(flow.trigger_type)) return true
  return !!userId && flow.created_by === userId
}

/**
 * A loop's trigger config as `viewer` may see it. The owner's event triggers
 * name the owner's own things: the channel a chat loop watches (possibly a
 * DM) and the sender a mail loop waits for. Anyone but the owner gets the
 * config without them ("a channel"; a mail loop's sender filter left out).
 * Every other trigger, and the owner, get it as stored.
 */
export function triggerConfigForViewer(
  triggerType: unknown,
  config: unknown,
  isOwner: boolean,
): Record<string, unknown> {
  const cfg = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>
  if (isOwner || !isOwnerEventTrigger(triggerType)) return cfg
  if (triggerType === 'chat_message') {
    const { channel_id, ...rest } = cfg
    return { ...rest, channel: channel_id === null || channel_id === undefined ? 'any channel' : 'a channel' }
  }
  if (triggerType === 'email_received') {
    const { from: _from, ...rest } = cfg
    void _from
    return rest
  }
  return cfg
}

/** What a member who may not read a loop's runs is told instead of them. */
export const OWNER_ONLY_RUNS_NOTE = "Only this loop's owner can see its runs: it starts on their own mail, chat or documents."

export type FlowActionType = 'http_post' | 'run_skill' | 'run_agent' | 'archive_capture' | 'call_tool' | 'run_local_agent'

/**
 * A run's outcome. 'pending' (the enum's own third value, migration 107) is a
 * run PARKED on an approval card (F4, call-tool.ts): an unattended outward
 * step held the exact call for the person, and the rest of the run waits for
 * their Accept, Edit or Skip (flow-step-resume.ts).
 */
export type FlowRunStatus = 'success' | 'failed' | 'pending'

/**
 * Entity types whose status change can trigger a flow. v1 wires 'action'
 * end-to-end; project/initiative/milestone are recognized by the trigger
 * config + condition model and land as the dispatcher gains their loaders.
 */
export type FlowEntityType = EntityTypeSubset<'action' | 'project' | 'initiative' | 'milestone'>

// ──────────────────────────────────────────────────────────────────
// Trigger config (discriminated on `kind`; missing kind = legacy
// entity_status_change rows — treat as such everywhere)
// ──────────────────────────────────────────────────────────────────

/**
 * Who caused a status change — the flow dispatcher's LOOP GUARD reads it
 * (docs/plans/agent-orchestration-investigation.md §2.2, precondition A3).
 *   user  — a person (UI, MCP, chat on the user's instruction, a human accept)
 *   agent — an unattended agent's tool call (skill-runner act mode, work-agent)
 *   loop  — the pipeline's one judgment authority applying a proposal (verdict
 *           auto-apply); allowed to fire flows, subject to the depth cap
 *   sync  — a remote task system's echo (Jira / Asana / Linear)
 */
export type StatusChangeActor = 'user' | 'agent' | 'loop' | 'sync'

export interface StatusChangeOrigin {
  actor: StatusChangeActor
  /** Automated hops before this write: 0 for a person, n+1 for a write made by
   *  a run that a depth-n fire dispatched. The dispatcher caps it. */
  depth: number
  /** The run that made the write (agent_run id, skill id, …) — for the ledger. */
  run_id?: string | null
}

export interface EntityStatusChangeTriggerConfig {
  entity_type: FlowEntityType
  /**
   * Loop guard opt-in: fire this flow for status changes made by an AGENT's
   * tool call too. Default (absent/false): agent-made changes are ledgered as
   * a skipped fire, so an automation can never re-trigger itself through the
   * board. Even when true, the automation depth cap still applies.
   */
  fire_on_agent_changes?: boolean
  /**
   * Status identifier shape depends on entity_type:
   *   - action     → workflow_state UUID
   *   - project    → project_status enum value
   *   - initiative → initiative_status enum value
   *   - milestone  → milestone_status enum value
   *
   * Null `from` matches any source status.
   */
  from_status_id: string | null
  to_status_id: string
}

export type ScheduleCadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron' | 'once'

/**
 * Workspace-scoped (team_id NULL) recurring trigger. next occurrence is
 * computed by computeNextRun (schedule.ts) and persisted on flow.next_run_at,
 * which the cron tick scans.
 *
 * `once` runs one time, at `run_at`: after it fires the tick sets next_run_at
 * NULL and switches the loop off (it reads as finished).
 */
export interface ScheduleTriggerConfig {
  kind: 'schedule'
  cadence: ScheduleCadence
  /** 'HH:mm' 24h wall-clock in `timezone`. Required for daily, weekdays, weekly and monthly. */
  time?: string
  /** 0 (Sunday) - 6 (Saturday). Weekly cadence only. */
  weekday?: number
  /** 1-28 (every month has it). Monthly cadence only. */
  day_of_month?: number
  /** A 5-field cron expression (minute hour day-of-month month day-of-week), evaluated in `timezone`. Cron cadence only. */
  cron?: string
  /** 'YYYY-MM-DDTHH:mm' wall-clock in `timezone` (stored normalized). Once cadence only. */
  run_at?: string
  /** IANA timezone name, e.g. 'America/Los_Angeles'. */
  timezone: string
}

/**
 * Workspace-scoped (team_id NULL) trigger fired when a capture's batch
 * extraction completes. No predicate — per-action conditions gate instead.
 */
export interface CaptureProcessedTriggerConfig {
  kind: 'capture_processed'
}

/**
 * Workspace-scoped (team_id NULL) trigger anchored to a RECURRING calendar
 * event (GEN-136): fire N minutes before/after each occurrence.
 *
 * Anchored by exact-normalized event TITLE, not a series id — there is no
 * cross-provider-stable series identity in `local_calendar_event` (each
 * occurrence is its own row with a per-occurrence `external_id`). The one
 * thing stable across every occurrence of "Couples Counseling" is its title.
 *
 * The clock reuses the schedule cron tick + flow.next_run_at; only the
 * next-run computation differs (computeNextCalendarRun in schedule-calendar.ts
 * derives it from the next matching occurrence ± offset, against the flow
 * creator's own calendar — user_id = flow.created_by).
 */
export interface CalendarEventTriggerConfig {
  kind: 'calendar_event'
  /** Recurring event title, matched exact-normalized (lowercased + trimmed). */
  event_title: string
  /**
   * Minutes relative to the occurrence's start_at. Negative = before (fire 30
   * min before → -30), positive = after, 0 = at start. Bounded to a day
   * either side by the validator.
   */
  offset_minutes: number
}

/** The PR states a pr_status_changed loop can wait for ('any' = every change). */
export const PR_TRIGGER_STATES = ['open', 'closed', 'merged', 'any'] as const
export type PrTriggerState = (typeof PR_TRIGGER_STATES)[number]

/**
 * Workspace-scoped (team_id NULL) trigger fired when a GitHub pull request
 * LINKED to one of the workspace's actions (action_github_pr) opens, closes,
 * merges or reopens (src/app/api/webhooks/github/route.ts →
 * `flow/pr.status_changed` → flowDispatchOnPrStatusChange). The fire's
 * entity is the linked action, so per-action conditions (label, team, …)
 * gate it; `{{trigger.to_status_id}}` is the PR's new state.
 *
 * `repo_full_name` is required: a loop fires only for the repo its author
 * named, never for any PR that happens to mention an identifier.
 */
export interface PrStatusChangedTriggerConfig {
  kind: 'pr_status_changed'
  /** "owner/repo", matched case-insensitively. */
  repo_full_name: string
  /** open (opened or reopened), closed (without merging), merged, or any. */
  to_state: PrTriggerState
}

/**
 * Workspace-scoped (team_id NULL) trigger fired when a customer's quote
 * arrives from the business's website form (roadmap B1,
 * src/lib/customers/receive.ts → `flow/quote.received` →
 * flowDispatchOnQuoteReceived). No entity: `{{trigger.quote_id}}` names the
 * quote, which a step reads with get_quote (the customer's words never ride
 * the template). No predicate: per-action conditions gate instead.
 */
export interface QuoteReceivedTriggerConfig {
  kind: 'quote_received'
}

/**
 * Fired when new mail ARRIVES in one of the flow OWNER's own connected
 * mailboxes (src/lib/flows/emit-email-received.ts, from the incremental sync's
 * triage). Never for the first import, the person's own mail, drafts, spam or
 * trash. No entity: `{{trigger.email_thread_id}}` and
 * `{{trigger.email_account_id}}` name the thread, which a step reads live with
 * read_email (no mail is stored). The sender's words never ride the template.
 */
export interface EmailReceivedTriggerConfig {
  kind: 'email_received'
  /**
   * Only mail from this sender: an exact address ("ana@acme.example") or a
   * domain ("acme.example", stored without a leading "@"), lowercased.
   * Absent: any sender.
   */
  from?: string
}

/**
 * Fired when a PERSON posts in team chat (src/lib/flows/emit-chat-message.ts,
 * from the post route), in a channel the flow's owner can read. Never for an
 * agent's message. `{{trigger.chat_message_id}}`, `{{trigger.chat_channel_id}}`
 * and `{{trigger.chat_thread_root_id}}` name it; a step reads it with
 * read_team_chat_message.
 */
export interface ChatMessageTriggerConfig {
  kind: 'chat_message'
  /** The channel it watches; null = any channel the owner can read (only with mentions_only). */
  channel_id: string | null
  /** Only messages that @mention the owner (never their own). */
  mentions_only: boolean
}

/**
 * Fired about five minutes after a PERSON creates a document the flow's owner
 * can see (src/lib/flows/emit-document-created.ts, from the documents route;
 * an agent's or a canon template's create never fires). `{{trigger.document_id}}`
 * names it; a step reads it with get_document.
 */
export interface DocumentCreatedTriggerConfig {
  kind: 'document_created'
}

/**
 * All trigger config shapes. Rows created before the loop engine have no
 * `kind` — a missing kind means entity_status_change (back-compat); the
 * row-level flow.trigger_type column is the authoritative discriminator.
 */
export type FlowTriggerConfig =
  | EntityStatusChangeTriggerConfig
  | ScheduleTriggerConfig
  | CaptureProcessedTriggerConfig
  | CalendarEventTriggerConfig
  | PrStatusChangedTriggerConfig
  | QuoteReceivedTriggerConfig
  | EmailReceivedTriggerConfig
  | ChatMessageTriggerConfig
  | DocumentCreatedTriggerConfig

// ──────────────────────────────────────────────────────────────────
// Condition model (per-action gate on the triggering entity)
// ──────────────────────────────────────────────────────────────────

/**
 * Fields of the triggering entity a condition can test. These map to the
 * normalized RunnerEntityData the dispatcher loads:
 *   - label       → entity's labels (multi-valued; label ids)
 *   - priority    → the priority value (action: numeric priority as string)
 *   - assignee    → entity's assignees (multi-valued; member ids)
 *   - project     → the entity's parent project id (single)
 *   - team        → the entity's team id (single)
 *   - from_status → the status the entity moved OUT of on this fire (single id)
 */
export type ConditionField =
  | 'label'
  | 'priority'
  | 'assignee'
  | 'project'
  | 'team'
  | 'from_status'

/**
 * Operators. Value semantics depend on whether the field is multi-valued on
 * the entity (label, assignee) or single-valued (priority, project, team,
 * from_status). See ConditionRule for the per-op contract.
 */
export type ConditionOp =
  | 'is'
  | 'is_not'
  | 'in'
  | 'not_in'
  | 'is_set'
  | 'is_not_set'

/**
 * One leaf test against a single field of the triggering entity.
 *
 * VALUE SEMANTICS BY FIELD
 * ------------------------
 * Multi-valued fields (label, assignee) — the entity holds a SET of ids:
 *   - is        value:string   → entity's set CONTAINS value
 *   - is_not    value:string   → entity's set does NOT contain value
 *   - in        value:string[] → entity's set INTERSECTS value (has ANY)
 *   - not_in    value:string[] → entity's set is DISJOINT from value (has NONE)
 *   - is_set    value:null     → entity has at least one label/assignee
 *   - is_not_set value:null    → entity has zero labels/assignees
 *
 * Single-valued id fields (project, team, from_status) — the entity holds ONE
 * id (or null). from_status is the status the entity moved out of on this fire
 * (the dispatcher's fromStatusId; may be null when "from any status"):
 *   - is        value:string   → entity's value EQUALS value
 *   - is_not    value:string   → entity's value DOES NOT equal value
 *   - in        value:string[] → entity's value is one of value
 *   - not_in    value:string[] → entity's value is none of value
 *   - is_set    value:null     → entity's value is non-null
 *   - is_not_set value:null    → entity's value is null
 *
 * priority — the entity's priority enum. For actions this is the numeric
 * priority column compared as its string form ('0'..'4'); non-action entities
 * have no priority, so a priority rule on them is never met.
 *
 * A rule whose value shape doesn't match its op (e.g. `in` with a non-array,
 * `is` with null) is treated as UNMET — evaluation is fail-closed, never throws.
 */
export interface ConditionRule {
  field: ConditionField
  op: ConditionOp
  /** string for is/is_not, string[] for in/not_in, null for is_set/is_not_set. */
  value: string | string[] | null
}

export interface ConditionGroup {
  /** 'all' = AND across rules; 'any' = OR. Empty rules[] is always-met. */
  match: 'all' | 'any'
  rules: ConditionRule[]
}

// ──────────────────────────────────────────────────────────────────
// Action model (ordered pipeline of http_post / run_skill actions)
// ──────────────────────────────────────────────────────────────────

export interface HttpPostActionConfig {
  method: 'POST' | 'PUT' | 'PATCH'
  url: string
  headers: Record<string, string>
  /** Mustache-lite template; rendered against TemplateContext at fire time. */
  body_template: string
}

/**
 * Config for a run_skill action — executes a skill (recipe row) headlessly
 * server-side (src/lib/flows/run-skill.ts executor, injected into runFlow).
 */
export interface RunSkillActionConfig {
  /** recipe row id, category 'skill'; must exist in-workspace (or is_system). */
  skill_id: string
  /**
   * Trust gradient. 'report' (default) runs with mutating tools denied — the
   * run can only produce its output document/comments. 'act' runs with the
   * skill's own tool ceiling, exactly what it would have in chat.
   */
  mode: 'report' | 'act'
  // NOTE: the per-action `runtime` key is REMOVED (migration 204 wiped every
  // surviving config.runtime value). Every loop body runs on the eve
  // skill-runner agent (run-skill-eve.ts).
  /** Extra user-message appended to the skill invocation; template-rendered. */
  instructions?: string
  deliver?: {
    /**
     * Where the output goes (output connectors, F3: docs/plans/flows-connectors.md
     * §2.4, src/lib/flows/output-connectors.ts). Absent = 'document', today's
     * report. 'notification' is the run's notice alone, no document.
     * 'post_drafts', 'doc_proposals' and 'email_drafts' make the skill return a
     * small typed output (an eve outputSchema) that deterministic code validates
     * and routes: For you post cards, section edits on a canon document, email
     * drafts. None of them ever publishes or sends anything.
     */
    to?: OutputConnector
    /** Write the output to a document. Default true. Read for 'document' only. */
    document?: boolean
    /** Send a flow_run_output in-app notification. Default true. */
    notification?: boolean
    /** Template for the output document title. Default '{skill} — {date}'. */
    document_title?: string
    /** doc_proposals: the canon document's key ('product', 'content-brief:x', …). */
    doc_key?: string
    /** post_drafts: the surface the posts are for (x, linkedin, threads, bluesky). */
    surface?: PostSurface
    /**
     * post_drafts (P9, the weekly post pass): posts a run brings and the most
     * waiting at once, 1-5. Absent: 3 (decision 3's default).
     */
    slots?: number
  }
  /**
   * F4 (flows-connectors.md §2.2): the flow owner's connected apps (their
   * connected_mcp_server ids) whose tools this run may use. Absent or empty:
   * none, the default. Reads run freely; in act mode a write is staged as the
   * owner's approval card and never runs unattended (an inert one, by the
   * input-aware rule, runs and is reported). Report mode sees only the reads.
   * Each tool still honours the server's allow-list and the person's access.
   */
  connections?: string[]
  /**
   * Trust gradient for a VERDICT-class skill (Phase 2, Workstream B). Only
   * meaningful when the skill's recipe declares agent_config.output_contract ===
   * 'verdict'; ignored for prose skills. Governs which of the run's accept
   * verdicts the engine applies automatically vs surfaces as a card.
   *
   * An accept auto-applies iff ALL hold: mode === 'act' AND auto_apply, the
   * decision's confidence >= min_confidence, the decision is explicitly the
   * run-as user's (is_mine_explicit — Liam's "only things explicitly mentioned
   * for me"), and it is not an external side effect (send_email/mcp_call —
   * allow_external is hard-false in v1). Everything else becomes a card, capped
   * at max_cards_per_run (overflow left pending in the capture, never dropped).
   *
   * Absent → the defaults below (propose-only: nothing auto-applies).
   */
  trust?: {
    /** Auto-apply qualifying accepts (act mode only). Default false. */
    auto_apply: boolean
    /** Confidence floor for an auto-apply. Default 0.85. */
    min_confidence: number
    /** External side effects (email/mcp) never auto-apply in v1. */
    allow_external: false
    /** Hard server-side cap on cards surfaced per run. Default 3. */
    max_cards_per_run: number
    /**
     * WS-2b: when an auto-applied accept is marked outreach-class
     * (decision.is_outreach), synthesize + surface a companion draft_email card
     * (server-resolved recipient; never sends). Default true — only an explicit
     * false suppresses it. Per-loop tunable.
     */
    outreach_draft_cards?: boolean
  }
}

/**
 * Config for a run_agent action — dispatches a sandboxed coding run on the eve
 * coding-agent (repo checkout → PR) via the agent_run infrastructure
 * (PR #187). Fire-and-forget: the executor creates an agent_run row and emits
 * `agent/run.requested`, then returns. There is NO report mode — this is
 * inherently 'act' (it writes code + opens PRs).
 *
 * v1 ships INERT: the live dispatch is disarmed behind RUN_AGENT_DISPATCH_ENABLED
 * (default false) in run-agent.ts — no agent_run row is written and no event is
 * emitted until the flag is flipped. See docs/loop-engine/RUN-AGENT-DESIGN.md.
 */
export interface RunAgentActionConfig {
  /** recipe row id, category 'agent'; must be visible in-workspace (or is_system). */
  agent_id: string
  /** "owner/repo" — validated that the run-as user can access it. */
  repo: string
  /** The task text handed to the agent; template-rendered at fire time. */
  instructions: string
  /**
   * entity_status_change-on-action triggers only: inherit repo (project's
   * github_repo), agent (the action's assignee), and the <issue> context from
   * the triggering action. Ignored for schedule/capture_processed (no action).
   * When true, `repo`/`agent_id` may be empty and are resolved from the action.
   */
  use_triggering_action_context?: boolean
  /**
   * The small_bug_draft_prs recipe's marker (P10 F4, src/lib/coding/proactive.ts;
   * capture_processed only). The step runs nothing itself: it rides Triage's
   * one read of each call, where a developer work_proposal that the pre-check
   * finds small and clear starts a coding run whose PR is a reviewed draft.
   * Set only by the recipe (create_flow's input schema has no such field), and
   * kept across update_flow. agent_id and repo are not used.
   */
  attempt_small_bugs?: true
  /** With attempt_small_bugs: the project whose repo the bugs go to (else the only project with a repo). */
  project_id?: string
  /**
   * The ci_fix_loop recipe's marker (P10 F7, src/lib/coding/ci-fix.ts;
   * pr_status_changed only). The step runs nothing itself: its loop, switched
   * on, is the owner's opt-in to fix runs on failing CI of the PRs their own
   * coding runs open in the trigger's repo. Set only by the recipe, kept across
   * update_flow. agent_id and repo are not used.
   */
  fix_ci?: true
}

/**
 * Config for an archive_capture action — archives the capture that triggered
 * the flow (a capture_processed fire; no-op skip on any other trigger, which
 * carries no capture). Reversible: sets captures.status = 'archived'. There is
 * no report/act gradient — archiving IS the action — but it is fenced: it only
 * ever touches the TRIGGERING capture, only when that capture belongs to the
 * flow's workspace and isn't a demo capture (executor re-checks). v1 carries no
 * fields; the shape exists so future options (e.g. a reason, a condition on
 * duration) have a home.
 */
export interface ArchiveCaptureActionConfig {
  /** Reserved for future options; empty in v1. */
  reason?: string
}

/**
 * Config for a call_tool action (F4, flows-connectors.md §2.2): one tool on
 * one of the flow OWNER's connected apps, with an input template. The input's
 * string values may reference the trigger and earlier steps
 * (`{{trigger.capture.title}}`, `{{steps.<step id>.output}}`; template.ts),
 * rendered strictly at run time (a missing reference fails the step). The
 * call is checked against the tool's own input schema when it is saved and
 * again when it runs (call-tool.ts). A read runs; a write follows the
 * input-aware rule (mcp-client/input-policy.ts): an inert one runs and is
 * reported, anything else parks the run on the owner's approval card. A post
 * or other public content ALWAYS takes the card.
 */
export interface CallToolActionConfig {
  /** The owner's connected_mcp_server id (list_connections). */
  connection: string
  /** The server's own tool name (not the mcp__ namespaced one). */
  tool: string
  /** The tool's input: a JSON object whose string values are templates. */
  input: Record<string, unknown>
}

/**
 * Config for a run_local_agent action (L5, docs/plans/teammate-agent.md): a
 * job on the flow OWNER's Mac, in one folder they shared there (a local
 * agent, src/lib/local-agent/unattended.ts). Fire-and-forget: the step starts
 * the job and returns; the job reports in the owner's home thread like one
 * they started, shows in the tray and the Agents panel, and stops from either.
 * The server sends words only (invariant 2): the request, the folder's id and
 * a mode, never a path or a command. Every tool call the job makes goes
 * through the blocking reviewer, checked against this saved request.
 */
export interface RunLocalAgentActionConfig {
  /** The owner's shared folder (its device_folder id, from local_agents). */
  folder_id: string
  /**
   * The request, in words. A template rendered at fire time (the trigger's
   * tokens, never another step's output); every substituted value is fenced
   * as untrusted, since it may come from a meeting or an email.
   */
  request: string
  /** 'read' (the default), or 'edit' (a git worktree; only in a folder shared for edits on the Mac). */
  mode?: 'read' | 'edit'
}

export type FlowActionConfig =
  | HttpPostActionConfig
  | RunSkillActionConfig
  | RunAgentActionConfig
  | ArchiveCaptureActionConfig
  | CallToolActionConfig
  | RunLocalAgentActionConfig

/**
 * A single action in a flow's action TREE, as stored in DB (with the encrypted
 * bearer token). `type` discriminates the config shape.
 *
 * TREE SHAPE: actions form a tree rooted at the trigger. `parent_id` is the id
 * of the action this one chains off, or null for an action that chains directly
 * off the trigger (a "root" action). Any node may have multiple children
 * (fan-out). The array is still flat in storage; the tree is reconstructed from
 * parent_id. Each action is gated independently by its own `condition` — the
 * parent link is structural (ordering + grouping), it does NOT propagate
 * success/failure. A disabled action (enabled:false) is skipped at fire time.
 */
export interface FlowAction {
  /** Stable id; keys canvas_layout ("action:<id>") and action_results. */
  id: string
  type: FlowActionType
  config: FlowActionConfig
  /** Optional gate on the triggering entity. null = always run. */
  condition: ConditionGroup | null
  /** Parent action id this one chains off; null = chains off the trigger. */
  parent_id: string | null
  /** When false, the action is skipped at fire time (greyed out in the editor). */
  enabled: boolean
  /** aes-256-gcm ciphertext (v1.iv.tag.ct). Never returned to clients. */
  bearer_token_encrypted: string | null
}

/**
 * Public-facing action (the encrypted token redacted to a boolean). This is
 * what API responses expose.
 */
export interface FlowActionPublic {
  id: string
  type: FlowActionType
  config: FlowActionConfig
  condition: ConditionGroup | null
  /** Parent action id this one chains off; null = chains off the trigger. */
  parent_id: string | null
  /** When false, the action is skipped at fire time. */
  enabled: boolean
  /** True iff a bearer token is saved for this action. Plaintext never leaves the server. */
  bearer_token_present: boolean
}

// ──────────────────────────────────────────────────────────────────
// Canvas layout (UI-only)
// ──────────────────────────────────────────────────────────────────

/**
 * UI-only canvas layout — node positions in the Flows editor. Pure
 * presentation data; has no effect on flow matching or the runner. The
 * trigger node is keyed `trigger`; each action node is keyed by its action id.
 */
export interface CanvasLayout {
  trigger?: { x: number; y: number }
  /** Keyed by action id. */
  actions?: Record<string, { x: number; y: number }>
}

// ──────────────────────────────────────────────────────────────────
// Flow + FlowRun
// ──────────────────────────────────────────────────────────────────

/** Public flow shape returned by the API (per-action tokens redacted). */
export interface Flow {
  id: string
  workspace_id: string
  /** Nullable: workspace-scoped triggers (schedule, capture_processed) have no team. */
  team_id: string | null
  name: string
  description: string | null
  enabled: boolean
  trigger_type: FlowTriggerType
  trigger_config: FlowTriggerConfig
  /** Ordered action pipeline; order = execution order. */
  actions: FlowActionPublic[]
  /** UI-only node positions for the canvas editor. */
  canvas_layout: CanvasLayout
  created_by: string
  created_at: string
  updated_at: string
  /**
   * Stable machine tag for a loop seeded on workspace creation (GEN-148).
   * Only 'seed:triage' is seeded now; older workspaces can still hold a
   * 'seed:groom', 'seed:reconcile' or 'seed:brief' loop someone turned on
   * (migration 351 removed the idle ones). NULL for user-created flows. A
   * non-null value marks the row as a seeded default.
   */
  seed_key: string | null
  /**
   * The teammate whose bot fronts this loop (migration 302, bots-v3 Phase 3):
   * its runs, cards and notices come through that bot. NULL only when its bot
   * was deleted (the editor then asks for one) or before the back-fill.
   */
  ai_team_member_id: string | null
  /** That teammate, as far as the reader may see it (null when hidden or none). Only on reads that embed it. */
  bot?: FlowBot | null
}

/** The bot a loop names: its teammate's face and name (embedded on the flow reads). */
export interface FlowBot {
  id: string
  name: string
  bot_character: string | null
  /** A work bot: made for loops, takes no assignments. */
  fronts_only: boolean
  is_system: boolean
  system_key: string | null
}

/**
 * Internal flow shape carrying the encrypted per-action tokens — used by the
 * runner/dispatcher only, never serialized to a client.
 */
export interface FlowWithSecrets extends Omit<Flow, 'actions'> {
  actions: FlowAction[]
}

/** Per-action outcome of a single flow fire. */
export interface ActionResult {
  action_id: string
  /** Did the action's condition pass? (true when no condition.) */
  condition_met: boolean
  /** True iff the action was disabled (enabled:false) at fire time. */
  disabled: boolean
  /**
   * True iff the action was enabled and condition-eligible but not runnable —
   * its config has no usable URL (a still-being-drafted action). Skipped at
   * fire time like a disabled one; the rest of the flow still fires.
   */
  incomplete: boolean
  /** True iff the action was NOT executed (disabled, incomplete, or condition_met=false). */
  skipped: boolean
  status: FlowRunStatus
  request_summary: RequestSummary | null
  response_status_code: number | null
  response_body_preview: string | null
  error_message: string | null
  duration_ms: number | null
  /** run_skill only: the delivered output document, when one was created. */
  output_document_id?: string | null
  /** run_agent: true iff an async run was dispatched (queued). */
  dispatched?: boolean
  /** run_agent only: the dispatched agent_run row id, for the Cloud-run deep link. */
  agent_run_id?: string | null
  /** run_local_agent only: the Mac job it started (local_agent_session id), when one was. */
  local_agent_session_id?: string | null
  /** archive_capture only: the capture id that was archived, when one was. */
  archived_capture_id?: string | null
  /**
   * run_skill with a structured output connector (post_drafts, doc_proposals,
   * email_drafts) or a lens: what deterministic code delivered and
   * refused. Ground truth like the verdict ledger: written from the delivery's
   * own results, never from model prose.
   */
  delivered?: ConnectorDeliverySummary | null
  /**
   * A lens flow that rode Triage's read of the call (lens flows, F3): the
   * flow_run of the Triage run that read it. Its own run never happened.
   */
  rode_flow_run_id?: string | null
  /**
   * F4: the step brought outside text into the run (a connected app's result,
   * an http_post response, a skill run that read some: run-outside-reads.ts).
   * Set in code from what ran, never by a model. Later steps inherit it: a
   * skill step's canon edits are labelled as from outside text, and its
   * instructions fence the values.
   */
  read_outside_text?: boolean
  /**
   * F4: the step parked the run on the owner's approval card (an unattended
   * outward call held for them, call-tool.ts). The run's status is 'pending'
   * and the steps after it wait (`waiting`) for the card.
   */
  parked?: { approval_id: string; card_id: string; title: string } | null
  /** F4: a step that was not run because the run parked before it (or ended at a parked step). */
  waiting?: boolean
  /** F4 call_tool: the connected app and tool the step called, for the run's history. */
  called?: { connection: string; server: string; tool: string; policy: 'read' | 'inert' | 'ask' } | null
  /**
   * Verdict-class run_skill only (Phase 2, Workstream B): the structured ledger
   * of what the run decided AND what the engine actually did about it. This IS
   * ground truth — claimed == actual, because the engine writes it from the
   * results of its own apply walk, not from model prose. Rides flow_run.action_results
   * (no separate flow_run column).
   */
  verdict?: VerdictLedger | null
}

/**
 * What an output connector (or a lens) delivered for one run: the counts the
 * run's ledger row and summary read, and a short reason per refused item.
 */
export interface ConnectorDeliverySummary {
  /** The connector, or `lens:<key>` for a lens's own delivery. */
  to: string
  /** Items that landed: cards inserted, edits applied, drafts written, notes saved. */
  delivered: number
  /** Items refused by the deterministic checks or the destination, with why (at most 10). */
  refused: string[]
  /** One line for the run's summary ("2 X posts for you"). */
  summary: string
  /** True when this was a dry run: nothing was delivered, the line says what would have been. */
  dry_run?: boolean
}

/** One entry in a verdict run's ledger — a decision + what the engine did with it. */
export interface VerdictLedgerEntry {
  proposal_id: string
  decision: 'accept' | 'dismiss' | 'fold_into' | 'revoke'
  /** What the engine ACTUALLY did (may differ from the decision — e.g. an accept
   *  that didn't clear the trust gate becomes 'carded'; a stale revoke 'skipped').
   *  'staged': an accept that didn't clear the gate and was left pending in its
   *  capture with no card (a new to-do, or a proposal that already had a card),
   *  where the capture page, the call's proposals card and the chat agent still
   *  offer it. */
  outcome: 'applied' | 'carded' | 'staged' | 'dismissed' | 'folded' | 'revoked' | 'skipped' | 'failed'
  /** The run's one-line, user-facing reason for the decision. */
  reason: string
  /** Set when an entity was created/mutated/deleted (applied/folded target/revoked). */
  entity_id?: string | null
  /** The kind of `entity_id` (the proposal's entity_type), so a touch can be written without a join. */
  entity_type?: string | null
  /** An 'applied' create: the run made `entity_id` itself (P13: the home thread says so, with an Undo). */
  created?: true
  /** Set when outcome is 'failed' or 'skipped' — why. */
  detail?: string | null
}

/** The full verdict ledger attached to a verdict-class run's ActionResult. */
export interface VerdictLedger {
  summary: string
  entries: VerdictLedgerEntry[]
  /** How many cards were really INSERTED to the rail this run. A unique-violation
   *  dedup or a failed insert is NOT counted here (see cards_deduped/cards_failed),
   *  so the grouped notification can never overstate (the Jul-6 "3 need you vs 2
   *  rows" bug). */
  cards_surfaced: number
  /** Card inserts that hit the (proposal_id, run_key) unique index — already
   *  surfaced (idempotent retry / a duplicate candidate). NOT in cards_surfaced. */
  cards_deduped?: number
  /** Card inserts that errored for a non-dedup reason. NOT in cards_surfaced. */
  cards_failed?: number
  /** Candidates beyond max_cards_per_run left pending in the capture (not dropped). */
  cards_overflow: number
  /** Card candidates not carded: a needs_user item whose proposal already had a
   *  card (pending, dismissed or expired: verdict-apply loadCardState), any
   *  candidate whose proposal is no longer pending or isn't in the workspace,
   *  a needs_user Create action card (that proposal stays in its capture), and
   *  a needs_user action or email card that names no proposal (nothing to
   *  apply: pending-cards isUnbackedCard). Absent when 0. */
  cards_suppressed?: number
  /** How many auto-accepted items this run revoked (surfaced honestly in the notification). */
  revoked_count: number
  /** True iff the model never called submit_run_verdict (ran out of steps) — nothing applied. */
  verdict_missing?: boolean
  /**
   * The exact verdict the model submitted (decisions + needs_user + summary),
   * persisted verbatim so every surfaced-or-not item is reconstructible — even a
   * needs_user entry that overflowed the cap or was deduped leaves a record here
   * (closes the Jul-6 "which was the 3rd card" gap). Absent on a no-verdict run.
   */
  submitted?: RunVerdict
  /**
   * Sequence step 3 (the auto-attempt gate): what the gate did with each
   * work_proposal that would have been carded. Present ONLY when the gate was
   * live for this verdict (env switch on AND the workspace in mode 'attempt');
   * absent otherwise, so a verdict's ledger is unchanged while the feature is off.
   */
  attempts?: VerdictAttemptEntry[]
  /**
   * Lens flows (F3): what each lens that rode this run delivered, by the lens
   * flow's id. Absent when no lens rode. The dispatcher records each on its
   * own flow's run.
   */
  lenses?: LensRideResult[]
}

/** One lens flow's outcome on the Triage run it rode (lens flows, F3). */
export interface LensRideResult {
  flow_id: string
  action_id: string
  lens: string
  status: FlowRunStatus
  delivered: ConnectorDeliverySummary | null
  error_message: string | null
}

/** One work_proposal the auto-attempt gate looked at (verdict-apply). */
export interface VerdictAttemptEntry {
  title: string
  proposal_id: string | null
  /** 'started' / 'reused' (a run exists for its fire_key) → no card; 'carded' → the gate refused. */
  outcome: 'started' | 'reused' | 'carded'
  agent_run_id?: string | null
  /** The refusal (auto-attempt.ts AutoAttemptRefusal, or a launch failure) when carded. */
  reason?: string | null
  detail?: string | null
}

export interface FlowRun {
  id: string
  flow_id: string
  triggered_by_action_id: string | null
  status: FlowRunStatus
  /** Per-action outcomes (ordered to match flow.actions). */
  action_results: ActionResult[]
  /**
   * Legacy top-level snapshot — mirrors the first executed action so the
   * run-list UI works without per-action expansion.
   */
  request_summary: RequestSummary | null
  response_status_code: number | null
  response_body_preview: string | null
  error_message: string | null
  fired_at: string
  duration_ms: number | null
}

export interface RequestSummary {
  method: string
  url: string
  /** Header NAMES only — values are sensitive (Authorization, etc.). */
  header_names: string[]
  body_byte_length: number
}

/**
 * Trigger context passed from the API route into Inngest. Keep this
 * serializable — Inngest events are JSON.
 */
export interface TriggerContext {
  type: FlowTriggerType
  /** Null for triggers with no status-bearing entity (schedule, capture_processed). */
  entity_type: FlowEntityType | null
  from_status_id: string | null
  to_status_id: string | null
  fired_at: string
  /** A quote_received fire: the quote it is about (`{{trigger.quote_id}}`). */
  quote_id?: string | null
  /** An email_received fire: the provider thread (`{{trigger.email_thread_id}}`), read live with read_email. */
  email_thread_id?: string | null
  /** An email_received fire: the connected account it arrived in (`{{trigger.email_account_id}}`). */
  email_account_id?: string | null
  /** An email_received fire: the sender's address, only when it is a well-formed address (`{{trigger.email_from}}`). */
  email_from?: string | null
  /** A chat_message fire: the message (`{{trigger.chat_message_id}}`). */
  chat_message_id?: string | null
  /** A chat_message fire: its channel (`{{trigger.chat_channel_id}}`). */
  chat_channel_id?: string | null
  /** A chat_message fire: the thread it replies in, or null in the channel itself (`{{trigger.chat_thread_root_id}}`). */
  chat_thread_root_id?: string | null
  /** A document_created fire: the document (`{{trigger.document_id}}`). */
  document_id?: string | null
}

/**
 * Event payload for `flow/entity.status_changed`. Sent from the PATCH
 * route of each entity that supports status-change triggers (v1: action;
 * project/initiative/milestone already emit too).
 */
export interface EntityStatusChangedEvent {
  data: {
    entity_type: FlowEntityType
    entity_id: string
    workspace_id: string
    /** Team scope for actions; projects don't have a team. Nullable. */
    team_id: string | null
    from_status_id: string | null
    to_status_id: string
    actor_user_id: string
    fired_at: string
    /** Absent on events emitted before the loop guard shipped → treated as a
     *  person at depth 0 (the emitter always sets it now). */
    origin?: StatusChangeOrigin
  }
}
