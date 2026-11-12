import { bareToolName as withoutMcpPrefix } from '@/lib/mcp/tool-names'
/**
 * Live step text (ACTIVITY-AND-REVIEW-DESIGN §3.3): the ONE place the
 * "agent is reading an email" copy lives.
 *
 * Producers hand the recorder tool NAMES, never inputs — the privacy fence the
 * agent-run log tail already enforces (`renderEventLine` forwards names only).
 * This module turns a name into a present-tense sentence for the Activity
 * panel's "Running now" row and the detail panel's step timeline.
 */

const STEP_PHRASES: Record<string, string> = {
  // Mail
  read_email: 'Reading an email thread',
  get_email_summary: 'Reading an email thread',
  list_emails: 'Scanning your mail',
  search_emails: 'Searching your mail',
  create_email_draft: 'Drafting a reply',
  generate_email_drafts: 'Drafting replies',
  get_email_drafts: 'Checking existing drafts',
  draft_followup_email: 'Drafting a follow-up',
  revise_email_draft: 'Revising a draft',
  update_email_thread: 'Tidying your inbox',
  unsubscribe_thread: 'Asking to unsubscribe',
  discard_email_draft: 'Discarding drafts',
  // Captures and knowledge
  get_capture_transcript: 'Reading the capture',
  get_capture_content: 'Reading the capture',
  get_capture_extractions: 'Reviewing what was extracted',
  undo_extraction_pass: 'Undoing what was filed',
  list_captures: 'Looking through recent captures',
  list_recent_captures: 'Looking through recent captures',
  search_claims: 'Searching what the workspace knows',
  deep_search: 'Searching the workspace',
  search: 'Searching the workspace',
  find: 'Searching the workspace',
  get_context_bundle: 'Gathering context',
  get_meeting_prep: 'Preparing for the meeting',
  // People and companies
  search_contacts: 'Looking up a contact',
  list_contacts: 'Looking through contacts',
  get_contact: 'Reading a contact',
  get_contact_details: 'Reading a contact',
  get_company_overview: 'Reading a company',
  list_companies: 'Looking through companies',
  // Board
  list_actions: 'Reviewing the board',
  get_action: 'Reading an action',
  create_action: 'Filing an action',
  create_actions_batch: 'Filing actions',
  update_action: 'Updating an action',
  complete_action: 'Completing an action',
  add_comment: 'Leaving a comment',
  accept_proposal: 'Accepting a proposal',
  dismiss_proposal: 'Dismissing a proposal',
  settle_card: 'Settling a card',
  get_action_suggestions: 'Reviewing suggestions',
  // Documents
  create_document: 'Writing a document',
  update_document: 'Updating a document',
  edit_document_content: 'Editing a document',
  edit_document_lines: 'Editing a document',
  replace_section: 'Editing a document',
  append_to_section: 'Editing a document',
  remove_section: 'Editing a document',
  insert_section_after: 'Editing a document',
  restore_document_revision: 'Restoring a document version',
  archive_document: 'Archiving a document',
  restore_document: 'Restoring a document',
  archive_reports: 'Archiving reports',
  delete_document: 'Asking to delete a document',
  list_document_revisions: 'Reading document history',
  get_document_revision: 'Reading document history',
  get_document: 'Reading a document',
  read_canon: 'Reading a canon document',
  // Connections (F2)
  list_connections: 'Checking connections',
  connect: 'Getting a Connect card ready',
  disconnect: 'Preparing to disconnect',
  set_tool_access: 'Changing tool access',
  get_tool_approval_result: 'Checking an approved call',
  // Posts (content C0)
  lint_post: 'Checking a post',
  review_post: 'Reviewing a post',
  publish_post: 'Asking to post',
  send_payment_link: 'Asking to send a payment link',
  send_quote: 'Asking to send a quote',
  book_quote: 'Asking to book a job',
  move_booking: 'Moving a booking',
  cancel_booking: 'Cancelling a booking',
  schedule_post: 'Asking to queue a post',
  create_canon_document: 'Writing a canon document',
  propose_section_edit: 'Editing a canon document',
  revert_section_edit: 'Reverting a document edit',
  list_documents: 'Looking through documents',
  // Calendar
  get_calendar_events: 'Checking the calendar',
  get_upcoming_meetings: 'Checking upcoming meetings',
  offer_times: 'Offering times',
  list_time_offers: 'Checking time offers',
  withdraw_time_offer: 'Withdrawing a time offer',
  cancel_offered_meeting: 'Cancelling a meeting',
  accept_time_offer: 'Booking an offered time',
  record_time_offer_answer: 'Recording an answer',
  book_poll_time: 'Booking a poll time',
  nudge_time_offer: 'Reminding guests',
  list_booking_links: 'Checking booking links',
  create_booking_link: 'Making a booking link',
  update_booking_link: 'Changing a booking link',
  delete_booking_link: 'Turning off a booking link',
  // Studio
  list_studio_projects: 'Looking through the Studio',
  get_studio_video: 'Reading a video',
  get_studio_catalog: 'Checking the editing commands',
  get_studio_storyboard: 'Reading a storyboard',
  get_studio_script: 'Reading a script',
  write_studio_script: 'Writing a script',
  list_studio_assets: 'Looking through the media',
  create_studio_project: 'Making a Studio project',
  update_studio_project: 'Changing a Studio project',
  create_studio_video: 'Making a video',
  update_studio_video: 'Changing a video',
  duplicate_studio_video: 'Copying a video',
  edit_studio_video: 'Editing a video',
  make_studio_format: 'Reframing a video',
  list_studio_versions: 'Checking versions',
  restore_studio_version: 'Restoring a version',
  check_studio_video: 'Checking a video',
  render_studio_stills: 'Looking at frames',
  export_studio_video: 'Exporting a video',
  check_studio_motion: 'Checking the motion',
  review_studio_video: 'Reviewing a video',
  look_at_studio_video: 'Checking text on screen',
  get_studio_job: 'Checking an export',
  wait_for_studio_job: 'Waiting for an export',
  archive_studio_video: 'Archiving a video',
  get_studio_brand_kit: 'Reading the brand kit',
  set_studio_brand_kit: 'Saving the brand kit',
  make_studio_static_ads: 'Making static ads',
  make_studio_motion_ad: 'Making a motion ad',
  make_studio_reel: 'Making a reel',
  list_studio_ads: 'Looking through the ads',
  cut_out_studio_subject: 'Cutting out the person',
  direct_studio_video: 'Directing the cut',
  set_studio_delivery_format: 'Reframing a video',
  sound_pass_studio_video: 'Sounding a video',
  add_studio_sounds: 'Adding sounds',
  import_studio_sound: 'Placing a sound',
  list_studio_sounds: 'Looking through the sounds',
  listen_to_studio_video: 'Listening to a video',
  set_studio_presentation: 'Setting how a video is framed',
  assign_studio_costs: 'Sorting the costs',
  check_studio_continuity: 'Checking the shots match',
  import_studio_file: 'Adding a file to the Studio',
  import_studio_media_from_link: 'Downloading media into the Studio',
  transcribe_studio_asset: 'Transcribing media',
  get_studio_transcript: 'Reading a transcript',
  get_studio_images: 'Looking at images',
  list_studio_fonts: 'Looking through the fonts',
  install_studio_font: 'Installing a font',
  // Judgement and research
  web_search: 'Researching on the web',
  search_tools: 'Choosing tools',
  request_user_input: 'Asking you a question',
  finish_work: 'Wrapping up',
  finish_run: 'Wrapping up',
}

/** Tool names carry MCP / namespace prefixes on some runtimes. */
function bareToolName(name: string): string {
  const trimmed = name.trim()
  const withoutMcp = trimmed.replace(/^mcp__[a-z0-9_-]+__/i, '')
  return withoutMcpPrefix(withoutMcp)
}

function humanize(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The sentence for one tool call. Unknown tools degrade to "Running <name>". */
export function phraseForTool(toolName: string): string {
  const bare = bareToolName(toolName)
  return STEP_PHRASES[bare] ?? `Running ${humanize(bare) || 'a tool'}`
}

/** The sentence for a step that called several tools: the last one is what the
 *  agent is doing NOW; the rest are already behind it. */
export function phraseForToolNames(toolNames: readonly string[]): string | null {
  const last = [...toolNames].reverse().find((n) => typeof n === 'string' && n.trim())
  return last ? phraseForTool(last) : null
}

/**
 * Derive a step from an agent-run log line. The eve watchers and the sandbox
 * event pump write lines shaped `[tool] name1, name2`, `[tool failed] name`,
 * `❓ [asked the user a question…]`, `[step failed] …` — names only. Anything
 * else (model prose, markers) yields null: no step, no beat lost.
 */
export function phraseFromLogLine(line: string): string | null {
  const text = line.trim()
  if (!text) return null
  const tool = /^\[tool\]\s*(.+)$/i.exec(text)
  if (tool) {
    const names = tool[1].split(/[,\s]+/).filter(Boolean)
    return phraseForToolNames(names)
  }
  if (/^\[tool failed\]/i.test(text)) return 'Retrying after a tool failed'
  if (/^\[step failed\]/i.test(text)) return 'Recovering from a failed step'
  if (text.startsWith('❓')) return 'Asking you a question'
  return null
}
