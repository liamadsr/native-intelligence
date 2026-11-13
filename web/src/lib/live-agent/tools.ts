import { tool } from 'ai'
import { CALL_CAPTURE_CHANGE_REFUSAL, callCaptureChangeAllowed } from './call-capture-fence'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { namespacedToolName } from '@/lib/mcp-client/adapter'
import { embed } from '@/lib/ai/embeddings'
import { attachClaimProvenance } from '@/lib/ai/claim-provenance'
import { dedupeRequesterFor } from '@/lib/knowledge/claim-visibility'
import { resolvePersonForCapture } from '@/lib/live-agent/speaker-resolution'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import {
  resolveClaimsAutoAcceptPolicy,
  shouldAutoAccept,
  type AutoAcceptPolicy,
} from '@/lib/knowledge/auto-accept'
import {
  updateAppliedEntity,
  deleteAppliedEntity,
} from '@/lib/proposed-changes/apply-engine'
import { resolveActionTarget } from '@/lib/proposed-changes/resolve-action-target'
import {
  HANDLED_COMBOS,
  canApplyChange,
  normalizeProposedChange,
} from '@/lib/proposed-changes/appliable-combos'
import { calibratePriority, calibrateDueDate, type Priority } from '@/lib/live-agent/calibrate-proposal'
import { isUntitledCapture } from '@/lib/live-agent/capture-groom'
import { broadcastNudge, type NudgeKind } from '@/lib/live-agent/nudge-channel'
import { appendAgentMessage, hasPendingLiveQuestion } from '@/lib/live-agent/conversation-writer'
import { trackServerEvent } from '@/lib/posthog'
import { LIVE_DIRECTIVE_MAX_CHARS, checkDirectiveTarget, insertDirective } from '@/lib/live-agent/directives'
import { isMcpToolHidden } from '@/lib/mcp-client/tool-access'
import { loadCallPlaybooks, matchCallPlaybook, saveActivePlaybookName } from '@/lib/live-agent/call-playbooks'

// Cosine-similarity floor above which a new commitment is treated as a
// restatement of an existing claim. Matches DEDUPE_THRESHOLD in
// src/lib/inngest/claim-extraction.ts so both ingestion paths agree on what
// counts as "the same claim".
const COMMITMENT_DEDUPE_THRESHOLD = 0.92

/**
 * Extraction-time calibration guardrail master switch (GEN-138). When true
 * (default), propose_change calibrates inflated priority / fabricated due dates
 * on create:action proposals before staging. One edit to disable if a heuristic
 * misbehaves. See docs/loop-engine/EXTRACTION-GUARDRAIL-DESIGN.md.
 *
 * NOTE: proposal DEDUP (the original GEN-137 half) was pulled — reusing the
 * fuzzy title matcher for identity at staging time silently folded distinct
 * tasks. Dedup lives in the Triage loop, which has cross-capture context and a
 * review gate. This flag now governs calibration only.
 */
const EXTRACTION_GUARDRAIL_ENABLED = true

/** Per-tool-set switches. An options OBJECT rather than a tenth positional
 *  boolean — the signature is already nine deep and a bare `true` at the end of
 *  a call site says nothing about what it turns on. */
export interface LiveAgentToolOptions {
  /**
   * This tool set is running against an EVAL capture (`captures.is_eval`,
   * migration 252) — a synthetic mock meeting driven by an Evals run.
   *
   * Only `record_commitment` changes: it returns a synthetic success BEFORE the
   * `match_claims` dedupe call, so no `claim`, `claim_chunks`, or provenance row
   * is ever written for a mock call. Everything else — propose_change and the
   * summary writers — stays live, because those write to the eval capture's OWN
   * `proposed_change` / `captures` rows, which is exactly what a trial grades
   * (the auto-apply gate then runs in 'report' mode at the route, so nothing
   * reaches the board).
   *
   * Claims are SUPPRESSED rather than tagged because `public.claim` has no
   * metadata column, and the dedupe runs BEFORE the insert — a ≥0.92 cosine
   * match would attach a mock call's provenance to a real, existing claim. The
   * gradeable signal ("did the agent detect the commitment") lives in the tool
   * CALL, which the eval trace already records.
   */
  isEvalCapture?: boolean
  /**
   * This tool set writes a call's capture (./call-capture-fence.ts): its words
   * are anyone's in the call, and its notes everyone's in the conversation.
   * propose_change then stages only new action items, decisions and
   * milestones; any other change (an update, an assignment, a delete, an
   * email draft, a CRM contact) is refused as a normal tool result.
   */
  callCapture?: boolean
}

/** search_contacts returns at most this many (visible) contacts. */
export const SEARCH_CONTACTS_LIMIT = 5
/**
 * How many times the limit search_contacts fetches before the visibility fence
 * (one contact_visible_to RPC per fetched row, so the over-fetch stays small).
 */
export const SEARCH_CONTACTS_OVERFETCH = 3

/**
 * Creates the tool set for the live meeting agent.
 * The primary tool is `propose_change` — instead of directly mutating entities,
 * the agent stages all changes in the proposed_change table for user review.
 *
 * `record_commitment` is the user-scoped counterpart: when SOMEONE ELSE commits
 * to a task, it's filed as a claim ("<name> committed to …") in the knowledge
 * graph rather than staged as an action item in the current user's queue.
 *
 * The agent also has read-only access to workspace data (projects, contacts, etc.)
 * for context gathering.
 *
 * `currentMemberId` / `currentMemberName` identify the user the agent assists —
 * used to attribute commitments and (in the route) to auto-apply only the
 * user's own high-confidence action items.
 */
export function createLiveAgentTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  captureId: string,
  teamId: string | null,
  projectId: string | null,
  currentMemberId: string | null = null,
  // Reserved: the route uses the member NAME in the prompt; the tools only need
  // the id. Kept in the signature so the call site passes a consistent tuple.
  _currentMemberName: string | null = null,
  // Pre-resolved once per turn by the route and shared with record_commitment
  // so it doesn't re-fetch the policy per commitment. Null → resolve lazily.
  autoAcceptPolicy: AutoAcceptPolicy | null = null,
  options: LiveAgentToolOptions = {},
) {
  void _currentMemberName
  const isEvalCapture = options.isEvalCapture === true

  // The capture's own date, fetched once and memoized across all propose_change
  // calls in this tool set's lifetime (captureId is fixed). Used by GEN-138's
  // due-date calibration to drop dates that predate the meeting (the "date
  // before the project existed" case). Resolves to null if unavailable — the
  // predates check is then skipped, but the quote-has-no-date check still runs.
  // The same read also carries who can see the capture (visibility + owner),
  // which record_commitment's dedupe needs (see dedupeRequesterFor). Null
  // fields when the read fails: the dedupe then falls back to NULL.
  let captureDate: string | null = null
  let captureVisibility: string | null = null
  let captureOwnerId: string | null = null
  let captureDateLoaded = false
  async function loadCaptureDate(): Promise<string | null> {
    if (captureDateLoaded) return captureDate
    captureDateLoaded = true
    const { data } = await supabase
      .from('captures')
      .select('started_at, created_at, visibility, user_id')
      .eq('id', captureId)
      .maybeSingle()
    captureDate =
      (data?.started_at as string | null) ?? (data?.created_at as string | null) ?? null
    captureVisibility = (data?.visibility as string | null) ?? null
    captureOwnerId = (data?.user_id as string | null) ?? null
    return captureDate
  }

  return {
    propose_change: tool({
      description: 'Propose a workspace change for user review. Use this for action items, project updates, decisions, milestones, email follow-ups, and assignments identified during the meeting. Changes are staged and require user approval before taking effect.',
      inputSchema: z.object({
        change_type: z
          .enum(['create', 'update', 'delete', 'assign', 'send_email'])
          .describe(
            'What to do. "create" = a NEW item (this is the right choice for any follow-up, task, or next step — including one that involves a person: meeting, calling, or connecting with someone is create:action with that person named in the title). "update" = change an EXISTING action/project/milestone/decision/contact. "assign" = re-point an EXISTING action to a different owner (ONLY when the action already exists; for a new task owned by someone use create:action with assignee_name). "delete" = remove an existing action/milestone. "send_email" = stage an email draft.',
          ),
        entity_type: z
          .enum(['action', 'project', 'decision', 'milestone', 'initiative', 'contact'])
          .describe(
            'What KIND of record the change is about. Supported pairs: create:action, create:decision, create:milestone, create:contact (a new CRM person — NOT a task about a person); update:action, update:project, update:milestone, update:decision, update:contact; assign:action; delete:action, delete:milestone; send_email:action, send_email:contact. Any other pair is rejected — a task ABOUT a contact or project is entity_type "action".',
          ),
        entity_id: z.string().nullable().optional().describe('ID of existing entity (for update/delete/assign). If you do not know the ID of the action an update/assign targets, leave this empty — the server resolves the target by title match.'),
        display_text: z.string().describe('Clean one-liner describing the change, e.g. "Sarah to update API docs by April 5"'),
        title: z.string().nullable().optional().describe('Entity title'),
        description: z.string().nullable().optional().describe('Rich context — why it matters, what was discussed'),
        priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).nullable().optional(),
        due_date: z.string().nullable().optional().describe('ISO8601 date (YYYY-MM-DD). Resolve relative dates ("next Monday", "end of week") against today\'s date given in the context. Leave empty if no date was given or you cannot resolve it — never invent one.'),
        status_to: z.string().nullable().optional().describe('New status for updates. Project statuses: planned, active, paused, completed, canceled. Milestone statuses: pending, in_progress, completed.'),
        assignee_name: z.string().nullable().optional().describe('Full name of person responsible. Use the real name from the Speaker Assignments block — NEVER a raw speaker label like "remote_2" (an unassigned label is dropped and the item staged without an assignee).'),
        speaker_label: z.string().nullable().optional().describe('Diarization label of the person who OWNS this item — the speaker who said "I\'ll do it" or the label of the person it was assigned to (e.g. "local_1", "remote_2"), exactly as it appears in the transcript. ALWAYS set this when the owner spoke; ownership resolved through the speaker map is trusted, ownership inferred from a name alone is not.'),
        project_id: z.string().nullable().optional().describe('Project ID to link to'),
        email_to_name: z.string().nullable().optional().describe('Email recipient name'),
        email_subject: z.string().nullable().optional().describe('Email subject'),
        email_context: z.string().nullable().optional().describe('Context for drafting the email'),
        trigger_quote: z.string().nullable().optional().describe('Exact quote from transcript'),
        reasoning: z.string().nullable().optional().describe('Why you are proposing this'),
        stakes: z.string().nullable().optional().describe('What happens if this is not done'),
        open_questions: z.array(z.string()).nullable().optional().describe('Unresolved questions'),
        confidence: z.number().min(0).max(1).optional().describe('How confident you are (0-1)'),
        // D2 (One Accept Authority): for DECISIONS and MILESTONES, whether the
        // item was EXPLICITLY stated in the meeting ("we decided X", "the
        // milestone is due Friday") vs INFERRED from context ("they seemed to
        // lean toward X"). The auto-apply gate only files an explicitly-stated
        // decision/milestone automatically; an inferred one is always shown as a
        // card to confirm. Ignored for other entity types. When unsure, false.
        is_explicitly_stated: z
          .boolean()
          .optional()
          .describe(
            'For decisions and milestones only: true if the item was explicitly stated in the meeting (e.g. "we decided to ship Friday"), false if you inferred it from context. Only explicitly-stated decisions/milestones are filed automatically. When unsure, use false.',
          ),
        label_ids: z.array(z.string()).nullable().optional().describe('Label IDs to attach to the action. Use list_labels to find available label IDs.'),
      }),
      execute: async (params) => {
        // A call's capture proposes only what the call itself produced (./call-capture-fence.ts).
        if (options.callCapture === true && !callCaptureChangeAllowed(params.change_type, params.entity_type)) {
          return { success: false, error: CALL_CAPTURE_CHANGE_REFUSAL }
        }
        // Resolve who the assignee actually is. Precedence:
        //   1. speaker_label → the capture's voice-ID speaker map. Deterministic
        //      ownership ('speaker_label' provenance) — the only provenance the
        //      self auto-apply gate trusts.
        //   2. assignee_name → fuzzy name match ('name_match' provenance). The
        //      model's inference echoed back; staged, shown, but never
        //      auto-applied to the current user.
        let assigneeMemberId: string | null = null
        let assigneeContactId: string | null = null
        let assigneeName: string | null = params.assignee_name || null
        let assigneeNote: string | undefined
        let assigneeResolution: 'speaker_label' | 'name_match' | null = null

        if (params.speaker_label) {
          const viaLabel = await resolvePersonForCapture(
            supabase, workspaceId, captureId, params.speaker_label, userId,
          )
          if (viaLabel.viaSpeakerMap && !viaLabel.unresolvedLabel) {
            assigneeName = viaLabel.name
            assigneeMemberId = viaLabel.memberId
            assigneeContactId = viaLabel.contactId
            assigneeResolution = 'speaker_label'
          }
          // An unmapped label is not a dead end for the ITEM — fall through to
          // the name path; the proposal just won't carry verified ownership.
        }

        if (!assigneeResolution && params.assignee_name) {
          const person = await resolvePersonForCapture(
            supabase, workspaceId, captureId, params.assignee_name, userId,
          )
          if (person.unresolvedLabel) {
            // An unassigned technical label is not a person — never store it
            // as an assignee. Stage the item unassigned instead.
            assigneeName = null
            assigneeNote = `assignee "${params.assignee_name}" is an unassigned speaker label, so the item was staged without an assignee — describe the person generically or leave unassigned`
          } else {
            assigneeName = person.name
            assigneeMemberId = person.memberId
            assigneeContactId = person.contactId
            // A name that IS a mapped label ("remote_2") resolved through the
            // speaker map — same deterministic ownership as speaker_label.
            assigneeResolution = person.viaSpeakerMap ? 'speaker_label' : 'name_match'
          }
        }

        // Resolve the target action for update/assign proposals staged without
        // an entity_id — the extractor almost never knows the UUID (live audits
        // found 11/11 and 25/25 pending updates staged with entity_id=null),
        // and an update with no target can only ever fail at apply time. Fuzzy
        // title match against the capture's project + team actions; when
        // nothing matches unambiguously the proposal stays targetless and the
        // apply engine retries resolution at accept time.
        let entityId: string | null = params.entity_id || null
        let targetNote: string | undefined
        if (
          !entityId &&
          params.entity_type === 'action' &&
          (params.change_type === 'update' || params.change_type === 'assign')
        ) {
          const target = await resolveActionTarget(supabase, workspaceId, {
            title: params.title,
            displayText: params.display_text,
            projectId: params.project_id || projectId,
            teamId,
          })
          if (target) {
            entityId = target.id
            targetNote = `resolved target action ${target.identifier ?? target.id}${
              target.title ? ` "${target.title}"` : ''
            } — use edit_proposal with entity_id to correct this if wrong`
          }
        }

        // ── Combo normalization + rejection (staging-time drift guard) ──
        // The schema is a free cross-product of change_type × entity_type, but
        // the apply engine only executes the combos in appliable-combos. Write
        // the row in its APPLIABLE form so the card never renders a disabled
        // "Unsupported: assign contact" (prod, capture 3261a80c: a "connect with
        // Nikhil's son" follow-up staged as assign:contact). Same rules the apply
        // engine and card layer use, so all three agree:
        //   • target-less assign (any entity) → create:action
        //   • target-less update:decision      → create:decision
        // A combo that STILL has no handler after normalization is refused with
        // guidance so the model re-proposes it as something appliable instead of
        // staging a card the user can only dismiss.
        let changeType = params.change_type
        let entityType = params.entity_type
        let comboNote: string | undefined
        const normalized = normalizeProposedChange({
          change_type: changeType,
          entity_type: entityType,
          entity_id: entityId,
        })
        if (normalized.changed) {
          changeType = normalized.change_type as typeof changeType
          entityType = normalized.entity_type as typeof entityType
          comboNote = `${params.change_type}:${params.entity_type} names no existing ${params.entity_type}, so it was staged as ${changeType}:${entityType} — use change_type "create" with entity_type "action" directly for a new task`
        }
        if (!canApplyChange({ change_type: changeType, entity_type: entityType, entity_id: entityId })) {
          return {
            success: false,
            error:
              `Unsupported combination ${params.change_type}:${params.entity_type} — nothing can apply it. ` +
              `Supported: ${[...HANDLED_COMBOS].filter((k) => !k.startsWith('mcp_call')).join(', ')}. ` +
              `Re-propose it as create:action (a task, naming the ${params.entity_type} in the title) ` +
              `or record it in the summary instead.`,
          }
        }

        // ── Extraction-time calibration guardrail (GEN-138) ──
        // Runs after assignee + update-target resolution, before the INSERT.
        // Deterministic backstop for the extractor's priority inflation +
        // date fabrication. Only ever DAMPS the proposal's own fields (lowers
        // an unjustified high/urgent, drops a fabricated/impossible date) —
        // never touches change_type/entity_id and never drops the item.
        //
        // SCOPED TO change_type === 'create'. An update/assign proposal often
        // carries a value the USER explicitly directed ("bump ENG-42 to high"),
        // which we must not damp — the inflation problem is an extraction-of-new-
        // work problem, not a user-edit problem.
        //
        // NOTE: proposal DEDUP (create-vs-existing, within-capture) deliberately
        // does NOT happen here. Reusing the fuzzy title matcher for identity
        // decisions at staging time folded genuinely-distinct tasks that differ
        // by one load-bearing word ("Add API logging" vs "Add BFF logging"),
        // silently dropping real work — the exact failure precision-over-recall
        // exists to prevent. Dedup is the Triage loop's job: it reviews with
        // full cross-capture context and a human/act-mode gate before anything
        // is merged or dismissed. See docs/loop-engine/EXTRACTION-GUARDRAIL-DESIGN.md.
        let priority: Priority | null = (params.priority as Priority | null) ?? null
        let dueDate: string | null = params.due_date || null
        const guardrailNotes: string[] = []
        const guardrail: Record<string, unknown> = {}

        if (
          EXTRACTION_GUARDRAIL_ENABLED &&
          entityType === 'action' &&
          changeType === 'create'
        ) {
          const pr = calibratePriority(priority, dueDate, params.trigger_quote)
          if (pr.changed) {
            priority = pr.value
            guardrail.priority_lowered = true
            if (pr.note) guardrailNotes.push(pr.note)
          }
          const dr = calibrateDueDate(dueDate, params.trigger_quote, await loadCaptureDate())
          if (dr.changed) {
            dueDate = dr.value
            guardrail.due_date_dropped = true
            if (dr.note) guardrailNotes.push(dr.note)
          }
        }

        // Get current count for sort_order
        const { count } = await supabase
          .from('proposed_change')
          .select('id', { count: 'exact', head: true })
          .eq('capture_id', captureId)

        // D2 (One Accept Authority): carry the model's explicitness verdict for
        // decisions/milestones into `extra` — the auto-apply gate reads it to
        // decide whether an explicitly-stated decision/milestone may auto-apply.
        // Only stamped when the model set it AND the entity is one the flag
        // governs, so it never adds noise to an action row.
        const explicitlyStated =
          typeof params.is_explicitly_stated === 'boolean' &&
          (entityType === 'decision' || entityType === 'milestone')
            ? params.is_explicitly_stated
            : undefined
        const extra: Record<string, unknown> = {
          ...(Object.keys(guardrail).length ? { guardrail } : {}),
          ...(assigneeResolution
            ? {
                assignee_resolution: assigneeResolution,
                ...(params.speaker_label
                  ? { assignee_speaker_label: params.speaker_label }
                  : {}),
              }
            : {}),
          ...(explicitlyStated !== undefined ? { is_explicitly_stated: explicitlyStated } : {}),
        }

        const { data, error } = await supabase
          .from('proposed_change')
          .insert({
            workspace_id: workspaceId,
            capture_id: captureId,
            change_type: changeType,
            entity_type: entityType,
            entity_id: entityId,
            display_text: params.display_text,
            title: params.title || null,
            description: params.description || null,
            priority: priority,
            due_date: dueDate,
            status_to: params.status_to || null,
            assignee_name: assigneeName,
            assignee_member_id: assigneeMemberId,
            assignee_contact_id: assigneeContactId,
            team_id: teamId,
            project_id: params.project_id || projectId,
            email_to_name: params.email_to_name || null,
            email_subject: params.email_subject || null,
            email_context: params.email_context || null,
            trigger_quote: params.trigger_quote || null,
            reasoning: params.reasoning || null,
            stakes: params.stakes || null,
            open_questions: params.open_questions || null,
            confidence: params.confidence ?? 0.5,
            sort_order: (count || 0),
            status: 'pending',
            labels: params.label_ids || null,
            // Machine markers: `guardrail` badges auto-calibrated proposals;
            // `assignee_resolution` records HOW the assignee was resolved
            // ('speaker_label' = verified through the voice-ID speaker map,
            // 'name_match' = fuzzy name inference — the auto-apply gates only
            // trust 'speaker_label' for items assigned to the current user);
            // `is_explicitly_stated` is the D2 explicitness verdict the gate
            // reads for decisions/milestones.
            ...(Object.keys(extra).length ? { extra } : {}),
          })
          .select('id, display_text')
          .single()

        if (error) {
          return { success: false, error: error.message }
        }

        const notes = [assigneeNote, targetNote, comboNote, ...guardrailNotes].filter(Boolean)
        return {
          success: true,
          id: data.id,
          display_text: data.display_text,
          ...(notes.length ? { note: notes.join('; ') } : {}),
        }
      },
    }),

    say_to_user: tool({
      description:
        "Speak DIRECTLY to the user during the live conversation — a short, in-the-moment heads-up shown on their floating display. Quiet by default: they have to stay present in their conversation, so use this only when it helps the conversation toward the call's goal or they need to know something now — a fact they are missing, a commitment at risk, a question to ask before the moment passes, a correction. Never repeat something you already told them, never narrate or react, and never name a speaker the Speaker Assignments do not establish. This is NOT a substitute for proposals or the summary — it does not create or change anything in the workspace; it just tells the user something. Keep it to one or two sentences, conversational, and skip it entirely when nothing rises to that bar (silence is usually correct).",
      inputSchema: z.object({
        message: z
          .string()
          .describe('What to tell the user, in one or two natural sentences. No preamble.'),
        kind: z
          .enum(['insight', 'reminder', 'suggestion'])
          .optional()
          .describe(
            'Loose classification: "insight" (a connection/observation), "reminder" (something being forgotten), "suggestion" (a recommended next move). Defaults to insight.',
          ),
      }),
      execute: async ({ message, kind }) => {
        const text = message.trim()
        if (!text) return { delivered: false, error: 'Empty message' }
        // ONE id for the nudge: the broadcast's `id` AND the chat row's
        // ui_message.id (so chat_messages.ui_message_id). A nudge the HUD
        // rendered off the broadcast is then the same message as its stored
        // row: the HUD dedupes by it, and a rating or a reference to it finds
        // the row.
        const nudge = {
          id: crypto.randomUUID(),
          message: text,
          kind: (kind ?? 'insight') as NudgeKind,
          captureId,
          ts: Date.now(),
        }
        // Authoritative surface: the capture's chat conversation (live-agent →
        // chat merge). Persistent, delivered over Realtime to the open panel,
        // and immune to the HUD relay's subscribe/occlusion failure modes.
        // Every nudge that gets this far writes its row (no throttle): the row
        // is what already-told reads back so the sidekick never says a thing
        // twice, and what a thumbs rating points at. No-ops for captures
        // without a conversation. Best-effort — the nudge must still fire even
        // if the chat write fails. (A stale nudge never gets here: the tool
        // route's time guard drops it before it persists or broadcasts.)
        const chatWrite = await appendAgentMessage(supabase, {
          captureId,
          messageId: nudge.id,
          parts: [{ type: 'text', text }],
          metadata: { kind: 'say_to_user', nudge_kind: nudge.kind },
        }).catch(() => ({ written: false as const }))

        // Ephemeral broadcast — no DB write. If no HUD is listening it's simply
        // dropped (nobody to tell). Never throws into the agent loop.
        const delivered = await broadcastNudge(nudge).catch(() => false)
        if (!delivered) {
          // Fire on ANY broadcast drop — not only when the chat write ALSO
          // failed. The old `!delivered && !chatWrite.written` AND-gate silently
          // masked the exact production symptom: chat shows the heads-up but the
          // HUD stays blank (broadcast dropped, chat write fine). Because chat is
          // now the authoritative surface it almost always succeeds, so the gate
          // never once fired in PostHog while HUD delivery was quietly failing in
          // the field. Split the signal instead: emit whenever the broadcast is
          // undelivered and carry `chat_written` so dashboards can separate
          // "HUD-only loss" (chat_written:true — the common, previously-invisible
          // case) from "total loss" (chat_written:false).
          console.warn(
            `say_to_user nudge broadcast undelivered (capture ${captureId}, chat_written=${chatWrite.written}): no subscriber or subscribe timeout`,
          )
          trackServerEvent(
            'live_agent_nudge_drop',
            { userId, workspaceId },
            {
              capture_id: captureId,
              stage: 'cloud_tool',
              kind: nudge.kind,
              chat_written: chatWrite.written,
            },
          )
        }
        // Delivered = shown somewhere: the broadcast was accepted (the desktop
        // HUD) OR the row was written (the chat panel and the web HUD render
        // rows; the web HUD has no broadcast subscriber).
        return { delivered: delivered || chatWrite.written, id: nudge.id }
      },
    }),

    ask_user: tool({
      description:
        "Ask the user a SHORT clarifying question mid-meeting when a small decision would materially change what you capture — e.g. which project an action belongs to, or whether something is worth tracking at all. It appears as a clickable option picker in their chat. Use this RARELY: only when you genuinely cannot proceed well without their answer, and never for anything you can reasonably infer. You may have only ONE unanswered question at a time (asking again while one is pending is refused). This does not change the workspace; it just asks.",
      inputSchema: z.object({
        question: z.string().describe('The question, one sentence. No preamble.'),
        options: z
          .array(z.string())
          .min(2)
          .max(4)
          .describe('2–4 short answer choices the user can click.'),
      }),
      execute: async ({ question, options }) => {
        // One pending question at a time (plan D8): refuse if the capture's
        // conversation already has an unanswered ask_user part.
        const hasPending = await hasPendingLiveQuestion(supabase, captureId)
        if (hasPending) {
          return {
            asked: false,
            error: 'A question is already awaiting the user — wait for their answer.',
          }
        }
        const toolCallId = crypto.randomUUID()
        const res = await appendAgentMessage(supabase, {
          captureId,
          parts: [
            {
              type: 'tool-ask_user',
              toolCallId,
              state: 'input-available',
              // The picker reads part.input.questions[]. One question, its
              // options as selectable labels.
              input: {
                questions: [
                  {
                    header: 'Quick question',
                    question,
                    options: options.map((label) => ({ label })),
                    multiSelect: false,
                  },
                ],
              },
            },
          ],
          metadata: { kind: 'ask_user' },
        }).catch(() => ({ written: false as const }))
        return { asked: res.written, id: toolCallId }
      },
    }),

    edit_proposal: tool({
      description: 'Edit a proposed change as the conversation refines it — deadline changed, different person assigned, more context, scope shifted. Works whether the proposal is still pending OR was already auto-accepted: for an applied item the edit is propagated to the real action/decision/milestone in place (no re-confirmation needed). Pass the proposal ID and only the fields to update.',
      inputSchema: z.object({
        proposal_id: z.string().describe('The ID of the proposed change to edit (returned from propose_change)'),
        display_text: z.string().nullable().optional().describe('Updated one-liner description'),
        title: z.string().nullable().optional().describe('Updated title'),
        description: z.string().nullable().optional().describe('Updated description/context'),
        priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).nullable().optional(),
        due_date: z.string().nullable().optional().describe('Updated ISO8601 date'),
        status_to: z.string().nullable().optional().describe('Updated status. Project statuses: planned, active, paused, completed, canceled. Milestone statuses: pending, in_progress, completed.'),
        assignee_name: z.string().nullable().optional().describe('Updated assignee name'),
        entity_id: z.string().nullable().optional().describe('ID of the existing entity this proposal targets (e.g. the action UUID for assign:action). Use this to correct a missing or wrong entity reference.'),
        project_id: z.string().nullable().optional().describe('Updated project ID'),
        reasoning: z.string().nullable().optional().describe('Updated reasoning'),
        label_ids: z.array(z.string()).nullable().optional().describe('Updated label IDs. Pass an empty array to remove all labels.'),
      }),
      execute: async (params) => {
        // Resolve a changed assignee name → person (shared by both branches).
        // Same pipeline as propose_change: speaker map → fuzzy member match →
        // contact fallback; an unassigned label clears the assignee.
        let resolvedAssigneeMemberId: string | null | undefined
        let resolvedAssigneeContactId: string | null | undefined
        let resolvedAssigneeName: string | null | undefined = params.assignee_name
        // Provenance of the RE-resolved assignee. An edit that re-points an
        // item via a name ("assign it to me") is inference, exactly like a
        // fresh name_match staging — it must not inherit a prior
        // 'speaker_label' marker, or the self auto-apply gate reopens.
        let editViaSpeakerMap = false
        if (params.assignee_name !== undefined) {
          if (params.assignee_name) {
            const person = await resolvePersonForCapture(
              supabase, workspaceId, captureId, params.assignee_name, userId,
            )
            if (person.unresolvedLabel) {
              resolvedAssigneeName = null
              resolvedAssigneeMemberId = null
              resolvedAssigneeContactId = null
            } else {
              resolvedAssigneeName = person.name
              resolvedAssigneeMemberId = person.memberId
              resolvedAssigneeContactId = person.contactId
              editViaSpeakerMap = person.viaSpeakerMap
            }
          } else {
            resolvedAssigneeMemberId = null
            resolvedAssigneeContactId = null
          }
        }

        // Look up the proposal first so we can branch on its lifecycle state.
        const { data: existing } = await supabase
          .from('proposed_change')
          .select('id, status, entity_type, result_entity_id, team_id, extra')
          .eq('id', params.proposal_id)
          .eq('capture_id', captureId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()

        if (!existing) {
          return { success: false, error: 'Proposal not found' }
        }

        // ── Already auto-accepted → propagate the edit to the REAL entity ──
        if (existing.status === 'applied') {
          const entityId = existing.result_entity_id as string | null
          if (!entityId) {
            return { success: false, error: 'Applied proposal has no created entity to edit' }
          }
          const res = await updateAppliedEntity(
            supabase,
            existing.entity_type as string,
            entityId,
            workspaceId,
            {
              title: params.title ?? undefined,
              description: params.description ?? undefined,
              priority: params.priority ?? undefined,
              due_date: params.due_date ?? undefined,
              status_to: params.status_to ?? undefined,
              assignee_member_id: resolvedAssigneeMemberId,
              team_id: (existing.team_id as string | null) ?? undefined,
            },
            // Attributes the status-change emit when this edit moves the status.
            userId,
          )
          if (!res.success) return res
          // Keep the proposed_change row's display in sync (best-effort) so the
          // agent's context shows the latest text.
          if (params.display_text !== undefined || params.title !== undefined) {
            await supabase
              .from('proposed_change')
              .update({
                ...(params.display_text !== undefined ? { display_text: params.display_text } : {}),
                ...(params.title !== undefined ? { title: params.title } : {}),
              })
              .eq('id', params.proposal_id)
          }
          return { success: true, id: params.proposal_id, applied_entity_id: entityId, updated_in_place: true }
        }

        // ── Still pending → edit the proposal as before ──
        const updates: Record<string, unknown> = {}
        if (params.display_text !== undefined) updates.display_text = params.display_text
        if (params.title !== undefined) updates.title = params.title
        if (params.description !== undefined) updates.description = params.description
        if (params.priority !== undefined) updates.priority = params.priority
        if (params.due_date !== undefined) updates.due_date = params.due_date
        if (params.status_to !== undefined) updates.status_to = params.status_to
        if (params.reasoning !== undefined) updates.reasoning = params.reasoning
        if (params.project_id !== undefined) updates.project_id = params.project_id
        if (params.entity_id !== undefined) updates.entity_id = params.entity_id
        if (params.label_ids !== undefined) updates.labels = params.label_ids
        if (params.assignee_name !== undefined) {
          updates.assignee_name = resolvedAssigneeName ?? null
          updates.assignee_member_id = resolvedAssigneeMemberId ?? null
          updates.assignee_contact_id = resolvedAssigneeContactId ?? null
          // Rewrite the provenance markers to reflect THIS resolution. Without
          // this, editing a speaker_label-staged item's assignee to the current
          // user would keep the stale 'speaker_label' marker and the next
          // auto-apply sweep would trust a name-echoed reassignment.
          const prevExtra = (existing.extra as Record<string, unknown> | null) ?? {}
          const {
            assignee_resolution: _prevResolution,
            assignee_speaker_label: _prevLabel,
            ...restExtra
          } = prevExtra
          const hasAssignee =
            (resolvedAssigneeMemberId ?? null) !== null ||
            (resolvedAssigneeContactId ?? null) !== null ||
            !!resolvedAssigneeName // '' = cleared, not an assignee
          updates.extra = hasAssignee
            ? { ...restExtra, assignee_resolution: editViaSpeakerMap ? 'speaker_label' : 'name_match' }
            : Object.keys(restExtra).length > 0
              ? restExtra
              : null
        }

        if (Object.keys(updates).length === 0) {
          return { success: false, error: 'No fields to update' }
        }

        const { data, error } = await supabase
          .from('proposed_change')
          .update(updates)
          .eq('id', params.proposal_id)
          .eq('capture_id', captureId)
          .eq('workspace_id', workspaceId)
          .eq('status', 'pending')
          .select('id, display_text')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, id: data.id, display_text: data.display_text }
      },
    }),

    dismiss_proposal: tool({
      description: 'Retract a proposed change the conversation made obsolete — task cancelled, decision reversed, a misunderstanding. Works whether pending OR already auto-accepted: if it was applied, the real action/decision/milestone it created is deleted so it disappears from the user\'s list. Pass the proposal ID.',
      inputSchema: z.object({
        proposal_id: z.string().describe('The ID of the proposed change to dismiss'),
        reason: z.string().optional().describe('Brief reason for dismissal'),
      }),
      execute: async ({ proposal_id, reason }) => {
        const { data: existing } = await supabase
          .from('proposed_change')
          .select('id, status, change_type, entity_type, result_entity_id, extra')
          .eq('id', proposal_id)
          .eq('capture_id', captureId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()

        if (!existing) return { success: false, error: 'Proposal not found' }

        // The dismissal reason lives in extra.dismiss_reason — NOT the
        // `reasoning` column, which holds why the AI proposed the item in the
        // first place and must survive dismissal for triage review.
        const dismissUpdate = {
          status: 'dismissed' as const,
          ...(reason
            ? { extra: { ...((existing.extra as Record<string, unknown> | null) ?? {}), dismiss_reason: reason } }
            : {}),
        }

        // Already auto-accepted → delete the entity it CREATED. For update/
        // assign proposals the target pre-existed, so we never delete it — we
        // just mark the proposal dismissed and tell the agent it couldn't be
        // auto-reverted (the prior state wasn't snapshotted).
        if (existing.status === 'applied') {
          const entityId = existing.result_entity_id as string | null
          let deletedEntity = false
          let note: string | undefined
          if (entityId) {
            const res = await deleteAppliedEntity(
              supabase,
              existing.change_type as string,
              existing.entity_type as string,
              entityId,
              workspaceId,
            )
            if (res.success) {
              deletedEntity = true
            } else if (res.code === 'NOT_CREATED_BY_PROPOSAL') {
              note =
                'This was an update/assignment to an existing item, so it was not deleted — the change stands. Tell the user if it needs manual reverting.'
            } else {
              return res
            }
          }
          await supabase
            .from('proposed_change')
            .update(dismissUpdate)
            .eq('id', proposal_id)
          return { success: true, deleted_entity: deletedEntity, ...(note ? { note } : {}) }
        }

        // Still pending → just mark the proposal dismissed.
        const { error } = await supabase
          .from('proposed_change')
          .update(dismissUpdate)
          .eq('id', proposal_id)
          .eq('capture_id', captureId)
          .eq('workspace_id', workspaceId)
          .eq('status', 'pending')

        if (error) return { success: false, error: error.message }
        return { success: true }
      },
    }),

    record_commitment: tool({
      description:
        'Record that ANOTHER participant (not the user you are assisting) committed to doing something. ' +
        'Use this instead of propose_change when someone else says they will do a task — e.g. "Sarah will send the deck", ' +
        '"the vendor is going to follow up". It files the commitment in the knowledge graph as a tracked claim ' +
        '("<name> committed to <thing>") attributed to that person, so the user can see who owes what — WITHOUT adding ' +
        'a task to the user\'s own action list. Do NOT use this for the user\'s own tasks (use propose_change for those).',
      inputSchema: z.object({
        person_name: z
          .string()
          .describe('Full name of the person who made the commitment (not the user you are assisting). Use the real name from the Speaker Assignments block — NEVER a raw speaker label like "remote_2"; an unassigned label is rejected because a commitment must be attributed to a person.'),
        commitment: z
          .string()
          .describe('What they committed to, as a clean statement. E.g. "send the Q3 deck to the team by Friday".'),
        trigger_quote: z
          .string()
          .nullable()
          .optional()
          .describe('Exact quote from the transcript where the commitment was made.'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('How explicit the transcript was about this commitment and its owner (0-1).'),
      }),
      execute: async ({ person_name, commitment, trigger_quote, confidence }) => {
        // EVAL capture: return a synthetic success and touch NOTHING. This
        // short-circuits ahead of the `match_claims` dedupe below, which is the
        // dangerous half — on a ≥0.92 cosine match it attaches provenance to an
        // EXISTING real claim, so a mock sales call would graft itself onto the
        // knowledge graph without ever inserting a row of its own. No `claim`,
        // no `claim_chunks`, no provenance is written on this path.
        //
        // The model sees an ordinary success, so the turn proceeds exactly as it
        // would on a real call; the graded signal is the tool CALL, which the
        // Evals trace records as `commitments[]`.
        if (isEvalCapture) {
          void trigger_quote
          void confidence
          return {
            success: true,
            claim_id: null,
            eval_suppressed: true,
            text: `${person_name} committed to ${commitment}`,
            subject: person_name,
          }
        }

        // Resolve the committer to a real person BEFORE anything is written:
        // speaker labels ("remote_2") map through the capture's voice-ID
        // assignments, then the name fuzzy-matches (nicknames, first names,
        // respellings) against members with a CRM-contact fallback. The member
        // becomes the claim's subject so "what did <member> commit to" is a
        // one-hop graph query; a contact is linked via an `about` edge instead.
        const person = await resolvePersonForCapture(
          supabase, workspaceId, captureId, person_name, userId,
        )
        if (person.unresolvedLabel) {
          // A claim attributed to an unassigned technical label is noise the
          // user can never act on — refuse it rather than pollute the graph.
          return {
            success: false,
            error: `"${person_name}" is an unassigned speaker label, not a person. Check the Speaker Assignments block for the real name; if the voice is unassigned, do not record the commitment — mention it generically in the summary or propose an unassigned action item instead.`,
          }
        }
        if (person.selfReference) {
          // "me"/"you" is the user this agent assists — their own tasks belong
          // on their action list via propose_change, not in the graph as a
          // third-party commitment.
          return {
            success: false,
            error: `"${person_name}" refers to the user you are assisting. record_commitment is for OTHER participants — use propose_change for the user's own tasks.`,
          }
        }
        const subjectMemberId = person.memberId
        const subjectContactId = person.contactId

        const text = `${person.name} committed to ${commitment}`

        // The capture's real-world time — this commitment "happened" when the
        // meeting did. Forward-filled onto claim.event_at and its provenance so
        // temporal recall ("what did Sarah commit to last week") works (mig 180).
        // Memoized loader (started_at ?? created_at); null when unavailable.
        const captureEventAt = await loadCaptureDate()

        // Embed BEFORE inserting so near-identical restatements of the same
        // commitment (live pass + batch Reprocess, or the model re-filing it in
        // different words) collapse onto the existing claim instead of storing
        // a second row. Same threshold as the ingestion pipeline
        // (claim-extraction's DEDUPE_THRESHOLD). Embedding failure skips dedup
        // and recall indexing but never blocks the claim itself.
        let embedding: number[] | null = null
        try {
          embedding = await embed(text, userId)
        } catch {
          // best-effort
        }

        // The links a dedupe hit attaches. Also what scopes the dedupe read: a
        // contact `about` edge becomes an always-visible claim_source row, so
        // with one the match must already be visible to everyone.
        const dedupeLinks = [
          ...(subjectMemberId
            ? [{ entity_type: 'member', entity_id: subjectMemberId, relation: 'committed_to' }]
            : []),
          ...(subjectContactId
            ? [{ entity_type: 'contact', entity_id: subjectContactId, relation: 'about' }]
            : []),
        ]

        if (embedding) {
          const { data: matches } = await supabase.rpc('match_claims', {
            p_workspace_id: workspaceId,
            p_embedding: `[${embedding.join(',')}]`,
            p_limit: 1,
            p_threshold: COMMITMENT_DEDUPE_THRESHOLD,
            p_type: null,
            p_confirmation: null,
            p_status: 'active',
            p_min_confidence: null,
            // Only claims this capture's audience can already see: a hit gets
            // the capture attached, and attaching a wider source would widen
            // the claim (a private chat claim must not turn shared because a
            // workspace meeting said the same thing). Private capture → its
            // owner; workspace capture → NULL (shared claims only).
            p_requesting_user_id: dedupeRequesterFor({
              sourceType: 'capture',
              ownerUserId: captureOwnerId,
              captureVisibility,
              links: dedupeLinks,
            }),
          })
          if (matches && matches.length > 0) {
            const existingId = (matches[0] as { claim_id: string }).claim_id
            // Duplicate — grow the existing claim's provenance (idempotent)
            // rather than creating a second claim.
            await attachClaimProvenance(supabase, {
              claimId: existingId,
              workspaceId,
              memberId: currentMemberId,
              sources: [
                {
                  source_type: 'capture',
                  source_id: captureId,
                  source_uri: null,
                  excerpt: trigger_quote || text,
                  relation: 'cites',
                  eventAt: captureEventAt,
                },
              ],
              links: dedupeLinks,
            })
            return {
              success: true,
              claim_id: existingId,
              tracked_as: text,
              deduplicated: true,
            }
          }
        }

        // A commitment by someone else is "personal" scope (about a specific
        // person) and confidence-gated for auto-accept just like a claim. Reuse
        // the policy the route already resolved; fall back to a lazy fetch only
        // if this tool set was created without one.
        // One Accept Authority (PR-2): the CLAIM auto-accept policy now reads the
        // ONE trust policy (trust_policy.claims via resolveClaimsAutoAcceptPolicy),
        // not the legacy auto_accept_policy. The flat AutoAcceptPolicy shape is
        // preserved; both routes pass the claims-projected policy, and the fallback
        // resolves it the same way.
        const policy =
          autoAcceptPolicy ??
          (await resolveClaimsAutoAcceptPolicy(supabase, workspaceId))
        const autoAccept = shouldAutoAccept('claims', confidence ?? null, policy)

        const { data: claim, error } = await supabase
          .from('claim')
          .insert({
            workspace_id: workspaceId,
            text,
            type: 'fact',
            confidence: confidence ?? null,
            confirmation: autoAccept ? 'confirmed' : 'suggested',
            auto_accepted: autoAccept,
            last_verified_at: autoAccept ? new Date().toISOString() : null,
            // The capture's time — the commitment pertains to this meeting (mig 180).
            event_at: captureEventAt,
            subject_member_id: subjectMemberId,
            scope: subjectMemberId || subjectContactId ? 'personal' : 'workspace',
            created_by: currentMemberId,
          })
          .select('id')
          .single()
        if (error) return { success: false, error: error.message }

        // Index for semantic recall, reusing the embedding computed for the
        // dedup check above (best-effort — skipped if embedding failed).
        if (embedding) {
          await supabase.from('claim_chunks').insert({
            claim_id: claim.id,
            workspace_id: workspaceId,
            chunk_index: 0,
            chunk_text: text,
            embedding: `[${embedding.join(',')}]`,
          })
        }

        // Provenance: cite the capture (where it was said) + a committed_to edge
        // to the member, or an `about` edge to the contact.
        await attachClaimProvenance(supabase, {
          claimId: claim.id,
          workspaceId,
          memberId: currentMemberId,
          sources: [
            {
              source_type: 'capture',
              source_id: captureId,
              source_uri: null,
              excerpt: trigger_quote || text,
              relation: 'cites',
              eventAt: captureEventAt,
            },
          ],
          links: [
            ...(subjectMemberId
              ? [{ entity_type: 'member', entity_id: subjectMemberId, relation: 'committed_to' }]
              : []),
            ...(subjectContactId
              ? [{ entity_type: 'contact', entity_id: subjectContactId, relation: 'about' }]
              : []),
          ],
        })

        return {
          success: true,
          claim_id: claim.id,
          tracked_as: text,
          auto_accepted: autoAccept,
        }
      },
    }),

    // Read-only tools for context gathering

    search_projects: tool({
      description: 'Search workspace projects by name. Use this when someone mentions a project to find its ID and current status. The search is fuzzy — it tries multiple variations to handle transcription misspellings.',
      inputSchema: z.object({
        query: z.string().describe('Project name or partial name to search for'),
      }),
      execute: async ({ query }) => {
        // Try exact substring first
        const { data: exact } = await supabase
          .from('projects')
          .select('id, name, status, description, lead_id, target_date')
          .eq('workspace_id', workspaceId)
          .ilike('name', `%${query}%`)
          .limit(5)

        if (exact && exact.length > 0) return { projects: exact }

        // Try without spaces (e.g. "Kokoa Link" → "KokoaLink" matches "KokoLink")
        const noSpaces = query.replace(/\s+/g, '')
        const { data: compacted } = await supabase
          .from('projects')
          .select('id, name, status, description, lead_id, target_date')
          .eq('workspace_id', workspaceId)
          .ilike('name', `%${noSpaces}%`)
          .limit(5)

        if (compacted && compacted.length > 0) return { projects: compacted }

        // Try individual words (e.g. "Kokoa Link" → search for "Kokoa" OR "Link")
        // Each word made safe for `.or()` (a model word like "Acme," broke the
        // filter, or "x,name.neq.zz" matched every project).
        const words = query.split(/\s+/).map(toIlikeSearchTerm).filter(w => w.length > 2)
        if (words.length > 0) {
          const orFilter = words.map(w => `name.ilike.%${w}%`).join(',')
          const { data: wordMatch } = await supabase
            .from('projects')
            .select('id, name, status, description, lead_id, target_date')
            .eq('workspace_id', workspaceId)
            .or(orFilter)
            .limit(5)

          if (wordMatch && wordMatch.length > 0) return { projects: wordMatch }
        }

        // Try first few characters (handles "Kokoa" matching "Koko")
        const prefix = query.replace(/\s+/g, '').slice(0, Math.max(4, Math.floor(query.length * 0.6)))
        const { data: prefixMatch } = await supabase
          .from('projects')
          .select('id, name, status, description, lead_id, target_date')
          .eq('workspace_id', workspaceId)
          .ilike('name', `%${prefix}%`)
          .limit(5)

        return { projects: prefixMatch || [] }
      },
    }),

    search_contacts: tool({
      description: 'Search CRM contacts by name or email. Use when someone mentions a person who might be in the CRM.',
      inputSchema: z.object({
        query: z.string().describe('Name or email to search for'),
      }),
      execute: async ({ query }) => {
        // The query is model-supplied and `.or()` takes a raw PostgREST logic
        // tree: strip what could add conditions or match everyone.
        const term = toIlikeSearchTerm(query)
        if (!term) return { contacts: [] }
        // Over-fetch, fence, THEN cut to the limit: this runs service-role on
        // the eve live-agent tool route, where the contact RLS (mig 058) does
        // not hide another member's private contacts, so each row goes through
        // contact_visible_to(contact, userId) (fails closed). Fencing after a
        // 5-row fetch would let hidden rows crowd visible matches out.
        const { data } = await supabase
          .from('contact')
          .select('id, full_name, email, job_title, company:company_id(name)')
          .eq('workspace_id', workspaceId)
          .or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
          .limit(SEARCH_CONTACTS_LIMIT * SEARCH_CONTACTS_OVERFETCH)

        const visible = await filterVisibleContacts(supabase, userId, data ?? [])
        return { contacts: visible.slice(0, SEARCH_CONTACTS_LIMIT) }
      },
    }),

    // list_workspace_members / list_labels are NOT built here. They are read
    // tools the registry owns (createTools, via buildLiveAgentReadTools). The
    // hand-rolled copies that used to live here were shadowed by the registry
    // ones in every tools map that served the live agent, and ran only when a
    // persona's tool selection narrowed the registry copy away. The ceiling
    // still grants both names on every turn, narrowing or not
    // (LIVE_AGENT_PINNED_READ_TOOL_NAMES in ./ceiling.ts), and the registry
    // implementation now serves them in that case too. /stage calls only
    // propose_change + write_summary from this factory.

    propose_mcp_call: tool({
      description:
        'Propose calling a tool on a connected external MCP server (Jira, Linear, Atlassian, etc.). ' +
        'Use this when the conversation describes work that belongs in an external system — creating a Jira ticket, ' +
        'updating a Linear cycle, posting a Confluence page, etc. Like propose_change, this stages the call for user ' +
        'review; the user clicks Apply in the capture and the call executes against the remote server. ' +
        'Choose the correct namespaced tool name from the "Connected external MCP servers" block in your context.',
      inputSchema: z.object({
        tool_name: z.string().describe(
          'Namespaced tool name as it appears in the external servers context, e.g. mcp__atlassian__create_jira_issue.',
        ),
        args: z.record(z.string(), z.unknown()).describe(
          'Arguments to pass to the remote tool. Must conform to that tool\'s input schema as documented in the context block.',
        ),
        display_text: z.string().describe(
          'Clean one-liner the user will see in the proposal card, e.g. "Create a Jira ticket in ACME for Sarah to draft the rollout plan".',
        ),
        trigger_quote: z.string().nullable().optional().describe('Exact quote from transcript that triggered this proposal.'),
        reasoning: z.string().nullable().optional().describe('Why this external call is being proposed.'),
        confidence: z.number().min(0).max(1).optional(),
      }),
      execute: async (params) => {
        // Resolve server + remote tool name from the namespaced wrapper.
        // We do not validate against the schema here — the apply-engine
        // re-checks at apply time and the remote will return an error if
        // args are malformed. Cheap to propose, expensive to call.
        // Scope to this user's servers explicitly. RLS already gates the
        // user-session client, but the explicit filter survives any future
        // refactor that swaps in a service-role client (e.g. Inngest job,
        // background worker) — without it, this could expand into a
        // cross-user IDOR.
        const { data: servers } = await supabase
          .from('connected_mcp_server')
          .select('id, user_id, display_name, tools_cache, is_enabled, disabled_tools, allowed_tools')
          .eq('user_id', userId)
          .eq('is_enabled', true)

        let matchedServerId: string | null = null
        let matchedServerName: string | null = null
        let matchedRemoteToolName: string | null = null
        let matchedServerUserId: string | null = null
        const cachedShape = (servers ?? []) as Array<{
          id: string
          user_id: string
          display_name: string
          tools_cache: Array<{ name: string }> | null
          disabled_tools: string[] | null
          allowed_tools?: string[] | null
        }>
        for (const s of cachedShape) {
          for (const t of s.tools_cache ?? []) {
            if (namespacedToolName(s.display_name, t.name) === params.tool_name) {
              // Switched off, or new (not on the allow-list yet: tool-access.ts).
              if (isMcpToolHidden(s, t.name)) continue
              matchedServerId = s.id
              matchedServerName = s.display_name
              matchedRemoteToolName = t.name
              matchedServerUserId = s.user_id
              break
            }
          }
          if (matchedServerId) break
        }

        if (!matchedServerId || !matchedRemoteToolName) {
          return {
            success: false,
            error: `No enabled external MCP tool found matching "${params.tool_name}". Refresh the server's tools cache or check that it is enabled.`,
          }
        }

        const { count } = await supabase
          .from('proposed_change')
          .select('id', { count: 'exact', head: true })
          .eq('capture_id', captureId)

        const { data, error } = await supabase
          .from('proposed_change')
          .insert({
            workspace_id: workspaceId,
            capture_id: captureId,
            change_type: 'mcp_call',
            entity_type: 'external',
            entity_id: null,
            display_text: params.display_text,
            title: null,
            description: null,
            team_id: teamId,
            project_id: projectId,
            trigger_quote: params.trigger_quote || null,
            reasoning: params.reasoning || null,
            confidence: params.confidence ?? 0.5,
            sort_order: count || 0,
            status: 'pending',
            extra: {
              server_id: matchedServerId,
              // Pin the proposing user. Apply-time checks that the
              // applier matches this — otherwise the proposal is treated
              // as MCP_SERVER_DISCONNECTED and the UI prompts re-connect.
              server_user_id: matchedServerUserId,
              server_name: matchedServerName,
              tool_name: matchedRemoteToolName,
              namespaced_tool_name: params.tool_name,
              args: params.args,
            },
          })
          .select('id, display_text')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, id: data.id, display_text: data.display_text }
      },
    }),

    get_project_details: tool({
      description: 'Get full details of a project including milestones and recent actions.',
      inputSchema: z.object({
        project_id: z.string().describe('The project ID'),
      }),
      execute: async ({ project_id }) => {
        // Service-role client on the eve path: fence the project to this
        // workspace, or a spoken / hallucinated id reads another workspace's
        // project. Milestones have no workspace column, so they are returned
        // only once the project passed that check.
        const [projectRes, milestonesRes, actionsRes] = await Promise.all([
          supabase.from('projects').select('*').eq('id', project_id).eq('workspace_id', workspaceId).maybeSingle(),
          supabase.from('milestone').select('id, name, status, target_date').eq('project_id', project_id).order('target_date'),
          supabase.from('actions').select('id, title, priority, status_id, assignee_id').eq('project_id', project_id).eq('workspace_id', workspaceId).limit(10),
        ])
        if (!projectRes.data) {
          return { project: null, milestones: [], recent_actions: [] }
        }

        return {
          project: projectRes.data,
          milestones: milestonesRes.data || [],
          recent_actions: actionsRes.data || [],
        }
      },
    }),

    // ─── Capture titling (scoped to this capture) ───

    set_capture_title: tool({
      description:
        'Give this capture a short, specific title (3-8 words) derived from what the meeting was actually about — e.g. "Koko Link PLP 503 debugging" or "Q3 roadmap planning with Sarah". Use this ONLY when the capture is still untitled (its title is blank or the generic "Untitled Capture"); the server refuses to overwrite a title the user already set. Call it once, near the end of a batch pass.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('The concise, specific meeting title'),
      }),
      execute: async ({ title }) => {
        // Server-enforced: never clobber a real user-set title. Only fill in
        // when the capture is still at the creation default / blank. Uses the
        // same isUntitledCapture predicate as the groom module so the guard and
        // the prompt agree on what "untitled" means.
        const { data: cap } = await supabase
          .from('captures')
          .select('title')
          .eq('id', captureId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        if (!isUntitledCapture(cap?.title as string | null)) {
          return { success: false, error: 'capture already has a user-set title; not overwritten' }
        }
        const clean = title.trim().slice(0, 120)
        const { error } = await supabase
          .from('captures')
          .update({ title: clean })
          .eq('id', captureId)
          .eq('workspace_id', workspaceId)
        if (error) return { success: false, error: error.message }
        return { success: true, title: clean }
      },
    }),

    // ─── Summary writing (scoped to this capture) ───

    write_summary: tool({
      description: 'Create the initial meeting summary or completely rewrite it. Call this ONCE at the start to establish the summary structure, then use update_summary for subsequent edits. Include <!-- proposal:ID --> markers in the markdown where proposed changes are referenced, using the ID returned from propose_change. Each proposal ID must appear exactly ONCE.',
      inputSchema: z.object({
        ai_summary: z.string().describe('Full markdown summary of the meeting so far'),
      }),
      execute: async ({ ai_summary }) => {
        const { error } = await supabase
          .from('captures')
          .update({ ai_summary })
          .eq('id', captureId)
          .eq('workspace_id', workspaceId)

        if (error) return { success: false, error: error.message }
        return { success: true }
      },
    }),

    update_summary: tool({
      description: 'Make a surgical edit to the existing summary. Use this instead of write_summary when adding, replacing, or inserting content. Operations: "replace" swaps exact text, "insert_after" adds new content after a match, "append_section" adds a bullet or paragraph to a section identified by its header.',
      inputSchema: z.object({
        operation: z.enum(['replace', 'insert_after', 'append_section']).describe(
          'replace: find exact text and swap it. insert_after: insert new content on the next line after the matched text. append_section: append content to the end of a section (matched by header text).',
        ),
        find_text: z.string().describe(
          'The exact text to find in the current summary. For replace/insert_after: the precise string to match. For append_section: the section header text (e.g. "Key Discussion Points").',
        ),
        new_text: z.string().describe(
          'For replace: the replacement text. For insert_after: the text to insert on the next line. For append_section: the content to append (e.g. a new bullet point).',
        ),
        proposal_id: z.string().nullable().optional().describe(
          'If this edit relates to a proposed change, include its ID so a <!-- proposal:ID --> marker is inserted alongside the new text.',
        ),
      }),
      execute: async ({ operation, find_text, new_text, proposal_id }) => {
        // Fetch current summary
        const { data: current } = await supabase
          .from('captures')
          .select('ai_summary')
          .eq('id', captureId)
          .eq('workspace_id', workspaceId)
          .single()

        const summary = current?.ai_summary || ''
        if (!summary) {
          return { success: false, error: 'No summary exists yet — use write_summary first' }
        }

        // Append proposal marker to new_text if provided
        const textWithMarker = proposal_id
          ? `${new_text}\n<!-- proposal:${proposal_id} -->`
          : new_text

        let updated: string

        if (operation === 'replace') {
          if (!summary.includes(find_text)) {
            return { success: false, error: `Could not find exact text: "${find_text.slice(0, 80)}..."` }
          }
          // Replace first occurrence only
          updated = summary.replace(find_text, () => textWithMarker)
        } else if (operation === 'insert_after') {
          if (!summary.includes(find_text)) {
            return { success: false, error: `Could not find exact text: "${find_text.slice(0, 80)}..."` }
          }
          const idx = summary.indexOf(find_text) + find_text.length
          // Insert on the next line after the matched text
          updated = summary.slice(0, idx) + '\n' + textWithMarker + summary.slice(idx)
        } else {
          // append_section: find the section, then append before the next header or end.
          // Strip leading #s from find_text so it works whether the AI passes
          // "Content Discussion" or "## Content Discussion".
          const headerText = find_text.replace(/^#{1,4}\s*/, '').trim()
          const escapedText = headerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

          // Try multiple patterns to find the section header:
          // 1. Markdown header: ## Content Discussion
          // 2. Bold header: **Content Discussion**
          // 3. Plain text containing the section name
          const patterns = [
            new RegExp(`(^|\\n)(#{1,4}\\s*${escapedText}[^\\n]*)`, 'i'),
            new RegExp(`(^|\\n)(\\*\\*${escapedText}\\*\\*[^\\n]*)`, 'i'),
            new RegExp(`(^|\\n)([^\\n]*${escapedText}[^\\n]*)`, 'i'),
          ]

          let headerMatch: RegExpMatchArray | null = null
          for (const pattern of patterns) {
            headerMatch = summary.match(pattern)
            if (headerMatch) break
          }

          if (!headerMatch) {
            return { success: false, error: `Could not find section header matching: "${find_text}"` }
          } else {
            const headerStart = summary.indexOf(headerMatch[2], headerMatch.index ?? 0)
            const headerEnd = headerStart + headerMatch[2].length
            // Determine header level from the matched header (default to ## if not a markdown header)
            const headerLevel = (headerMatch[2].trimStart().match(/^#{1,4}/)?.[0] || '##').length
            const restOfDoc = summary.slice(headerEnd)
            const nextHeaderRegex = new RegExp(`^#{1,${headerLevel}}\\s`, 'm')
            const nextHeaderMatch = restOfDoc.match(nextHeaderRegex)
            const insertPos = nextHeaderMatch?.index != null
              ? headerEnd + nextHeaderMatch.index
              : summary.length

            // Insert before the next header (or at end), with a newline
            const before = summary.slice(0, insertPos).trimEnd()
            const after = summary.slice(insertPos)
            updated = before + '\n' + textWithMarker + '\n' + after
          }
        }

        const { error } = await supabase
          .from('captures')
          .update({ ai_summary: updated })
          .eq('id', captureId)
          .eq('workspace_id', workspaceId)

        if (error) return { success: false, error: error.message }
        return { success: true }
      },
    }),

    // ─── Relaying to the note-taker (the paired assist-only copilot only) ───
    // The ceiling admits this on an assist-only live turn and nowhere else
    // (PAIRED_COPILOT_ONLY_TOOLS): the copilot writes no record, so when the
    // user asks it to note something it hands the ask to the note-taker, whose
    // next record-writing turn reads it (live-agent messaging L2).

    direct_notes: tool({
      description:
        'Pass something the user asked to have recorded to the note-taker, which writes this meeting\'s notes. Use it ONLY when the user explicitly asks for something to go in the notes, e.g. "note that Dana owns the budget" or "put the Friday deadline in the notes". Pass their ask in their own words, one ask per call. It is not for your own observations, and nothing you pass is shown to anyone in the room.',
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(LIVE_DIRECTIVE_MAX_CHARS)
          .describe('What the user asked the note-taker to record, in their words'),
      }),
      execute: async ({ text }) => {
        // A mock call reads no directives (the route skips them on eval
        // captures), so nothing is written; the graded signal is the call.
        if (isEvalCapture) return { success: true, eval_suppressed: true }
        const target = await checkDirectiveTarget(supabase, { captureId, workspaceId, userId })
        if (!target.ok) return { success: false, error: target.message }
        const inserted = await insertDirective(supabase, {
          captureId,
          workspaceId,
          userId,
          source: 'copilot',
          text,
        })
        if (!inserted.ok) return { success: false, error: inserted.message }
        return { success: true, directive_id: inserted.directive.id }
      },
    }),

    load_skill: tool({
      description:
        'Load the call playbook that fits this call, by name, from the list under "Call playbook" in your context. It returns the playbook (what to do and when to speak on this kind of call) and keeps it for the rest of the call, so later turns carry it without loading again. Load one as soon as you can tell what kind of call this is, or switch when the call clearly turns into a different kind. Instructions only: it changes nothing in the workspace.',
      inputSchema: z.object({
        skill: z.string().min(1).max(100).describe('The playbook name exactly as listed, e.g. "investor-pitch".'),
      }),
      execute: async ({ skill }) => {
        const playbooks = await loadCallPlaybooks(supabase, { workspaceId, userId })
        const match = matchCallPlaybook(playbooks, skill)
        if (!match) {
          return { error: `Unknown playbook "${skill}".`, available: playbooks.map((p) => p.name) }
        }
        // Best-effort: with no write, this turn still has the playbook and the next one shows the cards again.
        const kept = await saveActivePlaybookName(supabase, captureId, match.name)
        return {
          skill: match.name,
          instructions: match.markdown,
          kept_for_call: kept,
          note: 'Follow this playbook for the rest of the call.',
        }
      },
    }),
  }
}
