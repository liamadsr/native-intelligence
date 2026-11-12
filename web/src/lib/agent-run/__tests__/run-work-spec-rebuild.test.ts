/**
 * Unit tests for the work-run ceiling (Loops v3 work proposals).
 *
 * computeWorkRunCeiling IS the single source of the work-agent's tool surface —
 * the registry tools whose required `sideEffect` classification is in
 * WORK_RUN_ADMITTED_SIDE_EFFECTS (read, internal-write). WORK_RUN_EXCLUDED_TOOLS
 * is derived from the same classification. Both the eve spec-rebuild (what to
 * advertise) and the internal tool route (what to enforce) call it. These tests
 * pin the rule, the tools that drifted into the old hand-kept list's gaps, and
 * the current excluded set by name.
 */
import { describe, it, expect } from 'vitest'
import { computeDraftingCeiling, computeWorkRunCeiling } from '../run-work-spec-rebuild'
import { WORK_RUN_EXCLUDED_TOOLS } from '../types'
import {
  ALL_TOOL_NAMES,
  TOOL_CATEGORIES,
  WORK_RUN_ADMITTED_SIDE_EFFECTS,
  ATTENDED_ONLY_TOOL_NAMES,
  CHAT_NATIVE_TOOL_NAMES,
  getToolSideEffect,
  isAttendedOnlyTool,
  isChatNativeTool,
} from '@/lib/ai/tool-registry'

/**
 * Every tool the old hand-maintained WORK_RUN_EXCLUDED_TOOLS held. The
 * structural rule must keep each one out; if a reclassification re-admits one,
 * this fails by name.
 */
const HISTORIC_EXCLUDED = [
  'publish_draft',
  'publish_prospect_list',
  'push_action_to_asana',
  'push_action_to_jira',
  'push_action_to_linear',
  'create_flow',
  'update_flow',
  'update_sequence',
  'update_skill',
  'create_skill',
  'accept_proposal',
  'create_calendar_event',
  'update_calendar_event',
  'sync_calendar',
  'delete_action',
  'delete_calendar_event',
  'delete_flow',
  'delete_label',
] as const

describe('computeWorkRunCeiling', () => {
  const ceiling = computeWorkRunCeiling()

  it('keeps every tool the old hand-kept exclusion list held OUT (membership, by name)', () => {
    for (const name of HISTORIC_EXCLUDED) {
      expect(ALL_TOOL_NAMES, `${name} is a registry tool`).toContain(name)
      expect(ceiling.has(name), `${name} must be outside the ceiling`).toBe(false)
      expect(WORK_RUN_EXCLUDED_TOOLS, `${name} is in the derived excluded list`).toContain(name)
    }
  })

  it('excludes every derived-excluded tool', () => {
    for (const name of WORK_RUN_EXCLUDED_TOOLS) {
      expect(ceiling.has(name)).toBe(false)
    }
  })

  it('excludes publish_draft and every delete_* tool concretely', () => {
    expect(ceiling.has('publish_draft')).toBe(false)
    expect(ceiling.has('delete_action')).toBe(false)
    expect(ceiling.has('delete_calendar_event')).toBe(false)
    expect(ceiling.has('delete_flow')).toBe(false)
    expect(ceiling.has('delete_label')).toBe(false)
  })

  it('excludes publish_prospect_list — the prospecting tool that writes the CRM', () => {
    // Structurally the same as publish_draft: a curated draft (the prospect list)
    // becomes permanent CRM companies/contacts. Its curation-only sibling
    // save_prospect_entries writes nothing to the CRM and stays IN.
    expect(ceiling.has('publish_prospect_list')).toBe(false)
    expect(ceiling.has('save_prospect_entries')).toBe(true)
  })

  it('excludes every push_action_to_* tool — each creates a real third-party issue/task', () => {
    for (const name of ['push_action_to_asana', 'push_action_to_jira', 'push_action_to_linear']) {
      expect(ceiling.has(name)).toBe(false)
    }
    // Pinned by name, not by prefix scan, so a future rename cannot quietly
    // empty this check: the three names must still be real registry tools.
    for (const name of ['push_action_to_asana', 'push_action_to_jira', 'push_action_to_linear']) {
      expect(ALL_TOOL_NAMES).toContain(name)
    }
  })

  it('excludes create_flow and update_flow — a flow fires HTTP at a caller-chosen URL', () => {
    // create_flow builds an enabled-by-default outbound automation; update_flow can
    // re-point an existing one (and, before the carry-over fix, its stored bearer
    // token) at a new host. update_action emits the status change that fires them,
    // so either tool lets a run arrange its own outbound request. Pinned by name so
    // closing one cannot silently leave the other open.
    expect(ceiling.has('create_flow')).toBe(false)
    expect(ceiling.has('update_flow')).toBe(false)
    expect(ceiling.has('delete_flow')).toBe(false)
    expect(ceiling.has('list_flows')).toBe(true)
    for (const name of ['create_flow', 'update_flow']) expect(ALL_TOOL_NAMES).toContain(name)
  })

  it('excludes update_sequence — it can resume a launched sequence and rewrite unsent copy', () => {
    // Pause leaves auto_send on, so resume re-arms real outbound email on the next
    // dispatch tick; step copy stays editable while contacts are enrolled. The
    // draft/staging siblings never send and stay IN.
    expect(ceiling.has('update_sequence')).toBe(false)
    expect(ALL_TOOL_NAMES).toContain('update_sequence')
    expect(ceiling.has('create_sequence')).toBe(true)
    // Sequence step 2 (plan A.2): enrolling is the external act once a sequence
    // is live — 'external-write', out of the ceiling. Un-enrolling stays in.
    expect(ceiling.has('enroll_contacts_in_sequence')).toBe(false)
    expect(ceiling.has('remove_from_sequence')).toBe(true)
  })

  it('excludes update_skill and create_skill — automation re-aim and Discover publish', () => {
    // An act-mode run_skill flow runs the skill with the skill's OWN ceiling,
    // rebuilt from the live recipe row at fire time — which does not subtract this
    // list. update_skill rewrites that row's prompt and agent_config, and
    // update_action (in the ceiling) fires the flow. create_skill accepts
    // visibility:'public' (Discover, every tenant). Pinned by name.
    expect(ceiling.has('update_skill')).toBe(false)
    expect(ceiling.has('create_skill')).toBe(false)
    for (const name of ['update_skill', 'create_skill']) expect(ALL_TOOL_NAMES).toContain(name)
    // Reading skills stays in.
    expect(ceiling.has('list_skills')).toBe(true)
    expect(ceiling.has('get_skill')).toBe(true)
  })

  it('excludes accept_proposal — the apply engine runs staged mcp_call:external and deletes', () => {
    // auto-apply-gate stages MCP calls and deletes for a HUMAN; accept_proposal is
    // the registry path that would execute them. Listing and discarding stay in.
    expect(ceiling.has('accept_proposal')).toBe(false)
    expect(ALL_TOOL_NAMES).toContain('accept_proposal')
    expect(ceiling.has('get_action_suggestions')).toBe(true)
    expect(ceiling.has('dismiss_proposal')).toBe(true)
  })

  it('excludes provider-write calendar tools — event writes email attendees', () => {
    // create/update calendar event with attendees sends real invitations via the
    // provider (Graph POST /me/events) — external-write. sync_calendar makes no
    // provider write but runs the bulk calendar→capture sync job (contacts for
    // every external attendee, pending captures) — automation-write.
    expect(ceiling.has('create_calendar_event')).toBe(false)
    expect(ceiling.has('update_calendar_event')).toBe(false)
    expect(ceiling.has('sync_calendar')).toBe(false)
  })

  it('keeps READ calendar + internal-only meeting tools (no third-party email)', () => {
    // Reading the calendar and preparing for meetings has no external side effect;
    // create_capture_from_event reads the provider but only writes a workspace
    // capture — none of these email anyone, so they stay in the ceiling.
    expect(ceiling.has('get_calendar_events')).toBe(true)
    expect(ceiling.has('get_upcoming_meetings')).toBe(true)
    expect(ceiling.has('get_meeting_prep')).toBe(true)
    expect(ceiling.has('create_capture_from_event')).toBe(true)
  })

  it('keeps the draft/document/board write tools (the whole point of a work run)', () => {
    expect(ceiling.has('create_email_draft')).toBe(true)
    expect(ceiling.has('create_document')).toBe(true)
    expect(ceiling.has('update_document')).toBe(true)
    expect(ceiling.has('create_action')).toBe(true)
    expect(ceiling.has('update_action')).toBe(true)
    expect(ceiling.has('complete_action')).toBe(true)
  })

  it('pins the exact excluded set by name (membership, not just size)', () => {
    // A reclassification that re-admits a tool, or excludes a new one, is a
    // visible, reviewed change to this list. The last four are the tools the
    // side-effect classification excluded that the old hand list admitted.
    expect([...WORK_RUN_EXCLUDED_TOOLS].sort()).toEqual(
      [
        ...HISTORIC_EXCLUDED,
        'start_eval_run',
        // Work agents use their native policy-gated delegation tool, never
        // chat's root-launching registry tools (background helpers).
        'start_helper',
        'stop_helper',
        'unlink_document_from_action',
        'unlink_entities',
        'remove_from_package',
        // Sequence step 2 (plan A.2): enrolment is an external write.
        'enroll_contacts_in_sequence',
        // Bringing customers in (roadmap track G): undoing an import deletes the contacts it added.
        'undo_contact_import',
        // Roadmap D1/D2: a launch arms sending on the person's yes (external writes).
        'launch_sequence',
        'launch_campaign',
        // Roadmap D3: marking a job done emails the customer their review request,
        // and the review link is what every such email carries (automation write).
        'complete_job',
        'set_review_link',
        // Roadmap E: each opens a pull request on the business's website repo (automation writes).
        'wire_website_form',
        'change_website',
        'undo_website_change',
        // Custom vocabulary (migration 430): removing a word is a delete. (The
        // add/update tools are internal writes and refuse unattended runs themselves.)
        'delete_vocabulary_word',
        // Studio (migration 620): moving a video to the trash is classed a delete; the
        // Studio's reads and its artifact writes stay in.
        'archive_studio_video',
        // Studio: narration and generated shots spend on the workspace's own provider accounts
        // (external writes; the person's approval card decides, never an unattended run).
        'generate_studio_narration',
        'generate_studio_shot',
        // In-app browser: acting on the open web through Jev and
        // opening/closing the user's browser window are external writes, so an
        // unattended work run can READ the browser (read_browser_page,
        // get_browser_text, screenshot_browser stay in) but not act in it.
        'run_browser_task',
        'open_browser',
        'close_browser',
        // Bots v3 Phase 5: a bot's attended-only writes. settle_card is an
        // automation write and undo_extraction_pass a delete; revise_email_draft
        // is an internal write, out because it is attended-only.
        'settle_card',
        'undo_extraction_pass',
        'revise_email_draft',
        // Bots-v4 Phase A1: the main agent's reads of the bots' work. Reads,
        // out because they are attended-only.
        'list_bot_work',
        'get_bot_item',
        // Bots-v4 Phase A2: the main agent's writes on the bots' work. An
        // internal write and an automation write, out as attended-only too.
        'settle_work_item',
        'send_work_answer',
        // GEN-1168: the main agent renames, deletes and merges the bots. An
        // automation write and two deletes, out as attended-only too.
        'rename_bot',
        'delete_bot',
        'merge_bots',
        // Bots-v4 Phase A3: the main agent's relay to the bots, chat-native.
        // send_bot_message is an automation write; wait_for_bot_reply is a
        // read, out because only the main chat runs it.
        'send_bot_message',
        'wait_for_bot_reply',
        // The local agents on the person's Mac (docs/plans/local-agents.md),
        // chat-native: the reads (local_agents, read_local_agent) are out
        // because only the main chat runs them, the rest as automation writes.
        'local_agents',
        'start_local_agent',
        'message_local_agent',
        'read_local_agent',
        'stop_local_agent',
        // Guest access (429): the main agent's answer to a guest's ask, an
        // outward write the main chat alone runs.
        'answer_guest',
        // Agent links (435): the main agent asking a linked person's agent, an
        // outward write the main chat alone runs.
        'ask_agent',
        // Their cloud counterpart (docs/plans/environments.md E2), an
        // automation write the main chat alone runs.
        'start_cloud_coding_run',
        // One-agent plan Part 3: the main agent's memory, an internal write,
        // out as attended-only (only the person says what to remember).
        'remember',
        // The person's Now file (docs/plans/now-file.md), the main agent's
        // sketchpad: an internal write, out as attended-only.
        'update_now',
        // Getting started (docs/plans/getting-started-skill.md): the person's
        // own turn ends it, an internal write, out as attended-only.
        'finish_getting_started',
        // Pages in the chat: read_card reads a card on the person's screen,
        // a read, out because it is attended-only.
        'read_card',
        // F1: handing a loop to another member, an automation write behind
        // the new owner's card, attended-only.
        'transfer_flow_owner',
        // F1: asking a loop's owner for it, behind the owner's card, attended-only.
        'request_flow_takeover',
        // F1: a dry run of a loop (its skills run, nothing is delivered), attended-only.
        'test_flow',
        // Documents phase 1: rolling a document back is the person's call, an
        // internal (artifact) write, out as attended-only.
        'restore_document_revision',
        // Canon D2: undoing one edit at section level, the same call one section at a time.
        'revert_section_edit',
        // Flows-connectors F2: the person's connections, all out as attended-only.
        'list_connections',
        'connect',
        'disconnect',
        'set_tool_access',
        // Content C0: the post review needs the chat's writer model, out as attended-only.
        'review_post',
        // C2a: posting through Typefully, only on the person's own card.
        'publish_post',
        'schedule_post',
        // GEN-1166: the inbox triage, while the person looks; unsubscribing only on their card.
        'update_email_thread',
        'unsubscribe_thread',
        // Roadmap B: what the business's customers are told, and its website
        // form's secret link, internal writes out as attended-only.
        'update_business_profile',
        'create_quote_form_link',
        // Availability: the person's working hours, an internal write out as attended-only.
        'set_working_hours',
        // Availability phase 4a: booking links, made and changed only at the person's word.
        'create_booking_link',
        'update_booking_link',
        'delete_booking_link',
        // GEN-1169: deleting a document is a delete, only on the person's own card.
        // (Archiving and restoring are internal writes and stay in.)
        'delete_document',
        // GEN-1165: discarding Native Intelligence's drafts is a delete, attended-only.
        'discard_email_draft',
        // Roadmap C2: a payment link to a customer, an external write, only on the owner's own card.
        'send_payment_link',
        // Roadmap F3: the owner's answer to a quote (its text, or the booked time), external writes on their own card.
        'send_quote',
        'book_quote',
        // Issue #11's follow-up: the owner's own move or cancel of a booking texts the customer, an external write.
        'move_booking',
        'cancel_booking',
        // Availability phase 3a: offering an outside guest times, booking or cancelling one, external writes.
        'offer_times',
        'cancel_offered_meeting',
        'accept_time_offer',
        // Availability phase 5: a poll's answer that may book, its time booked anyway, its reminder, external writes.
        'record_time_offer_answer',
        'book_poll_time',
        'nudge_time_offer',
      ].sort(),
    )
  })

  it('never holds a chat-native tool, whatever its class (bots-v4 Phase A3: wait_for_bot_reply is a read)', () => {
    for (const name of CHAT_NATIVE_TOOL_NAMES) {
      expect(ceiling.has(name), name).toBe(false)
      expect(computeDraftingCeiling().has(name), name).toBe(false)
      expect(WORK_RUN_EXCLUDED_TOOLS, name).toContain(name)
    }
    expect(getToolSideEffect('wait_for_bot_reply')).toBe('read')
  })

  it('never holds an attended-only tool, whatever its class (bots v3 Phase 5)', () => {
    for (const name of ATTENDED_ONLY_TOOL_NAMES) {
      expect(ceiling.has(name), name).toBe(false)
      expect(WORK_RUN_EXCLUDED_TOOLS, name).toContain(name)
    }
    expect(getToolSideEffect('revise_email_draft')).toBe('internal-write')
  })

  it('keeps the in-app browser READ tools (a work run may look, not act)', () => {
    expect(ceiling.has('read_browser_page')).toBe(true)
    expect(ceiling.has('get_browser_text')).toBe(true)
    expect(ceiling.has('screenshot_browser')).toBe(true)
  })

  it('every excluded name is a real registry tool', () => {
    const registry = new Set(ALL_TOOL_NAMES)
    for (const name of WORK_RUN_EXCLUDED_TOOLS) expect(registry.has(name)).toBe(true)
  })

  it('is exactly the registry tools classified read or internal-write', () => {
    const admitted = TOOL_CATEGORIES.flatMap((c) => c.tools)
      .filter((t) => WORK_RUN_ADMITTED_SIDE_EFFECTS.has(t.sideEffect) && !isAttendedOnlyTool(t.name) && !isChatNativeTool(t.name))
      .map((t) => t.name)
    expect([...ceiling].sort()).toEqual([...new Set(admitted)].sort())
  })

  it('WORK_RUN_EXCLUDED_TOOLS is derived: exactly the registry tools outside the admitted classes', () => {
    const notAdmitted = TOOL_CATEGORIES.flatMap((c) => c.tools)
      .filter((t) => !WORK_RUN_ADMITTED_SIDE_EFFECTS.has(t.sideEffect) || isAttendedOnlyTool(t.name) || isChatNativeTool(t.name))
      .map((t) => t.name)
    expect([...WORK_RUN_EXCLUDED_TOOLS].sort()).toEqual([...new Set(notAdmitted)].sort())
    // The two partition the registry: nothing is in both, nothing in neither.
    for (const name of ALL_TOOL_NAMES) {
      expect(ceiling.has(name) !== WORK_RUN_EXCLUDED_TOOLS.includes(name), name).toBe(true)
    }
  })

  it('is zero-argument, synchronous, and returns a fresh Set each call', () => {
    expect(computeWorkRunCeiling.length).toBe(0)
    const a = computeWorkRunCeiling()
    const b = computeWorkRunCeiling()
    expect(a).toBeInstanceOf(Set)
    expect(a).not.toBe(b)
    expect([...a]).toEqual([...b])
    // Prototype-magic names are plain misses on a Set.
    for (const name of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      expect(a.has(name), name).toBe(false)
    }
  })

  it('does not advertise search_tools as a registry proxy (it is added by the tool route)', () => {
    // search_tools is not a registry tool; it must never appear in the ceiling set
    // (the tool route reaches it via its own harness, not a proxy).
    expect(ceiling.has('search_tools')).toBe(false)
  })
})
