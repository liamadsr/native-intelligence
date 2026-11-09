/**
 * The tools whose result carries text someone outside wrote (A5 slice 4,
 * "untrusted labels everywhere"; the list revives the one A2 deleted with the
 * outside-text guard, d51dbd61b^:src/lib/chat/outside-text-guard.ts).
 *
 * Every tool here wraps that text INSIDE its own result, in the
 * untrusted-content marker (src/lib/email/untrusted.ts), so the model reads it
 * as data whichever agent, door or surface called the tool. The JSON envelope
 * keeps its shape; only the outside text is fenced. A drift test
 * (src/lib/ai/__tests__/outside-text-tools.test.ts) holds each entry to its
 * fence, and holds every registry tool whose name looks like it reads outside
 * text to either this list or NOT_OUTSIDE_TEXT_TOOLS, with a reason.
 *
 * `fence` names the helper(s) the tool's definition calls; the drift test
 * checks the tool's own block in `file` for one of them.
 */
export interface OutsideTextTool {
  /** Where the tool is defined (from the repo root). */
  file: string
  /** What the outside text is: the marker kind it is wrapped with. */
  kind: 'EMAIL' | 'CALENDAR' | 'FILE' | 'BROWSER' | 'TOOL' | 'TRANSCRIPT' | 'WEB'
  /** The fence the tool's definition calls (any one is enough). */
  fence: readonly string[]
  /** What carries the outside text. */
  note: string
}

/** The app's tools (src/lib/ai/tools/*) whose result is outside text. */
export const OUTSIDE_TEXT_TOOLS: Readonly<Record<string, OutsideTextTool>> = {
  list_emails: {
    file: 'src/lib/ai/tools/email.ts',
    kind: 'EMAIL',
    fence: ['untrustedListedEmail', 'wrapUntrusted'],
    note: 'subject, snippet and body of each message',
  },
  read_email: {
    file: 'src/lib/ai/tools/email.ts',
    kind: 'EMAIL',
    fence: ['wrapUntrusted'],
    note: 'subject and body of the message or each message of the thread',
  },
  unsubscribe_thread: {
    file: 'src/lib/ai/tools/email.ts',
    kind: 'EMAIL',
    fence: ['wrapUntrusted'],
    note: "the sender's unsubscribe link, when a web page is all it offers",
  },
  get_quote: {
    file: 'src/lib/ai/tools/business.ts',
    kind: 'WEB',
    fence: ['wrapUntrusted'],
    note: "what the customer wrote on the business's website quote form",
  },
  list_bookings: {
    file: 'src/lib/ai/tools/business.ts',
    kind: 'WEB',
    fence: ['wrapUntrusted'],
    note: "each booking's note, as the customer wrote it",
  },
  get_calendar_events: {
    file: 'src/lib/ai/tools/calendar.ts',
    kind: 'CALENDAR',
    fence: ['eventForModel'],
    note: "each event's description (written by whoever sent the invite)",
  },
  get_attachment_content: {
    file: 'src/lib/ai/tools/attachments.ts',
    kind: 'FILE',
    fence: ['wrapUntrusted'],
    note: "a text file's content (an image is shown, a binary file is a link)",
  },
  read_contact_file: {
    file: 'src/lib/ai/tools/contact-import.ts',
    kind: 'FILE',
    fence: ['wrapUntrusted'],
    note: "a contacts file's column headers and sample values (a spreadsheet or vCard someone sent)",
  },
  read_chat_file: {
    file: 'src/lib/ai/tools/attachments.ts',
    kind: 'FILE',
    fence: ['wrapUntrusted'],
    note: "an uploaded text file's content (a photo is shown)",
  },
  read_browser_page: {
    file: 'src/lib/ai/tools/browser.ts',
    kind: 'BROWSER',
    fence: ['run(', 'fenceBrowserPageRead'],
    note: "the page snapshot's text (run() fences every completed read through completedResult)",
  },
  get_browser_text: {
    file: 'src/lib/ai/tools/browser.ts',
    kind: 'BROWSER',
    fence: ['run('],
    note: "the page's readable text",
  },
  run_browser_task: {
    file: 'src/lib/ai/tools/browser.ts',
    kind: 'BROWSER',
    fence: ['run('],
    note: 'the task readings: evidence, linkEvidence, evidenceLedger, freshReadings',
  },
  wait_for_browser_command: {
    file: 'src/lib/ai/tools/browser.ts',
    kind: 'BROWSER',
    fence: ['completedResult('],
    note: 'a pending read or task, settled: the same fences as the call it waits for',
  },
  get_capture_transcript: {
    file: 'src/lib/ai/tools/captures.ts',
    kind: 'TRANSCRIPT',
    fence: ['transcriptForModel'],
    note: 'a transcript page (what the other speakers said)',
  },
  find: {
    file: 'src/lib/ai/tools/search.ts',
    kind: 'EMAIL',
    fence: ['wrapUntrusted'],
    note: "email hits' title (subject) and excerpt (snippet); attachment hits' excerpt (FILE). Claim, capture and document excerpts are workspace records",
  },
  search: {
    file: 'src/lib/ai/tools/search.ts',
    kind: 'EMAIL',
    fence: ['wrapUntrusted'],
    note: "email hits' title (subject) and metadata.snippet, plain and enriched",
  },
  deep_search: {
    file: 'src/lib/ai/tools/search.ts',
    kind: 'TRANSCRIPT',
    fence: ['fenceChunks'],
    note: "each meeting passage's chunk_text (TRANSCRIPT) and attachment passage's chunk_text (FILE), after the relevance filter",
  },
  get_document: {
    file: 'src/lib/ai/tools/documents.ts',
    kind: 'FILE',
    fence: ['documentContentForModel'],
    note: 'the body of a page the reference ingest generated from an uploaded file (or the part read: a section, lines, the passages around a match); person- and agent-written documents stay plain',
  },
  get_document_revision: {
    file: 'src/lib/ai/tools/documents.ts',
    kind: 'FILE',
    fence: ['documentContentForModel'],
    note: "a version's text from a generated page's history, as get_document marks the page",
  },
  get_capture_content: {
    file: 'src/lib/ai/tools/captures.ts',
    kind: 'TRANSCRIPT',
    fence: ['transcriptFirstPage'],
    note: "include_transcript's first page",
  },
  // Web-derived CRM and prospecting text (always-on safety fixes, 2026-10-15;
  // src/lib/ai/tools/web-derived.ts): what enrichment and prospecting read off
  // public pages. Names, domains, ids and URLs stay plain.
  research_my_company: {
    file: 'src/lib/ai/tools/prospecting.ts',
    kind: 'WEB',
    fence: ['fenceWebValues'],
    note: "the company's industry, description and ICP-card fields, read off its website",
  },
  list_prospect_entries: {
    file: 'src/lib/ai/tools/prospecting.ts',
    kind: 'WEB',
    fence: ['entrySummary'],
    note: "each entry's fit_rationale and a person's title (entrySummary fences them)",
  },
  list_contacts: {
    file: 'src/lib/ai/tools/contacts.ts',
    kind: 'WEB',
    fence: ['fenceWebFields'],
    note: 'job_title and department, which enrichment fills from public profiles',
  },
  get_contact: {
    file: 'src/lib/ai/tools/contacts.ts',
    kind: 'WEB',
    fence: ['fenceContactForModel'],
    note: 'job_title, department and metadata.enrichment (WEB); notes, the person\'s words with the enrichment summary folded in (WORKSPACE)',
  },
  list_companies: {
    file: 'src/lib/ai/tools/companies.ts',
    kind: 'WEB',
    fence: ['fenceWebFields'],
    note: 'industry, which enrichment fills from the company site',
  },
  create_company: {
    file: 'src/lib/ai/tools/companies.ts',
    kind: 'WEB',
    fence: ['fenceWebFields'],
    note: "the returned row's industry",
  },
  update_company: {
    file: 'src/lib/ai/tools/companies.ts',
    kind: 'WEB',
    fence: ['fenceWebFields'],
    note: "the returned row's industry",
  },
  enrich_contact: {
    file: 'src/lib/ai/tools/enrich-contact.ts',
    kind: 'WEB',
    fence: ['settledResult'],
    note: 'the job_title and department the run found on public pages and the bio it wrote into their notes (settledResult fences them: fenceWebFields, webText)',
  },
  get_contact_details: {
    file: 'src/lib/ai/tools/crm.ts',
    kind: 'WEB',
    fence: ['fenceWebFields'],
    note: "the person's job_title (WEB) and their email threads' subjects (EMAIL, fenceThreads)",
  },
  get_company_overview: {
    file: 'src/lib/ai/tools/crm.ts',
    kind: 'WEB',
    fence: ['fenceWebFields'],
    note: "the company's industry and description and each person's job_title (WEB); email threads' subjects (EMAIL, fenceThreads)",
  },
  // GEN-1172: an approved call's stored result, mostly a connected app's (src/lib/safety/approval-results.ts).
  get_tool_approval_result: {
    file: 'src/lib/ai/tools/approval-results.ts',
    kind: 'TOOL',
    fence: ['approvalOutcomeForModel'],
    note: "the result a held call returned once the person approved it: another service's text, or a Native Intelligence tool's output",
  },
}

/**
 * Registry tools whose names look like outside text but whose results are not,
 * each with why. A new tool matching the drift test's name pattern must land in
 * one of the two lists.
 */
export const NOT_OUTSIDE_TEXT_TOOLS: Readonly<Record<string, string>> = {
  // A business's website (roadmap track E, src/lib/ai/tools/website.ts).
  list_website_repos: 'GitHub repo names (owner/repo shape only: no spaces, no prose), an origin and a date',
  connect_website: "Native Intelligence's own words about the repo; file paths and field names are shape-checked (no spaces) and quoted as data",
  wire_website_form: "a write; returns Native Intelligence's own status words",
  change_website: "a write; returns Native Intelligence's own status words",
  undo_website_change: "a write; returns Native Intelligence's own status words",
  import_contact_file: 'a write; returns its own counts, summary and the contact ids to check (no file text)',
  import_stripe_customers: "a write; returns Native Intelligence's own status words and a batch id (the customers are read in the background)",
  list_contact_imports: 'import batches: source, status, counts, the summary Native Intelligence wrote',
  undo_contact_import: 'a write; returns its own summary',
  get_email_summary: 'counts only (unread, needs reply, drafts)',
  get_email_drafts: "the agent's own drafts",
  create_email_draft: 'a write; returns the draft it made',
  generate_email_drafts: 'a write; returns counts and draft ids',
  revise_email_draft: 'a write; returns the revised draft',
  update_email_thread: 'a write; returns thread ids, what changed and the undo (no mail text)',
  discard_email_draft: "a delete; returns ids and outcomes (its confirm list carries the agent's own drafts' subjects, fenced)",
  draft_followup_email: 'a write; returns the draft it made',
  publish_draft: 'a write; returns a receipt',
  list_attachments: 'file metadata only (names, sizes, types)',
  attach_chat_file: 'a write; returns a receipt',
  create_calendar_event: 'a write; returns the event it made',
  update_calendar_event: 'a write; returns a receipt',
  delete_calendar_event: 'a write; returns a receipt',
  sync_calendar: 'a write; returns counts',
  screenshot_browser: 'an image, shown only to a model that can view images',
  open_browser: 'a window receipt',
  close_browser: 'a window receipt',
  // Matched by the CRM / prospecting part of the name pattern; their results
  // carry no web-derived prose.
  list_contact_captures: "capture titles and dates: the workspace's own records",
  create_contact: 'a write; returns the contact it made (enrichment runs later, in the background)',
  update_contact: 'a write; returns id, name and email',
  update_crm_contact: 'a write; returns a receipt',
  enroll_contacts_in_sequence: 'a write; returns counts',
  list_prospect_lists: 'list names, purposes and stage tallies the person or agent wrote',
  create_prospect_list: 'a write; returns the list it made',
  update_prospect_list: 'a write; returns the list',
  run_prospect_discovery: 'starts a run; returns its id and counters',
  research_prospect_companies: 'starts a run; returns its id and counters',
  find_prospect_people: 'starts a run; returns its id and counters',
  find_prospects: 'starts runs; returns their ids and counters',
  wait_for_prospecting_run: "a run's status, progress counters and counts",
  get_prospecting_run_candidates: 'suppression groups with candidate names, identity keys, links and our own discovery angles',
  cancel_prospecting_run: 'a write; returns a receipt',
  save_prospect_entries: 'a write; returns the saved entries by name',
  publish_prospect_list: 'a write; returns counts',
  dismiss_prospect_entries: 'a write; returns a receipt',
}

/**
 * Outside text that reaches a model outside src/lib/ai/tools:
 *   - external MCP tools (`mcp__*`): src/lib/mcp-client/adapter.ts fences every
 *     result's text parts (fenceMcpContent), and `mcp_confirm_call`'s too;
 *   - eve's web_fetch: every agent that keeps it wraps the page
 *     (agents/<name>/tools/web_fetch.ts + lib/untrusted.ts);
 *   - eve's web_search: provider-executed (Exa through the Gateway), so no
 *     executor of ours sees the results before the model does. Not wrappable
 *     here; the standing "Web access" instruction treats results as data.
 */
export const PROVIDER_EXECUTED_UNWRAPPED = ['web_search'] as const
