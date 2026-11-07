/**
 * Canonical registry of all AI tool categories and their tools.
 * Single source of truth used by: skill/agent creation UI, system prompt builder, agent_config validation.
 */
import { RUN_BROWSER_TASK_DESCRIPTION } from '@/lib/browser-agent/task-instructions'
import { ENRICH_CONTACT_DESCRIPTION } from '@/lib/ai/tools/enrich-contact-text'

/**
 * What a tool DOES to the world, judged from its implementation (the tool's
 * execute body and everything it calls), never from its name or description.
 * Every registry entry carries exactly one; the field is REQUIRED, so a new
 * entry without it does not typecheck. src/lib/ai/__tests__/tool-side-effects.test.ts
 * re-checks the values at runtime (an `as` cast or hand-edited data cannot
 * slip an unknown string through).
 *
 *   - 'read'             — reads workspace data, or performs an external READ
 *                          with no effect outside this workspace's rows. Exa /
 *                          web research counts as a read even though it spends
 *                          money.
 *   - 'internal-write'   — creates or updates rows in this workspace's own
 *                          tables only. Sends nothing outside the app, changes
 *                          no automation or config that other runs execute,
 *                          deletes nothing. Unsent email DRAFTS, dismiss /
 *                          confirm / archive soft states, and an update that
 *                          replaces the entity's OWN join rows (labels,
 *                          assignees) belong here. A write that fans out
 *                          through a mirror the workspace already configured (a
 *                          status-change flow, the opt-in HubSpot contact push)
 *                          stays here too; that trade-off is the OPEN
 *                          "configured mirrors" call above
 *                          WORK_RUN_EXCLUDED_TOOLS in src/lib/agent-run/types.ts.
 *   - 'external-write'   — leaves the workspace database: sends or publishes,
 *                          pushes to a connected tracker, writes a calendar
 *                          PROVIDER event (the provider emails the attendees),
 *                          publishes a prospect list, fires outbound HTTP,
 *                          calls an external MCP server.
 *   - 'automation-write' — changes what OTHER automations or agents execute or
 *                          can reach, or executes staged work: flows, sequence
 *                          edits, skill prompts / tool config, accepting staged
 *                          proposals, starting an eval run (it replays cases
 *                          through another agent at scale), running a sync job.
 *   - 'delete'           — hard-deletes rows: every delete_* tool, a tool
 *                          whose effect is removing a link or pin row, and
 *                          publish_draft (it hard-deletes the author's pending
 *                          draft row; its "publish" never leaves the DB).
 *
 * The work-run ceiling admits only WORK_RUN_ADMITTED_SIDE_EFFECTS, so a tool is
 * outside it unless its classification says read or internal write.
 */
export type ToolSideEffect = 'read' | 'internal-write' | 'external-write' | 'automation-write' | 'delete'

/** Every ToolSideEffect value, for runtime validation of registry data. */
export const TOOL_SIDE_EFFECTS: readonly ToolSideEffect[] = [
  'read',
  'internal-write',
  'external-write',
  'automation-write',
  'delete',
]

/**
 * The side-effect classes an unattended work run may hold (computeWorkRunCeiling
 * in src/lib/agent-run/run-work-spec-rebuild.ts). The ONE definition: the
 * ceiling, WORK_RUN_EXCLUDED_TOOLS and the tests all read this set.
 */
export const WORK_RUN_ADMITTED_SIDE_EFFECTS: ReadonlySet<ToolSideEffect> = new Set<ToolSideEffect>([
  'read',
  'internal-write',
])

/**
 * What an INTERNAL write lands on (Sequence step 2, plan Appendix A.3):
 *   artifact — a document, draft, claim, package, capture record, eval case:
 *              the run's own output, reviewed on its own surface;
 *   board    — actions, projects, initiatives, cycles, decisions, labels,
 *              comments, sequences, campaigns: the shared plan of record;
 *   crm      — contacts and companies.
 * The drafting ceiling (computeDraftingCeiling) admits read + artifact writes
 * only: an attempted run may produce, never re-plan the board or edit the CRM.
 */
export type WriteTarget = 'artifact' | 'board' | 'crm'
export const WRITE_TARGETS: readonly WriteTarget[] = ['artifact', 'board', 'crm']

interface ToolDefinitionBase {
  name: string
  label: string
  description: string
}

/**
 * A registry entry. `sideEffect` is required (an entry without a classification
 * must not compile); an internal write must also say what it writes
 * (`writeTarget`), and no other class may carry one.
 */
export type ToolDefinition =
  | (ToolDefinitionBase & { sideEffect: 'internal-write'; writeTarget: WriteTarget })
  | (ToolDefinitionBase & { sideEffect: Exclude<ToolSideEffect, 'internal-write'>; writeTarget?: undefined })

export interface ToolCategory {
  id: string
  label: string
  description: string
  icon: string
  tools: ToolDefinition[]
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'captures',
    label: 'Captures',
    description: 'Meeting notes, transcripts, and session recordings',
    icon: '🎙️',
    tools: [
      { name: 'list_captures', sideEffect: 'read', label: 'List Captures', description: 'List captures in a project (requires project_id)' },
      { name: 'list_recent_captures', sideEffect: 'read', label: 'Recent Captures', description: 'List the workspace\'s most recent captures across all projects' },
      { name: 'list_contact_captures', sideEffect: 'read', label: 'Contact Captures', description: 'List captures a specific contact participated in' },
      { name: 'get_capture_content', sideEffect: 'read', label: 'Read Capture', description: 'Get full capture content by ID — use search to find by name first' },
      { name: 'get_capture_transcript', sideEffect: 'read', label: 'Get Transcript', description: 'Get a capture\'s raw transcript, a page at a time (next_offset continues)' },
      { name: 'create_capture', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Capture', description: 'Create a new capture session' },
      { name: 'update_capture', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Update Capture', description: 'Update capture title or metadata' },
      { name: 'get_capture_extractions', sideEffect: 'read', label: 'Get Extractions', description: 'Get AI-extracted items from a capture' },
      { name: 'edit_capture_content', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Edit Content', description: 'Make a surgical text edit to a capture field' },
      { name: 'archive_capture', sideEffect: 'internal-write', writeTarget: 'board', label: 'Archive Capture', description: 'Archive a capture (soft delete)' },
      { name: 'tell_note_taker', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Tell the Note-taker', description: "During a live meeting, pass on something the user asked to have recorded in the meeting's notes" },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): deletes the entities one extraction pass created.
      { name: 'undo_extraction_pass', sideEffect: 'delete', label: 'Undo Extraction', description: 'Undo what one extraction pass filed from a capture (only that pass\'s entries), putting its proposals back for review, when the person asks you to' },
      { name: 'list_recipes', sideEffect: 'read', label: 'List Skills & Agents', description: 'List available library Skills and Agents (recipes)' },
      // Custom vocabulary (migration 430): words transcription should get right, fixed by sound in transcripts and dictation.
      { name: 'list_vocabulary', sideEffect: 'read', label: 'List Vocabulary', description: 'List the custom vocabulary (words transcription should spell right), the words harvested from what the team writes, and the names added automatically' },
      { name: 'add_vocabulary_word', sideEffect: 'internal-write', writeTarget: 'board', label: 'Add Vocabulary Word', description: 'Add a word to the custom vocabulary (a product, person or acronym transcription gets wrong), with how it is misheard' },
      { name: 'update_vocabulary_word', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Vocabulary Word', description: 'Fix a vocabulary word, turn it off or on, or move it between workspace and personal' },
      { name: 'delete_vocabulary_word', sideEffect: 'delete', label: 'Delete Vocabulary Word', description: 'Remove a word from the custom vocabulary' },
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    description: 'Tasks, to-dos, and work items',
    icon: '✅',
    tools: [
      // Main chat only (CHAT_NATIVE_TOOL_NAMES): background helpers (always-on-agent §4), run by the chat tool route itself.
      // Starting one starts paid background work that drafts; stopping one cancels a run.
      { name: 'start_helper', sideEffect: 'automation-write', label: 'Start Helper', description: "In main chat, hand a self-contained job to a background helper (or one of the person's custom agents) that reads and drafts while you keep talking, and reports back in this conversation. Once per job: a queued result starts on its own; a refusal or error is final unless the user asks again" },
      { name: 'stop_helper', sideEffect: 'automation-write', label: 'Stop Helper', description: "In main chat, stop one of the person's running helpers when they ask; what it drafted stays" },
      // Main chat only (CHAT_NATIVE_TOOL_NAMES): local agents on the person's Mac (docs/plans/local-agents.md), run by the chat tool route itself.
      // Starting one starts work on their Mac; a message starts or steers its turn; stopping one cancels it. The fence is the Mac's.
      { name: 'local_agents', sideEffect: 'read', label: 'Local Agents', description: "In main chat, the person's Macs (online or not), their environment (every folder they granted, available in every chat), and this chat's local agents with their status and last signal" },
      { name: 'start_local_agent', sideEffect: 'automation-write', label: 'Start a Local Agent', description: "In main chat, start a local agent on the person's Mac in one granted folder, with a request in words, when they ask for work there; it reports back here. Typed turns only; once per task" },
      { name: 'message_local_agent', sideEffect: 'automation-write', label: 'Message a Local Agent', description: "In main chat, send one of the person's local agents a message: an answer to its question, a steer while it works, or the next thing to do" },
      { name: 'read_local_agent', sideEffect: 'read', label: 'Read a Local Agent', description: "In main chat, read one local agent's transcript, compact: messages, replies, tool calls, reports, its question or finish summary" },
      { name: 'stop_local_agent', sideEffect: 'automation-write', label: 'Stop a Local Agent', description: "In main chat, stop one of the person's local agents when they ask; what it did stays" },
      // Main chat only (CHAT_NATIVE_TOOL_NAMES): the cloud counterpart (docs/plans/environments.md E2), run by the chat tool route itself.
      // It files an action and starts a coding run, which opens a pull request.
      // Main chat only (CHAT_NATIVE_TOOL_NAMES): guest access (migration 429). Texts the guest who asked, so outward.
      { name: 'answer_guest', sideEffect: 'external-write', label: 'Answer a Guest', description: "In main chat, answer a question one of the person's guests asked through the agent the person set up for them; it is texted to that guest" },
      { name: 'ask_agent', sideEffect: 'external-write', label: 'Ask Their Agent', description: "In main chat, ask or message another person's agent (a teammate's, or another Dial8 user's) for the person; the answer comes back to the chat on its own, and an unlinked name lists who is linked" },
      { name: 'start_cloud_coding_run', sideEffect: 'automation-write', label: 'Start a Cloud Coding Run', description: "In main chat, file an action in a project and start a coding run on its GitHub repository in this chat's cloud environment (or a shared one the person picks); it opens a pull request. Typed turns only; once per task" },
      { name: 'list_actions', sideEffect: 'read', label: 'List Actions', description: 'List and filter actions in the workspace' },
      { name: 'get_action', sideEffect: 'read', label: 'Get Action', description: 'Get full details for a single action by ID or identifier (e.g. ENG-42)' },
      { name: 'create_action', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Action', description: 'Create a new task or action item' },
      { name: 'update_action', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Action', description: 'Edit action details, priority, or assignee' },
      { name: 'complete_action', sideEffect: 'internal-write', writeTarget: 'board', label: 'Complete Action', description: 'Mark an action as done' },
      { name: 'list_workflow_states', sideEffect: 'read', label: 'List Workflow States', description: 'List a team\'s board columns / workflow states (Todo, In Progress, Done, etc.)' },
      { name: 'confirm_action', sideEffect: 'internal-write', writeTarget: 'board', label: 'Confirm Suggestion', description: 'Confirm an AI-suggested action' },
      { name: 'dismiss_action', sideEffect: 'internal-write', writeTarget: 'board', label: 'Dismiss Suggestion', description: 'Dismiss an AI-suggested action' },
      // automation-write: applyChange runs staged mcp_call:external and delete:action handlers
      { name: 'accept_proposal', sideEffect: 'automation-write', label: 'Accept Proposal', description: 'Promote a suggested capture proposal into a real entity in one call' },
      { name: 'dismiss_proposal', sideEffect: 'internal-write', writeTarget: 'board', label: 'Dismiss Proposal', description: 'Dismiss a pending capture proposal' },
      // An artifact write: it stages suggestions the person settles on their own surface; nothing on the board changes until they accept (docs/plans/suggestions-everywhere.md).
      { name: 'suggest_changes', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Suggest Changes', description: 'Stage changes to actions, projects, milestones (or an email to a contact) as one-click suggestions the person accepts, dismisses or modifies, instead of describing them in prose: close, move, reassign, reschedule, reprioritize, create. Name items by identifier (GEN-42). Each result has a marker to place after the text it belongs to' },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): accepting hands the card's proposal to the apply engine, like accept_proposal.
      { name: 'settle_card', sideEffect: 'automation-write', label: 'Settle Card', description: "Accept, dismiss or start one of the person's own pending cards (from list_bot_work, get_bot_item or a run), exactly as their click would, when they ask you to. Name the card by card_id" },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): the main agent reads the bots' work (bots-v4 Phase A1), the caller's own rows and cards only.
      { name: 'list_bot_work', sideEffect: 'read', label: 'List Agent Work', description: "Every one of the person's agents, busy or not, across their workspaces: each one's state (working, asleep or awake, and why it's asleep: switched off, attempts paused, stopped by the AI limit) and what it does; the busy ones with their waiting, new, seen and running counts and their items (cards, drafts, documents, questions) with ids, then the idle ones (capped, with a count). Answers which agents they have, why one is asleep, what one does, and what's pending. The Assistant (marked self) is the person's own agent: its work in every area, and work no other agent holds, is listed under it; sequence sends, which have no agent, by lane. One agent's detail by bot_id, or find agents by name (past the caps too)" },
      { name: 'get_bot_item', sideEffect: 'read', label: 'Get Agent Item', description: "Read one of the person's agents' waiting items in full: a draft's text, a document, a question with its options, a card's proposal" },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): the main agent acts on the bots' work (bots-v4 Phase A2), at the person's word, the caller's own items only.
      // Settling a review writes the person's own ledger row (and reads its notices), as their Reviewed / Dismiss click does.
      { name: 'settle_work_item', sideEffect: 'internal-write', writeTarget: 'board', label: 'Settle Agent Work', description: "Mark one of the person's agents' waiting reviews reviewed, or dismiss it, exactly as their click would, when they ask you to; dismiss also stops waiting on a question whose run is gone" },
      // Answering resumes the parked run, which then acts with its own tools: it executes staged work, like accepting a proposal.
      { name: 'send_work_answer', sideEffect: 'automation-write', label: 'Send an Agent an Answer', description: "Send the person's answer to a question one of their agents' runs is waiting on, so the run picks up from there, when they tell you the answer" },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): the main agent manages the person's agents (GEN-1168), under the
      // agent editor's own rules (src/lib/bots/manage-bots.ts). A rename changes how an agent shows to everyone.
      { name: 'rename_bot', sideEffect: 'automation-write', label: 'Rename an Agent', description: "Rename one of the person's agents (a bot_id from list_bot_work) when they ask; it applies at once" },
      // delete: removes the agent row (its chats and memories cascade), only from the person's verified card; refused while a loop points at it.
      { name: 'delete_bot', sideEffect: 'delete', label: 'Delete an Agent', description: "Delete one of the person's agents once they accept the card it raises, which says what goes with it; refused while a loop points at it" },
      // delete: folds duplicates into one (loops, work, cards, actions and memories move) and deletes the spares, only from the person's one card.
      { name: 'merge_bots', sideEffect: 'delete', label: 'Merge Agents', description: "Clean up the person's duplicate agents: one card lists what is kept and what is removed; on their accept the spares' loops and work move to the one kept and the spares are deleted. Finds the duplicates itself, or takes the groups" },
      // Main chat only (CHAT_NATIVE_TOOL_NAMES): the main agent talks to the bots (bots-v4 Phases A3/A4), run by the chat tool route itself.
      // Sending starts the bot's own turn, which acts with its own tools: a turn that may write, like an answer resuming a run.
      { name: 'send_bot_message', sideEffect: 'automation-write', label: 'Message an Agent', description: "Pass the person's message to one of their agents, in the chat of the run behind an item it has waiting or in the agent's own chat with them; the agent acts on it with its own tools and replies, when the person asks you to" },
      { name: 'wait_for_bot_reply', sideEffect: 'read', label: 'Wait for an Agent', description: "Wait for an agent's reply that send_bot_message handed off as still working" },
      { name: 'get_action_suggestions', sideEffect: 'read', label: 'Action Suggestions', description: 'Get AI-suggested actions for a capture' },
      { name: 'create_actions_batch', sideEffect: 'internal-write', writeTarget: 'board', label: 'Batch Create', description: 'Create multiple actions at once' },
      { name: 'list_labels', sideEffect: 'read', label: 'List Labels', description: 'List available labels for tagging actions' },
      { name: 'create_label', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Label', description: 'Create a new workspace label with name, color, scopes, and group' },
      { name: 'update_label', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Label', description: 'Rename, recolor, or rescope an existing label' },
      { name: 'delete_label', sideEffect: 'delete', label: 'Delete Label', description: 'Delete a label from the workspace permanently' },
      { name: 'delete_action', sideEffect: 'delete', label: 'Delete Action', description: 'Delete an action permanently' },
      { name: 'reorder_actions', sideEffect: 'internal-write', writeTarget: 'board', label: 'Reorder Actions', description: 'Reorder actions — pass all action IDs in desired new order' },
      { name: 'push_action_to_asana', sideEffect: 'external-write', label: 'Push to Asana', description: 'Push an action to the workspace\'s connected Asana project as a task and link the two' },
      { name: 'push_action_to_jira', sideEffect: 'external-write', label: 'Push to Jira', description: 'Push an action to the workspace\'s connected Jira project as an issue and link the two' },
      { name: 'push_action_to_linear', sideEffect: 'external-write', label: 'Push to Linear', description: 'Push an action to the workspace\'s connected Linear team as an issue and link the two' },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    description: 'Projects, milestones, and initiative tracking',
    icon: '📊',
    tools: [
      { name: 'list_projects', sideEffect: 'read', label: 'List Projects', description: 'List workspace projects' },
      { name: 'get_project_context', sideEffect: 'read', label: 'Project Context', description: 'Get full context for a project including actions and milestones' },
      { name: 'create_project', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Project', description: 'Create a new project' },
      { name: 'update_project', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Project', description: 'Edit project details or status' },
      { name: 'list_milestones', sideEffect: 'read', label: 'List Milestones', description: 'List milestones for a project' },
      { name: 'create_milestone', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Milestone', description: 'Create a project milestone' },
      { name: 'update_milestone', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Milestone', description: 'Edit a milestone' },
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    description: 'Docs, wiki pages, and reference material',
    icon: '📄',
    tools: [
      { name: 'list_documents', sideEffect: 'read', label: 'List Documents', description: 'List documents in the workspace' },
      { name: 'get_document', sideEffect: 'read', label: 'Read Document', description: 'Read a document with backlinks and outbound graph edges' },
      // Canon documents (D1): the workspace's ground truth, read by key (never searched for).
      { name: 'read_canon', sideEffect: 'read', label: 'Read Canon', description: 'Read a canon document (product, team playbook, a content brief, voice notes) by key, or one section of it' },
      // D2: a canon document from its template (fixed sections, empty). An ordinary document create.
      { name: 'create_canon_document', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Canon', description: 'Create a canon document (product, team playbook, a content brief, voice notes) from its template' },
      // D2, decision 16: one section edit, applied at once with its sources
      // (a revision, one digest line), labelled when it rests on outside text;
      // never a card. The same kind of write as replace_section.
      { name: 'propose_section_edit', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Edit Canon Section', description: 'Edit one section of a canon document by key (replace, append or remove), with its reason and sources' },
      // Undo one edit at section level: a text write, for a person in the chat
      // only (ATTENDED_ONLY_TOOL_NAMES), like restore_document_revision.
      { name: 'revert_section_edit', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Revert Edit', description: 'Undo just one edit to a document, at section level, keeping later edits to other sections' },
      { name: 'create_document', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Document', description: 'Create a new document' },
      { name: 'update_document', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Update Document', description: 'Edit document content directly (published, no draft)' },
      { name: 'edit_document_content', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Edit Content', description: 'Make a surgical text edit to a document' },
      // Part edits (documents phase 1): the same kind of write as
      // edit_document_content, addressed by line range or by heading; every one
      // is compare-and-swap and leaves a revision.
      { name: 'edit_document_lines', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Edit Lines', description: 'Replace, insert or delete lines of a document by line number' },
      { name: 'replace_section', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Replace Section', description: 'Replace one section of a document (by heading), leaving the rest as it is' },
      { name: 'append_to_section', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Add to Section', description: 'Add text at the end of one section of a document (by heading)' },
      { name: 'remove_section', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Remove Section', description: 'Remove one section of a document (by heading), subsections included' },
      { name: 'insert_section_after', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Insert Section', description: 'Add a new section to a document after an existing one (by heading)' },
      { name: 'propose_document_edit', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Propose Edit', description: 'Stage an edit to a document as a draft for the user to review' },
      // Version history (migration 364): every change to a document's text is a
      // revision. Reading it is a read; restoring one is an ordinary text write
      // (compare-and-swap, a new revision), for a person in the chat only
      // (ATTENDED_ONLY_TOOL_NAMES): an unattended run never rolls a document back.
      { name: 'list_document_revisions', sideEffect: 'read', label: 'Document History', description: "List a document's version history: who changed it (a person or Dial8), what and when" },
      { name: 'get_document_revision', sideEffect: 'read', label: 'Read Version', description: 'Read one version of a document and what that change did (a line diff)' },
      { name: 'restore_document_revision', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Restore Version', description: 'Put an earlier version of a document back, as a new revision (undo an edit)' },
      // Archive (GEN-1169): the soft delete, status 'archived', restorable with
      // its history. writeTarget board, like archive_capture: it changes what the
      // shared lists show, not a run's own output, so a drafting run never does it.
      { name: 'archive_document', sideEffect: 'internal-write', writeTarget: 'board', label: 'Archive Document', description: 'Archive documents (out of the lists and search, kept with their history, restorable)' },
      { name: 'restore_document', sideEffect: 'internal-write', writeTarget: 'board', label: 'Restore Document', description: 'Bring archived documents back, as they were' },
      { name: 'archive_reports', sideEffect: 'internal-write', writeTarget: 'board', label: 'Archive Reports', description: 'Archive many skill or loop reports (or meeting preps) at once: older than N days, in a window, or one skill\'s' },
      // The hard delete: attended only (ATTENDED_ONLY_TOOL_NAMES), and only on
      // the person's card (src/lib/documents/delete-card.ts); never a canon document.
      { name: 'delete_document', sideEffect: 'delete', label: 'Delete Document', description: 'Delete a document for good, once the person accepts the card it raises' },
      // delete, not external-write: "publish" is in-app wiki state only (nothing leaves
      // the DB). It HARD-DELETEs the author's document_draft row and re-syncs (delete +
      // reinsert) entity_link rows, consuming a human's pending draft past the review gate.
      { name: 'publish_draft', sideEffect: 'external-write', label: 'Publish Draft', description: 'Publish the current draft — snapshots history and re-syncs wikilinks' },
      { name: 'link_document_to_action', sideEffect: 'internal-write', writeTarget: 'board', label: 'Link Document to Action', description: 'Attach an existing document to an action item' },
      // delete: hard DELETE of the action_document row
      { name: 'unlink_document_from_action', sideEffect: 'delete', label: 'Unlink Document from Action', description: 'Remove the link between a document and an action item' },
      { name: 'list_action_documents', sideEffect: 'read', label: 'List Action Documents', description: 'List documents linked to an action item' },
    ],
  },
  {
    id: 'decisions',
    label: 'Decisions',
    description: 'Decisions extracted from captures',
    icon: '⚖️',
    tools: [
      { name: 'list_decisions', sideEffect: 'read', label: 'List Decisions', description: 'List decisions from a capture' },
      { name: 'create_decision', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Decision', description: 'Log a new decision' },
      { name: 'confirm_decision', sideEffect: 'internal-write', writeTarget: 'board', label: 'Confirm Decision', description: 'Confirm an AI-suggested decision' },
      { name: 'dismiss_decision', sideEffect: 'internal-write', writeTarget: 'board', label: 'Dismiss Decision', description: 'Dismiss an AI-suggested decision' },
      { name: 'confirm_all_decisions', sideEffect: 'internal-write', writeTarget: 'board', label: 'Confirm All', description: 'Confirm all pending decisions for a capture' },
    ],
  },
  {
    id: 'emails',
    label: 'Emails',
    description: 'Gmail and Outlook inbox management',
    icon: '✉️',
    tools: [
      { name: 'list_emails', sideEffect: 'read', label: 'List Emails', description: 'List recent emails from the inbox' },
      { name: 'read_email', sideEffect: 'read', label: 'Read Email', description: 'Read a specific email or thread' },
      // internal-write: unsent DRAFT. previous_draft_id deletes a provider draft, but only one this
      // user has indexed as is_draft, id-shape checked and URL-encoded (deleteProviderDraft)
      { name: 'create_email_draft', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Draft', description: 'Create a new email draft for review and sending' },
      { name: 'get_email_summary', sideEffect: 'read', label: 'Email Summary', description: 'Get inbox status: unread, needs-reply, pending drafts' },
      { name: 'get_email_drafts', sideEffect: 'read', label: 'Get Drafts', description: 'List pending AI drafts for review' },
      { name: 'generate_email_drafts', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Generate Drafts', description: 'AI-generate batch draft replies for the inbox' },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): rewrites an unsent draft in place (the row and the mailbox's draft), never sends.
      { name: 'revise_email_draft', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Revise Draft', description: 'Rewrite one of the person\'s own unsent email drafts in place, in Dial8 and in their mailbox, when they ask for a change; never sends' },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES). internal-write: like a draft, it changes only the
      // person's OWN mailbox (a label, a folder, a read flag) and reaches nobody; every change is
      // reversible (the result's undo), and Trash / Spam are never touched (src/lib/email/thread-triage.ts).
      { name: 'update_email_thread', sideEffect: 'internal-write', writeTarget: 'board', label: 'Triage Threads', description: 'Archive (or move back to the inbox), mark read or unread, star, label or mute threads in the person\'s own mailbox; every change can be undone' },
      // Attended chat only, and ALWAYS the person's approval card (src/lib/safety/outward-gate.ts): it
      // calls the sender's one-click link or sends an unsubscribe email from their mailbox.
      { name: 'unsubscribe_thread', sideEffect: 'external-write', label: 'Unsubscribe', description: 'Unsubscribe the person from the mailing list a thread came from (its one-click link, or an unsubscribe email), once they approve the card' },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): hard-deletes Dial8's own draft rows and their mailbox drafts, never sends (GEN-1165).
      { name: 'discard_email_draft', sideEffect: 'delete', label: 'Discard Drafts', description: 'Discard email drafts Dial8 wrote (one or many) from the person\'s mailbox and from Dial8, with why, when they ask; never touches a draft they wrote, never sends' },
    ],
  },
  {
    id: 'contacts',
    label: 'Contacts & Companies',
    description: 'Contacts, companies, and CRM relationship management',
    icon: '👥',
    tools: [
      { name: 'list_contacts', sideEffect: 'read', label: 'List Contacts', description: 'List contacts in the workspace' },
      { name: 'get_contact', sideEffect: 'read', label: 'Get Contact', description: 'Get contact details' },
      { name: 'get_contact_details', sideEffect: 'read', label: 'CRM Details', description: 'Get full CRM profile: interactions, meetings, open actions, pending commitments, emails, decisions' },
      { name: 'get_company_overview', sideEffect: 'read', label: 'Company Overview', description: 'Get account-level company overview: visible people, open actions, pending commitments, meetings, emails, decisions' },
      { name: 'list_companies', sideEffect: 'read', label: 'List Companies', description: 'List the companies in the CRM with contact/meeting counts and last interaction — the way to find a company_id' },
      { name: 'create_company', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Create Company', description: 'Add a company to the CRM' },
      { name: 'update_company', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Update Company', description: 'Edit a company: name, domain, industry, size, address, tags' },
      { name: 'create_contact', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Create Contact', description: 'Add a new contact' },
      // Bringing existing customers in (roadmap track G, src/lib/ai/tools/contact-import.ts). Not attended only:
      // they run on the person's own text turn too; the writes refuse an unattended turn themselves.
      { name: 'read_contact_file', sideEffect: 'read', label: 'Read Contact File', description: 'Read a spreadsheet (CSV, Excel) or phone contacts file the person sent and map its columns to CRM fields' },
      { name: 'import_contact_file', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Import Contacts', description: 'Import a spreadsheet or phone contacts file into the CRM: deduped, never over their edits, undoable as a whole; nothing goes out' },
      { name: 'list_contact_imports', sideEffect: 'read', label: 'List Contact Imports', description: 'Their recent imports of existing customers (files, Google Contacts, HubSpot, Brevo) with counts and the contacts to check' },
      { name: 'undo_contact_import', sideEffect: 'delete', label: 'Undo Contact Import', description: 'Take one import back as a whole: the contacts it added are removed, what it changed goes back; edits since stay' },
      { name: 'update_contact', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Update Contact', description: 'Edit contact details' },
      { name: 'update_crm_contact', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Update CRM', description: 'Update CRM relationship fields' },
      // internal-write: one paid web search (counted as a read, like web research) whose
      // result fills the contact's own empty columns. Asks first: confirmed_with_user.
      { name: 'enrich_contact', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Enrich Contact', description: ENRICH_CONTACT_DESCRIPTION },
      // automation-write: the link goes to every customer after a job, from the owner's mailbox; from a text it waits for the owner's card.
      { name: 'set_review_link', sideEffect: 'automation-write', label: 'Set Review Link', description: "Save the business's Google review link, sent once to each customer after their job is done" },
      // external-write: it emails the customer (the review request), so from a text it waits for the owner's card (a sender's number can be faked).
      { name: 'complete_job', sideEffect: 'external-write', label: 'Complete Job', description: "Mark a customer's job done; with a review link set, that customer gets one review request for the job" },
      // The business's front door (roadmap B, src/lib/ai/tools/business.ts): customers' quotes, what
      // its customers' assistant may tell them, open slots and bookings. In the CRM: customers are contacts.
      // Customer text (their notes) is fenced inside the result (outside-text-tools.ts).
      { name: 'list_quotes', sideEffect: 'read', label: 'List Quotes', description: "List the quotes customers sent the business (its website's quote form, texts), newest first" },
      { name: 'get_quote', sideEffect: 'read', label: 'Get Quote', description: "Read one customer's quote in full: items, sizes, price, dates, address and what they wrote" },
      { name: 'update_quote', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Update Quote', description: "Change a quote's status, price or notes; never texts the customer" },
      { name: 'get_business_profile', sideEffect: 'read', label: 'Business Profile', description: "What the business's customers are told, its booking hours, booking link, customer number and quote form" },
      // Attended only (ATTENDED_ONLY_TOOL_NAMES): what customers hear is rewritten only at the person's word.
      { name: 'update_business_profile', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Update Business Profile', description: "Change what the business's customers are told (services, prices, FAQ) and when jobs can be booked" },
      // Attended only: a new secret URL for the website's quote form (the old one stops).
      { name: 'create_quote_form_link', sideEffect: 'internal-write', writeTarget: 'crm', label: 'Quote Form Link', description: "Make the secret URL the business's website quote form posts to; any old one stops working" },
      { name: 'find_booking_slots', sideEffect: 'read', label: 'Find Booking Slots', description: "The business's open times for a job, from its booking hours and the owner's calendar" },
      { name: 'list_bookings', sideEffect: 'read', label: 'List Bookings', description: "The business's customer bookings, confirmed or waiting for the owner's yes" },
      // external-write: the owner's answer to a quote (roadmap F3, src/lib/customers/quote-reply.ts), texted from
      // the business number or emailed from their mailbox to a number or address a web form typed. The outward gate
      // holds every call as the owner's card showing exactly who gets what text; the tool runs only as that card's
      // replay. Neither moves money (send_payment_link stays the one money tool).
      { name: 'send_quote', sideEffect: 'external-write', label: 'Send Quote', description: "Send a customer their quote's price and the booking link to pick a time; always the owner's approval card first" },
      // external-write: books the time the customer chose (a customer_booking, the owner's calendar, the customer's confirmation text).
      { name: 'book_quote', sideEffect: 'external-write', label: 'Book Quote', description: "Book the time a customer chose for their quote: the owner's calendar and a confirmation text; always the owner's approval card first" },
      // external-write: a payment link to a customer (roadmap C2): a Stripe Payment Link on the owner's own
      // connected account, texted from the business number / emailed from their mailbox. The agent's ONE money
      // tool: nothing refunds, pays out or edits Stripe (src/lib/ai/__tests__/payments-tool.test.ts). The outward
      // gate holds every call as the owner's card once Stripe is ready; before that it only texts them the setup link.
      { name: 'send_payment_link', sideEffect: 'external-write', label: 'Send Payment Link', description: "Send a customer a payment link for a quote or job, paid by card into the owner's own Stripe; always the owner's approval card first" },
      // The business's own website in a GitHub repo, worked on by text (roadmap track E, src/lib/ai/tools/website.ts).
      // connect_website reads the repo and saves it (and the project its runs use). The other three open a pull
      // request on that repo only (automation-write: a coding run, or GitHub's revert): nothing goes live until the
      // owner's merge card gets their yes (src/lib/website/approval.ts), so a text turn doesn't hold them a second time.
      { name: 'list_website_repos', sideEffect: 'read', label: 'List Website Repos', description: "The owner's GitHub repositories, the likeliest to be their business's website first, numbered" },
      { name: 'connect_website', sideEffect: 'internal-write', writeTarget: 'board', label: 'Connect Website', description: "Connect the business's website repo: read how it's built, where it's hosted and its quote or contact form" },
      { name: 'wire_website_form', sideEffect: 'automation-write', label: 'Wire Website Form', description: "Open a pull request that makes the website's form also send requests to the business; live only on the owner's yes" },
      { name: 'change_website', sideEffect: 'automation-write', label: 'Change Website', description: "Make a change the owner asked for on their website, as a pull request; live only on the owner's yes" },
      { name: 'undo_website_change', sideEffect: 'automation-write', label: 'Undo Website Change', description: "Undo the last website change, as a pull request; live only on the owner's yes" },
      { name: 'list_workspace_members', sideEffect: 'read', label: 'List Members', description: 'List all workspace members with IDs and names — use to assign actions, and to resolve a person\'s name to their subject_member_id for person-scoped claim queries' },
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Calendar events and scheduling',
    icon: '📅',
    tools: [
      { name: 'get_calendar_events', sideEffect: 'read', label: 'Get Events', description: 'List calendar events for a date range' },
      // external-write: provider write: the provider emails every attendee
      { name: 'create_calendar_event', sideEffect: 'external-write', label: 'Create Event', description: 'Create a new calendar event' },
      // external-write: provider write: attendees get update emails
      { name: 'update_calendar_event', sideEffect: 'external-write', label: 'Update Event', description: 'Edit a calendar event' },
      // delete: deletes the provider event
      { name: 'delete_calendar_event', sideEffect: 'delete', label: 'Delete Event', description: 'Remove a calendar event' },
    ],
  },
  {
    id: 'attachments',
    label: 'Attachments',
    description: 'File attachments on captures and actions',
    icon: '📎',
    tools: [
      { name: 'list_attachments', sideEffect: 'read', label: 'List Attachments', description: 'List file attachments on a capture or action' },
      { name: 'get_attachment_content', sideEffect: 'read', label: 'Get Content', description: 'Get file content or download URL' },
      { name: 'read_chat_file', sideEffect: 'read', label: 'Read Chat File', description: 'Read a file the user just uploaded in chat, or look at a photo they uploaded, by storage_path, without attaching it' },
      { name: 'attach_chat_file', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Attach File', description: 'Attach a chat-uploaded file to an action or capture' },
    ],
  },
  {
    id: 'initiatives',
    label: 'Initiatives',
    description: 'Strategic objectives and OKRs',
    icon: '🎯',
    tools: [
      { name: 'list_initiatives', sideEffect: 'read', label: 'List Initiatives', description: 'List initiatives with progress, project rollup, and health' },
      { name: 'get_initiative', sideEffect: 'read', label: 'Get Initiative', description: 'Get full initiative details including child projects and action rollup' },
      { name: 'create_initiative', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Initiative', description: 'Create a new strategic objective or OKR' },
      { name: 'update_initiative', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Initiative', description: 'Edit initiative details or status' },
    ],
  },
  {
    id: 'cycles',
    label: 'Cycles',
    description: 'Sprints and time-boxed iterations',
    icon: '🔄',
    tools: [
      { name: 'list_cycles', sideEffect: 'read', label: 'List Cycles', description: 'List cycles (sprints) for a team with status and action stats' },
      { name: 'get_cycle', sideEffect: 'read', label: 'Get Cycle', description: 'Get cycle details with list of actions in the cycle' },
      { name: 'create_cycle', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Cycle', description: 'Create a new sprint cycle for a team' },
      { name: 'start_cycle', sideEffect: 'internal-write', writeTarget: 'board', label: 'Start Cycle', description: 'Start a cycle — only one per team can be active' },
      { name: 'complete_cycle', sideEffect: 'internal-write', writeTarget: 'board', label: 'Complete Cycle', description: 'Complete a cycle and optionally roll unfinished actions forward' },
    ],
  },
  {
    id: 'comments',
    label: 'Comments',
    description: 'Threaded comments on actions, captures, and documents',
    icon: '💬',
    tools: [
      { name: 'list_comments', sideEffect: 'read', label: 'List Comments', description: 'List top-level comments on an entity' },
      { name: 'add_comment', sideEffect: 'internal-write', writeTarget: 'board', label: 'Add Comment', description: 'Add a comment or reply to an existing comment' },
      { name: 'get_comment_replies', sideEffect: 'read', label: 'Get Replies', description: 'Get threaded replies for a comment' },
    ],
  },
  {
    id: 'calendar_capture',
    label: 'Calendar & Captures',
    description: 'Meeting-capture sync, preparation, and follow-up',
    icon: '🔗',
    tools: [
      // automation-write: bulk sync job (contacts + pending captures); makes no provider write
      { name: 'sync_calendar', sideEffect: 'automation-write', label: 'Sync Calendar', description: 'Sync upcoming calendar events to captures for meeting tracking' },
      { name: 'get_upcoming_meetings', sideEffect: 'read', label: 'Upcoming Meetings', description: 'Get next meetings with their capture status' },
      { name: 'create_capture_from_event', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Capture from Event', description: 'Create a capture from a specific calendar event' },
      { name: 'draft_followup_email', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Draft Follow-up', description: 'Generate a follow-up email draft from a processed capture' },
      { name: 'get_meeting_prep', sideEffect: 'read', label: 'Meeting Prep', description: 'Search past captures, actions, and decisions to prepare for a meeting, with the goal the user set for it' },
      { name: 'set_meeting_goal', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Set Meeting Goal', description: "Set or clear the user's goal for one of their upcoming meetings (what they want out of the call), by its calendar event id and start" },
    ],
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Workspace dashboard and status overview',
    icon: '📋',
    tools: [
      { name: 'get_dashboard_summary', sideEffect: 'read', label: 'Dashboard Summary', description: "Get the user's dashboard — assigned actions, overdue items, reviews, cycle progress" },
      // Pages in the chat (docs/plans/one-agent-and-chat-pages.md, Part 1).
      // Here because every edition has the dashboard, so every chat can show.
      { name: 'show', sideEffect: 'read', label: 'Show', description: 'Put a page in the chat: a live list or board of records filtered your way, one record, the calendar for a day, week or month, a mail folder or thread, or a whole page (a team board, sequences, prospecting, flows, evals, campaigns, knowledge, agents & skills, teams, the browser). The answer to "what\'s due", "my open deals", "my week", "unread from Acme" and the like, instead of rows in prose' },
      // Attended only (ATTENDED_ONLY_TOOL_NAMES): reads a card on the person's screen.
      { name: 'read_card', sideEffect: 'read', label: 'Read Card', description: "Read the rows a card in this chat shows the person now, their own filter, sort and search changes included, with the fields asked for" },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: "What happened for the person lately: their agent's events",
    icon: '🔔',
    tools: [
      // The person's agent events, not a list of notices (docs/plans/retire-notifications-page.md).
      { name: 'get_notifications', sideEffect: 'read', label: 'Get Notifications', description: "What happened for the person over the last 7 days, told or not: their agent's events (waiting on them, drafts, mail, meetings, mentions, teammates' updates, reminders, failures, finished work), one line each, counted by kind. Titles are data, clipped. An agent's pending work is list_bot_work's" },
    ],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Cross-entity workspace search',
    icon: '🔍',
    tools: [
      { name: 'find', sideEffect: 'read', label: 'Find', description: 'Unified ranked search across claims, captures, documents (+ optional attachments/contacts/emails) — fuses keyword, semantic, and recency in one list with inline provenance; supports since/until temporal recall' },
      { name: 'search', sideEffect: 'read', label: 'Search', description: 'Deprecated: prefer find. Universal keyword search across actions, captures, documents, projects, decisions, claims, contacts, and emails' },
      { name: 'deep_search', sideEffect: 'read', label: 'Deep Search', description: 'Deprecated: prefer find. AI-powered semantic search across captures and file attachments using vector similarity' },
    ],
  },
  {
    id: 'flows',
    label: 'Flows',
    description: 'Workspace automations (loops), each with an agent — status, schedule, capture and calendar triggers running HTTP calls or skills',
    icon: '⚡',
    tools: [
      { name: 'list_flows', sideEffect: 'read', label: 'List Flows', description: 'List automations (loops) in the workspace, each with its trigger, actions, on/off state and agent: the teammate that tells the person about its runs' },
      // automation-write: an automation that later runs HTTP calls at a caller-chosen URL, skills or capture archiving.
      // A loop the person asks for is saved on (enabled: true); one the agent proposes is saved off until their yes; a webhook loop
      // switches on only from the person's verified card (flow-approvals.ts needsSwitchOnCard). Attended only (ATTENDED_ONLY_TOOL_NAMES): no unattended run builds or switches on a loop.
      { name: 'create_flow', sideEffect: 'automation-write', label: 'Create Flow', description: 'Create a loop: a status-change, schedule, capture, calendar, linked-PR or website-quote trigger that runs HTTP calls, skills or capture archiving. A loop the person asked for is on at once; one you propose waits for their yes, and one with a webhook (http_post) step for their approval card. Every loop has an agent: pick one, or it gets a default' },
      // automation-write: re-aims or switches on an existing automation (switching one on needs confirmed_with_user;
      // a webhook loop switches on only from the person's verified card, and someone else's outward or acting loop
      // only from its owner's: F1 flow-approvals.ts). Attended only.
      { name: 'update_flow', sideEffect: 'automation-write', label: 'Update Flow', description: 'Edit a loop: its trigger, actions, on/off state, agent, a skill step\'s report title or trust. Switching a loop on needs the person\'s yes; one with a webhook (http_post) step needs their approval card, and someone else\'s loop that acts outside Dial8 or on its own needs its owner\'s' },
      // Attended only (ATTENDED_ONLY_TOOL_NAMES). Deletes only from the person's verified card (F1).
      { name: 'delete_flow', sideEffect: 'delete', label: 'Delete Flow', description: 'Delete a loop and its run history, once the person accepts the card it raises' },
      // automation-write: changes who an automation runs as (whose data and connections). Attended only;
      // the NEW owner accepts a verified card (F1).
      { name: 'transfer_flow_owner', sideEffect: 'automation-write', label: 'Transfer Flow Owner', description: 'Hand a loop to another member so it runs as them, once they accept the card it raises' },
      // The reverse: a member asks the CURRENT owner for a loop; their card. Attended only (F1).
      { name: 'request_flow_takeover', sideEffect: 'automation-write', label: 'Request Flow Takeover', description: "Ask a loop's owner to hand it to you so you can change it, once they accept the card it raises" },
      { name: 'list_flow_runs', sideEffect: 'read', label: 'List Flow Runs', description: 'Inspect flow delivery history — fired/failed, HTTP response, error, latency' },
      { name: 'get_flow_run', sideEffect: 'read', label: 'Get Flow Run', description: 'Read one loop run in full: each step\'s result, response and output preview' },
      // automation-write: runs the loop's skill steps (paid, as the caller, report mode, nothing delivered);
      // HTTP calls are rendered, never sent (F1, src/lib/flows/test-fire.ts). Attended only.
      { name: 'test_flow', sideEffect: 'automation-write', label: 'Test Flow', description: 'Dry-run a loop against a sample: skill steps run for real but deliver nothing, HTTP calls are shown, not sent' },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    description: 'Claims-based knowledge graph — durable facts, decisions, and links across the workspace',
    icon: '🧠',
    tools: [
      { name: 'list_claims', sideEffect: 'read', label: 'List Claims', description: 'List claims by linked entity, type, or status; group_by_change buckets new/newly-confirmed/superseded for "what\'s new on project X"' },
      { name: 'get_claim', sideEffect: 'read', label: 'Get Claim', description: 'Read a claim with its sources and graph neighbors' },
      { name: 'search_claims', sideEffect: 'read', label: 'Search Claims', description: 'Deprecated: prefer find. Semantic search over claims — "what does the workspace know about X?"' },
      { name: 'create_claim', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Claim', description: 'Propose a new claim with sources and entity links (defaults to suggested)' },
      { name: 'confirm_claim', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Confirm Claim', description: 'Mark a suggested claim as confirmed' },
      { name: 'dismiss_claim', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Dismiss Claim', description: 'Dismiss a suggested or active claim' },
      { name: 'supersede_claim', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Supersede Claim', description: 'Replace a stale claim with an updated version (creates a new claim, marks the old superseded)' },
      { name: 'link_entities', sideEffect: 'internal-write', writeTarget: 'board', label: 'Link Entities', description: 'Create a graph edge between any two entities (claim, document, contact, etc.)' },
      { name: 'list_entity_links', sideEffect: 'read', label: 'List Entity Links', description: 'List the graph edges connected to an entity' },
      // delete: hard DELETE of entity_link rows
      { name: 'unlink_entities', sideEffect: 'delete', label: 'Unlink Entities', description: 'Remove a graph edge between two entities' },
      { name: 'traverse', sideEffect: 'read', label: 'Traverse Graph', description: 'Walk one hop in the entity graph — find what links to or from an entity (returns labels inline)' },
      { name: 'get_context_bundle', sideEffect: 'read', label: 'Context Bundle', description: 'Assemble the connected knowledge subgraph around an entity in one call — claims, linked entities, and edges with labels' },
      { name: 'ingest_source', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Ingest Source', description: 'Kick off background ingestion of a file, capture, document, conversation, or URL into the knowledge graph' },
      { name: 'ingest_reference', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Ingest Reference', description: 'Turn a PDF spec (API docs, data models) into a navigable reference wiki — index + per-endpoint pages with verbatim payloads' },
      { name: 'list_packages', sideEffect: 'read', label: 'List Packages', description: 'List the workspace knowledge packages — named, shareable bundles of curated context' },
      { name: 'get_package', sideEffect: 'read', label: 'Get Package', description: 'Read a knowledge package — its pinned entities, rules, resolved claims, and compiled brief' },
      { name: 'create_package', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Package', description: 'Create a knowledge package to curate and gate context about a subject, project, or initiative' },
      { name: 'update_package', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Update Package', description: 'Rename a package or change its description, visibility, or standing inclusion rules' },
      { name: 'add_to_package', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Add To Package', description: 'Pin an entity (claim, document, capture, project, contact...) into a knowledge package' },
      // delete: hard DELETE of the knowledge_package_item row
      { name: 'remove_from_package', sideEffect: 'delete', label: 'Remove From Package', description: 'Remove a pinned entity from a knowledge package' },
    ],
  },
  {
    id: 'sequences',
    label: 'Sequences',
    description: 'Outreach email sequences — multi-step templated campaigns sent from the user\'s own mailbox, auto-stopping on reply. Agents draft, stage and ask to launch; a launch sends only on the person\'s yes to its card.',
    icon: '📨',
    tools: [
      { name: 'list_sequences', sideEffect: 'read', label: 'List Sequences', description: 'List outreach sequences with enrollment and reply counts' },
      { name: 'get_sequence', sideEffect: 'read', label: 'Get Sequence', description: 'Get sequence detail — steps with sent/failed counts and every enrollment\'s status/exit reason' },
      { name: 'create_sequence', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Sequence', description: 'Create an outreach sequence as a draft (never sends; the user launches from Review & Launch)' },
      // automation-write: can resume a launched sequence (live outbound email)
      { name: 'update_sequence', sideEffect: 'automation-write', label: 'Update Sequence', description: 'Edit a sequence\'s structure or pause/resume/archive it (cannot launch)' },
      // internal-write: staged inert: next_send_at NULL until the user launches
      { name: 'enroll_contacts_in_sequence', sideEffect: 'external-write', label: 'Enroll Contacts', description: 'Stage CRM contacts into a sequence with per-contact skip reasons (inert until the user launches)' },
      { name: 'remove_from_sequence', sideEffect: 'internal-write', writeTarget: 'board', label: 'Remove From Sequence', description: 'Exit a contact\'s enrollment so no further steps send (never retracts sent mail)' },
      // external-write: on the person's yes it arms sending. The call itself only raises their card (UNREVIEWED in action-review.ts).
      { name: 'launch_sequence', sideEffect: 'external-write', label: 'Launch Sequence', description: 'Ask the person to launch a sequence: one card with every email and recipient; it sends only on their yes (in the app, or by text with the card\'s code)' },
    ],
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    description:
      "Campaigns — the named pushes a marketer's work and knowledge hang off, and the outreach that sends: an audience (a CRM filter or group) through a sequence, launched on the person's yes. No delete: a campaign is an anchor other records point at, so retiring one is a status change.",
    icon: '📣',
    tools: [
      { name: 'list_campaigns', sideEffect: 'read', label: 'List Campaigns', description: 'List the workspace\'s campaigns with status, objective, channels and dates, and for one that sends its audience and sent / replied / opted-out counts — the way to find a campaign_id' },
      { name: 'create_campaign', sideEffect: 'internal-write', writeTarget: 'board', label: 'Create Campaign', description: 'Create a campaign with an objective, channels, dates, and optionally an audience and the sequence it sends; recipe win_back sets up the win-back campaign and its draft emails (nothing sends)' },
      { name: 'update_campaign', sideEffect: 'internal-write', writeTarget: 'board', label: 'Update Campaign', description: 'Edit a campaign\'s name, objective, status, channels, dates, owner, tags, audience, sequence or rolling — only the fields you pass are touched' },
      // external-write: on the person's yes it enrolls the audience and arms sending. The call itself only raises their card (UNREVIEWED in action-review.ts).
      { name: 'launch_campaign', sideEffect: 'external-write', label: 'Launch Campaign', description: 'Ask the person to launch a campaign: one card with every email and every recipient its audience reaches today (opt-outs left out); it enrolls and sends only on their yes' },
    ],
  },
  {
    id: 'library',
    label: 'Skills & Agents',
    description: 'Author and edit the workspace\'s reusable chat skills, read its agents (personas), and manage the person\'s connections (integrations and connected apps)',
    icon: '📚',
    tools: [
      // The person's connections (flows-connectors F2). Here, in the core group, so no edition or
      // persona loses them and no persona-grant migration is needed. Attended only (ATTENDED_ONLY_TOOL_NAMES):
      // the person's own accounts and apps, never a token.
      { name: 'list_connections', sideEffect: 'read', label: 'List Connections', description: "List the person's integrations and connected apps: status, what each can do, each app tool's access, and which loops use it" },
      // external-write: it saves nothing (the person's tap does, on the provider's page), but for a server from a URL
      // it calls that server, at an address the model passes, so it is never counted as a read. Attended only.
      { name: 'connect', sideEffect: 'external-write', label: 'Connect', description: "Put a Connect card in the chat for an integration, a catalog app or any MCP server by URL; the person signs in on the provider's own page" },
      // delete: removes the account or app row (and its tokens), and switches off the loops that need it,
      // only from the person's verified card. Attended only.
      { name: 'disconnect', sideEffect: 'delete', label: 'Disconnect', description: 'Disconnect an integration or app once the person accepts the card it raises, which names the loops that need it (they are switched off)' },
      // automation-write: changes which outside tools every agent can reach and which ask first. Tightening applies at once;
      // loosening only from the person's verified card. Attended only.
      { name: 'set_tool_access', sideEffect: 'automation-write', label: 'Set Tool Access', description: "Set a connected app tool's access (off, ask, read_only; one tool or all). Tightening applies at once; loosening waits for the person's card" },
      // How a call held for the person's approval ended, by its approval_id (GEN-1172): the caller's own rows only.
      { name: 'get_tool_approval_result', sideEffect: 'read', label: 'Approved Call Result', description: "Read how a call held for the person's approval ended, by its approval_id: still waiting, ran (with what it returned) or failed, declined, or expired. Use it once they approve a card, instead of asking them to approve it again" },
      // Guest access: one guest's conversation with the agent the person made for them, and the calls it held (PROD 11-02).
      // A read of the person's own guests: in the app, by text, and for a home turn answering a guest's ask alike.
      { name: 'read_guest_conversation', sideEffect: 'read', label: 'Read a Guest Conversation', description: "Read one of the person's guests' conversation with the agent the person made for them: what they asked for, what their agent said and did, and how each call it held for the person's approval ended" },
      { name: 'list_skills', sideEffect: 'read', label: 'List Skills', description: 'List the workspace\'s skills plus the built-in system skills (catalog only, no prompts)' },
      { name: 'get_skill', sideEffect: 'read', label: 'Get Skill', description: 'Read one skill in full, including its system_prompt and agent_config' },
      { name: 'list_agents', sideEffect: 'read', label: 'List Agents', description: "List the workspace's agents (personas: what its AI teammates, chat agents and live-meeting agents are built on) plus the built-in ones (catalog only, no prompts). Change one in Customize (About on its agent's page) or in the Agents & skills card" },
      { name: 'get_agent', sideEffect: 'read', label: 'Get Agent', description: 'Read one agent (persona) in full, including its system_prompt, agent_config (its tools) and model' },
      // automation-write: writes the instructions the main agent later loads and follows; visibility public (Discover) is owner/admin only.
      // Attended only (ATTENDED_ONLY_TOOL_NAMES): no unattended run saves injected text as a skill.
      { name: 'create_skill', sideEffect: 'automation-write', label: 'Create Skill', description: 'Save a new reusable skill the user can re-invoke as a slash command' },
      // automation-write: rewrites the prompt act-mode flows execute. Attended only, as create_skill.
      { name: 'update_skill', sideEffect: 'automation-write', label: 'Update Skill', description: 'Edit an existing custom skill (system skills are read-only)' },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): a line of an area's memory (one-agent plan Part 3, migration 317), what the person said.
      // An artifact write: the note is reviewed on its own surface (What Dial8 has learned) and undone from the chat's chip. Runs nothing.
      { name: 'remember', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Remember', description: "Save a preference the person states or a correction they make: how they work to their profile (scope profile, every workspace, with a quote of their own words; unverified it waits as a suggestion), or what they work on to one area's memory in this workspace (personal by default; a workspace line from a non-admin waits for an admin)" },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): the person's Now file, the main agent's sketchpad (docs/plans/now-file.md).
      // An artifact write: the person's own private document, with its history and Restore. Runs nothing.
      { name: 'update_now', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Now', description: "Update the person's Now file, your own running notes on what is going on for them right now: add, replace, remove or move lines under its six headings (Focus, In flight, Waiting on you, Waiting on others, Coming up, Keep in mind), or rewrite it for a tidy" },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): ends the person's getting started (docs/plans/getting-started-skill.md).
      // An artifact write: their own onboarding progress. Runs nothing.
      { name: 'finish_getting_started', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Finish Getting Started', description: "End the person's getting started once its steps are done or they don't want the walk-through: the getting-started section stops" },
      // Setup by text (roadmap track A, src/lib/onboarding/text-setup.ts). Not attended only: they run on the person's
      // own text turn (person_remote); each refuses an unattended turn itself (src/lib/ai/tools/text-setup.ts).
      // A one_time_link row: the link opens the provider's own sign-in, from the person's phone, once.
      { name: 'connect_link', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Connect Link', description: "Make a single-use link (15 minutes) that connects the person's Google, Microsoft or GitHub account from their phone, to put in a text" },
      // The owner's confirmed answers as workspace lines of the knowledge memory; renames the workspace; ends setup by text.
      { name: 'save_business_profile', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Save Business Profile', description: "Save what the owner confirmed about their business (name, services, area, pickup days, prices) to the business memory and end setup by text" },
    ],
  },
  {
    id: 'evals',
    label: 'Evals',
    description: 'Suites of synthetic mock meetings that grade an agent or skill against a prompt version',
    icon: '🧪',
    tools: [
      { name: 'create_eval_suite', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Suite', description: 'Create an eval suite targeting one agent or skill' },
      { name: 'create_eval_case', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Case', description: 'Write one synthetic meeting (script + participants) and the outcomes it should produce' },
      { name: 'list_evals', sideEffect: 'read', label: 'List Evals', description: 'List eval suites with case counts, last outcome, and the estimated cost per run mode' },
      // automation-write: replays every case x trial through the live agent, billed
      { name: 'start_eval_run', sideEffect: 'automation-write', label: 'Start Run', description: 'Queue a run of a suite in batch or live mode; adopts an in-flight run rather than starting a second' },
      { name: 'get_eval_run', sideEffect: 'read', label: 'Get Run', description: 'Read a run: outcome, per-dimension scores, failing checks with rationale, and one trial\'s trace on request' },
      { name: 'update_eval_case', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Update Case', description: 'Refine a case\'s script or expected outcomes; re-freezes the chunk boundaries' },
    ],
  },
  {
    id: 'prospecting',
    label: 'Prospecting',
    description:
      "Build prospect lists: research the workspace's own company, find and score companies that match an ICP, find the people at them, save them to the list and publish it into the CRM. Searches, research, publish and dismiss need the person's yes first: call with confirmed_with_user: true only after they said yes to that call. Without it the tool refuses and nothing runs.",
    icon: '🔭',
    tools: [
      { name: 'research_my_company', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Research My Company', description: "Establish and research the workspace's OWN company, the source every ICP is seeded from. With no arguments it runs nothing when the company is already researched; researching it needs confirmed_with_user: true" },
      { name: 'list_prospect_lists', sideEffect: 'read', label: 'List Prospect Lists', description: 'Every prospect list in the workspace with its per-stage tally — the front door to prospecting, and where every other prospect tool gets its list_id' },
      { name: 'create_prospect_list', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Create Prospect List', description: 'Create a prospect list with a purpose, an ICP, and its run defaults; runs no search' },
      { name: 'update_prospect_list', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Update Prospect List', description: "Edit a list's name, ICP, exclusions, or run defaults; archive it; runs no search" },
      { name: 'list_prospect_entries', sideEffect: 'read', label: 'List Prospect Entries', description: 'Read a list\'s companies and people with fit score, rationale, stage, and whether the full profile landed' },
      { name: 'run_prospect_discovery', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Run Discovery', description: 'Runs a search (confirmed_with_user: true): find companies across several angles, deduped against the CRM and every other list, then profile and score each one' },
      { name: 'research_prospect_companies', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Research Accounts', description: 'Runs a search per company (confirmed_with_user: true): profile and score the companies the user picked' },
      { name: 'find_prospect_people', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Find People', description: "Runs a search per company (confirmed_with_user: true): find the people to contact, anchored on each company's own domain" },
      { name: 'find_prospects', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Find Prospects', description: 'Runs two searches per company on one yes (confirmed_with_user: true): profile and score, then find people; already-profiled companies skip the first' },
      { name: 'wait_for_prospecting_run', sideEffect: 'read', label: 'Wait For Run', description: 'Poll a run with backoff until it finishes (or ~4 minutes elapse); budget_exhausted is an outcome, not a failure' },
      { name: 'get_prospecting_run_candidates', sideEffect: 'read', label: 'Run Candidates', description: 'The run\'s candidate ledger grouped by why each one was kept or suppressed — answers "why only six?"' },
      { name: 'cancel_prospecting_run', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Cancel Run', description: 'Stop a live run, keeping every partial result' },
      { name: 'save_prospect_entries', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Save To List', description: 'Keep entries on their prospect list (curation) — writes nothing to the CRM' },
      // external-write: the publish rule; code: bulk CRM promotion in this workspace
      { name: 'publish_prospect_list', sideEffect: 'external-write', label: 'Publish List', description: 'Publish a prospect list into the CRM as a group of real companies/contacts (confirmed_with_user: true) — the only thing that writes to the CRM' },
      { name: 'dismiss_prospect_entries', sideEffect: 'internal-write', writeTarget: 'artifact', label: 'Dismiss Entries', description: 'Dismiss (or restore) entries at the user\'s request (confirmed_with_user: true); competitor / already_customer suppress workspace-wide' },
    ],
  },
  {
    id: 'browser',
    label: 'Browser',
    description:
      "Control your own browser (the agent's browser in the cloud) with run_browser_task: give Jev the complete goal, including every exact user constraint. Jev handles clicks, field values, typing and scrolling, and every result returns what it read. Keep one task outstanding per tab and await its result before further browser calls. Use returned readings before reading more page text. Site permissions and sensitive-action approvals still apply.",
    icon: '🌐',
    tools: [
      { name: 'read_browser_page', sideEffect: 'read', label: 'Read Page', description: 'Inspect the current page for context or completion checks; run_browser_task observes intermediate pages itself' },
      { name: 'get_browser_text', sideEffect: 'read', label: 'Get Page Text', description: 'Read missing final facts after the task settles; use returned task evidence first and start with max_chars:3000' },
      { name: 'screenshot_browser', sideEffect: 'read', label: 'Screenshot', description: 'JPEG screenshot of the current tab for a visual check' },
      { name: 'open_browser', sideEffect: 'external-write', label: 'Open Browser', description: 'Show the user your browser (its live view)' },
      { name: 'close_browser', sideEffect: 'external-write', label: 'Close Browser', description: 'Put the live view of your browser away' },
      { name: 'wait_for_browser_command', sideEffect: 'read', label: 'Wait For Browser', description: 'Wait for a pending browser command (returned {pending, run_id}) to finish and get its result' },
      { name: 'run_browser_task', sideEffect: 'external-write', label: 'Run Browser Task', description: RUN_BROWSER_TASK_DESCRIPTION },
    ],
  },
  {
    // Content C0 (docs/plans/content-skill-set.md): the craft checks on a post.
    // Last, after browser: migration 387 grants it to every inherit-all persona.
    // Both only read: nothing here posts (decision 2: the person posts from the
    // link, on the platform's own page). review_post spends a reviewer call,
    // a read like web research.
    id: 'content',
    label: 'Content',
    description: 'Posts for X, LinkedIn, Threads and Bluesky: the craft checks on a draft, and posting through the person\'s Typefully only on their approval card.',
    icon: '✍️',
    tools: [
      { name: 'lint_post', sideEffect: 'read', label: 'Check Post', description: 'Check a drafted post against the writing rules, the platform\'s limits and the public-safe screen, with no model call; returns the post link once it passes' },
      // Attended chat only (ATTENDED_ONLY_TOOL_NAMES): the writer's model rides the chat's envelope.
      { name: 'review_post', sideEffect: 'read', label: 'Review Post', description: 'A fresh-eyes review of a finished post by a model from another vendor: ready or revise, with quoted issues' },
      // C2a (P9): the narrow tools in front of the person's Typefully. Attended
      // chat only, and never run in a turn: the outward gate makes every call
      // the person's approval card (decision 2), and the tools run only as
      // that approved call (src/lib/ai/tools/content.ts).
      { name: 'publish_post', sideEffect: 'external-write', label: 'Post via Typefully', description: 'Post on their own account now through their Typefully, once, after they accept the approval card' },
      { name: 'schedule_post', sideEffect: 'external-write', label: 'Queue in Typefully', description: 'Put a post in their Typefully queue (next free slot), once, after they accept the approval card' },
    ],
  },
]

export const ALL_CATEGORY_IDS = TOOL_CATEGORIES.map((c) => c.id)

export const ALL_TOOL_NAMES = TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name))

/**
 * Registry tools only the MAIN CHAT can run. Their schema lives in the registry
 * (so the chat's ceiling, persona categories and search see them) but they
 * have no generic execute: the authenticated chat tool route
 * (/api/internal/chat/tool) supplies their identity and runs them, the way
 * ask_user is native to the chat agent. Every other surface treats them as
 * absent, never advertised: skill runs (computeSkillCeiling, the skill spec
 * rebuild and tool route, inherit-all included), the live agent's ceiling,
 * work runs (WORK_RUN_EXCLUDED_TOOLS, whatever the class), teammate chats
 * (TEAMMATE_CHAT_EXCLUDED_TOOLS: a bot's thread and conversations, and loop
 * runs' chats), the device ask (SURFACE_EXCLUDED_TOOLS), MCP (no execute) and
 * the library's tool picker. A call from anywhere else could only fail
 * TOOL_NO_EXECUTE.
 *
 *   start_helper         hand a job to a background helper, or a custom agent
 *                        (always-on-agent §4; its launch is keyed on eve's
 *                        call, turn and session ids);
 *   stop_helper          stop one of the person's running helpers (the Stop
 *                        button's own cancel path);
 *   send_bot_message     the main agent talks to a bot (bots-v4 Phases A3/A4,
 *                        docs/plans/bots-v4.md "The main agent talks to the
 *                        bots"): one turn in the chat of an item's run, or in
 *                        the bot's own thread, keyed on the same ids, so a
 *                        retried call sends once;
 *   wait_for_bot_reply   waits for a reply send_bot_message handed off;
 *   local_agents, start_local_agent, message_local_agent, read_local_agent,
 *   stop_local_agent     the Dial8 agent manages local agents on the person's
 *                        Mac (docs/plans/local-agents.md): only the main chat
 *                        (and, for the reads, a stop and an answer to an open
 *                        question, its home turns: serverTurnMayCall) ever
 *                        talks to the person's Mac. start_local_agent is keyed
 *                        on eve's call, turn and session ids, so a retried call
 *                        starts one once.
 *   start_cloud_coding_run  the cloud counterpart (docs/plans/environments.md
 *                        E2): files an action in a project and starts its
 *                        coding run in the chat's cloud environment; typed
 *                        turns only, keyed on the same ids.
 *   answer_guest         the main agent answers a guest's ask (guest access,
 *                        src/lib/guests/guest-asks.ts): a home turn may (its
 *                        guest_ask update carries the asks, serverTurnMayCall),
 *                        a typed turn's call is the person's outward call.
 *   ask_agent            the main agent asks a linked person's agent (agent
 *                        links, src/lib/agent-links/exchange.ts): a typed turn
 *                        starts an exchange (the person's outward call); a
 *                        home turn's agent_answer update may only follow up
 *                        inside one (serverTurnMayCall).
 *
 * So a bot never calls back into the main agent or another bot: no run, run
 * chat, bot chat, live agent or device ask holds the two relay tools, and the
 * chat tool route refuses them on a teammate or surface token besides.
 */
export const CHAT_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'start_helper',
  'stop_helper',
  'send_bot_message',
  'wait_for_bot_reply',
  'local_agents',
  'start_local_agent',
  'message_local_agent',
  'read_local_agent',
  'stop_local_agent',
  'start_cloud_coding_run',
  'answer_guest',
  'ask_agent',
])

/** True for a tool only the main chat can run (CHAT_NATIVE_TOOL_NAMES). */
export function isChatNativeTool(name: string): boolean {
  return CHAT_NATIVE_TOOL_NAMES.has(name)
}

/**
 * Registry tools only an ATTENDED chat may hold (bots v3 Phase 5, "tell it what
 * to do next", docs/plans/bots-v3.md): the writes that let a bot act on what
 * its run did, at the person's word, in the conversation about it.
 *
 *   settle_card           accept, dismiss or start one of the person's cards
 *                         (the attention-items PATCH, owner-only);
 *   revise_email_draft    rewrite an unsent draft in place (the row and the
 *                         mailbox's draft), never send;
 *   discard_email_draft   discard drafts Dial8 wrote (the rows and the
 *                         mailbox's drafts), one or many, with why; never one
 *                         the person wrote, never send (GEN-1165). No bot is
 *                         granted it;
 *   undo_extraction_pass  undo what one extraction pass filed, and only that.
 *
 * And the main agent's reads of the bots' work (bots-v4 Phase A1,
 * docs/plans/bots-v4.md "The main agent talks to the bots"), which no bot is
 * granted (follow-through.ts), so only the main chat and a person's own
 * connector hold them:
 *
 *   list_bot_work         every bot the person can reach, with its state
 *                         and what it does, and what each busy one has
 *                         waiting on them, new and seen, with the bots'
 *                         own counts;
 *   get_bot_item          one of those items in full.
 *
 * And its writes on that work (bots-v4 Phase A2), at the person's word, with
 * the same effects as their click, also granted to no bot:
 *
 *   settle_work_item      Reviewed or Dismiss on a review (the activity
 *                         PATCH's path, owner-only);
 *   send_work_answer      the person's answer to a question a run waits on
 *                         (the respond route's path, the run's starter only).
 *
 * And managing the bots themselves (GEN-1168), under the agent editor's rules
 * (src/lib/bots/manage-bots.ts). An injected email must never get a run to
 * rename, delete or fold away the person's agents:
 *
 *   rename_bot            rename one;
 *   delete_bot            delete one, from the person's card;
 *   merge_bots            fold duplicates into one, from one card.
 *
 * And the main agent's memory (one-agent plan Part 3, "Memory"), granted to
 * no bot either: what the person told it to remember is theirs to say.
 *
 *   remember              save a fact about how the person works to their
 *                         profile (scope 'profile', every workspace; active
 *                         only on a verified quote of their words), or one
 *                         line to an area's note (personal, or a workspace
 *                         line that waits for an admin unless an owner or
 *                         admin said it).
 *
 * And the person's Now file (docs/plans/now-file.md): the main agent's
 * sketchpad, so only the person's own chat writes it (and, from Slice 2, the
 * check-in, through its own narrow exception: serverTurnMayCall's check_in
 * branch and the tool route's one grant, now-context.ts checkInNowGrant). A
 * background turn that read an email, a helper, a text, Slack, a guest, a run
 * and MCP (MCP_ATTENDED_TOOL_NAMES leaves it out) never can. No new gate:
 * being in this set is what keeps it from all of them.
 *
 *   update_now            add, replace, remove or move lines of the note, or
 *                         rewrite it (src/lib/now/now-file.ts).
 *
 * And finish_getting_started (docs/plans/getting-started-skill.md): the person
 * says they don't want the walk-through, or the agent has shown them it
 * working. Only their own turn ends it; MCP_ATTENDED_TOOL_NAMES leaves it out.
 *
 * And read_card (docs/plans/one-agent-and-chat-pages.md): the rows a card on
 * the person's screen shows now. Only the main chat sends its cards with a
 * turn, so nowhere else has a card for it to read.
 *
 * And the loop builders (A1b): what runs on its own is the person's to set up.
 * An injected email or capture must never get a skill run, a work run or the
 * device ask to build, re-aim, switch on or delete a loop. No bot is granted
 * them either.
 *
 *   create_flow           build a loop (on when the person asked for it,
 *                         off until their yes when the agent proposes it; a
 *                         webhook loop only from the person's verified card);
 *   update_flow           change one, or switch it on (with the person's yes;
 *                         a webhook loop only from their verified card,
 *                         someone else's outward loop only from its owner's);
 *   delete_flow           delete one and its run history (from a card);
 *   transfer_flow_owner   hand one to another member (their card);
 *   request_flow_takeover ask a loop's owner for it (the owner's card);
 *   test_flow             dry-run one: its skills run (and bill) as the
 *                         caller, nothing is sent or delivered.
 *
 * And the skill writers: a skill is instructions the main agent later loads
 * and follows (load_skill, the area packs), and a loop can run it on a
 * schedule. Injected text a run reads must never persist itself as one, to be
 * followed later. No bot is granted them; the `create-skill` system skill and
 * the library playbook are the main chat's (a background run that reads the
 * playbook leaves the step to the person: BACKGROUND_PERSON_STEPS_NOTE).
 *
 *   create_skill          save a new skill;
 *   update_skill          rewrite one (its prompt, or publish it).
 *
 * And restore_document_revision (documents phase 1): rolling a document back
 * to an earlier version is the person's call, made while they look at it. An
 * unattended run that could restore could also quietly undo the person's own
 * edits; it edits forward instead (the edit tools), and every edit stays in
 * the history for them to restore. revert_section_edit (canon D2, undoing one
 * edit at section level) is the same call, one section at a time.
 *
 * And delete_document (GEN-1169): deleting a document for good is the
 * person's card, and only their own chat can raise it for them. An unattended
 * run archives instead (archive_document), which they can undo.
 *
 * And the connection tools (flows-connectors F2): the person's own accounts
 * and connected apps are theirs to add, remove and widen, while they look.
 * An injected email must never get a run to list, connect, disconnect or
 * loosen one. Connecting happens on the provider's own page from a card;
 * disconnecting and loosening a tool's access are the person's cards.
 *
 *   list_connections      their integrations and apps, status and access;
 *   connect               a Connect card (their tap signs in on the provider);
 *   disconnect            remove one, from their card;
 *   set_tool_access       an app tool's access: tighten now, loosen by card.
 *
 * And review_post (content C0): the fresh-eyes review of a post the person is
 * looking at. Its reviewer must be another vendor than the writer, and only
 * the chat's envelope says who the writer was; it also spends a model call
 * per draft, which only the person's own conversation should ask for.
 *
 * And publish_post / schedule_post (content C2a): a post goes out through
 * their Typefully only on their own approval card, which only their own
 * chat can raise for them.
 *
 * And the inbox triage (GEN-1166): the person's own mailbox is theirs to
 * sort, while they look. An injected email must never get a run to archive or
 * mute the mail that would expose it, and a bulk change waits for their yes
 * in the chat. unsubscribe_thread also goes out only on their approval card.
 *
 *   update_email_thread   archive, read, star, label, mute (reversible);
 *   unsubscribe_thread    a list's one-click link or unsubscribe email.
 *
 * NEVER in an unattended run: skill runs (computeSkillCeiling, and
 * NON_CHAT_TOOL_NAMES for inherit-all), work runs (WORK_RUN_EXCLUDED_TOOLS),
 * the live agent's ceiling, the device ask (SURFACE_EXCLUDED_TOOLS) and a
 * pinned or provisioned MCP run token. A bot's chat (a teammate chat, a loop
 * run's or a work run's follow-up chat) holds one only when its bot is granted
 * it (src/lib/chat/follow-through.ts: per system key, or per loop it fronts);
 * the main chat and a person's own MCP connector hold them as the person's
 * own tools. Each tool re-checks that the thing it touches is the caller's.
 */
export const ATTENDED_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'settle_card',
  'revise_email_draft',
  'discard_email_draft',
  'undo_extraction_pass',
  'list_bot_work',
  'get_bot_item',
  'settle_work_item',
  'send_work_answer',
  'rename_bot',
  'delete_bot',
  'merge_bots',
  'remember',
  'update_now',
  'finish_getting_started',
  'read_card',
  'create_flow',
  'update_flow',
  'delete_flow',
  'transfer_flow_owner',
  'request_flow_takeover',
  'test_flow',
  'create_skill',
  'update_skill',
  'restore_document_revision',
  'revert_section_edit',
  'delete_document',
  'list_connections',
  'connect',
  'disconnect',
  'set_tool_access',
  'review_post',
  'publish_post',
  'schedule_post',
  'update_email_thread',
  'unsubscribe_thread',
  // Roadmap B: what customers are told, and the website form's secret URL, change only at the person's word.
  'update_business_profile',
  'create_quote_form_link',
])

/** True for a tool only an attended chat may hold (ATTENDED_ONLY_TOOL_NAMES). */
export function isAttendedOnlyTool(name: string): boolean {
  return ATTENDED_ONLY_TOOL_NAMES.has(name)
}

/**
 * The registry an UNATTENDED runtime may hold: ALL_TOOL_NAMES minus the
 * chat-native tools and the attended-only ones. What "inherit-all" means for a
 * skill run.
 */
export const NON_CHAT_TOOL_NAMES: readonly string[] = ALL_TOOL_NAMES.filter(
  (name) => !isChatNativeTool(name) && !isAttendedOnlyTool(name),
)

/**
 * Expands category IDs to flat list of tool names.
 * Unknown IDs (e.g. raw tool names from older skill configs) are passed through unchanged.
 */
export function getToolNamesForCategories(categoryIds: string[]): string[] {
  const result: string[] = []
  for (const id of categoryIds) {
    const category = TOOL_CATEGORIES.find((c) => c.id === id)
    if (category) {
      result.push(...category.tools.map((t) => t.name))
    } else {
      result.push(id)
    }
  }
  return [...new Set(result)]
}

/** Returns the ToolDefinition for a tool name, or undefined. */
export function getToolDefinition(toolName: string): ToolDefinition | undefined {
  for (const category of TOOL_CATEGORIES) {
    const tool = category.tools.find((t) => t.name === toolName)
    if (tool) return tool
  }
  return undefined
}

/**
 * The registry's side-effect class for a tool, or undefined for a name that is
 * not a registry tool. A Map lookup, so '__proto__' and friends are plain misses.
 */
export function getToolSideEffect(toolName: string): ToolSideEffect | undefined {
  return TOOL_REGISTRY_MAP.get(toolName)?.tool.sideEffect
}

/** The write target of an internal-write registry tool; undefined for every other class and for non-registry names. */
export function getToolWriteTarget(toolName: string): WriteTarget | undefined {
  const tool = TOOL_REGISTRY_MAP.get(toolName)?.tool
  return tool?.sideEffect === 'internal-write' ? tool.writeTarget : undefined
}

/** O(1) lookup: tool name → { tool, category }. Used by tool discovery search. */
export const TOOL_REGISTRY_MAP: Map<string, { tool: ToolDefinition; category: ToolCategory }> = new Map(
  TOOL_CATEGORIES.flatMap((cat) => cat.tools.map((t) => [t.name, { tool: t, category: cat }] as const)),
)

// ──────────────────────────────────────────────────────────────────
// Live meeting agent — hand-rolled READ resolvers
// ──────────────────────────────────────────────────────────────────

/**
 * The live agent's five resolver READS. Registered HERE so every name the live
 * agent can call has exactly one registry entry — the single source its eve spec
 * rebuild and ceiling tests read — instead of a parallel, unregistered set
 * (LIVE-AGENT-DESIGN §4.6).
 *
 * Three are hand-rolled and live-only (search_projects, search_contacts,
 * get_project_details — built by `createLiveAgentTools` beside its staging write
 * tools, src/lib/live-agent/tools.ts). They are deliberately NOT in
 * TOOL_CATEGORIES: those are the per-agent allowlist categories every other
 * runtime (chat, skills, work runs) grants from, and the category set itself is
 * load-bearing (agentInheritsAllTools reads "every category enabled" as
 * inherit-all). The live agent never narrows its staging half by category.
 *
 * The other two ARE registry read tools — `list_workspace_members` and
 * `list_labels` — with ONE definition each, the registry's (createTools).
 * createLiveAgentTools used to keep hand-rolled copies that the registry ones
 * shadowed; those copies are deleted. The live ceiling grants both names on
 * every turn whatever the persona's selection (LIVE_AGENT_PINNED_READ_TOOL_NAMES
 * in src/lib/live-agent/ceiling.ts). tool-registry-sync.test.ts pins both sides.
 */
export const LIVE_AGENT_RESOLVER_TOOL_NAMES = [
  'search_projects',
  'search_contacts',
  'list_workspace_members',
  'list_labels',
  'get_project_details',
] as const

/** The resolvers with no registry counterpart — defined only for the live agent. */
export const LIVE_AGENT_ONLY_RESOLVER_TOOLS: ToolDefinition[] = [
  { name: 'search_projects', sideEffect: 'read', label: 'Search Projects', description: 'Fuzzy-search workspace projects by name (tolerates transcription misspellings)' },
  { name: 'search_contacts', sideEffect: 'read', label: 'Search Contacts', description: 'Search CRM contacts by name or email' },
  { name: 'get_project_details', sideEffect: 'read', label: 'Project Details', description: 'Get a project with its milestones and recent actions' },
]

/**
 * The ONE definition of a live-agent resolver: the registry's own entry when the
 * name is a registry tool (list_workspace_members, list_labels), else its
 * live-only entry. Undefined for any other name.
 */
export function getLiveAgentResolverDefinition(toolName: string): ToolDefinition | undefined {
  if (!(LIVE_AGENT_RESOLVER_TOOL_NAMES as readonly string[]).includes(toolName)) return undefined
  return TOOL_REGISTRY_MAP.get(toolName)?.tool ?? LIVE_AGENT_ONLY_RESOLVER_TOOLS.find((t) => t.name === toolName)
}

// ──────────────────────────────────────────────────────────────────
// Mutation classification (report-mode flow runs)
// ──────────────────────────────────────────────────────────────────

/**
 * A tool is mutating when its name starts with a write verb.
 *
 * `settle_`, `revise_` and `undo_` joined it with bots v3 Phase 5's attended
 * tools (settle_card, revise_email_draft, undo_extraction_pass).
 *
 * `discard_` joined it with discard_email_draft (GEN-1165).
 *
 * `research_` and `cancel_` joined the list with the prospecting family:
 * `research_my_company` / `research_prospect_companies` each fire a paid Exa
 * search and write its result onto a row, and `cancel_prospecting_run` flips a
 * run's status. All three are writes wearing a domain verb. Registry tool
 * names are verb_noun by convention, so the prefix IS the classification —
 * the guard test (__tests__/mutating-tools.test.ts) asserts every real tool
 * is recognizably read- or write-shaped so a future tool can't silently
 * escape report mode.
 */
const MUTATING_TOOL_NAME_RE =
  /^(create|update|delete|complete|confirm|dismiss|accept|reorder|link|unlink|send|publish|schedule|archive|start|supersede|merge|ingest|propose|suggest|draft|generate|sync|set|add|remove|edit|attach|research|cancel|settle|revise|discard|undo|replace|append|insert|restore|revert|rename)_/

/**
 * The writes a report-mode run is DEFINED to be allowed: producing its own
 * output surface (a document + comments) and staging suggestions on it
 * (suggest_changes: nothing on the board changes until a person accepts).
 * Everything else that matches the write-verb pattern is denied in report mode.
 */
export const REPORT_MODE_WRITE_ALLOWLIST = ['create_document', 'add_comment', 'suggest_changes'] as const

/**
 * Tools that mutate despite not matching the verb pattern. Reviewed against
 * the full registry (2026-07-01): every mutator at that time matched the
 * pattern (list_/get_/read_/search-shaped names are all pure reads — including
 * get_action_suggestions, read_email, get_meeting_prep, traverse). It exists so
 * a non-verb-shaped mutator has an explicit home; the guard test fails on any
 * tool it can't classify.
 *
 * `push_action_to_asana` is the first entry: it creates a task in an EXTERNAL
 * system (and a local link row), so a report-mode run must not reach it, but
 * `push_` isn't a Dial8 write verb and renaming it would misdescribe what it
 * does. `push_action_to_jira` is its sibling for the same reason — every
 * `push_action_to_*` tool belongs here by construction.
 */
const NON_PREFIX_MUTATING_TOOLS: string[] = [
  // Inbox triage (GEN-1166): calls a mailing list's one-click link or sends an
  // unsubscribe email from the person's mailbox. (update_email_thread matches `update_`.)
  'unsubscribe_thread',
  // (start_helper, which starts paid background work, matches `start_`.)
  // Cancels a running helper; `stop_` is no write verb, but it changes a run.
  'stop_helper',
  // Local agents (docs/plans/local-agents.md): a message starts or steers a
  // turn on the person's Mac, and a stop cancels one. (start_local_agent
  // matches `start_`; local_agents and read_local_agent only read.)
  'message_local_agent',
  'stop_local_agent',
  // Texts a guest the main agent's answer (guest access); `answer_` is no write verb.
  'answer_guest',
  // Sends a linked person's agent a message (agent links); `ask_` is no write verb.
  'ask_agent',
  // Saves a line to an area's memory; `remember` is no write verb, but a write.
  'remember',
  // Ends the person's getting started (writes their onboarding progress); `finish_` is no write verb.
  'finish_getting_started',
  'push_action_to_asana',
  'push_action_to_jira',
  'push_action_to_linear',
  // Stages sequence enrollments (writes sequence_enrollment rows). `enroll_`
  // isn't a Dial8 write verb and renaming would misdescribe the staging
  // semantics, so it lives here.
  'enroll_contacts_in_sequence',
  // Outreach launches (roadmap D1/D2): each raises the person's launch card
  // and, on their yes, arms sending. `launch_` is no Dial8 write verb.
  'launch_sequence',
  'launch_campaign',
  // A paid web search that fills the contact's empty columns; `enrich_` is no
  // Dial8 write verb, and the name is the person's own word for it.
  'enrich_contact',
  // Prospecting's three money-spending / CRM-writing tools whose names are
  // neither read- nor write-verb-shaped. `find_prospect_people` is the sharp
  // one: it READS like a search and is in fact a paid Exa run that writes
  // person entries onto the list, so it is also excluded from
  // isReadShapedToolName below — the `find_` prefix must not launder it.
  'find_prospect_people',
  // The combined verb, and the sharpest of the lot: `find_` over TWO paid runs
  // back to back. Same treatment as `find_prospect_people` — listed here, and
  // excluded from isReadShapedToolName below so the prefix cannot launder it.
  'find_prospects',
  'run_prospect_discovery',
  'save_prospect_entries',
  'publish_prospect_list',
  // Browser writes: verb-first names whose verbs (navigate/click/type) are none
  // of the write-verb regex's, so they're listed here. They act on the open web
  // (external-write), gated by the person's blocked sites in the agent's browser.
  'run_browser_task',
  'open_browser',
  'close_browser',
  // Writes a live_directive row for the meeting's note-taker (live-agent
  // messaging L2). `tell_` is not a write verb, and the name says what the user
  // asked for, so it lives here.
  'tell_note_taker',
  // Raises a card that changes who a loop runs as (F1). `transfer_` is not a
  // write verb.
  'transfer_flow_owner',
  // Raises the owner's card to hand a loop over (F1). `request_` is not a write verb.
  'request_flow_takeover',
  // Runs a loop's skill steps (a paid run, F1). `test_` is not a write verb.
  'test_flow',
  // Calls a server at a URL the model passes (F2). Neither verb is a Dial8 write verb.
  'connect',
  // Removes a connection from the person's card (F2).
  'disconnect',
  // Setup by text (src/lib/onboarding/text-setup.ts): a one_time_link row, and the owner's
  // business profile into the workspace memory. Neither `connect_` nor `save_` is a write verb.
  'connect_link',
  'save_business_profile',
  // Imports a contact file into the CRM (roadmap track G). `import_` is not a write verb.
  'import_contact_file',
  // A business's website (roadmap track E): connect_website saves the site and its project; the
  // other two open a pull request on its repo. None of `connect_`, `wire_`, `change_` is a write verb.
  'connect_website',
  'wire_website_form',
  'change_website',
  // Books a customer's chosen time on the owner's yes (roadmap F3): a booking, the owner's
  // calendar and the customer's text. `book_` is not a write verb. (send_quote matches `send_`.)
  'book_quote',
]

/**
 * Every registered tool name that mutates workspace state, minus the
 * report-mode allowlist. Feed this to computeToolCeiling's disabledTools arg
 * (and subtract it from the result — CORE_TOOL_NAMES bypass that arg) to
 * build the report-mode ceiling for headless run_skill flow actions.
 */
export function getMutatingToolNames(): Set<string> {
  const allowed = new Set<string>(REPORT_MODE_WRITE_ALLOWLIST)
  const mutating = new Set<string>()
  for (const name of ALL_TOOL_NAMES) {
    if (allowed.has(name)) continue
    if (MUTATING_TOOL_NAME_RE.test(name) || NON_PREFIX_MUTATING_TOOLS.includes(name)) {
      mutating.add(name)
    }
  }
  return mutating
}

/**
 * True when a tool name is read-shaped (never mutates). Exported for the
 * classification guard test: every real tool must be either read-shaped or
 * in getMutatingToolNames() ∪ REPORT_MODE_WRITE_ALLOWLIST.
 */
export function isReadShapedToolName(name: string): boolean {
  // `find_prospect_people` and `find_prospects` wear a read-shaped prefix over
  // PAID Exa runs that write list entries (`find_prospects` over two of them).
  // The prefix is the user-facing verb ("find me people at these companies")
  // and renaming it would misdescribe the tool, so the exception lives here —
  // and both are listed in NON_PREFIX_MUTATING_TOOLS above, which is what
  // actually keeps report mode away from them.
  if (name === 'find_prospect_people' || name === 'find_prospects') return false
  return (
    /^(list|get|read|search|find)_/.test(name) ||
    // Non-verb-prefixed pure reads, reviewed individually.
    name === 'find' ||
    name === 'search' ||
    name === 'deep_search' ||
    name === 'traverse' ||
    // Chat-only clarifying-question picker — asks, never writes.
    name === 'ask_user' ||
    // Puts a page in the chat: runs one query, writes nothing.
    name === 'show' ||
    // Content C0: check a post (pure), and review one (a reviewer call that
    // writes nothing but its usage row, like web research). Neither posts.
    name === 'lint_post' ||
    name === 'review_post' ||
    // Polls a run row until it settles. Spends nothing and writes nothing —
    // `wait_` is simply not one of the read prefixes.
    name === 'wait_for_prospecting_run' ||
    // Waits on a relay row for a bot's reply (bots-v4 Phase A3). Reads only:
    // the message was sent by send_bot_message, which is a write.
    name === 'wait_for_bot_reply' ||
    // Lists the person's Macs, folders and local agents (docs/plans/local-agents.md).
    // Reads only; `local_` is no verb at all.
    name === 'local_agents' ||
    // In-app browser: a JPEG screenshot and the pending-command poll — both
    // pure reads whose verbs aren't read prefixes. (read_/get_browser_* match
    // the regex already.)
    name === 'screenshot_browser' ||
    name === 'wait_for_browser_command'
  )
}
