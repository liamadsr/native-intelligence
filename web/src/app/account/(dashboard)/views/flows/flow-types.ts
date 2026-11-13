/**
 * Client-side types + editor-state model for the Flows canvas editor.
 *
 * These mirror the public shape returned by /api/account/flows (see
 * src/lib/flows/types.ts). Model: one trigger (entity status change, schedule,
 * or capture processed) → an ORDERED list of N actions (http_post | run_skill),
 * each with an optional AND/OR condition on the triggering entity. The canvas
 * renders the trigger node plus one node per action (a vertical fan-out).
 */

import type { FlowEntityType } from '@/lib/flows/types'
import { validateCronExpression } from '@/lib/flows/cron'
import { runAtInstant } from '@/lib/flows/schedule'
export type { FlowEntityType }

export type FlowTriggerType =
  | 'entity_status_change'
  | 'schedule'
  | 'capture_processed'
  | 'calendar_event'
  | 'pr_status_changed'
  | 'email_received'
  | 'chat_message'
  | 'document_created'

export type ScheduleCadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron' | 'once'

export type ConditionField =
  | 'label'
  | 'priority'
  | 'assignee'
  | 'project'
  | 'team'
  | 'from_status'

export type ConditionOp = 'is' | 'is_not' | 'in' | 'not_in' | 'is_set' | 'is_not_set'

export interface ConditionRule {
  field: ConditionField
  op: ConditionOp
  value: string | string[] | null
}

export interface ConditionGroup {
  match: 'all' | 'any'
  rules: ConditionRule[]
}

export interface EntityStatusChangeTriggerConfig {
  entity_type: FlowEntityType
  from_status_id: string | null
  to_status_id: string
}

/** Workspace-scoped (team_id NULL) recurring trigger. */
export interface ScheduleTriggerConfig {
  kind: 'schedule'
  cadence: ScheduleCadence
  /** 'HH:mm' 24h wall-clock in `timezone`. Required for daily, weekdays, weekly and monthly. */
  time?: string
  /** 0 (Sunday) - 6 (Saturday). Weekly cadence only. */
  weekday?: number
  /** 1-28. Monthly cadence only. */
  day_of_month?: number
  /** A 5-field cron expression. Cron (custom) cadence only. */
  cron?: string
  /** 'YYYY-MM-DDTHH:mm' wall-clock in `timezone`. Once cadence only. */
  run_at?: string
  /** IANA timezone name, e.g. 'America/Los_Angeles'. */
  timezone: string
}

/** Workspace-scoped trigger fired when a capture's batch extraction completes. */
export interface CaptureProcessedTriggerConfig {
  kind: 'capture_processed'
}

/** GEN-136: fire N minutes before/after each occurrence of a recurring calendar event. */
export interface CalendarEventTriggerConfig {
  kind: 'calendar_event'
  /** Recurring event title, matched exact-normalized (lowercased + trimmed) server-side. */
  event_title: string
  /** Minutes relative to the occurrence start_at. Negative = before, positive = after, 0 = at start. */
  offset_minutes: number
}

/** A linked pull request opening, closing, merging or reopening (src/lib/flows/types.ts). */
export type PrTriggerState = 'open' | 'closed' | 'merged' | 'any'
export interface PrStatusChangedTriggerConfig {
  kind: 'pr_status_changed'
  /** "owner/repo". */
  repo_full_name: string
  to_state: PrTriggerState
}

/** New mail in the loop owner's own inbox, optionally from one sender (an address or a domain). */
export interface EmailReceivedTriggerConfig {
  kind: 'email_received'
  from?: string
}

/** A person's team chat message: in one channel, or (mentions_only) anywhere the owner is @mentioned. */
export interface ChatMessageTriggerConfig {
  kind: 'chat_message'
  channel_id: string | null
  mentions_only: boolean
}

/** A person creates a document the owner can see. */
export interface DocumentCreatedTriggerConfig {
  kind: 'document_created'
}

export type FlowTriggerConfig =
  | EntityStatusChangeTriggerConfig
  | ScheduleTriggerConfig
  | CaptureProcessedTriggerConfig
  | CalendarEventTriggerConfig
  | PrStatusChangedTriggerConfig
  | EmailReceivedTriggerConfig
  | ChatMessageTriggerConfig
  | DocumentCreatedTriggerConfig

export interface HttpPostActionConfig {
  method: 'POST' | 'PUT' | 'PATCH'
  url: string
  headers: Record<string, string>
  body_template: string
}

/** Executes a skill (recipe row) headlessly server-side. */
export interface RunSkillActionConfig {
  skill_id: string
  /** 'report' (default) denies mutating tools; 'act' runs with the skill's own ceiling. */
  mode: 'report' | 'act'
  instructions?: string
  deliver?: {
    /** Output connector (F3, src/lib/flows/output-connectors.ts). The editor has no control for it; a save carries it through. */
    to?: 'document' | 'notification' | 'post_drafts' | 'doc_proposals' | 'email_drafts'
    document?: boolean
    notification?: boolean
    document_title?: string
    doc_key?: string
    /** The platform a post_drafts loop drafts for (P8: src/lib/content/post-draft.ts POST_SURFACES). */
    surface?: 'x' | 'linkedin' | 'threads' | 'bluesky'
  }
  /**
   * A verdict skill's trust gradient (src/lib/flows/types.ts). The editor has
   * no control for it: a stored one rides through a save (stored_run_skill).
   */
  trust?: {
    auto_apply: boolean
    min_confidence: number
    allow_external: false
    max_cards_per_run: number
    outreach_draft_cards?: boolean
  }
  /** F4: the owner's connected apps this skill may use (set in chat; a save carries it through). */
  connections?: string[]
}

/**
 * F4: one tool on one of the owner's connected apps (src/lib/flows/types.ts).
 * Its input's string values are templates ({{steps.<id>.output}}, …).
 */
export interface CallToolActionConfig {
  connection: string
  tool: string
  input: Record<string, unknown>
}

/**
 * Dispatches a sandboxed coding run on the eve coding-agent (repo checkout →
 * PR) via the agent_run infrastructure. Fire-and-forget; inherently 'act' (no report mode).
 * INERT in v1 — dispatch is disarmed behind a server-side flag.
 */
export interface RunAgentActionConfig {
  agent_id: string
  repo: string
  instructions: string
  use_triggering_action_context?: boolean
}

export type FlowActionType = 'http_post' | 'run_skill' | 'run_agent' | 'archive_capture' | 'call_tool' | 'run_local_agent'

/** A job on the owner's Mac (L5): set up from chat; the editor shows it and keeps it as it is. */
export interface RunLocalAgentActionConfig {
  folder_id: string
  request: string
  mode?: 'read' | 'edit'
}

/** archive_capture carries no required fields (archives the triggering capture). */
export interface ArchiveCaptureActionConfig {
  reason?: string
}

export type FlowActionConfig =
  | HttpPostActionConfig
  | RunSkillActionConfig
  | RunAgentActionConfig
  | ArchiveCaptureActionConfig
  | CallToolActionConfig
  | RunLocalAgentActionConfig

/** Public action shape from the API (token redacted to a boolean). */
export interface FlowActionPublic {
  id: string
  type: FlowActionType
  config: FlowActionConfig
  condition: ConditionGroup | null
  /** Parent action id this one chains off; null = chains off the trigger. */
  parent_id: string | null
  /** When false, the action is skipped at fire time (greyed out in the editor). */
  enabled: boolean
  bearer_token_present: boolean
}

/** UI-only node positions for the canvas editor; actions keyed by action id. */
export interface CanvasLayout {
  trigger?: { x: number; y: number }
  actions?: Record<string, { x: number; y: number }>
}

export interface Flow {
  id: string
  workspace_id: string
  /** Null for workspace-scoped triggers (schedule, capture_processed). */
  team_id: string | null
  name: string
  description: string | null
  enabled: boolean
  trigger_type: FlowTriggerType
  trigger_config: FlowTriggerConfig
  actions: FlowActionPublic[]
  canvas_layout: CanvasLayout
  created_by: string
  created_at: string
  updated_at: string
  /** 'seed:triage' etc. for a loop seeded on workspace creation, else null. */
  seed_key?: string | null
  /** The teammate whose bot fronts this loop (bots-v3 Phase 3); null once its bot was deleted. */
  ai_team_member_id?: string | null
  /** That teammate's face and name, when the reader may see it. */
  bot?: FlowBotSummary | null
  /** Who it runs as (GET /api/account/flows/[id] only, F1). */
  owner?: { user_id: string | null; name: string | null }
  /** The reader owns it: only they change its trigger and steps. */
  viewer_is_owner?: boolean
  /** The reader asked the owner to take it over and the card still waits. */
  takeover_pending?: boolean
}

/** A loop's bot as the flow reads embed it (src/lib/flows/queries.ts FLOW_BOT_EMBED). */
export interface FlowBotSummary {
  id: string
  name: string
  bot_character: string | null
  fronts_only: boolean
  is_system: boolean
  system_key: string | null
}

/**
 * The agent the editor has picked (bots-v3 Phase 3): an existing teammate, or
 * a new one, for which saving always makes a new work agent named `name`
 * (blank: named after the face the server hands it).
 */
export type EditorBot =
  | { kind: 'teammate'; id: string }
  | { kind: 'new'; name: string }

/** One bot the picker offers (GET /api/account/flows/bots). */
export interface FlowBotOption extends FlowBotSummary {
  /** The loops its bot already fronts, by name. */
  fronts: string[]
  /** A custom agent's bot (bots-v3 Phase 6): the agent it speaks for, by name. */
  agent?: string | null
}

/** What GET /api/account/flows/bots answers. */
export interface FlowBotOptions {
  teammates: FlowBotOption[]
  free_characters: string[]
  suggested: { kind: 'teammate'; teammateId: string } | { kind: 'character'; character: string } | null
}

/** The seeded loops that keep their own system teammate, Captures (the picker is read-only for them). */
export const SEEDED_BOT_KEYS: Readonly<Record<string, string>> = {
  'seed:triage': 'captures',
  'seed:reconcile': 'captures',
}

export interface Team {
  id: string
  name: string
}

export interface WorkflowState {
  id: string
  team_id: string
  name: string
  category: string
  color: string
  sort_order: number
}

export interface Label {
  id: string
  name: string
  color: string | null
}

export interface Member {
  id: string
  display_name: string | null
}

export interface Project {
  id: string
  name: string
}

/** Skill option for the run_skill picker (subset of the library item shape). */
export interface SkillOption {
  id: string
  name: string
  icon: string | null
  is_system: boolean
}

/** Agent option for the run_agent picker (category 'agent' library items). */
export interface AgentOption {
  id: string
  name: string
  icon: string | null
  is_system: boolean
}

export interface ActionResult {
  action_id: string
  condition_met: boolean
  disabled: boolean
  incomplete: boolean
  skipped: boolean
  /** 'pending': a step parked on an approval card, or one waiting behind it (F4). */
  status: 'success' | 'failed' | 'pending'
  /** F4: the step parked the run on this approval card. */
  parked?: { approval_id: string; card_id: string; title: string } | null
  /** F4: not run yet: the run is parked on a card before it. */
  waiting?: boolean
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
  /** Verdict-skill only: the ledger of what the run decided + applied. The audit
   *  surface for a closed-loop triage run (cards default to no output document). */
  verdict?: {
    summary: string
    cards_surfaced: number
    cards_overflow: number
    revoked_count: number
    verdict_missing?: boolean
    entries?: Array<{
      // Mirror of the server VerdictLedgerEntry (src/lib/flows/types.ts) — keep
      // these field names in sync; the UI reads outcome/reason/detail/decision.
      proposal_id?: string
      decision: 'accept' | 'dismiss' | 'fold_into' | 'revoke'
      outcome: 'applied' | 'carded' | 'staged' | 'dismissed' | 'folded' | 'revoked' | 'skipped' | 'failed'
      entity_id?: string | null
      reason?: string
      detail?: string
    }>
  } | null
}

export interface FlowRun {
  id: string
  /** 'pending': parked on an approval card (F4), the rest of the run waits for it. */
  status: 'success' | 'failed' | 'pending'
  action_results: ActionResult[]
  response_status_code: number | null
  response_body_preview: string | null
  error_message: string | null
  fired_at: string
  duration_ms: number | null
  action: { identifier: string | null; title: string } | null
}

// ── Editor state ──────────────────────────────────────────────

/** Which node's config panel is open. */
export type SelectedNode =
  | { kind: 'trigger' }
  | { kind: 'action'; id: string }
  /** The loop's bot ("Its bot"), opened from the header. */
  | { kind: 'bot' }
  | null

export interface EditorRule {
  /** Client-only row id for stable React keys. */
  id: string
  field: ConditionField
  op: ConditionOp
  /** Always string[] in the editor; collapses to scalar at save for scalar ops. */
  value: string[]
}

export interface EditorCondition {
  /** When false, the condition section is collapsed and not sent (always run). */
  enabled: boolean
  match: 'all' | 'any'
  rules: EditorRule[]
}

/**
 * Editor action: a flat superset of both action types' fields so switching
 * the type in the config panel never loses what the user already typed.
 * `type` selects which field group serializes at save.
 */
export interface EditorAction {
  id: string
  type: FlowActionType
  /** Parent action id this one chains off; null = chains off the trigger. */
  parent_id: string | null
  /** When false, the action (and its subtree) is skipped; shown greyed out. */
  enabled: boolean
  // http_post fields
  method: 'POST' | 'PUT' | 'PATCH'
  url: string
  headers: Array<{ key: string; value: string }>
  body_template: string
  bearer_token: string // empty = unchanged (editing) or unset (creating)
  bearer_token_present: boolean
  // run_skill fields
  skill_id: string // '' = not picked yet (a draft; skipped at fire time)
  mode: 'report' | 'act'
  instructions: string
  deliver_document: boolean
  deliver_notification: boolean
  /**
   * Stored run_skill settings the editor has no control for (a report title,
   * a verdict skill's trust), carried through a save untouched so a UI save
   * never drops them (the PATCH route replaces the whole config). Kept only
   * for the skill they were set for (`skill_id`); null for a new action.
   */
  stored_run_skill: {
    skill_id: string
    mode: 'report' | 'act'
    document_title?: string
    /** The output connector and its destination (F3), set in chat. */
    connector?: Pick<NonNullable<RunSkillActionConfig['deliver']>, 'to' | 'doc_key' | 'surface'>
    trust?: RunSkillActionConfig['trust']
    /** F4: the connected apps it may use, set in chat. */
    connections?: string[]
  } | null
  // run_agent fields
  agent_id: string // '' = not picked yet (a draft; skipped at fire time)
  repo: string // "owner/repo"
  agent_instructions: string
  use_triggering_action_context: boolean
  // call_tool fields (F4)
  connection: string // '' = not picked yet (a draft; skipped at fire time)
  tool: string
  /** The input as JSON text (templates inside its strings). */
  tool_input: string
  /**
   * run_local_agent (L5): the stored step, which the editor has no controls
   * for (it is set up in chat), carried through a save untouched.
   */
  stored_local_agent: RunLocalAgentActionConfig | null
  condition: EditorCondition
}

/**
 * Editor trigger: flat superset of every trigger type's fields — same
 * rationale as EditorAction. `kind` selects what serializes at save.
 */
export interface EditorTrigger {
  kind: FlowTriggerType
  // entity_status_change fields
  entity_type: FlowEntityType
  from_status_id: string // '__any__' sentinel for "any source"
  to_status_id: string
  // schedule fields
  cadence: ScheduleCadence
  time: string // 'HH:mm'
  weekday: number // 0 (Sunday) - 6 (Saturday)
  day_of_month: number // 1-28, monthly
  cron: string // 5-field expression, custom
  run_at: string // 'YYYY-MM-DDTHH:mm' in timezone, once
  timezone: string // IANA name
  // calendar_event fields (GEN-136)
  event_title: string // recurring event title to anchor to
  offset_minutes: number // relative to the occurrence start (-1440..1440); <0 = before
  // pr_status_changed fields (F1): a PR linked to one of the workspace's actions
  repo_full_name: string // "owner/repo"
  pr_state: PrTriggerState
  // email_received: '' = any sender
  email_from: string
  // chat_message: ANY_CHANNEL = any channel (only with mentions_only), '' = none picked yet
  chat_channel_id: string
  mentions_only: boolean
}

/** The chat trigger's "Any channel" choice (stored as channel_id null). */
export const ANY_CHANNEL = '__any__'

export interface EditorState {
  id: string | null // null = creating
  name: string
  description: string
  team_id: string
  enabled: boolean
  trigger: EditorTrigger
  actions: EditorAction[]
  canvas_layout: CanvasLayout // persisted node positions
  /** Its bot (bots-v3 Phase 3). Null on a new loop until the default is suggested, or once its bot was deleted. */
  bot: EditorBot | null
  /** The person changed the bot (only then does a save send it for an existing loop). */
  botDirty: boolean
  /** The loop's seed key: a seeded Triage / Reconciler loop keeps its system teammate. */
  seed_key: string | null
  /** The saved bot's face and name, from the flow read (before the picker's options load). */
  botSummary: FlowBotSummary | null
  /**
   * F1: the loop belongs to someone else. Its trigger and steps are read-only
   * here; "Take over this flow" asks the owner. Null when the viewer owns it
   * (and on a new loop).
   */
  ownedBy: { name: string; requested: boolean } | null
  /** A saved one-time loop's time, as stored (the once field says what a save does). */
  savedOnce?: SavedOnce | null
}

/** A one-time loop's saved time. */
export interface SavedOnce {
  run_at: string
  timezone: string
}

/** The saved one-time time of a flow read, or null when it is not a one-time loop. */
export function savedOnceOf(flow: Pick<Flow, 'trigger_type' | 'trigger_config'>): SavedOnce | null {
  if (flow.trigger_type !== 'schedule') return null
  const cfg = (flow.trigger_config ?? {}) as { cadence?: unknown; run_at?: unknown; timezone?: unknown }
  return cfg.cadence === 'once' && typeof cfg.run_at === 'string' && typeof cfg.timezone === 'string' ? { run_at: cfg.run_at, timezone: cfg.timezone } : null
}

/**
 * The once field's line: what the loop did and what a save does, as the PATCH
 * route decides it (next-run.ts onceArming). A NEW time ahead switches the
 * loop on for it; a time that has passed leaves it off; the saved time keeps
 * the switch as it is.
 */
export function onceFieldNote(args: { runAt: string; timezone: string; saved: SavedOnce | null | undefined; enabled: boolean; now?: Date }): string {
  const at = runAtInstant(args.runAt, args.timezone)
  if (!at) return 'Runs one time, then the loop switches itself off.'
  const ahead = at.getTime() > (args.now ?? new Date()).getTime()
  const isSaved = !!args.saved && args.saved.run_at === args.runAt && args.saved.timezone === args.timezone
  if (!isSaved) return ahead ? 'Saving switches the loop on to run at this time; then it switches itself off.' : 'That time has passed: saving leaves the loop off. Pick a time ahead to run it.'
  if (ahead) return args.enabled ? 'Runs one time, then the loop switches itself off.' : 'Off: it won’t run at this time unless you switch it on.'
  return args.enabled ? 'Its time has passed: it runs at the next chance, then switches itself off.' : 'It ran at this time and is off now. Pick a new time and save to run it again.'
}

/** True when the editor shows the loop's trigger and steps read-only (someone else owns it). */
export function isReadOnlyFlow(editor: Pick<EditorState, 'ownedBy'>): boolean {
  return editor.ownedBy !== null
}

export const ENTITY_LABELS: Record<FlowEntityType, string> = {
  action: 'Action',
  project: 'Project',
  initiative: 'Initiative',
  milestone: 'Milestone',
}

export const TRIGGER_TYPE_LABELS: Record<FlowTriggerType, string> = {
  entity_status_change: 'Status change',
  schedule: 'Schedule',
  capture_processed: 'Capture processed',
  calendar_event: 'Calendar event',
  pr_status_changed: 'Pull request',
  email_received: 'New email',
  chat_message: 'Chat message',
  document_created: 'New document',
}

export const PR_STATE_LABELS: Record<PrTriggerState, string> = {
  any: 'Any change',
  open: 'Opened or reopened',
  merged: 'Merged',
  closed: 'Closed without merging',
}

export const CADENCE_LABELS: Record<ScheduleCadence, string> = {
  hourly: 'Hourly',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  monthly: 'Monthly',
  cron: 'Custom',
  once: 'Once',
}

/** Indexed by the schedule trigger's 0 (Sunday) - 6 (Saturday) weekday. */
export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** Browser timezone for new schedule triggers; editable in the config panel. */
function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** One-line summary of a schedule trigger for the canvas node / config panel. */
export function describeSchedule(
  t: Pick<EditorTrigger, 'cadence' | 'time' | 'weekday'> & Partial<Pick<EditorTrigger, 'day_of_month' | 'cron' | 'run_at'>>,
): string {
  switch (t.cadence) {
    case 'monthly':
      return `Monthly on day ${t.day_of_month ?? 1} at ${t.time || '--:--'}`
    case 'cron':
      return t.cron?.trim() ? `Custom: ${t.cron.trim()}` : 'Custom schedule'
    case 'once':
      return t.run_at ? `Once on ${t.run_at.replace('T', ' at ')}` : 'Once: pick a date and time'
    case 'hourly':
      return 'Every hour'
    case 'daily':
      return `Daily at ${t.time || '--:--'}`
    case 'weekdays':
      return `Weekdays at ${t.time || '--:--'}`
    case 'weekly':
      return `${WEEKDAY_LABELS[t.weekday] ?? 'Monday'}s at ${t.time || '--:--'}`
  }
}

/** Condition field labels for the builder UI. */
export const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  label: 'Label',
  priority: 'Priority',
  assignee: 'Assignee',
  project: 'Project',
  team: 'Team',
  from_status: 'From status',
}

/** Numeric action priority → display label (matches the app's priority enum). */
export const PRIORITY_LABELS: Record<string, string> = {
  '0': 'No priority',
  '1': 'Urgent',
  '2': 'High',
  '3': 'Medium',
  '4': 'Low',
}

let __seq = 0
function localId(prefix: string): string {
  // crypto.randomUUID when available; fall back to a counter for SSR safety.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  __seq += 1
  return `${prefix}-${__seq}`
}

export function newRule(): EditorRule {
  return { id: localId('rule'), field: 'label', op: 'in', value: [] }
}

function newCondition(): EditorCondition {
  return { enabled: false, match: 'all', rules: [] }
}

/** Matches the runner's save-time uuid check for run_skill skill_ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is an editor action complete enough to fire? Mirrors the runner's
 * isActionRunnable at the client level, per type: http_post needs a non-empty,
 * http(s)-parseable URL; run_skill needs a picked skill (uuid skill_id). An
 * incomplete action saves fine (it's a draft) but is flagged "needs setup" on
 * the canvas and skipped at fire time. Private-host rejection is a server-only
 * concern; here we only need the "has a usable target" signal.
 */
/** "owner/repo" — a single slash, non-empty owner + repo segments. */
const REPO_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/

export function isActionComplete(
  action: Pick<
    EditorAction,
    'type' | 'url' | 'skill_id' | 'agent_id' | 'repo' | 'use_triggering_action_context'
  > &
    Partial<Pick<EditorAction, 'connection' | 'tool' | 'stored_local_agent'>>,
): boolean {
  if (action.type === 'run_skill') return UUID_RE.test(action.skill_id)
  if (action.type === 'run_agent') {
    // Complete iff it inherits from the triggering action, OR it has both a
    // picked agent (uuid) and an "owner/repo". Mirrors the runner's
    // isActionRunnable for run_agent.
    if (action.use_triggering_action_context) return true
    return UUID_RE.test(action.agent_id) && REPO_FULL_NAME_RE.test(action.repo.trim())
  }
  // archive_capture has no config to complete — always runnable.
  if (action.type === 'archive_capture') return true
  // run_local_agent: a shared folder and a request (the runner's isActionRunnable).
  if (action.type === 'run_local_agent') return UUID_RE.test(action.stored_local_agent?.folder_id ?? '') && !!action.stored_local_agent?.request.trim()
  // call_tool: a picked connection and tool (the runner's isActionRunnable).
  if (action.type === 'call_tool') return UUID_RE.test(action.connection ?? '') && !!action.tool?.trim()
  const url = action.url.trim()
  if (!url) return false
  try {
    const p = new URL(url)
    return p.protocol === 'https:' || p.protocol === 'http:'
  } catch {
    return false
  }
}

export function newAction(parentId: string | null = null): EditorAction {
  return {
    id: localId('action'),
    type: 'http_post',
    parent_id: parentId,
    enabled: true,
    method: 'POST',
    url: '',
    headers: [],
    body_template: '{"text": "{{entity.name}} → {{entity.status}}"}',
    bearer_token: '',
    bearer_token_present: false,
    skill_id: '',
    mode: 'report',
    instructions: '',
    deliver_document: true,
    deliver_notification: true,
    stored_run_skill: null,
    agent_id: '',
    repo: '',
    agent_instructions: '',
    use_triggering_action_context: false,
    connection: '',
    tool: '',
    tool_input: '{}',
    stored_local_agent: null,
    condition: newCondition(),
  }
}

/** Editor defaults for every trigger kind (the flat superset shape). */
function newTrigger(): EditorTrigger {
  return {
    kind: 'entity_status_change',
    entity_type: 'action',
    from_status_id: '__any__',
    to_status_id: '',
    cadence: 'daily',
    time: '09:00',
    weekday: 1, // Monday
    timezone: defaultTimezone(),
    event_title: '',
    offset_minutes: -15, // fire 15 min before the meeting by default
    repo_full_name: '',
    pr_state: 'any',
    day_of_month: 1,
    cron: '0 9 * * 1-5', // weekdays at 9
    run_at: '',
    email_from: '',
    chat_channel_id: '',
    mentions_only: false,
  }
}

export function emptyEditor(): EditorState {
  return {
    id: null,
    name: '',
    description: '',
    team_id: '',
    enabled: true,
    trigger: newTrigger(),
    actions: [newAction()],
    canvas_layout: {},
    bot: null,
    botDirty: false,
    seed_key: null,
    botSummary: null,
    ownedBy: null,
  }
}

/** Ops that take a scalar (single) value vs a list. */
export const SCALAR_OPS: ConditionOp[] = ['is', 'is_not']
export const NULLARY_OPS: ConditionOp[] = ['is_set', 'is_not_set']

function conditionToEditor(condition: ConditionGroup | null): EditorCondition {
  if (!condition || !Array.isArray(condition.rules) || condition.rules.length === 0) {
    return newCondition()
  }
  return {
    enabled: true,
    match: condition.match === 'any' ? 'any' : 'all',
    rules: condition.rules.map((r) => ({
      id: localId('rule'),
      field: r.field,
      op: r.op,
      value: Array.isArray(r.value) ? r.value : typeof r.value === 'string' ? [r.value] : [],
    })),
  }
}

function actionToEditor(a: FlowActionPublic): EditorAction {
  const base = { ...newAction(a.parent_id ?? null), id: a.id, enabled: a.enabled !== false }
  if (a.type === 'run_agent') {
    const c = a.config as RunAgentActionConfig
    return {
      ...base,
      type: 'run_agent',
      agent_id: typeof c.agent_id === 'string' ? c.agent_id : '',
      repo: typeof c.repo === 'string' ? c.repo : '',
      agent_instructions: typeof c.instructions === 'string' ? c.instructions : '',
      use_triggering_action_context: c.use_triggering_action_context === true,
      condition: conditionToEditor(a.condition),
    }
  }
  if (a.type === 'archive_capture') {
    // No config fields to map — the flat editor defaults carry through.
    return { ...base, type: 'archive_capture', condition: conditionToEditor(a.condition) }
  }
  if (a.type === 'run_local_agent') {
    const c = a.config as RunLocalAgentActionConfig
    return {
      ...base,
      type: 'run_local_agent',
      stored_local_agent: {
        folder_id: typeof c.folder_id === 'string' ? c.folder_id : '',
        request: typeof c.request === 'string' ? c.request : '',
        ...(c.mode === 'edit' ? { mode: 'edit' as const } : {}),
      },
      condition: conditionToEditor(a.condition),
    }
  }
  if (a.type === 'call_tool') {
    const c = a.config as CallToolActionConfig
    return {
      ...base,
      type: 'call_tool',
      connection: typeof c.connection === 'string' ? c.connection : '',
      tool: typeof c.tool === 'string' ? c.tool : '',
      tool_input: JSON.stringify(c.input && typeof c.input === 'object' ? c.input : {}, null, 2),
      condition: conditionToEditor(a.condition),
    }
  }
  if (a.type === 'run_skill') {
    const c = a.config as RunSkillActionConfig
    return {
      ...base,
      type: 'run_skill',
      skill_id: typeof c.skill_id === 'string' ? c.skill_id : '',
      mode: c.mode === 'act' ? 'act' : 'report',
      instructions: c.instructions ?? '',
      deliver_document: c.deliver?.document !== false,
      deliver_notification: c.deliver?.notification !== false,
      stored_run_skill:
        typeof c.skill_id === 'string' && c.skill_id
          ? {
              skill_id: c.skill_id,
              mode: c.mode === 'act' ? 'act' : 'report',
              ...(typeof c.deliver?.document_title === 'string' ? { document_title: c.deliver.document_title } : {}),
              ...(c.deliver?.to
                ? {
                    connector: {
                      to: c.deliver.to,
                      ...(c.deliver.doc_key ? { doc_key: c.deliver.doc_key } : {}),
                      ...(c.deliver.surface ? { surface: c.deliver.surface } : {}),
                    },
                  }
                : {}),
              ...(c.trust && typeof c.trust === 'object' ? { trust: c.trust } : {}),
              ...(Array.isArray(c.connections) && c.connections.length ? { connections: c.connections } : {}),
            }
          : null,
      condition: conditionToEditor(a.condition),
    }
  }
  const c = a.config as HttpPostActionConfig
  return {
    ...base,
    type: 'http_post',
    method: c.method,
    url: c.url,
    headers: Object.entries(c.headers || {}).map(([k, v]) => ({ key: k, value: v })),
    body_template: c.body_template,
    bearer_token: '',
    bearer_token_present: a.bearer_token_present,
    condition: conditionToEditor(a.condition),
  }
}

/**
 * Normalize a stored canvas_layout, migrating a legacy single-action position
 * (under actions.__legacy__) onto the first action's id.
 */
function normalizeLayout(layout: CanvasLayout, actions: EditorAction[]): CanvasLayout {
  const out: CanvasLayout = { trigger: layout.trigger, actions: { ...(layout.actions || {}) } }
  if (out.actions && out.actions.__legacy__ && actions[0]) {
    if (!out.actions[actions[0].id]) out.actions[actions[0].id] = out.actions.__legacy__
    delete out.actions.__legacy__
  }
  return out
}

/**
 * Map a stored trigger onto the flat editor shape. The row-level trigger_type
 * is the authoritative discriminator (legacy configs carry no `kind`); fields
 * for the other kinds keep their editor defaults so switching type in the
 * panel starts from something sensible.
 */
function triggerToEditor(flow: Pick<Flow, 'trigger_type' | 'trigger_config'>): EditorTrigger {
  const base = newTrigger()
  if (flow.trigger_type === 'schedule') {
    const cfg = flow.trigger_config as Partial<ScheduleTriggerConfig>
    return {
      ...base,
      kind: 'schedule',
      cadence: cfg.cadence && cfg.cadence in CADENCE_LABELS ? cfg.cadence : base.cadence,
      time: typeof cfg.time === 'string' && cfg.time ? cfg.time : base.time,
      weekday:
        typeof cfg.weekday === 'number' && cfg.weekday >= 0 && cfg.weekday <= 6
          ? cfg.weekday
          : base.weekday,
      timezone: typeof cfg.timezone === 'string' && cfg.timezone ? cfg.timezone : base.timezone,
      day_of_month:
        typeof cfg.day_of_month === 'number' && cfg.day_of_month >= 1 && cfg.day_of_month <= 28
          ? cfg.day_of_month
          : base.day_of_month,
      cron: typeof cfg.cron === 'string' && cfg.cron ? cfg.cron : base.cron,
      run_at: typeof cfg.run_at === 'string' ? cfg.run_at : base.run_at,
    }
  }
  if (flow.trigger_type === 'email_received') {
    const cfg = flow.trigger_config as Partial<EmailReceivedTriggerConfig>
    return { ...base, kind: 'email_received', email_from: typeof cfg.from === 'string' ? cfg.from : '' }
  }
  if (flow.trigger_type === 'chat_message') {
    const cfg = flow.trigger_config as Partial<ChatMessageTriggerConfig>
    return {
      ...base,
      kind: 'chat_message',
      chat_channel_id: typeof cfg.channel_id === 'string' && cfg.channel_id ? cfg.channel_id : cfg.mentions_only ? ANY_CHANNEL : '',
      mentions_only: cfg.mentions_only === true,
    }
  }
  if (flow.trigger_type === 'document_created') {
    return { ...base, kind: 'document_created' }
  }
  if (flow.trigger_type === 'capture_processed') {
    return { ...base, kind: 'capture_processed' }
  }
  if (flow.trigger_type === 'pr_status_changed') {
    const cfg = flow.trigger_config as Partial<PrStatusChangedTriggerConfig>
    return {
      ...base,
      kind: 'pr_status_changed',
      repo_full_name: typeof cfg.repo_full_name === 'string' ? cfg.repo_full_name : '',
      pr_state: cfg.to_state && cfg.to_state in PR_STATE_LABELS ? cfg.to_state : 'any',
    }
  }
  if (flow.trigger_type === 'calendar_event') {
    const cfg = flow.trigger_config as Partial<CalendarEventTriggerConfig>
    return {
      ...base,
      kind: 'calendar_event',
      event_title: typeof cfg.event_title === 'string' ? cfg.event_title : '',
      offset_minutes:
        typeof cfg.offset_minutes === 'number' ? cfg.offset_minutes : base.offset_minutes,
    }
  }
  const cfg = flow.trigger_config as Partial<EntityStatusChangeTriggerConfig>
  return {
    ...base,
    kind: 'entity_status_change',
    entity_type: (cfg.entity_type ?? 'action') as FlowEntityType,
    from_status_id: cfg.from_status_id ?? '__any__',
    to_status_id: cfg.to_status_id ?? '',
  }
}

export function flowToEditor(flow: Flow): EditorState {
  const actions = flow.actions.length > 0 ? flow.actions.map(actionToEditor) : [newAction()]
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description ?? '',
    team_id: flow.team_id ?? '',
    enabled: flow.enabled,
    trigger: triggerToEditor(flow),
    actions,
    canvas_layout: normalizeLayout(flow.canvas_layout ?? {}, actions),
    bot: flow.ai_team_member_id ? { kind: 'teammate', id: flow.ai_team_member_id } : null,
    botDirty: false,
    seed_key: flow.seed_key ?? null,
    botSummary: flow.bot ?? null,
    // Only an explicit "not yours" makes it read-only: a read that predates the
    // ownership fields (or a list row) keeps today's editor.
    ownedBy: flow.viewer_is_owner === false ? { name: flow.owner?.name ?? 'someone else', requested: flow.takeover_pending === true } : null,
    savedOnce: savedOnceOf(flow),
  }
}

/**
 * The skills a loop's enabled run_skill actions run, each once: what the
 * default bot is suggested from (GET /api/account/flows/bots?skill_ids=).
 */
export function editorSkillIds(editor: Pick<EditorState, 'actions'>): string[] {
  const ids = new Set<string>()
  for (const a of editor.actions) if (a.type === 'run_skill' && a.enabled && a.skill_id) ids.add(a.skill_id)
  return [...ids]
}

/**
 * The editor's agent as a save sends it: the teammate's id, or `bot_new` and,
 * when the person typed one, the new agent's name. `bot_new` always makes a
 * new work agent (it never reuses a teammate); unnamed, the server names it
 * after the face it hands it.
 */
export function botPayload(bot: EditorBot): Record<string, unknown> {
  if (bot.kind === 'teammate') return { ai_team_member_id: bot.id }
  const name = bot.name.replace(/\s+/g, ' ').trim()
  return { bot_new: true, ...(name ? { bot_name: name } : {}) }
}

function conditionToConfig(condition: EditorCondition): ConditionGroup | null {
  if (!condition.enabled || condition.rules.length === 0) return null
  const rules: ConditionRule[] = []
  for (const r of condition.rules) {
    if (NULLARY_OPS.includes(r.op)) {
      rules.push({ field: r.field, op: r.op, value: null })
    } else if (SCALAR_OPS.includes(r.op)) {
      rules.push({ field: r.field, op: r.op, value: r.value[0] ?? '' })
    } else {
      rules.push({ field: r.field, op: r.op, value: r.value })
    }
  }
  return { match: condition.match, rules }
}

/**
 * Builds the request payload for POST/PATCH /api/account/flows. Returns a
 * validation error (with the offending action index, 1-based, when relevant)
 * or { payload }.
 */
/** 24h 'HH:mm' — matches the server-side schedule validator. */
const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** The cadences that run at a time of day. */
const SCHEDULE_TIMED: ScheduleCadence[] = ['daily', 'weekdays', 'weekly', 'monthly']

/** Serialize the editor trigger to the shape the per-type validators expect. */
function triggerToConfig(t: EditorTrigger): Record<string, unknown> {
  switch (t.kind) {
    case 'schedule':
      return {
        kind: 'schedule',
        cadence: t.cadence,
        ...(SCHEDULE_TIMED.includes(t.cadence) ? { time: t.time } : {}),
        ...(t.cadence === 'weekly' ? { weekday: t.weekday } : {}),
        ...(t.cadence === 'monthly' ? { day_of_month: t.day_of_month } : {}),
        ...(t.cadence === 'cron' ? { cron: t.cron.trim() } : {}),
        ...(t.cadence === 'once' ? { run_at: t.run_at } : {}),
        timezone: t.timezone.trim(),
      }
    case 'email_received':
      return { kind: 'email_received', ...(t.email_from.trim() ? { from: t.email_from.trim() } : {}) }
    case 'chat_message':
      return {
        kind: 'chat_message',
        channel_id: t.chat_channel_id && t.chat_channel_id !== ANY_CHANNEL ? t.chat_channel_id : null,
        mentions_only: t.mentions_only,
      }
    case 'document_created':
      return { kind: 'document_created' }
    case 'capture_processed':
      return { kind: 'capture_processed' }
    case 'pr_status_changed':
      return { kind: 'pr_status_changed', repo_full_name: t.repo_full_name.trim(), to_state: t.pr_state }
    case 'calendar_event':
      return {
        kind: 'calendar_event',
        event_title: t.event_title.trim(),
        offset_minutes: t.offset_minutes,
      }
    case 'entity_status_change':
      return {
        entity_type: t.entity_type,
        from_status_id: t.from_status_id === '__any__' ? null : t.from_status_id,
        to_status_id: t.to_status_id,
      }
  }
}

/** A call_tool step's input text as an object, or null when it isn't a JSON object. */
export function parseToolInput(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text.trim() || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The steps a step chains off (its parent, the parent's parent, …): the ones whose output it may use. */
export function ancestorSteps(actions: readonly EditorAction[], id: string): EditorAction[] {
  const byId = new Map(actions.map((a) => [a.id, a]))
  const out: EditorAction[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)?.parent_id ? byId.get(byId.get(id)!.parent_id!) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return out
}

export function buildSavePayload(editor: EditorState):
  | { error: string; actionIndex?: number; bot?: true }
  | { payload: Record<string, unknown> } {
  if (!editor.name.trim()) return { error: 'Name is required' }
  // Every loop has a bot: a saved loop whose bot was deleted asks for one. A
  // new loop with none picked yet gets the server's default.
  if (editor.id && !editor.bot) return { error: 'Pick an agent for this loop: its agent was removed', bot: true }
  // Someone else's loop (F1): only what a non-owner may change rides the save
  // (name, description, on/off, its agent, positions). The trigger and steps
  // stay as stored, unchecked here; the server refuses a change to them anyway
  // (NOT_FLOW_OWNER).
  if (editor.id && editor.ownedBy) {
    return {
      payload: {
        name: editor.name.trim(),
        description: editor.description || null,
        enabled: editor.enabled,
        canvas_layout: editor.canvas_layout,
        ...(editor.bot && editor.botDirty ? botPayload(editor.bot) : {}),
      },
    }
  }
  const t = editor.trigger
  // Only status-change flows are team-scoped; schedule / capture_processed
  // flows are workspace-scoped (the server stores team_id NULL).
  const isTeamScoped = t.kind === 'entity_status_change'
  if (isTeamScoped) {
    if (!editor.team_id) return { error: 'Team is required' }
    if (!t.to_status_id) return { error: 'Target status is required' }
  }
  if (t.kind === 'schedule') {
    if (SCHEDULE_TIMED.includes(t.cadence) && !SCHEDULE_TIME_RE.test(t.time)) {
      return { error: 'Schedule time is required' }
    }
    if (!t.timezone.trim()) return { error: 'Timezone is required' }
    if (t.cadence === 'monthly' && !(Number.isInteger(t.day_of_month) && t.day_of_month >= 1 && t.day_of_month <= 28)) {
      return { error: 'Pick a day of the month from 1 to 28' }
    }
    if (t.cadence === 'cron') {
      const checked = validateCronExpression(t.cron, t.timezone.trim())
      if (checked instanceof Error) return { error: `Custom schedule: ${checked.message}` }
    }
    if (t.cadence === 'once' && !t.run_at) return { error: 'Pick the date and time it runs' }
  }
  if (t.kind === 'chat_message' && !t.chat_channel_id) return { error: 'Pick a channel' }
  if (t.kind === 'chat_message' && t.chat_channel_id === ANY_CHANNEL && !t.mentions_only) {
    return { error: 'Pick a channel, or turn on “Only when I’m @mentioned” to watch every channel' }
  }
  if (t.kind === 'pr_status_changed' && !/^[^/\s]+\/[^/\s]+$/.test(t.repo_full_name.trim())) {
    return { error: 'Repository is required, as owner/repo' }
  }
  if (t.kind === 'calendar_event') {
    if (!t.event_title.trim()) return { error: 'Event title is required' }
    if (
      !Number.isInteger(t.offset_minutes) ||
      t.offset_minutes < -1440 ||
      t.offset_minutes > 1440
    ) {
      return { error: 'Offset must be a whole number of minutes within a day (±1440)' }
    }
  }
  if (editor.actions.length === 0) return { error: 'Add at least one action' }
  // A call_tool's input must be a JSON object (it is checked against the app's own schema on save).
  for (let i = 0; i < editor.actions.length; i++) {
    const a = editor.actions[i]
    if (a.type === 'call_tool' && parseToolInput(a.tool_input) === null) {
      return { error: `Action ${i + 1}: the input must be a JSON object`, actionIndex: i }
    }
  }

  // Saving never blocks on an incomplete action — a missing URL / unpicked
  // skill just means the action is a draft (it's skipped at fire time, flagged
  // "needs setup" on the canvas). We only reject a genuinely malformed
  // CONDITION (a rule with no value), since that's an editing mistake, not an
  // intentional draft state.
  for (let i = 0; i < editor.actions.length; i++) {
    const a = editor.actions[i]
    if (a.condition.enabled) {
      for (const r of a.condition.rules) {
        if (!NULLARY_OPS.includes(r.op) && r.value.length === 0) {
          return { error: `Action ${i + 1}: a condition rule is missing a value`, actionIndex: i }
        }
      }
    }
  }

  const actions = editor.actions.map((a) => {
    if (a.type === 'run_local_agent') {
      return {
        id: a.id,
        type: 'run_local_agent',
        parent_id: a.parent_id ?? null,
        enabled: a.enabled,
        config: a.stored_local_agent ?? { folder_id: '', request: '' },
        condition: conditionToConfig(a.condition),
      }
    }
    if (a.type === 'run_agent') {
      return {
        id: a.id,
        type: 'run_agent',
        parent_id: a.parent_id ?? null,
        enabled: a.enabled,
        config: {
          agent_id: a.agent_id,
          repo: a.repo.trim(),
          ...(a.agent_instructions.trim() ? { instructions: a.agent_instructions } : {}),
          ...(a.use_triggering_action_context ? { use_triggering_action_context: true } : {}),
        },
        condition: conditionToConfig(a.condition),
      }
    }
    if (a.type === 'run_skill') {
      // What the editor can't show (a report title, a verdict skill's trust)
      // rides through from the stored action for the same skill. Moved from
      // report into act, a carried trust never auto-applies (the chat tools'
      // rule: no switching auto-apply on through the back door).
      const kept = a.stored_run_skill && a.stored_run_skill.skill_id === a.skill_id ? a.stored_run_skill : null
      const trust = kept?.trust
        ? kept.mode !== 'act' && a.mode === 'act'
          ? { ...kept.trust, auto_apply: false }
          : kept.trust
        : undefined
      return {
        id: a.id,
        type: 'run_skill',
        parent_id: a.parent_id ?? null,
        enabled: a.enabled,
        config: {
          skill_id: a.skill_id,
          mode: a.mode,
          ...(a.instructions.trim() ? { instructions: a.instructions } : {}),
          deliver: {
            document: a.deliver_document,
            notification: a.deliver_notification,
            ...(kept?.document_title !== undefined ? { document_title: kept.document_title } : {}),
            // The output connector set in chat (F3) rides a save untouched.
            ...(kept?.connector ?? {}),
          },
          ...(trust ? { trust } : {}),
          // The connected apps set in chat (F4) ride a save untouched.
          ...(kept?.connections?.length ? { connections: kept.connections } : {}),
        },
        condition: conditionToConfig(a.condition),
      }
    }
    if (a.type === 'call_tool') {
      return {
        id: a.id,
        type: 'call_tool',
        parent_id: a.parent_id ?? null,
        enabled: a.enabled,
        config: { connection: a.connection, tool: a.tool.trim(), input: parseToolInput(a.tool_input) ?? {} },
        condition: conditionToConfig(a.condition),
      }
    }
    if (a.type === 'archive_capture') {
      return {
        id: a.id,
        type: 'archive_capture',
        parent_id: a.parent_id ?? null,
        enabled: a.enabled,
        config: {},
        condition: conditionToConfig(a.condition),
      }
    }
    return {
      id: a.id,
      type: 'http_post',
      parent_id: a.parent_id ?? null,
      enabled: a.enabled,
      config: {
        method: a.method,
        url: a.url.trim(),
        headers: Object.fromEntries(
          a.headers.filter((h) => h.key.trim() && h.value.trim()).map((h) => [h.key.trim(), h.value]),
        ),
        body_template: a.body_template,
      },
      condition: conditionToConfig(a.condition),
      // Only send bearer_token if the user typed something. Omitting = leave
      // the stored token alone (matched by id on the server).
      ...(a.bearer_token ? { bearer_token: a.bearer_token } : {}),
    }
  })

  const payload: Record<string, unknown> = {
    name: editor.name.trim(),
    description: editor.description || null,
    // Workspace-scoped triggers must not carry a team — the server stores NULL.
    ...(isTeamScoped ? { team_id: editor.team_id } : {}),
    enabled: editor.enabled,
    trigger_type: t.kind,
    trigger_config: triggerToConfig(t),
    actions,
    canvas_layout: editor.canvas_layout,
    // Its bot: always on a create (when one is picked), and on an edit only
    // when the person changed it (a seeded loop's stays its own).
    ...(editor.bot && (!editor.id || editor.botDirty) ? botPayload(editor.bot) : {}),
  }
  return { payload }
}
