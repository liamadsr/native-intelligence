/**
 * Shared contracts for generalized agent runs (Loops v3 work proposals —
 * docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * `agent_run` carries two kinds of run since migration 197:
 *   - 'coding'    — a sandboxed coding run on the eve coding agent (repo → PR).
 *   - 'workspace' — an approved piece of workspace WORK (draft an email,
 *                   prepare a doc, update the board) executed as a durable eve
 *                   task session on the work-agent mount.
 *
 * These types are the single source of truth for the jsonb columns Postgres
 * only shape-checks (deliverables / resources are `jsonb_typeof = 'array'`
 * constrained; the element shape is enforced here and at the write sites).
 */

import {
  LINKABLE_ENTITY_TYPES,
  type LinkableEntityType,
} from '@/lib/knowledge/entity-registry'
import type { WorkExpectation, WorkRole } from '@/lib/work/roles'
import { TOOL_CATEGORIES, WORK_RUN_ADMITTED_SIDE_EFFECTS, isChatNativeTool } from '@/lib/ai/tool-registry'
import { attendedOnlyToolsDeniedTo } from '@/lib/safety/caller'

export type AgentRunKind = 'coding' | 'workspace'

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'canceling'
  | 'pr_open'
  | 'completed'
  | 'failed'
  | 'canceled'

/**
 * The ONE declaration of run-status liveness — the single source of truth that
 * kills the ~13-site duplication (docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md
 * §"Status vocabulary"). Every inline TERMINAL/LIVE array, the duplicate union in
 * agent-run-ui.tsx, `toWorkRunStatus` / `isLiveWork` / `WORK_LIVE_STATUSES`, and
 * `isLive`/`isCancelable`/`STATUS_META` re-point HERE. Importing these constants
 * is the fix, not adding an eighth copy.
 *
 * TERMINAL = the run is settled and will not change again: no more polling, no
 * cancel. LIVE = the run is in flight (queued waiting to start, running, parked on
 * a question, or being canceled) — poll it, and it's cancelable. `pr_open` is a
 * terminal coding outcome (the PR is up), NOT live.
 */
export const AGENT_RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'canceled',
  'pr_open',
] as const

export const AGENT_RUN_LIVE_STATUSES = [
  'queued',
  'running',
  'needs_input',
  'canceling',
] as const

/** True when a run is still in flight (poll it; it's cancelable). */
export function isAgentRunLive(status: string): boolean {
  return (AGENT_RUN_LIVE_STATUSES as readonly string[]).includes(status)
}

/** True when a run is settled and will not change again (stop polling). */
export function isAgentRunTerminal(status: string): boolean {
  return (AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/**
 * One clarifying question the work agent asked mid-run — the QuestionPicker shape
 * (identical to src/lib/ai/tools/ask-user.ts's per-question schema), carried
 * verbatim inside `pending_input.questions` so the existing picker renders it
 * unchanged.
 */
export interface WorkRunQuestion {
  question: string
  header: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/**
 * `agent_run.pending_input` — present iff `status='needs_input'`. Written by the
 * dispatcher at a `request_user_input` park; cleared on resume. `requestId` +
 * `approveOptionId` / `denyOptionId` are the eve HITL facts the resume driver
 * echoes back to resolve the approval (never a hardcoded literal — the ids come
 * off the request's own options). NOTE the FIELD name `denyOptionId` is a
 * persisted `pending_input` JSONB key and stays as-is for in-flight rows; its
 * VALUE is eve's current negative verb, which 0.32.0 renamed 'deny' → 'cancel'
 * (0.47.7 emits [{id:'approve'},{id:'cancel'}]). `questions` is the picker
 * renders. NOTE: `session_state` (the resume token) is a SEPARATE, server-only
 * column — pending_input is safe to return to the client; session_state is not.
 */
export interface PendingInput {
  requestId: string
  approveOptionId: string
  denyOptionId: string
  questions: WorkRunQuestion[]
  /** ISO timestamp the question was asked. */
  askedAt: string
  /**
   * Other approvals in the same eve batch that the resume must answer with the
   * question, or eve never resolves the batch: a `delegate_work` called in the
   * same step as the question, refused (ASK_FIRST) and approved so its execute
   * returns the refusal.
   */
  companionResponses?: Array<{ requestId: string; optionId: string }>
}

/**
 * Why a handoff was refused (Part 3.2). The refusal is the parent's tool result,
 * so the model decides what to do without the child; the would-be child is a
 * `skipped` ledger row.
 */
export type DelegationRefusalCode =
  | 'DELEGATION_DEPTH'
  | 'DELEGATION_FAN_OUT'
  | 'ROOT_BUDGET'
  | 'DELEGATION_NOT_ALLOWED'
  | 'DELEGATION_ROLE_UNSUPPORTED'
  | 'NO_TEAMMATE_FOR_ROLE'
  | 'TEAMMATE_CANNOT_DRAFT'
  | 'USAGE_LIMIT'
  | 'AUTONOMY_OFF'
  | 'POLICY_UNAVAILABLE'
  | 'ASK_FIRST'
  | 'INVALID_BRIEF'
  | 'CHILD_START_FAILED'

/** One `delegate_work` call in a delegation park: the eve approval it resolves
 *  and what became of it. */
export interface DelegationParkEntry {
  /** eve's approval request id — answered (approve) at the release. */
  requestId: string
  /** The tool call id: the child's fire_key / ledger run_key suffix, and what
   *  the tool's execute looks its result up by. */
  callId: string
  approveOptionId: string
  role: string
  /** The child run, or null when the handoff was refused. */
  childRunId: string | null
  refused?: { code: DelegationRefusalCode; reason: string }
}

/**
 * `agent_run.pending_input` while a run waits on the teammates it handed work
 * to (status `needs_input`, like a question park; its ledger row is
 * `waiting_on_child`). Released by work/run.child_settled once every child is
 * terminal: the parent's approvals are answered and each `delegate_work`
 * execute fetches its child's result as its own tool result. A person can
 * never answer it (the respond route refuses `kind: 'delegation'`).
 */
export interface DelegationPark {
  kind: 'delegation'
  children: DelegationParkEntry[]
  /** ISO timestamp the handoff happened. */
  askedAt: string
}

/** Is this pending_input a delegation park (and not a question)? */
export function isDelegationPark(v: unknown): v is DelegationPark {
  return !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'delegation' && Array.isArray((v as { children?: unknown }).children)
}

/**
 * `agent_run.session_state` — the eve resume + replay handle for a run's durable
 * conversation session. Written at EVERY park (question park, post-settle park,
 * each post-follow-up-turn park).
 *
 * eve 0.31.0 REMOVED continuation tokens: a session is addressed purely by its id,
 * and authority comes from the Client's own auth/header cascade. What remains are
 * an identity and two cursors, which must never be conflated (the
 * frozen-vs-advancing streamIndex bug):
 *
 *   - `sessionId` — the durable eve session id. The whole address. Mirrors the
 *     `eve:<id>` value on `sandbox_id`; carried here too so a snapshot is
 *     self-sufficient.
 *   - `streamIndex` — the ADVANCING read cursor. What
 *     `client.sessions.attach(id, { streamIndex })` resumes STREAMING from, so a
 *     follow-up POST streams only the NEW turn's events. Advances every turn;
 *     freezing it makes each follow-up POST replay the prior turn.
 *   - `settleStreamIndex` — the FROZEN transcript boundary. Stamped exactly ONCE when
 *     the run reaches a terminal park (the classifier's case-2 / case-3 parks). GET
 *     replay starts from HERE so a reload reconstructs the full follow-up transcript.
 *     Every later persist PRESERVES it (never re-derives / re-advances it).
 *
 * LEGACY ROWS: blobs written before the 0.31.0 upgrade carry a `continuationToken`
 * and no `sessionId`. They are NOT resumable — `parseConversationSnapshot()` in
 * src/lib/eve/conversation-session.ts returns null for them and callers degrade
 * into their existing "no session to continue" path. No migration is performed.
 *
 * SERVER-ONLY: NEVER return it from any account API route (the run-detail route
 * strips it; the interaction routes read it server-side to mint the resume turn).
 */
export interface SessionStateSnapshot {
  sessionId: string
  streamIndex: number
  /**
   * The frozen follow-up-transcript boundary, stamped exactly once at the terminal
   * park (classifier case 2 / case 3). Absent until the run settles; once set, it
   * is preserved by every subsequent persist. GET /chat replay reads from here.
   */
  settleStreamIndex?: number
}

/**
 * One answer to one work-run question, submitted by the user from the run
 * drill-in. `question` matches a `PendingInput.questions[i].question`; `answer`
 * is the chosen label(s) rendered as a single string (multi-select joined). The
 * resume driver formats these into the follow-up `message` the model reads (eve
 * discards text on an approval response, so the answers ride as the message).
 */
export interface AskUserAnswer {
  question: string
  answer: string
}

/**
 * One reviewable artifact a work run produced, written at settle time onto
 * `agent_run.deliverables`. `entity_type` qualifies type 'entity' (e.g. a
 * contact the run updated); the first three get first-class link treatment in
 * the run-detail UI.
 */
export interface WorkDeliverable {
  type: 'email_draft' | 'document' | 'action' | 'entity'
  id: string
  label: string
  entity_type?: string
}

/**
 * Every resource type a work proposal may declare: the linkable entity types
 * plus 'package'. This used to be a hand-copied duplicate of
 * LINKABLE_ENTITY_TYPES kept honest by a parity test, because this module is
 * client-bundled and the vocabulary lived in server code (claims.ts, which
 * pulls in Supabase + Inngest + embeddings). The registry it now imports is
 * plain data with zero imports, so the copy — and the reason for it — is gone.
 */
export type WorkResourceType = LinkableEntityType | 'package'
export const WORK_RESOURCE_TYPES: readonly [WorkResourceType, ...WorkResourceType[]] = [
  ...LINKABLE_ENTITY_TYPES,
  'package',
]

/**
 * A declared resource the work will draw on — snapshotted from the approval
 * card's payload onto `agent_run.resources` at Start. `type` is one of
 * `WORK_RESOURCE_TYPES` (the LINKABLE_ENTITY_TYPES plus 'package'), but stays
 * typed as `string` because it is model-authored data — an unknown type must
 * round-trip without a compile error (the Start route drops its id, keeps the
 * label). `id` is optional: a label-only reference is valid.
 */
export interface WorkResourceRef {
  type: string
  id?: string
  label: string
}

/**
 * The `attention_item.payload` shape for kind 'work_proposal'. Written by
 * verdict-apply (server-clamped: task ≤4000, title ≤200, resources ≤8 with
 * labels ≤80) and read by the card UI and the Start route.
 */
export interface WorkProposalPayload {
  /** Self-contained instructions for the executor. */
  task: string
  deliverable_hint?: 'email_draft' | 'document' | 'board_update' | 'mixed'
  resources?: WorkResourceRef[]
  /**
   * WHO should do it — a teammate role from WORK_ROLES (src/lib/work/roles.ts).
   * Absent = not routable: the auto-attempt gate (B PR 3) never attempts it.
   */
  role?: WorkRole
  /** WHAT it must produce — validated against the run's deliverables at settle (step 13). */
  expects?: WorkExpectation[]
  // Provenance (same fields other card kinds carry):
  skill_name?: string
  capture_id?: string
  capture_title?: string
  confidence?: number
  // Email-flavored work:
  email_to_name?: string
  email_to_address?: string
}

/** Server-side clamps for work-proposal payloads (enforced in verdict-apply). */
export const WORK_TASK_MAX_CHARS = 4000
export const WORK_TITLE_MAX_CHARS = 200
export const WORK_RESOURCES_MAX = 8
export const WORK_RESOURCE_LABEL_MAX_CHARS = 80

/**
 * THE WORK-RUN TOOL CEILING IS STRUCTURAL (SYNTHESIS.md WS-3c Fix item 3).
 *
 * Every registry entry (TOOL_CATEGORIES in @/lib/ai/tool-registry) carries a
 * REQUIRED `sideEffect` classification, judged from the tool's implementation:
 * 'read' | 'internal-write' | 'external-write' | 'automation-write' | 'delete'
 * (see ToolSideEffect there for the definitions). A work run holds exactly the
 * registry tools whose class is in WORK_RUN_ADMITTED_SIDE_EFFECTS — read and
 * internal-write — and nothing else. A new registry entry does not compile
 * until it is classified, and it only enters the ceiling if it is classified
 * as a read or an internal write. There is no hand-kept list to forget.
 *
 * WORK_RUN_EXCLUDED_TOOLS below is DERIVED from the registry: every tool that
 * has at least one entry outside the admitted classes (so an unknown class
 * string, or a duplicate name with any non-admitted entry, fails closed). It is
 * the complement of computeWorkRunCeiling() over the registry and exists so the
 * route, the spec rebuild and the tests have a name to point at.
 *
 * computeWorkRunCeiling() (./run-work-spec-rebuild.ts) is the single source for
 * both the eve spec-rebuild (what to advertise) and the internal tool route
 * (what to enforce), so the two can never drift. Kept as bare tool names — a
 * Set membership test is prototype-pollution-safe (a name like '__proto__' is
 * a plain key).
 *
 * Why the non-admitted classes are out, with the tools that carried each lesson
 * (before this was structural, a hand-kept list of these names drifted four
 * times: calendar event writes; publish_prospect_list and the push_action_to_*
 * trio; the flow and sequence edit tools; update_skill / create_skill /
 * accept_proposal):
 *   - external-write — a work run produces DRAFTS, never fires something into
 *     the world. `publish_prospect_list` turns a curated list into real CRM
 *     companies/contacts (taxonomy's publish rule; the one prospecting tool
 *     that writes the CRM — `save_prospect_entries`, curation only, stays IN). `push_action_to_asana` / `_jira` / `_linear` create a
 *     real, externally visible task/issue in a connected tracker.
 *     `create_calendar_event` / `update_calendar_event` write the provider
 *     event, which reaches every attendee: Graph (`POST /me/events`) emails
 *     them unconditionally; on Google they land as guests on the event, but
 *     the code passes no `sendUpdates` (src/lib/integrations/calendar.ts), so
 *     Google sends no invitation email by default. Email DRAFT tools
 *     (`create_email_draft`, `draft_followup_email`, `generate_email_drafts`)
 *     are internal-write: they save provider drafts and never send.
 *   - automation-write — tools that build, re-aim or execute automations.
 *     `create_flow` / `update_flow` build or re-point a flow whose http_post
 *     fires POST/PUT/PATCH at a URL the caller picks (with a stored bearer
 *     token; chat's tools save a webhook loop off until the person's
 *     verified card, and they are attended only, ATTENDED_ONLY_TOOL_NAMES),
 *     and `update_action` / `complete_action` (IN) emit
 *     the status change that fires them. `update_sequence` can resume a paused,
 *     launched sequence (auto_send survives a pause, so the dispatch cron sends
 *     again) and rewrite unsent step copy; `create_sequence` (a draft),
 *     `enroll_contacts_in_sequence` (staged inert: next_send_at NULL until the
 *     user launches, even into a launched sequence) and `remove_from_sequence`
 *     (can only reduce mail) stay IN. `update_skill` rewrites a skill's
 *     system_prompt and agent_config, and an act-mode `run_skill` flow runs that
 *     skill on its OWN ceiling (computeSkillCeiling → computeToolCeiling, which
 *     does not subtract this list); `create_skill` also accepts
 *     visibility:'public' (Discover, every Dial8 tenant). (Whether a caller may
 *     publish to Discover at all is a separate role gate, canPublishPublic,
 *     applied by the HTTP routes, MCP and chat's skill tools alike. Both skill
 *     tools are attended only besides, ATTENDED_ONLY_TOOL_NAMES.) `accept_proposal` hands staged
 *     proposals to the apply engine, whose handlers include `mcp_call:external`
 *     (a real call to a connected MCP server as the run-as user) and
 *     `delete:action`; auto-apply-gate.ts stages those for a HUMAN.
 *     `dismiss_proposal` stays IN. `start_eval_run` replays every case × trial
 *     through the live-agent route and bills judge-model calls. `sync_calendar`
 *     runs the calendar→capture sync job (bulk CRM contacts for every external
 *     attendee over the next 7 days, pending captures); it makes no provider
 *     write, and an unattended run has no reason to trigger it. There is no
 *     direct registry tool for an external MCP call; `accept_proposal` was the
 *     one registry path to it.
 *   - delete — irreversible destruction is out of scope for an autonomous run:
 *     every delete_* tool, and the link/pin removals (`unlink_entities`,
 *     `unlink_document_from_action`, `remove_from_package`) whose code is a hard
 *     DELETE. `publish_draft` is here too: its "publish" is in-app wiki state
 *     only (nothing leaves the DB), but it hard-deletes the run-as user's
 *     document_draft row and delete-reinserts entity_link rows, consuming a
 *     human's pending draft past the review gate propose_document_edit relies
 *     on.
 *   Read calendar tools (`get_calendar_events`, `get_upcoming_meetings`,
 *   `get_meeting_prep`) and internal-only `create_capture_from_event` (reads
 *   the provider, writes a workspace capture, emails no one) stay IN.
 *
 * FLOW FIRES FROM THE RUN'S OWN CHANGES — the other half of the automation hop.
 * `update_action` / `complete_action` / `create_actions_batch` stay IN (moving
 * board items is the work), and each emits the status change that fires a
 * flow. A flow's act-mode `run_skill` then runs on the skill's own ceiling,
 * reading the action text the run wrote, and `run_agent` opens a PR from it.
 * That hop is OPEN on this branch: the work-run trigger-origin marker that makes
 * the dispatcher skip act-mode run_skill and every run_agent for a work-run fire
 * lives on the separate hardening branch (claude/security-hardening-from-ws3c),
 * not here. (Dropping a flow action's stored bearer token when its URL moves to
 * a new host is on that branch too.)
 *
 * OPEN — needs Liam's product call: configured mirrors. NOT YET DECIDED; the
 * current code is the proposal below, written down so the trade-off is visible,
 * not approved. Some in-ceiling internal writes fan out to systems the
 * WORKSPACE ALREADY WIRED UP, via Inngest, not via the tool: `create_contact` →
 * `crm/hubspot-push-contact` (only when the workspace opted into
 * push_contacts_to_hubspot); `update_action` / `complete_action` → the
 * Asana/Jira/Linear status echo (only for an action a user already pushed);
 * those two and `create_actions_batch` → any flow the user already built on
 * that status change. The trade-off: MODEL-AUTHORED CONTENT does reach those
 * systems — the contact's name/email/company land in HubSpot, and a
 * status-change flow's http_post renders {{action.title}} /
 * {{action.description}} into its body for an endpoint the user configured.
 * What the run can NOT do is choose a new recipient, host, credential, or
 * automation: every tool that could CREATE or RE-AIM an outbound path or an
 * automation's instructions is classified outside the ceiling (above). (It CAN
 * still fire an existing act-mode skill or agent run through a flow on this
 * branch — see FLOW FIRES above.) Withholding the mirrors themselves would mean
 * withholding contacts and board updates, which is the work itself. If the
 * answer is no, the fix is a work-run origin marker threaded through
 * emitStatusChange and the create_contact HubSpot send (the hardening branch's
 * flows/trigger-origin.ts is that marker for flow fires), not reclassifying
 * those tools.
 *
 * OPEN — needs Liam's product call: web_fetch egress. NOT YET DECIDED. Liam's
 * decision is that web access is on for every Dial8 agent; nobody has decided
 * that the exfiltration channel below is acceptable. The work-agent's live
 * `web_fetch` (agents/work-agent/tools/web_fetch.ts) GETs any public https URL
 * the model picks. SSRF is covered (url-guard + eve's per-hop public-IP DNS
 * check) and a per-session cap bounds volume, but nothing constrains the
 * destination host or what goes into the path/query. So a run steered by
 * injected text in something it reads (an inbound email, a transcript, a fetched
 * page) could put workspace data into a URL it fetches. Stripping query strings
 * would not close this (the path carries data just as well) and would break
 * ordinary reads. This is NOT a tool-ceiling property (web_fetch is an eve
 * tool, not a registry tool) and the ceiling does not claim to cover it; the
 * options if the answer is no are a host allowlist (e.g. only hosts returned by
 * web_search this session) or disabling web_fetch for briefs with no web
 * resources.
 *
 * Residual, by design: data a work run writes is read LATER by anything that
 * reads the workspace (a scheduled act-mode skill, a teammate's chat). That is
 * the same prompt-injection surface as any inbound email or transcript and is
 * not something a work-run ceiling can close.
 *
 * Second net: __tests__/work-run-ceiling-guard.test.ts cross-checks the
 * classification against a text heuristic (names, descriptions, input schemas
 * that SAY send / publish / push / outbound HTTP / external write). A tool the
 * heuristic flags must be classified outside the ceiling, or be listed there as
 * reviewed with a reason. The classification, not the heuristic, is the fence.
 */
export const WORK_RUN_EXCLUDED_TOOLS: readonly string[] = /*#__PURE__*/ deriveWorkRunExcludedTools()

/**
 * The DRAFTING profile's exclusions (Sequence step 2, plan A.3): everything the
 * work-run ceiling excludes PLUS every internal write that is not on an
 * artifact — board moves, CRM edits, `archive_capture`. An attempted run
 * (B PR 3 picks this profile by the run's origin) produces documents, drafts
 * and proposals; it never re-plans the board. Derived from the classification
 * like WORK_RUN_EXCLUDED_TOOLS, so an entry whose writeTarget is missing or
 * unknown is excluded, never admitted.
 */
export const DRAFTING_EXCLUDED_TOOLS: readonly string[] = /*#__PURE__*/ deriveDraftingExcludedTools()

function deriveDraftingExcludedTools(): readonly string[] {
  const excluded = new Set<string>(WORK_RUN_EXCLUDED_TOOLS)
  for (const category of TOOL_CATEGORIES) {
    for (const tool of category.tools) {
      if (tool.sideEffect === 'internal-write' && tool.writeTarget !== 'artifact') excluded.add(tool.name)
    }
  }
  return Object.freeze([...excluded])
}

function deriveWorkRunExcludedTools(): readonly string[] {
  const excluded = new Set<string>()
  // A work run's own turns are unattended (caller.ts): the attended-only tools
  // the trust authority denies that class.
  const attendedOnly = new Set(attendedOnlyToolsDeniedTo('agent_unattended'))
  for (const category of TOOL_CATEGORIES) {
    for (const tool of category.tools) {
      // Set membership on a runtime string: an unknown class (a cast, drifted
      // data) is simply not admitted, so the tool is excluded.
      if (!WORK_RUN_ADMITTED_SIDE_EFFECTS.has(tool.sideEffect)) excluded.add(tool.name)
      // An attended-only tool (bots v3 Phase 5: revise_email_draft is an
      // internal write) is out whatever its class: a work run is unattended.
      // Its follow-up chat may hold one its bot is granted (follow-through.ts).
      if (attendedOnly.has(tool.name)) excluded.add(tool.name)
      // A chat-native tool (start_helper, stop_helper, and the main agent's relay:
      // send_bot_message, wait_for_bot_reply; bots-v4 Phase A3) is out whatever
      // its class: only the main chat runs it. wait_for_bot_reply is a read, so
      // the class alone would let it reach work runs and their chats.
      if (isChatNativeTool(tool.name)) excluded.add(tool.name)
    }
  }
  return Object.freeze([...excluded])
}
