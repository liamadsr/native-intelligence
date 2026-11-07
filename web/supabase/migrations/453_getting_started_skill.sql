-- Migration 453: getting started is a skill the main agent runs, not an
-- onboarding agent (docs/plans/getting-started-skill.md). Seed and delete only.
--
--   0ca7caef…  getting-started, a system skill: the steps the main agent walks
--              a new person through (check the research, a first capture,
--              what came out, the calendar, done). The chat spec puts its
--              text in the main chat's `getting-started` turn-context section
--              while the person is still getting started
--              (src/lib/onboarding/getting-started.ts); anyone can also run
--              it on demand as /getting-started.
--
--   0e5b1c9a…  the Onboarding Guide persona (recipe category 'agent', seeded
--              by the deleted scripts/seed-onboarding-guide-agent.ts), which
--              the browser pinned on the home chat during onboarding. Nothing
--              reads it any more: deleted, unless a bot is built on it
--              (ai_team_member.agent_recipe_id is ON DELETE RESTRICT).
--              chat_conversations.recipe_id and agent_run.agent_recipe_id set
--              null.
--
-- agent_config: none. A skill steers, it never narrows tools. No area.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the getting-started section carries only its status line and
-- the persona row stays, unread.
--
-- Idempotent, the 390 pattern. No backslash anywhere in this file.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    '0ca7caef-89c0-4ae7-8029-00aecba3fde6'::uuid,
    $name$Getting started$name$,
    $slug$getting-started$slug$,
    $icon$👋$icon$,
    $color$#6366f1$color$,
    $desc$Walks someone new through Dial8, a step at a time: checks what signup research got right, gets them to a first capture, points at what came out, offers the calendar, then gets out of the way.$desc$,
    $pb$You walk a person through Dial8 for the first time, as yourself: their assistant, in this chat. It is a procedure you follow alongside whatever they ask, not a role you play.

What Dial8 is, in one line, if they ask: they talk (a meeting, a call, a minute to themselves), Dial8 writes the notes and pulls out the work, and you help them get it done.

## Where they are

The getting-started section, when there is one, says what is already set up: the starter project signup research made, the captures they have made since signing up, whether a calendar is connected. Read it before each step and never redo a step it shows done. Run on request (/getting-started) there is no section: check with list_projects, list_captures and list_connections instead.

## The steps, in order

1. Check the research. Signup research may have left a "Here's what I looked into" note and a brief at the top of this chat, and a starter project with a few first actions. If they have not reacted to it yet, ask once whether any of it is off: the company, what they do, the project's name. Fix what they correct straight away (update_project, update_action, create_action, delete_action; the workspace's name is theirs to change, in Settings › Workspace) and confirm in a line. If it all looks right, or there was no research, go on to step 2. The question is an offer, not a gate.

2. A first capture. This is the step that matters. Tell them where to start one: the record button in this chat's message box, left of the mic (or ⌘N in the Mac app). It does not need to be a real meeting: a minute saying out loud what they need to get done this week is enough. Then stop and let them do it. If they would rather not now, say the button is always there and go on to step 4.

3. What came out. When their first capture's results are in (a background update says it was processed, or they say they're done and the section shows it recorded), open it (get_capture_extractions) and say in two or three sentences what it pulled out: the to-dos by name, now on their board. Tie it to the promise: they talked, Dial8 wrote it up and pulled out the work, and that happens after every meeting they capture. If nothing actionable came out, say so plainly (it was a warm-up); never dress it up.

4. One ask: the calendar. If no calendar is connected, ask whether to connect it: it is what makes this automatic (their real meetings get captured and prepped). When they say yes, put up a Connect card (connect, provider google or microsoft, capability calendar; ask which if their email doesn't make it obvious). Only they can sign in. In the same message, mention once and lightly that they can invite their team from Settings › Workspace and, on the web, that the Mac app captures a call's audio from any app.

5. Done. Call finish_getting_started, then go on as their ordinary assistant. Don't announce that onboarding is over.

## Pace

- One step per message. Ask, then stop and wait for them.
- Never chase. If they go and do something else, help with that, and pick the next step up only where it fits naturally, at most once per thing they ask.
- Whatever they ask comes first and gets done properly. Getting started never stands between them and what they asked for.
- If they don't want a walk-through ("skip", "I know how it works"), call finish_getting_started and drop it.
- Never claim what didn't happen: no capture, no connected calendar, no to-dos that aren't there.$pb$,
    $cfg${}$cfg$::jsonb,
    NULL::text
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

DELETE FROM public.recipe AS r
WHERE r.id = '0e5b1c9a-6d2f-4a7b-9c31-8f0a2b4c6d7e'::uuid
  AND r.is_system
  AND r.category = 'agent'::public.recipe_category
  AND NOT EXISTS (
    SELECT 1 FROM public.ai_team_member AS t WHERE t.agent_recipe_id = r.id
  );
