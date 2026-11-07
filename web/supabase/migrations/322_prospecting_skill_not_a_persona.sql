-- Migration 322: the prospecting skill stops being a persona
-- (docs/plans/always-on-agent.md, phase A0). Seed only.
--
-- The system skill 253 seeded as "Scout" opened "You are Scout…" and ran to
-- about 3,000 tokens. The main chat lists skills by name and loads one before
-- improvising, so `load_skill` handed it a second identity to switch into,
-- and the prospecting playbook (319) called it the thing that "walks the whole
-- pipeline": the model read Scout as an agent to hand off to. Prospecting has
-- no model of its own; it is plain code and Exa behind the prospecting tools.
-- Scout stays the FACE of the Prospecting system teammate (318); only the
-- skill changes.
--
-- What lands, on the same fixed ids:
--   c4b81f6d…  the skill, renamed `build-prospect-list` ("Build a prospect
--              list"): a procedural recipe of about 950 tokens. The steps
--              (their company, who they want, the list, find and score,
--              people, save / publish / enroll) and the cases the playbook
--              doesn't cover; the playbook's rules (the go-ahead, never
--              talking about money, what is the person's to decide) by
--              reference only. Tagged `prospecting` like 316 tagged it.
--   1b502445…  the prospecting playbook, 319's text with one line changed:
--              it points at `build-prospect-list` instead of `scout`.
--
-- System skills are global rows (workspace_id NULL), one per skill, so these
-- two rows are every copy. A workspace's own fork of Scout (forked_from) is a
-- member's skill with its own slug and stays as they made it.
--
-- The app arms the skill by slug (PROSPECT_LIST_SKILL_SLUG in
-- src/app/account/(dashboard)/prospecting/start-event.ts), so the slug and that
-- constant ship together. src/lib/packs/__tests__/migration-322.test.ts pins
-- this file, and playbook-accuracy.test.ts reads these two texts in place of
-- 319's playbook.
--
-- Idempotent, the 316/319 pattern: fixed ids, inserted when missing, else
-- updated only where they differ.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'::uuid,
    $name$Build a prospect list$name$,
    $slug$build-prospect-list$slug$,
    $icon$🔭$icon$,
    $color$#0ea5e9$color$,
    $desc$Steps to build a prospect list end to end: research the person's company, find and score companies, find people, save, publish to the CRM, enroll in a sequence.$desc$,
    $pb$Steps to build a prospect list end to end. The prospecting playbook holds the rules (the go-ahead before every search and publish, never talking about money, what is the person's to decide): load the `prospecting-playbook` skill first if it isn't loaded. Most requests need a step or two: start at the one they asked for.

## 1. Their company
- A turn that says "Learn about my company" with a domain and whether the source company is established came from the Prospecting page's button: start here with that domain. "Continue prospect list: <id>" means work on that list from the step it needs.
- Call `research_my_company` with no arguments first. It runs nothing when the company is already profiled.
- `needs_go_ahead`: researching reads their site, about a minute. Ask, then call again with `confirmed_with_user`.
- `needs_domain` (a personal email signup, nothing established): ask for their website, then call with `domain` and the go-ahead.
- Read it back in one sentence ("You sell X to Y") and have them confirm it before any search. "That's not us" is a new `domain`.

## 2. Who they want
One or two questions with options drawn from what you just learned (an ask_user picker works well): segment, size, geography, the signal that shows the problem. Skip this when their message already said; confirm the ICP when you ask to run discovery.

## 3. The list
`list_prospect_lists` first: when a list already targets this, offer to continue it. Otherwise `create_prospect_list`, seeded from the company profile and edited to their answers. When they react to a round ("too big", "US only"), `update_prospect_list` rather than a second list.

## 4. Find and score companies
- One ask for `run_prospect_discovery`, naming both halves: search, then profile and score each company, four to eight minutes in all.
- `wait_for_prospecting_run`, then again on its `follow_up_run`. Speak when a phase ends, never per row. Name the list so it renders as a link: they open it; never navigate the app for them.
- Then `list_prospect_entries`: how many came back, how the scores look, the best matches by name with one line of `fit_rationale` each. Asked why a score: read `fit_rationale`, don't judge it again.

## 5. People
- Ask which companies: everything still on the list, the strong matches, or the ones they pick. One search per company, about five minutes for thirty. `find_prospect_people`, then wait. A result with `joined_live_run` joined a running search: wait on the run id it gives.
- A company with no score (added by hand, or a run that stopped early): `research_prospect_companies` profiles it, or `find_prospects` scores it and finds people on one yes.

## 6. Save, publish, enroll
Each only when they ask.
- `save_prospect_entries` on what they name. Give the counts from `by_list` and say the CRM doesn't have them yet.
- Publish: `whole_list_entry_counts.pending_publish` from `list_prospect_entries` is what's waiting. Say "N companies and people go into the CRM under [list name]", get the yes, call `publish_prospect_list`. Then name each `needs_review` person and take them one at a time.
- Enroll with the `sequenceable_contact_ids` publish returned: a person who is only on the list has no contact yet. Say nothing sends until they launch the sequence.

## Edge cases
- When a list is open, the prompt's prospecting selection says which entries "these" means. Pass exactly those as `entry_ids`.
- A run already live on the list: wait on it, never start another. People searches join instead.
- Dismissing an entry that was published takes it out of the list's CRM group; the CRM row stays.
- A low score or a thin list is information for them, not a reason to dismiss or re-run. "Why so few?" is `get_prospecting_run_candidates`.$pb$,
    $cfg${"enabled_tools": ["prospecting", "sequences", "contacts"], "preferred_tools": ["research_my_company", "list_prospect_lists", "create_prospect_list", "run_prospect_discovery", "wait_for_prospecting_run", "list_prospect_entries", "find_prospect_people", "save_prospect_entries", "publish_prospect_list", "enroll_contacts_in_sequence"], "response_style": {"tone": "direct", "format": "structured"}}$cfg$::jsonb,
    'prospecting'
  ),
  (
    '1b502445-3db0-4f04-bc4b-39505d2fe5ca'::uuid,
    $name$Prospecting playbook$name$,
    $slug$prospecting-playbook$slug$,
    $icon$🔭$icon$,
    $color$#22c55e$color$,
    $desc$How Dial8's prospecting works and how to run it well: ideal-customer fit, discovery and scoring, finding people, saving, publishing to the CRM and enrolling. Loads by itself when you prospect.$desc$,
    $pb$How prospecting works in Dial8, and how to run it like a sharp SDR lead.

## What you're looking at
- A prospect list is one search for one kind of company: its ideal customer profile (ICP), its exclusions and its run defaults. `list_prospect_lists` is the front door: every other tool needs a `list_id`, and each list has its counts by stage.
- Entries are companies and the people found at them, each discovered, shortlisted, saved or dismissed. The list is not the CRM: nothing reaches the CRM until `publish_prospect_list`.
- Searches run against a real vendor and take minutes. The search tools, publish and dismiss take `confirmed_with_user`: say in one line what the call will do and roughly how long, wait for a yes to it, then call with true. One yes covers one call. `confirmed_with_user` is true only when the person said yes in this conversation. A background run never passes it: report what you'd run and leave it for them. Never talk about money: no prices, budgets or what's left.
- To build a list end to end, follow the steps in the `build-prospect-list` skill.

## Ideal-customer fit
- Start from their own company. `research_my_company` with no arguments runs nothing when the company is already profiled and returns what it sells, to whom and its buyers. Read it back in one sentence ("You sell X to Y") and have them confirm.
- The ICP is prose, not filters. What matters most is the target description: who has the problem, what size, where, and the signal that says so. Add industries, sizes, geographies, buyer titles, competitors, and anti rules (industries and keywords to exclude). You build it from their answer in `create_prospect_list`. When the workspace has remembered who it targets, start there.
- Fit is a match score from 0 to 100, set when each company is profiled, with a label (strong 80+, good 60–79, partial 40–59, weak under 40) and its rationale. Say both: "Vanta, 88, strong". No score yet means not profiled, never a bad fit. A 0 citing an excluded industry or keyword is their own anti rule. Never say hot, warm or cold: the CRM uses those words.

## Running it
1. `create_prospect_list`: a name they'd use (it becomes the CRM group), a purpose (buyers by default; investors, partners, talent, custom) and the ICP. Defaults: 20 new companies a run, 2 search rounds, 3 people per company, and it skips companies already in the CRM and anyone ever contacted.
2. `run_prospect_discovery` searches up to four angles a round, then hands off by itself to a run that profiles and scores each company: one go-ahead covers both, about four to eight minutes. Then `wait_for_prospecting_run`; when it returns `follow_up_run`, wait on that too before reading scores. One discovery or scoring run per list at a time: if a wait returns `still_running`, wait again, never start another.
3. `list_prospect_entries` reads them best match first (50 by default, up to 200). Pass `stage` (without it dismissed entries come back too) and `min_fit_score` for the strong ones. "Why so few?" is `get_prospecting_run_candidates`: every candidate grouped by why it was kept or suppressed (already in the CRM, on another list, contacted).
4. People: `find_prospect_people` on the company entries they pick (up to 50 a call), anchored on each company's own domain; a second call joins a live people run. `find_prospects` scores any unscored companies first, then finds people. `research_prospect_companies` re-profiles a company that missed scoring; it searches every company you pass, scored or not.
5. `budget_exhausted` means it stopped early and kept what it found: say so, ask whether to continue, don't explain.

## The list is theirs
- Save, dismiss, publish and enroll only when asked. `save_prospect_entries` puts entries on the list (a company brings its people) and writes nothing to the CRM; read counts from `by_list`.
- `dismiss_prospect_entries` always with a `reason`, after confirming the batch. `competitor` and `already_customer` suppress that company in every list in the workspace: say so first.
- `publish_prospect_list` writes real companies and contacts, deduped, filed under the list; a second publish adds only what's new. Report from `by_list`. A person skipped as `needs_review` couldn't be verified against the company's domain: name them, and publish one alone with `include_unverified` only after the person confirms that one.
- Then outreach: `enroll_contacts_in_sequence` with the `sequenceable_contact_ids` publish returns, the people who have an email. Most found people don't: offer the `find-email` skill for the ones that matter. Enrollment is staged; nothing sends until they launch the sequence.
- Published people are CRM contacts: `show` a contact list filtered on `prospect_list_ids`.$pb$,
    $cfg${"enabled_tools": ["prospecting", "sequences", "contacts"], "preferred_tools": ["list_prospect_lists", "research_my_company", "create_prospect_list", "run_prospect_discovery", "wait_for_prospecting_run", "list_prospect_entries", "find_prospect_people", "publish_prospect_list"]}$cfg$::jsonb,
    'prospecting'
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
