-- Migration 326: feature skills, A1c CRM & outreach (docs/plans/always-on-agent.md
-- §1b item 7). Seed only.
--
-- 1. Rewrites four area cores on the ids 319/322 seeded them under, so packs,
--    background runs and the compaction resend keep finding them by slug:
--      e05a0562…  crm-playbook          contacts, companies (get_company_overview
--                 takes company_id or domain, never a name), visibility,
--                 enrichment, interactions, voice matches, cheapest-first
--                 lookups; check-ins are drafts.
--      1b502445…  prospecting-playbook  322's rules kept (confirmed_with_user
--                 before every search, publish and dismiss; never money; the
--                 list is not the CRM until publish), in the core shape.
--      1438190a…  sequences-playbook    staged enrolling, steps, pause / resume /
--                 archive; there is no launch tool: the person launches. 319
--                 said there was no sequence card: `show` kind sequences is one.
--      48b8e8bd…  campaigns-playbook    what the three tools really do (fields,
--                 no sends, no metrics), the campaigns page card.
--    Each core has the 323 shape (what's here, how to find things, doing it
--    well, pitfalls, helpers) and is at most about 2,000 tokens.
--
-- 2. Rewrites `build-prospect-list` (c4b81f6d…, 322) in place: still global
--    (the Prospecting page arms it by slug, PROSPECT_LIST_SKILL_SLUG), same
--    slug and id, trimmed under 800 tokens, enrolling handed to
--    `launch-a-sequence`.
--
-- 3. Adds two pack-only recipes, each listed only inside its area's pack:
--      stale-relationships  crm        who's gone quiet for N days, ranked by
--                                      what's at stake, a next step each;
--                                      check-ins offered as drafts only
--      launch-a-sequence    sequences  pick or write, enroll, review, then the
--                                      person launches (no launch tool);
--                                      resume only on their yes
--
-- Gating: every row is in its feature's systemRecipeIds
-- (src/lib/editions/manifest.ts): crm, prospecting, sequences, campaigns.
--
-- src/lib/packs/__tests__/migration-326.test.ts pins this file, and
-- playbook-accuracy.test.ts holds every text to the code. Eval cases per skill:
-- src/lib/packs/skill-evals/cases/.
--
-- Idempotent, the 316/319/322/323 pattern: fixed ids, inserted when missing,
-- else updated only where they differ.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    'e05a0562-a4a2-4700-8c7b-19435fa7430b'::uuid,
    $name$CRM playbook$name$,
    $slug$crm-playbook$slug$,
    $icon$👥$icon$,
    $color$#0ea5e9$color$,
    $desc$How Dial8's CRM works and how to keep relationships accurate: contacts and companies, who can see what, enrichment, interactions, briefing before a call. Loads by itself in the CRM.$desc$,
    $pb$How the CRM works in Dial8, and how to keep relationships accurate and useful.

## What's here
- Contacts are people; companies are the organizations they work at. A contact links to one company, and Dial8 attaches contacts to a company by their email domain on its own. Teammates are contacts too (Internal); everyone else is External. Contacts come from email and calendar sync, meeting participants, imports, prospecting and by hand.
- There are no deal or stage fields. A relationship is its type (contact, lead, customer, partner, vendor, internal, candidate), its strength (strong, warm, neutral, cold, stale), tags, a follow-up date and notes, plus what Dial8 logs by itself: interactions (meetings, emails sent and received, actions assigned or completed, notes), the last one, and how many. "Pipeline" means leads and customers, their follow-up dates and their open actions.
- Visibility: a contact is private to whoever created it (plus owners and admins), shared with a team, or visible to the whole workspace. `create_contact` makes it private to the person; only the Share button on the contact's page changes that, no tool does. A contact the person can't see reads exactly like one that doesn't exist ("Contact not found"): say you can't find it in what they can see, not that it's missing. In `get_company_overview`, `people_on_record` above `contact_count` means others exist that they can't see. A company is listed once the person can see one of its people (owners and admins see all).
- Enrichment: Dial8 fills new contacts from the web by itself (title, department, LinkedIn, a short bio in the notes) and companies (site, industry, size, location), only into empty fields, never overwriting. `get_contact` shows `enrichment_status` (pending, enriched, failed, skipped). No tool runs it again: the Enrich button on the contact or company does. A missing work email is the `find-email` skill's job: it finds one from cited sources and never guesses.
- Voices: meeting speakers are matched to contacts by voice. `list_contact_captures` includes the meetings where a contact was identified by voice, and `get_capture_content` lists each participant's `speaker_label` and `voice_match_confidence`. No tool assigns a speaker or teaches a voice: the person does that in the app.

## How to find things
Cheapest first. Every CRM tool needs `search_tools` first; `find`, `list_captures` and `show` are always there.
1. Who: `list_contacts` with `search` (name or email), `relationship_type` or `company_id`: 50 by default, up to 200, most recently in touch first, each row with `last_interaction_at` and `interaction_count`. A company: `list_companies` with `search` (name or domain), most recently active first, with contact and meeting counts and `last_interaction_at`; page with `offset`.
2. The record: `get_contact` by `contact_id` or email returns notes, tags, the follow-up date and enrichment. By name it takes the first match the person can see, so prefer an id or an email.
3. The brief before a call: `get_contact_details` by `contact_id` or email: the relationship, the last 10 interactions, recent meetings with summaries, open actions with them, commitments still pending, recent threads from the person's own mailbox, and decisions. It follows a merged contact to the one it was merged into.
4. The account: `get_company_overview` takes a `company_id` or `domain`, not a name: find the company with `list_companies` first. One call returns the people on record, open actions across the account, pending commitments, recent meetings, threads and decisions.
5. Their meetings in full: `list_contact_captures` with `contact_id` (20 by default, up to 100).
6. To show people: `show` with `entity_type: contact` or `company` puts the real list in the chat. Contacts filter on `relationship_type`, `relationship_strength`, `company_id` (a name works), `tags`, `source`, `next_followup_at` lt today's ISO date for overdue follow-ups, `last_interaction_at` for who's gone quiet, `prospect_list_ids` for a published prospect list, or `full_name` contains. Companies filter on `name`, `domain`, `industry`, `employee_count_range`, `tags` and `prospect_list_ids`. `kind: record` opens one contact or company by id.
Recipes: `stale-relationships` for who's gone quiet, `everything-about` for one company or person across Dial8.

## Doing it well
- Before a meeting, brief from `get_contact_details`: who they are, the last conversation, what each side owes, the next step. After one, commitments go on the board as actions and the next touch goes on the contact as a follow-up date.
- Search before creating: `create_contact` and `create_company` don't dedupe, and a duplicate email or domain fails. `create_contact` needs a name or an email; add the email, company and title when you have them.
- `update_contact` changes identity: name, email, phone, title, department, LinkedIn, notes. `update_crm_contact` changes the relationship: type, strength, tags, follow-up date, notes. Both replace notes and tags whole, so read them with `get_contact` and pass the full new value. `update_company` changes only the fields you pass.
- Change strength on evidence (a cold reply, a signed contract) and say why. Set `next_followup_at` when someone asks to be contacted later ("ping me in March").
- Name the relationships going cold: strong once, quiet for weeks. Offer the next step (a check-in draft, a follow-up date) rather than just the observation.
- Keep notes about the relationship (what they care about, who decides), not a copy of the meeting: captures already hold that.
- Sending is the person's act. A check-in you recommend is a draft: `suggest_changes` with a `send_email` change on the contact makes a card whose Accept writes a draft for review. Nothing sends from the chat.

## Pitfalls
- No tool moves a contact to another company, merges, deletes or shares one, and none deletes a company: point to the contact's or company's page.
- Assignees and campaign owners take member ids from `list_workspace_members`, never contact ids.
- `list_contacts` has no offset and returns the most recent first: past 200 rows, narrow by `relationship_type` or `company_id`, or show the card, which holds every match.
- `update_crm_contact` takes the type and strength as free text: use the words above exactly.
- When the workspace syncs to HubSpot, a contact `create_contact` makes with an email is pushed there too: say so when you create one.

## When to hand to a helper
Not yet: helpers come later, so do the work here.$pb$,
    $cfg${"enabled_tools": ["contacts", "captures", "dashboard"], "preferred_tools": ["list_contacts", "list_companies", "get_contact", "get_contact_details", "get_company_overview", "list_contact_captures", "show", "update_crm_contact", "create_contact"]}$cfg$::jsonb,
    'crm'
  ),
  (
    '1b502445-3db0-4f04-bc4b-39505d2fe5ca'::uuid,
    $name$Prospecting playbook$name$,
    $slug$prospecting-playbook$slug$,
    $icon$🔭$icon$,
    $color$#22c55e$color$,
    $desc$How Dial8's prospecting works and how to run it well: ideal-customer fit, discovery and scoring, finding people, saving, publishing to the CRM and enrolling. Loads by itself when you prospect.$desc$,
    $pb$How prospecting works in Dial8, and how to run it like a sharp SDR lead.

## What's here
- A prospect list is one search for one kind of company: a name (it becomes the CRM group), a purpose (buyers by default; investors, partners, talent, custom), its ideal customer profile (ICP), exclusions and run defaults: 20 new companies a run, 2 search rounds, 3 people per company, skipping companies already in the CRM and anyone ever contacted.
- Entries are companies and the people found at them, each discovered, shortlisted, saved or dismissed. The list is not the CRM: saving keeps an entry on the list, and nothing reaches the CRM until `publish_prospect_list`.
- Fit is a match score from 0 to 100, set when each company is profiled, with a label (strong 80+, good 60–79, partial 40–59, weak under 40) and its rationale. Say both: "Vanta, 88, strong". No score yet means not profiled, never a bad fit. A 0 citing an excluded industry or keyword is their own anti rule. Never say hot, warm or cold: the CRM uses those words.
- Searches run against a real vendor and take minutes. The search tools, publish and dismiss take `confirmed_with_user`: say in one line what the call will do and roughly how long, wait for a yes to it, then call with true. One yes covers one call. `confirmed_with_user` is true only when the person said yes in this conversation. A background run never passes it: report what you'd run and leave it for them. Never talk about money: no prices, budgets or what's left.

## How to find things
Every prospecting tool needs `search_tools` first; `show` is always there.
1. `list_prospect_lists` is the front door: every other tool needs a `list_id`, and each list has its counts by stage and how many saved entries wait to be published. Archived lists only with `include_archived`.
2. `list_prospect_entries` reads one list best match first (50 by default, up to 200). Pass `stage` (without it dismissed entries come back too), `min_fit_score` for the strong ones, and `kind` for companies or people. `matched` is the size of what you asked for; `whole_list_entry_counts` is always the whole list.
3. "Why so few?" is `get_prospecting_run_candidates`: every candidate grouped by why it was kept or suppressed (already in the CRM, on another list, contacted).
4. A run in flight: `wait_for_prospecting_run`.
5. To show a list: `show` with `kind: prospecting` and the list as `target`. Published people are CRM contacts: `show` with `entity_type: contact`, filter `prospect_list_ids`.
To build a list end to end, follow the steps in the `build-prospect-list` skill.

## Doing it well
Ideal-customer fit:
- Start from their own company. `research_my_company` with no arguments runs nothing when the company is already profiled and returns what it sells, to whom and its buyers. Read it back in one sentence ("You sell X to Y") and have them confirm.
- The ICP is prose, not filters. What matters most is the target description: who has the problem, what size, where, and the signal that says so. Add industries, sizes, geographies, buyer titles, competitors, and anti rules (industries and keywords to exclude). You build it from their answer in `create_prospect_list`. When the workspace has remembered who it targets, start there.

Running it:
1. `create_prospect_list` with the name, purpose and ICP; it runs no search. When they react to a round ("too big", "US only"), `update_prospect_list` rather than a second list.
2. `run_prospect_discovery` searches up to four angles a round, then hands off by itself to a run that profiles and scores each company: one go-ahead covers both, about four to eight minutes. Then `wait_for_prospecting_run`; when it returns `follow_up_run`, wait on that too before reading scores. One discovery or scoring run per list at a time: if a wait returns `still_running`, wait again, never start another.
3. People: `find_prospect_people` on the company entries they pick (up to 50 a call), anchored on each company's own domain; a second call joins a live people run. `find_prospects` scores any unscored companies first, then finds people. `research_prospect_companies` re-profiles a company that missed scoring; it searches every company you pass, scored or not.
4. `budget_exhausted` means it stopped early and kept what it found: say so, ask whether to continue, don't explain.

The list is theirs:
- Save, dismiss, publish and enroll only when asked. `save_prospect_entries` puts entries on the list (a company brings its people) and writes nothing to the CRM; read counts from `by_list`.
- `dismiss_prospect_entries` always with a `reason`, after confirming the batch. `competitor` and `already_customer` suppress that company in every list in the workspace: say so first.
- `publish_prospect_list` writes the saved companies and people into the CRM as real rows, deduped, filed under the list; a second publish adds only what's new. Report from `by_list`. A person skipped as `needs_review` couldn't be verified against the company's domain: name them, and publish one alone with `include_unverified` only after the person confirms that one.
- Then outreach: `enroll_contacts_in_sequence` with the `sequenceable_contact_ids` publish returns, the people who have an email. Most found people don't: offer the `find-email` skill for the ones that matter. Enrollment is staged; nothing sends until they launch the sequence.

## Pitfalls
- A low score or a thin list is information for them, not a reason to dismiss or re-run.
- A person who is only on the list has no contact yet: enroll only what publish returned.
- Dismissing an entry that was published takes it out of the list's CRM group; the CRM row stays.
- `cancel_prospecting_run` stops a live run and keeps what it found: only when they ask.

## When to hand to a helper
Not yet: helpers come later, so do the work here.$pb$,
    $cfg${"enabled_tools": ["prospecting", "sequences", "contacts"], "preferred_tools": ["list_prospect_lists", "research_my_company", "create_prospect_list", "run_prospect_discovery", "wait_for_prospecting_run", "list_prospect_entries", "find_prospect_people", "publish_prospect_list"]}$cfg$::jsonb,
    'prospecting'
  ),
  (
    '1438190a-646d-4709-ae89-22e24ddf340b'::uuid,
    $name$Sequences playbook$name$,
    $slug$sequences-playbook$slug$,
    $icon$📨$icon$,
    $color$#a855f7$color$,
    $desc$How Dial8's sequences work and how to run outreach well: writing steps, timing and merge fields, enrolling, what sends when and who launches. Loads by itself when you work on sequences.$desc$,
    $pb$How sequences work in Dial8, and how to run outreach the person can stand behind.

## What's here
- A sequence is a run of emails sent from the person's own Gmail or Outlook to each contact enrolled in it, one step after another, until they reply or the steps run out. Every step is an email: there are no call, LinkedIn or text steps.
- A sequence is draft, active, paused or archived. You build, edit and stage; only the person launches, from Review & launch on the sequence's page, where they read every contact's emails rendered and can edit them. There's no launch tool. The only call that restarts sending is `status` resume on a paused sequence. Never say a sequence is sending before they've launched it.
- Launching needs a mailbox of theirs connected, at least one step, at least one contact enrolled, and every merge field filled for every contact. If it paused because the mailbox disconnected, they reconnect it first. Then step 1 goes to each staged contact in the next open send window, spread out a little, and each later step its delay after the one before.
- An enrollment is one contact in one sequence: active until it exits as replied, completed, removed, opted out or failed.

## How to find things
Every sequences tool needs `search_tools` first; `show` is always there.
1. `list_sequences`: every sequence with its status and enrollment counts (total, active, replied).
2. `get_sequence` with `sequence_id`: its steps with sent and failed counts, its window and timezone, and each enrollment with its status, current step, next send and exit reason. The per-contact list stops at 50 (`enrollment_limit` up to 200); the counts always cover everyone.
3. To show them: `show` with `kind: sequences`, and `target` a sequence's name or id to open that one, where the person reviews and launches.
4. Who to enroll: CRM contacts with an email, from `list_contacts`, a contact card, or a published prospect list's `sequenceable_contact_ids`.
Recipe: `launch-a-sequence` takes one from picking it to the person's launch.

## Doing it well
Writing one: `create_sequence` saves a draft and never sends.
- Steps: 1 to 20, with `step_order` 1, 2, 3 and so on. Each has a `subject`, a `body` and `delay_days`, counted from when the previous step actually went out; step 1 goes at launch. Step 1 needs a subject. Leave it off later steps so they land as replies in the same thread; a subject on a later step starts a new thread.
- Timing: the send window defaults to weekdays 9:00 to 16:00, America/Los_Angeles. Set `timezone` (an IANA name) to the person's or the recipients' and, if needed, `send_window` (`days` 1–7 for Monday to Sunday, `start_hour`, and `end_hour`, which is exclusive). `delay_unit` is business by default, counting only window days; calendar counts every day.
- Merge fields: `{{first_name|there}}` (with a fallback), `{{last_name}}`, `{{full_name}}`, `{{company}}`, `{{email}}`, `{{sender_name}}`, `{{sender_first_name}}`. A field with no value and no fallback blocks the launch, so give `{{first_name}}` and `{{company}}` fallbacks.
- What works: three to five steps over two to three weeks. Step 1 is short (under 120 words): why them, why now, one clear ask. Each follow-up adds something new, such as a proof point, a useful resource or a different angle, never "just bumping this". The last closes the loop politely. Plain text, in the person's voice (the `write-in-your-tone` skill).
- A draft never sends: save it with `create_sequence`, then show the steps and offer changes.

Enrolling: `enroll_contacts_in_sequence` stages CRM contacts, up to 200 a call. Nothing sends: new enrollments wait for the person to launch, and on a live sequence they run Review & launch again to schedule the newcomers. Say so. On a paused sequence, Review & launch also restarts everyone already in it. Ask to resume it first (on their yes, with `status` resume), then send them to Review & launch for the newcomers. Each skip has a reason: `no_email`, `already_active` (in any sequence right now, or ever in this one; re-enrolling isn't supported), `suppressed` (opted out) or `not_found` (no such contact, or one they can't see). Report skips by reason. People with no email need one first (the `find-email` skill).

Running it:
- `update_sequence` edits a draft or a live one. Pass the whole step list, with each kept step's `id` from `get_sequence`; a step left out is deleted. Sent steps can't be deleted, reordered or re-timed, and the refusal names which. Copy, unsent delays, the window and new steps at the end can change any time.
- `status` pause stops sending; resume restarts a paused sequence and moves overdue sends forward through the window with no burst; archive ends it for good and exits everyone. Pause only when asked. Resume and archive only on the person's yes in this conversation, after saying what happens: resuming sends real mail (say how many contacts are active and when the next sends go), and archiving can't be undone. Sent mail is never recalled.
- `remove_from_sequence` stops one contact (`contact_id` or `enrollment_id`).
- A reply ends that contact's enrollment by itself: it stops when the thread has more messages than Dial8 sent, so a bounce or a manual email to them stops it too. If the sending mailbox disconnects, the sequence pauses and the person is told.

Reading results: lead with replies: who replied, then what's still active and when the next sends go. Per-step counts show where people go quiet and where mail fails. Many sends and no replies means step 1 or the list needs work, not more steps. A reply is a conversation now: offer to draft the answer in Mail.

## Pitfalls
- A draft can't be started with `status` resume: it's refused, because drafts launch only from Review & launch. Never claim you launched one.
- Enrolling into a live sequence doesn't put anyone in the wave: the newcomers wait for Review & launch.
- `get_sequence` lists 50 enrollments by default: read the counts before saying who's in it.

## When to hand to a helper
Not yet: helpers come later, so do the work here.$pb$,
    $cfg${"enabled_tools": ["sequences", "contacts"], "preferred_tools": ["list_sequences", "get_sequence", "create_sequence", "update_sequence", "enroll_contacts_in_sequence", "remove_from_sequence", "show"]}$cfg$::jsonb,
    'sequences'
  ),
  (
    '48b8e8bd-2299-43b2-9a65-f9928a232b90'::uuid,
    $name$Campaigns playbook$name$,
    $slug$campaigns-playbook$slug$,
    $icon$📣$icon$,
    $color$#ec4899$color$,
    $desc$How Dial8's campaigns work and how to help a marketer run them: objectives, status, owners, tying what the team learns to a campaign. Loads by itself when you work on campaigns.$desc$,
    $pb$How campaigns work in Dial8, and how to help a marketer run them.

## What's here
- A campaign is a named marketing push: a name, a one-line objective, a description for the brief, a status (planned, active, paused, completed, archived), free-form channels (email, linkedin, events, whatever they use), start and end dates, an owner (a member) and tags. Every member of the workspace can see and edit every campaign.
- Campaigns are what a marketer's knowledge hangs off: meetings, documents and claims can be linked to one, so "what do we know about the Q4 launch" has an answer.
- What the tools really do: list campaigns, create one, and change its fields. Nothing here sends, picks an audience or measures results: outreach to contacts runs in sequences, when that feature is on, and results live wherever the team tracks them. Never promise metrics Dial8 doesn't hold.

## How to find things
Every campaigns tool needs `search_tools` first; `find` and `show` are always there.
1. `list_campaigns`: most recently updated first (50 by default, up to 200; page with `offset`), filtered by `status` or a `search` on the name. It returns whole rows with their `id`; there's no separate read for one campaign.
2. What's known about one: `list_claims` with entity type campaign and its `id`, or `get_context_bundle` for everything linked to it; `find` with its name for meetings and documents that mention it.
3. To show them: `show` with `kind: campaigns` puts the Campaigns page in the chat.

## Doing it well
Creating:
1. `list_campaigns` with a `search` first: nothing stops a duplicate.
2. Get the essentials: the name, what it's for, the channels and the dates. Ask only for what's missing, and never make up dates.
3. `create_campaign`. Dates are YYYY-MM-DD in `starts_on` and `ends_on`. The owner is a member: resolve the name with `list_workspace_members` and pass that `id` as `owner_member_id`. Status starts planned unless you pass one.

Running:
- `update_campaign` changes only the fields you pass. Move the status as reality moves: active at launch, paused, completed when it ends. To retire one, archive it.
- Tie what the team learns to the campaign: `link_entities` from a document, capture or claim to the campaign (entity type campaign) makes it show up when someone asks. A lesson ("webinars outperformed paid social 3 to 1 for mid-market") is knowledge: `create_claim` linked to the campaign, with its source.
- The work a campaign needs belongs on the board as actions, in its project when there is one.
- An objective is a result, not an activity: "Book 40 meetings with heads of RevOps by March 31", not "Run LinkedIn ads".
- The description is a real brief: audience, message, offer, channels, timing and who does what. A good brief lets a teammate pick it up cold.
- Active campaigns past their end date are worth a nudge: offer to mark them completed and to capture what worked.
- Before planning the next one, look at the last ones: their objectives, what was learned, what the team said in meetings about them.
- Keep channels consistent across campaigns (pick "linkedin", not sometimes "LinkedIn Ads"), so they compare.
- When a campaign targets a segment, prospecting builds the list and sequences reach it: offer those when the features are on.

## Pitfalls
- There's no delete: archive instead. Dates can be changed but not cleared.
- `channels` and `tags` replace the whole list: pass every value to keep.
- The owner is a member id, never a contact id.

## When to hand to a helper
Not yet: helpers come later, so do the work here.$pb$,
    $cfg${"enabled_tools": ["campaigns", "knowledge", "contacts"], "preferred_tools": ["list_campaigns", "create_campaign", "update_campaign", "link_entities", "list_workspace_members", "show"]}$cfg$::jsonb,
    'campaigns'
  ),
  (
    'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'::uuid,
    $name$Build a prospect list$name$,
    $slug$build-prospect-list$slug$,
    $icon$🔭$icon$,
    $color$#0ea5e9$color$,
    $desc$Steps to build a prospect list end to end: research the person's company, find and score companies, find people, save, publish to the CRM, enroll in a sequence.$desc$,
    $pb$Steps to build a prospect list end to end. The rules (the go-ahead before every search, publish and dismiss; never talking about money; what's the person's to decide) are in the `prospecting-playbook` skill: load it first. Most requests need a step or two: start at the one they asked for.

## 1. Their company
- "Learn about my company" with a domain came from the Prospecting page's button: start here. "Continue prospect list: <id>" means work on that list from the step it needs.
- `research_my_company` with no arguments first: it runs nothing when the company is already profiled.
- `needs_go_ahead`: researching reads their site, about a minute. Ask, then call again with `confirmed_with_user`.
- `needs_domain` (a personal email signup): ask for their website, then call with `domain` and the go-ahead.
- Read it back in one sentence ("You sell X to Y") and have them confirm before any search. "That's not us" is a new `domain`.

## 2. Who they want
One or two questions, with options from what you learned (an ask_user picker works well): segment, size, geography, the signal that shows the problem. Skip it when their message said; confirm the ICP when you ask to run discovery.

## 3. The list
`list_prospect_lists` first: when a list already targets this, offer to continue it. Otherwise `create_prospect_list`, seeded from the company profile, edited to their answers. A reaction to a round ("too big", "US only") is `update_prospect_list`, not a second list.

## 4. Find and score companies
- One ask for `run_prospect_discovery`, naming both halves: search, then profile and score each company, four to eight minutes in all.
- `wait_for_prospecting_run`, then again on its `follow_up_run`. Speak when a phase ends, never per row. Name the list so it renders as a link: they open it; never navigate the app for them.
- Then `list_prospect_entries`: how many came back, how the scores look, the best matches, each with a line of `fit_rationale`. Asked why a score: read `fit_rationale`; don't re-judge it.

## 5. People
- Ask which companies: all of them, the strong matches, or the ones they pick. `find_prospect_people` (one search per company, about five minutes for thirty), then wait. A result with `joined_live_run` joined a running search: wait on the run id it gives.
- A company with no score: `research_prospect_companies` profiles it, or `find_prospects` scores it and finds people on one yes.

## 6. Save, publish, enroll
Each only when they ask.
- `save_prospect_entries` on what they name. Give the counts from `by_list` and say the CRM doesn't have them yet.
- Publish: `whole_list_entry_counts.pending_publish` from `list_prospect_entries` is what's waiting. Say "N companies and people go into the CRM under [list name]", get the yes, call `publish_prospect_list`. Then name each `needs_review` person and take them one at a time.
- Enroll the `sequenceable_contact_ids` publish returned, following the `launch-a-sequence` skill: nothing sends until they launch.

## Edge cases
- With a list open, the prompt's prospecting selection says which entries "these" means: pass exactly those as `entry_ids`.
- "Why so few?" is `get_prospecting_run_candidates`.$pb$,
    $cfg${"enabled_tools": ["prospecting", "sequences", "contacts"], "preferred_tools": ["research_my_company", "list_prospect_lists", "create_prospect_list", "run_prospect_discovery", "wait_for_prospecting_run", "list_prospect_entries", "find_prospect_people", "save_prospect_entries", "publish_prospect_list", "enroll_contacts_in_sequence"], "response_style": {"tone": "direct", "format": "structured"}}$cfg$::jsonb,
    'prospecting'
  ),
  (
    'a7337d9e-1ec0-4ed8-b6f0-0311edd54335'::uuid,
    $name$Stale relationships$name$,
    $slug$stale-relationships$slug$,
    $icon$🕸️$icon$,
    $color$#0ea5e9$color$,
    $desc$Contacts and accounts the person hasn't been in touch with for N days, ranked by what's at stake, with a next step each; check-ins offered as drafts, never sent.$desc$,
    $pb$Who the person has let go quiet, ranked by what's at stake, with a next step for each. Reveal the CRM tools with `search_tools` first.

## Steps
1. The window: N days from the request ("a month", "since summer"); none given: 30 days, and say so. The cutoff is today minus N, as an ISO date.
2. Candidates, cheapest first:
   - People: `list_contacts` with `relationship_type` customer, then lead, then partner, `limit` 200 each. Keep the rows whose `last_interaction_at` is before the cutoff. Rows come most recent first, so a type that fills all 200 may hold quieter people past the cap: say so, and lean on the card.
   - Accounts, when asked about companies: `list_companies` with `limit` 200, paging with `offset`. Its `last_interaction_at` is the latest touch with anyone there; keep the ones before the cutoff.
   - No `last_interaction_at` at all means never in touch: leave them out unless asked.
3. Rank from the rows first: customers before leads before partners; strong or warm before cold; a high `interaction_count` (they used to talk often).
4. For the top five to ten only, the stakes: `get_contact_details` for a person, `get_company_overview` by `company_id` for an account, and `get_contact` (it has `next_followup_at`) for the top few: a follow-up date already past moves one up. Open actions, commitments still pending and the last meeting or thread move one up. There are no deals in Dial8: open work and unkept promises stand in for them.

## The answer
- One line on the window and how many went quiet. Then the ranked list: who, how long since the last touch and what it was, why it matters (an open action, a pending commitment, a customer gone silent), and one next step each: a check-in, a follow-up date, an action, or letting it go.
- When the person is in the chat, `show` the set: `entity_type: contact`, filter `last_interaction_at` lt the cutoff's ISO date and `relationship_type` is any of customer, lead and partner, ordered by `last_interaction_at`. The card holds every match; name only your top ones.
- Drafts stay drafts. Offer check-ins as `suggest_changes` with a `send_email` change on each contact, one call for the batch, each with a `why`: Accept writes a draft for review, and nothing sends from the chat. A follow-up date the person agrees to goes on with `update_crm_contact` and `next_followup_at`.
- Nobody quiet: say so in one line, with the window you checked.$pb$,
    $cfg${"enabled_tools": ["contacts", "captures", "actions"], "preferred_tools": ["list_contacts", "list_companies", "get_contact_details", "get_company_overview", "show", "suggest_changes", "update_crm_contact"], "pack_only": true}$cfg$::jsonb,
    'crm'
  ),
  (
    '287cbaef-c539-42b2-84be-3cbfef7a88ec'::uuid,
    $name$Launch a sequence$name$,
    $slug$launch-a-sequence$slug$,
    $icon$🚀$icon$,
    $color$#a855f7$color$,
    $desc$Pick or write a sequence, enroll the right contacts, review the steps, then hand the launch to the person with exactly what will send and when. Nothing sends from the chat.$desc$,
    $pb$From a chosen sequence to the person's launch. Reveal the sequences and CRM tools with `search_tools` first. Nothing here launches: there is no launch tool, and the person launches from Review & launch. The only call that restarts sending is `status` resume on a paused sequence.

## 1. The sequence
`list_sequences`. Use the one they name; ask when several fit. None fits: draft the steps (the sequences playbook says how) and save them with `create_sequence` (a draft never sends), then show them and offer changes.

## 2. Who goes in
- Resolve the people to contact ids: `list_contacts` with `search`, `relationship_type` or `company_id`, or a published prospect list's `sequenceable_contact_ids`. Only contacts with an email can go in; offer the `find-email` skill for the ones that matter.
- Read back who goes in (how many, which segment) and wait for their yes before enrolling anyone they didn't name: a contact removed from a sequence can never rejoin it, and while enrolled they can't go into any other.
- `enroll_contacts_in_sequence` with `sequence_id` and `contact_ids`, up to 200 a call. Report enrolled, and skipped by reason: `no_email`, `already_active`, `suppressed`, `not_found`.

## 3. Review the steps
`get_sequence`: check each step against the people going in. Step 1 has a subject; later ones leave it off so they thread. Every merge field needs a value or a fallback for everyone, since one gap blocks the launch. Propose the fixes. On an active or paused sequence, change it only on their yes: it changes the next email everyone already in it receives. Then `update_sequence`, passing every step with its `id`. Point out anything that reads like a template.

## 4. The launch is theirs
- Say exactly what will send and when, from the sequence's steps, `send_window`, `timezone` and `delay_unit`: "Launching sends step 1, 'Quick idea for {{company}}', to 14 people from your mailbox in the next send window (weekdays 9 to 4, Pacific), then step 2 three business days later to anyone who hasn't replied." Name who was skipped.
- Then hand it over: `show` with `kind: sequences` and the sequence as `target`, and say they launch from Review & launch, where they can read and edit every email. Never say it's sending or launched.
- On a sequence already live, the newcomers wait too: they run Review & launch again to schedule them.
- A paused sequence: Review & launch also restarts everyone already in it. Ask to resume it first: resuming sends real mail in the next window, so say how many active contacts it reaches and when, and call `update_sequence` with `status` resume only after their yes to that, in a later turn. "Set it up and launch it" is not that yes. Then send them to Review & launch for the newcomers.

## The answer
The sequence, who went in and who was skipped, what launching will send and when, and where they launch. Short: they'll read the emails themselves.$pb$,
    $cfg${"enabled_tools": ["sequences", "contacts"], "preferred_tools": ["list_sequences", "create_sequence", "list_contacts", "enroll_contacts_in_sequence", "get_sequence", "update_sequence", "show"], "pack_only": true}$cfg$::jsonb,
    'sequences'
  )
),
inserted AS (
  INSERT INTO public.recipe (
    id, workspace_id, name, slug, icon, color, description,
    system_prompt, agent_config, area,
    category, is_system, is_default, sort_order, visibility
  )
  SELECT id, NULL::uuid, name, slug, icon, color, description,
         system_prompt, agent_config, area,
         'skill'::public.recipe_category, true, false, 0, 'workspace'::public.recipe_visibility
  FROM skill
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
UPDATE public.recipe AS r
SET name          = p.name,
    slug          = p.slug,
    icon          = p.icon,
    color         = p.color,
    description   = p.description,
    system_prompt = p.system_prompt,
    agent_config  = p.agent_config,
    area          = p.area,
    updated_at    = now()
FROM skill AS p
WHERE r.id = p.id
  AND (r.system_prompt IS DISTINCT FROM p.system_prompt
       OR r.description IS DISTINCT FROM p.description
       OR r.agent_config IS DISTINCT FROM p.agent_config
       OR r.area IS DISTINCT FROM p.area
       OR r.slug IS DISTINCT FROM p.slug
       OR r.name IS DISTINCT FROM p.name
       OR r.icon IS DISTINCT FROM p.icon
       OR r.color IS DISTINCT FROM p.color);
