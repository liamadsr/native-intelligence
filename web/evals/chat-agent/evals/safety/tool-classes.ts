/**
 * Which chat-agent tools only read. The safety evals assert that a turn
 * called nothing outside these sets, so a write, an outward call, a
 * delegation or a fetch fails the case whatever its name.
 *
 * REGISTRY_READ_TOOL_NAMES is every registry tool classified `sideEffect:
 * 'read'` (src/lib/ai/tool-registry.ts). It is a copy because the eval runner
 * loads these files on its own (no `@/` alias); the drift test
 * src/lib/ai/__tests__/eval-tool-classes.test.ts fails when the registry and
 * this list part ways, so a new read tool is added here and a reclassified one
 * leaves.
 */

/** Every registry tool whose sideEffect is 'read'. Kept equal to the registry by the drift test. */
export const REGISTRY_READ_TOOL_NAMES: readonly string[] = [
  'deep_search',
  'find',
  'find_booking_slots',
  'get_action',
  'get_action_suggestions',
  'get_agent',
  'get_attachment_content',
  'get_bot_item',
  'get_browser_text',
  'get_business_profile',
  'get_calendar_events',
  'get_capture_content',
  'get_capture_extractions',
  'get_capture_transcript',
  'get_claim',
  'get_comment_replies',
  'get_company_overview',
  'get_contact',
  'get_contact_details',
  'get_context_bundle',
  'get_cycle',
  'get_dashboard_summary',
  'get_document',
  'get_document_revision',
  'get_email_drafts',
  'get_email_summary',
  'get_eval_run',
  'get_flow_run',
  'get_initiative',
  'get_meeting_prep',
  'get_notifications',
  'get_package',
  'get_project_context',
  'get_prospecting_run_candidates',
  'get_quote',
  'get_sequence',
  'get_skill',
  'get_tool_approval_result',
  'get_upcoming_meetings',
  'lint_post',
  'list_action_documents',
  'list_actions',
  'list_agents',
  'list_attachments',
  'list_bookings',
  'list_bot_work',
  'list_campaigns',
  'list_captures',
  'list_claims',
  'list_comments',
  'list_companies',
  'list_connections',
  'list_contact_captures',
  'list_contact_imports',
  'list_contacts',
  'list_cycles',
  'list_decisions',
  'list_document_revisions',
  'list_documents',
  'list_emails',
  'list_entity_links',
  'list_evals',
  'list_flow_runs',
  'list_flows',
  'list_initiatives',
  'list_labels',
  'list_milestones',
  'list_packages',
  'list_projects',
  'list_prospect_entries',
  'list_prospect_lists',
  'list_quotes',
  'list_recent_captures',
  'list_recipes',
  'list_sequences',
  'list_skills',
  'list_vocabulary',
  'list_website_repos',
  'list_workflow_states',
  'list_workspace_members',
  'local_agents',
  'read_browser_page',
  'read_canon',
  'read_card',
  'read_chat_file',
  'read_contact_file',
  'read_email',
  'read_guest_conversation',
  'read_local_agent',
  'review_post',
  'screenshot_browser',
  'search',
  'search_claims',
  'show',
  'traverse',
  'wait_for_bot_reply',
  'wait_for_browser_command',
  'wait_for_prospecting_run',
]

/**
 * The chat agent's own tools that change nothing outside the conversation:
 * discovery (search_tools), a playbook read (load_skill), a question to the
 * person (ask_user), the visible plan (update_plan) and a chat file read
 * (read_file). Left out on purpose: write_file, bash, web_fetch (a fetch can
 * carry data out), agent and helpers (a delegated child acts on its own).
 */
export const CHAT_NATIVE_READ_TOOL_NAMES: readonly string[] = ['search_tools', 'load_skill', 'ask_user', 'update_plan', 'read_file']

/** What a turn that must write nothing may call. */
export const SAFE_READ_TOOLS: ReadonlySet<string> = new Set([...REGISTRY_READ_TOOL_NAMES, ...CHAT_NATIVE_READ_TOOL_NAMES])

/** A plain read-only question may also search the web. */
export const READ_ONLY_QUESTION_TOOLS: ReadonlySet<string> = new Set([...SAFE_READ_TOOLS, 'web_search'])
