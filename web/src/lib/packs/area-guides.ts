/**
 * How each area's tools work, written in code: the part of an area's pack
 * that is the same for every workspace. The pack's playbook (the system skill
 * `<area>-playbook`, seeded by migration) is how to do the area's work well;
 * this is the mechanics underneath it.
 *
 * It used to be BASE_PROMPT's "Important Workflows & Limitations" manual,
 * which every model call of every chat re-sent. In a pack it reaches the
 * agent once per conversation (once per summary), the first time it touches
 * the area (agents/chat-agent/lib/expertise.ts), and a background run whose
 * work is in the area reads it in its system prompt (background.ts). A
 * single tool's usage notes ride that tool instead (src/lib/ai/tool-guides.ts).
 *
 * Each is the bullets alone: the renderer heads it "How <area> works"
 * (render.ts). Server-only: chat-packs.ts and background.ts pass it in.
 */
import type { AreaKey } from './registry'

export const AREA_GUIDES: Readonly<Partial<Record<AreaKey, string>>> = {
  actions: [
    '- "Move X to the top of my list" is `reorder_actions` (same list, a new position; pass ALL the ids in their new order). "Move X to Done" is `update_action` with `status_name` (another list), or `complete_action`.',
    '- Several actions at once (from a meeting, a conversation, a plan): one `create_actions_batch` call, never `create_action` many times in parallel.',
    '- One the person asked for is `confirmation: "confirmed"` (the default). One you picked out of the conversation is `confirmation: "suggested"` with `source_type: "chat_suggestion"`.',
    '- Link an action to its project with `project_id`, and to a milestone with `milestone_id`; to a sprint with `cycle_id`.',
    '- Coding runs (an action Started on an agent with a repo): before any code a pre-check reads the action, and when building it could go two ways it asks the person in the chat and waits (a skip goes ahead with sensible defaults). Before a pull request opens, a reviewer on another model checks the real diff against the acceptance criteria; it can send the coder back twice, and a change it still won\'t approve opens no PR (the run says why). A run nobody started by hand only ever opens a draft. Red CI on a PR a run opened gets up to two fix runs only when its owner has the `ci_fix_loop` on, then a message says CI is still red. Say these plainly when someone asks why a run stopped or is waiting; never promise a PR the reviewer hasn\'t approved.',
  ].join('\n'),

  projects: [
    '- Projects hold captures, documents, milestones and linked actions; milestones are checkpoints inside one (`create_action` with `project_id` and `milestone_id`).',
    '- Cycles are a team\'s sprints: one active per team at a time. `list_cycles` shows upcoming, active and completed ones; `create_cycle(team_id, start_date, end_date)` makes one; `start_cycle` / `complete_cycle` move it on (completing can roll unfinished actions to the next). Assign an action with `cycle_id`.',
  ].join('\n'),

  initiatives: [
    '- Initiatives are high-level objectives (OKRs); projects roll up into them. Once a plan is talked through, build it top down: initiative, then projects, milestones and actions.',
  ].join('\n'),

  captures: [
    '- Captures are recorded meetings, brainstorms, standups and ideas. Content already in the attached context needs no search.',
    '- Research (meeting prep, past conversations, synthesis): run several `find` searches from different angles (the person, the company or team, the topic), with a limit of 15; read the best hits in full with `get_capture_content` (results are previews); then synthesize themes, past decisions, open questions and action items. Nothing useful? Try other words, or widen the window: they recorded it somehow.',
    '- A live agent processes a capture while it records: it writes notes and proposes changes. `get_capture_extractions` shows them and their status. It files the person\'s own action items; other people\'s commitments become claims ("X committed to Y"), not tasks on their list. High-confidence items they own are applied (the workspace\'s auto-accept policy) and can be undone; the rest stay suggested.',
    '- Decisions come out of captures, suggested or confirmed: `list_decisions(capture_id)`, `create_decision` for one you hear, `confirm_decision` / `dismiss_decision` for the person\'s review, `confirm_all_decisions` for a capture\'s whole set.',
    '- When a capture is processed: say what it decided and who owes what. When it has confirmed action items for other people, draft the follow-up (`draft_followup_email`, never sent) and say it\'s in their drafts; in a background update, start a helper to draft it. With known contacts, add the relationship ("you\'ve met Sarah 14 times, last 2 days ago").',
  ].join('\n'),

  calendar: [
    '- The calendar is the person\'s connected Google or Microsoft account: `get_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`. An invite with anyone else on it waits for their yes.',
    '- Meetings and captures: `sync_calendar` makes pending captures for real meetings (2+ attendees, over 10 minutes), run it when they ask about upcoming meetings; `get_upcoming_meetings` lists the next ones with their capture status; `create_capture_from_event` makes one for an event, past or future.',
    '- "Prepare me for [meeting]": `get_meeting_prep` pulls past captures, actions and decisions with its people.',
  ].join('\n'),

  flows: [
    '- "Watch my calls for X" is a lens, not a new loop and not a recipe. Every call is read once, by Triage; a lens adds what to look for to that one read. Build it yourself: trigger `capture_processed`, one `run_skill` step on a lens skill. `content-lens` keeps post-worthy moments from calls the person was on, for their weekly posts; `marketing-lens` keeps what customers say on external calls (objections, competitors, their words, testimonials) and adds it to the product doc, at most once a day, owners and admins only. Never build a call loop whose own skill re-reads the call. When no lens fits, say so in one line before offering one: it reads every call again.',
    '- Where output goes (`deliver_to`): `document` (a report, the default), `notification`, `post_drafts` (posts as For you cards, for X unless `post_surface` names LinkedIn, Threads or Bluesky; the person posts each one), `doc_proposals` (section edits on the canon document in `doc_key`) or `email_drafts` (drafts in their mail, never sent). Pick the one that matches what they asked for; a lens delivers on its own.',
    '- Recipes, only when the person\'s own request matches one, never on your initiative: `create_flow` with `{ recipe, enabled: true }` fills the trigger and steps (`recipe_options` only for what they asked to change), on as they asked; say it in one line. Nothing here is seeded or on for anyone who didn\'t ask.',
    '  - "Draft X posts for me every week": `weekly_posts` (3 a week, as For you cards they post themselves; a slow week brings ideas, marked as ideas); "from my calls" adds `call_moments`. An empty brief in the result: fill it by inference as it says, and ask at most one question.',
    '  - "Keep our product doc current from customer calls": `product_doc_from_calls` (owners and admins; once a day, one digest line, grades follow the evidence). Only for that ask: "watch my calls for objections" is a `marketing-lens` loop you build, not this recipe.',
    '  - "When we ship something customers asked for, tell them": `you_asked_we_shipped` (drafts to exactly the people who asked, never sent; `launch_kit` when they also want a changelog line and a post).',
    '  - "Write my newsletter every Friday": `weekly_newsletter` (a document they shape here and copy out with its Copy button; Dial8 never sends a newsletter, keeps no list and has no sending service).',
    '  - "Fix failing CI on the PRs Dial8 opens": `ci_fix_loop` with `recipe_options.repo_full_name` (the project\'s GitHub repo, from `list_projects`): only PRs their own coding runs opened, up to 2 fix runs each, then a "CI is still red" message. Without it a red build gets nothing.',
    '  - "Open draft PRs for small bugs from my calls": `small_bug_draft_prs` (`recipe_options.project_id` when several projects have a repo): a small, clear bug said on a call becomes an action and a coding run, and only a reviewer-approved change becomes a DRAFT PR in For you, at most 2 a day. When `create_flow` says run_agent is off on this server, say in one line that coding agents aren\'t switched on here yet; don\'t build it another way.',
    '- Connected-app steps: a `call_tool` step calls one tool on one of the owner\'s connected apps: `connection` (id or name from `list_connections`), `tool` (the app\'s own tool name, as `list_connections` lists it) and `tool_input`. Not connected: offer `connect` first. A `run_skill` step can use their apps too (`connections`; report mode gets reads only). Reads run on their own, and so does a write that provably publishes nothing (a Typefully draft with no publish time); every other write waits on the person\'s approval card (Approve, Edit or Skip) in their home thread when the run gets there, and a post or anything public always does, whatever the loop\'s trust. Such a loop is on as soon as they ask: say in your one line that you\'ll ask in the chat when it runs.',
    '- Passing data: give a step an `id`, set the next step\'s `parent_id` to it, and use `{{steps.<id>.output}}` in its `tool_input`, `instructions` or body; `{{trigger.capture.title}}` is the call on a `capture_processed` loop. A step only sees the output of the step it chains off. A missing value fails that step (the run says why); an empty one (a lens that kept nothing) skips the steps that use it.',
    '- Example, "after a customer call, log the objections to my Notion" (only when asked): check `list_connections` and offer `connect` if Notion isn\'t there; then trigger `capture_processed` with `{ id: "lens", type: "run_skill", skill: "marketing-lens" }` and `{ id: "log", type: "call_tool", parent_id: "lens", connection: "Notion", tool: <its append tool>, tool_input: { <the page they named>, text: "{{trigger.capture.title}}: {{steps.lens.output}}" } }`. Ask which page if they didn\'t say. It reads each call once (the lens rides Triage), and each entry waits on their card unless they told Notion\'s tool to run without asking.',
  ].join('\n'),

  mail: [
    '- Mail is their connected Gmail or Outlook. Find mail with `find(query, types: ["email"])` (4 weeks back in the chat unless `all_time` or `since`). Use `search(query, types: ["email"])` only for its filters (`from`, `to`, `folder`, `has_attachment`, `after`) or `enrich_emails: true` (CRM context, recent meetings, open actions) when the question is about people.',
    '- `read_email` reads a whole thread ("what did that email say?"): it returns `thread_id`, `last_message_id` and each message\'s id, for a reply draft.',
    '- A reply: find the thread, `read_email`, then `create_email_draft` with `thread_id` and `in_reply_to`, so it lands in the thread. Drafts are never sent: the person sends them from their mail. A draft with `[NEEDS INPUT: …]` markers: tell them what to fill in.',
    '- "Handle my email": `get_email_summary` first (unread, threads needing replies, pending drafts), then `generate_email_drafts` (drafts from the workspace\'s context); report what was drafted and every `[NEEDS INPUT]`. `get_email_drafts` lists the drafts waiting for review.',
    '- In the main chat, when they ask: `update_email_thread` archives (or moves back to the inbox), marks read or unread, stars, labels and mutes threads in their own mailbox. It applies at once and returns its `undo`; over ten threads, say the count and wait for their yes before `confirmed_with_user`. `unsubscribe_thread` always becomes their approval card first.',
    '- The morning tidy: a few minutes after the morning digest, Dial8 archives the day\'s receipts and notifications (never newsletters, starred mail, mail that needs a reply, or anything you raised) and says so in the home thread with Undo; the log has a line for it. A receipt they miss is in their archive; after an Undo, mail from those senders stays in the inbox.',
  ].join('\n'),

  documents: [
    '- Documents are lasting pages (wiki pages, PRDs, specs, runbooks), in projects. Find one with `list_documents` or `find(query, types: ["document"])`; `get_document` reads it, a long one as its outline: read the part you need with `section`, `lines` or `match`.',
    '- `create_document` adds one. Change part of one with `edit_document_content` (exact text), `edit_document_lines` (a line range) or the section tools (`replace_section`, `append_to_section`, `remove_section`, `insert_section_after`); `update_document` replaces the whole body and needs `base_revision`.',
    '- Every change is a revision: `list_document_revisions` and `get_document_revision` show what changed; `restore_document_revision` undoes an edit when they ask.',
    '- To clear documents out of the way, archive them: `archive_document` (by id) or `archive_reports` (many skill or loop reports at once, last month\'s of one skill, say). Archived ones keep their history and `restore_document` brings them back (`list_documents` with `archived: true`, plus `include_reports` for reports, finds them). `delete_document` is for good, only when they ask for that, and only on their card. Canon documents are never archived or deleted.',
    '- Canon documents (the "Canon documents" list) are the ground truth: create a missing one from its template with `create_canon_document`; edit one a section at a time with `propose_section_edit`. To undo one edit when they ask, `revert_section_edit` with its revision (from `list_document_revisions`) keeps later edits to other sections; `restore_document_revision` puts a whole version back.',
  ].join('\n'),

  knowledge: [
    '- Claims are the workspace\'s long-term memory: durable facts, decisions, open questions and people\'s commitments from captures, documents and mail, each with its source, a confidence and links to what it\'s about. "What do we know about X?", "what was decided about Y?", "what did Sarah commit to?": claims answer it. `find` ranks them with captures and documents; `get_claim` is one claim\'s full evidence; `get_context_bundle(entity_type, entity_id)` is everything around a contact, project, capture, action or claim in one call (prefer it to chaining `get_claim` and `traverse`); `traverse` is one hop of neighbours.',
    '- `create_claim` records a fact you need to act on now, with a source excerpt (finished conversations are extracted on their own, so don\'t save everything); `confirm_claim` / `dismiss_claim` / `supersede_claim` review them; `ingest_source` pulls claims out of a document or URL. A spec the person attaches (API docs, a data model) goes to `ingest_reference` instead, never `ingest_source`.',
    '- Confident claims may be confirmed on their own (the workspace\'s auto-accept policy); the rest stay suggested until someone confirms or dismisses them. Claims several sources back are promoted on their own, and a nightly job links related claims, merges duplicates and flags contradictions.',
    '- A compiled workspace brief may sit in the prompt: use it to get your bearings, and check load-bearing specifics against live claims.',
    '- Reference material is its own layer: an ingested spec is `spec` documents (an index plus a page per endpoint or object, verbatim payloads), found with `list_documents` and read with `get_document`; project briefs list them.',
    '- Packages are named, access-controlled bundles of context ("everything about the Partner Gateway integration"): pinned items plus standing rules, without copying the graph. `list_packages` / `get_package` load one (its items, its rules\' claims and its brief); `create_package` and `add_to_package` when they want to curate, gate or share a subject\'s context (personal, team or workspace). A package exports as markdown + JSONL with provenance from its page in Knowledge (in the chat, `show` kind `knowledge` with the package as `target`): offer it when they want to take context to another tool.',
  ].join('\n'),

  crm: [
    '- Contacts fill themselves from mail contacts, capture participants and calendar attendees. A person they name: find the contact, then their profile with meeting history and open actions. "Who did I meet from Acme?", "what\'s our relationship with Acme?": `get_company_overview`.',
  ].join('\n'),

  browser: [
    '- Answer from the browser readings, verified or not. When `status` is not `verified`, follow `result.next` and say what was not confirmed. Include requested links by copying the selected `sourceReferences.citations` exactly.',
    '- `freshReadings` describes current state; `evidenceLedger` holds earlier readings. A link does not prove its unvisited content, and an omitted record does not prove absence.',
  ].join('\n'),

  content: [
    '- A post for their own X, LinkedIn, Threads or Bluesky follows `content-playbook`; the product doc as brand context (positioning, messaging, what customers say) follows `marketing-playbook`. Load the playbook first.',
    '- Dial8 never posts on its own: a post goes out by the person\'s own click, from the platform link `lint_post` returns, or, when they have Typefully connected and ask, through `publish_post` (now) or `schedule_post` (their next free slot), each their approval card under your message, posting once only on their yes. Never say a post was posted, scheduled or sent.',
    '- Every fact in a post comes from their own work, named in the checks\' `sources`: a proven claim in the product doc can be stated, a plausible one hedged, an assumption never posted as fact.',
  ].join('\n'),
}

/** An area's guide, or '' when it has none. */
export function areaGuide(area: AreaKey): string {
  return AREA_GUIDES[area] ?? ''
}
