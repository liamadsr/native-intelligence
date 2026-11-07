-- Migration 347: the Morning Brief stops prepping each meeting; prep comes
-- about 30 minutes before each meeting instead.
--
-- WHY (Liam, 2026-10-15): the brief ran at the start of the day and wrote the
-- prep for every meeting at once, hours before most of them, while "things
-- can change up until like 15 minutes before the call". Each meeting now gets
-- its own prep about 30 minutes before it starts, from the always-on agent's
-- 5-minute meeting pass (src/lib/agent-events/meeting-prep.ts). The brief
-- keeps one overview line for the day's meetings and the rest of its job
-- (what is owed, what is overdue, the first move).
--
-- What changes, on the system `brief` skill only:
--   system_prompt   step 2 (work out what each meeting is about) becomes one
--                   overview line plus one broad search for what is owed;
--                   the sentences that asked for per-meeting prep follow.
--   agent_config    the three per-meeting context rules give way to one.
--   description     says where the prep went.
-- Idempotent: each statement changes only text that is still the old text.
-- No backslash anywhere (multi-line strings are plain literals).

-- 1. Step 2: one overview line, no per-meeting prep.
UPDATE public.recipe
SET system_prompt = overlay(
      system_prompt
      PLACING '### 2. Meetings get one line here; their prep comes later
Each meeting''s full prep is made on its own about 30 minutes before it starts, so it reads the latest information (things change up to the last minutes before a call). So do NOT prep meetings in this brief: no section per meeting, no search per meeting, no `get_meeting_prep`. Give today''s meetings ONE line: how many work meetings, when they start and end, and any conflict or tight back-to-back stretch ("Four calls, 10:00 to 16:30, two back-to-back after lunch; each one''s prep lands about 30 minutes before it").

Then run ONE broad `deep_search` with `cross_workspace: true` and `types: ["claims", "captures"]` for dated commitments the person owes this week (things they promised to send, decide or deliver). That one call is for what is owed, not for meetings.

'
      FROM position('### 2. Work out what each real meeting is about' IN system_prompt)
      FOR position('### 3. Pull what' IN system_prompt) - position('### 2. Work out what each real meeting is about' IN system_prompt)
    ),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('### 2. Work out what each real meeting is about' IN system_prompt) > 0
  AND position('### 3. Pull what' IN system_prompt) > position('### 2. Work out what each real meeting is about' IN system_prompt);

-- 2. The opening paragraph: no "work out what each meeting is about".
UPDATE public.recipe
SET system_prompt = replace(system_prompt,
      'read the calendar, work out what each meeting is actually about, pull the threads they''ve left open,',
      'read the calendar, pull the threads they''ve left open,'),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('read the calendar, work out what each meeting is actually about, pull the threads they''ve left open,' IN system_prompt) > 0;

-- 3. Where the data lives: the cross-workspace search is for what is owed now.
UPDATE public.recipe
SET system_prompt = replace(system_prompt,
      'So whenever you look up what a meeting is about, search ACROSS workspaces, not just the active one.',
      'So whenever you search for what the person owes, search ACROSS workspaces, not just the active one.'),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('So whenever you look up what a meeting is about, search ACROSS workspaces, not just the active one.' IN system_prompt) > 0;

-- 4. Step 1: work meetings are counted, not prepped.
UPDATE public.recipe
SET system_prompt = replace(system_prompt,
      'These are the spine of the brief.',
      'These are what the overview line counts.'),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('These are the spine of the brief.' IN system_prompt) > 0;

UPDATE public.recipe
SET system_prompt = replace(system_prompt,
      'Weight by how hard a meeting is to walk into cold: an external meeting with a dozen people and a vendor on the line needs prep; a recurring daily standup with the same five people rarely does. If two work meetings overlap, call out the conflict and prep the higher-stakes one (more external, more attendees, more that''s at stake).',
      'If two work meetings overlap, call out the conflict in the overview line.'),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('Weight by how hard a meeting is to walk into cold:' IN system_prompt) > 0;

-- 5. How to write it: the meetings are one line.
UPDATE public.recipe
SET system_prompt = replace(system_prompt,
      '- **Your meetings** — only the ones that matter, each with its 2-3 lines of what-it''s-about and what-you-owe. In chronological order.',
      '- **Today''s meetings** — the one overview line from step 2, nothing more: each meeting''s prep arrives about 30 minutes before it.'),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('- **Your meetings** — only the ones that matter, each with its 2-3 lines of what-it''s-about and what-you-owe. In chronological order.' IN system_prompt) > 0;

UPDATE public.recipe
SET system_prompt = replace(system_prompt,
      '- **Be specific or be quiet.** "Prep for the pilot readiness call" is weak; "the pilot readiness call — last week you flagged device config as the blocker for accurate pilot testing, and a July 31 checkpoint is confirmed" is the brief doing its job. Specifics come from the searches in step 2 — if you don''t have them, a short honest line beats vague filler.',
      '- **Be specific or be quiet.** "Look at overdue work" is weak; "GEN-121, the diagram you promised Dana by Friday, is two days late" is the brief doing its job. Specifics come from the searches in steps 2 and 3 — if you don''t have them, a short honest line beats vague filler.'),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND position('- **Be specific or be quiet.** "Prep for the pilot readiness call" is weak;' IN system_prompt) > 0;

-- 6. The context rules: one rule for meetings instead of three prep rules.
UPDATE public.recipe
SET agent_config = jsonb_set(
      COALESCE(agent_config, '{}'::jsonb),
      '{context_rules}',
      '["No per-meeting prep in the brief: each meeting gets its own prep about 30 minutes before it starts. Give today''s meetings ONE overview line (how many, when they start and end, conflicts) from get_calendar_events, render every time in the user''s local zone, and mention personal/noise (gym, meals, holidays, PTO, focus blocks) in at most one line."]'::jsonb
        || COALESCE(
          (SELECT jsonb_agg(t.rule ORDER BY t.ord)
             FROM jsonb_array_elements(COALESCE(agent_config -> 'context_rules', '[]'::jsonb)) WITH ORDINALITY AS t(rule, ord)
            WHERE t.rule::text NOT LIKE '%to find what a meeting is about%'
              AND t.rule::text NOT LIKE '%Derive each meeting%'
              AND t.rule::text NOT LIKE '%Triage the calendar%'),
          '[]'::jsonb)
    ),
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND COALESCE(agent_config::text, '') NOT LIKE '%No per-meeting prep in the brief%';

-- 7. The description.
UPDATE public.recipe
SET description = 'Start your day with one clear picture — the shape of your meetings, what you owe, what is overdue, and the single best first move. Each meeting''s full prep arrives on its own about 30 minutes before it starts.',
    updated_at = now()
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND description LIKE 'Start your day with one clear picture — what each meeting is really about%';
