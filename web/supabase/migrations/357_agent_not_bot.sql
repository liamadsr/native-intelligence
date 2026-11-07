-- ============================================================
-- 357: agents, not bots (or birds). Seed text only.
-- ============================================================
-- Decision, 2026-10-17 (Liam): the bot/bird persona is gone (PR #751,
-- persona removal part 1). The words the person and the model read call our
-- AI teammates "agent", never "bot" or "bird". This rewords the seeded text
-- stored in the database that still says either:
--
--   1. The work-agent identity anchor recipe (302_every_loop_has_a_bot.sql):
--      name "Work agent", and its description and prompt say agent. Its icon
--      goes back to 302's robot where 350 made it a bird. The slug
--      `loop-work-bot` stays (the app finds the anchor by it:
--      WORK_BOT_ANCHOR_SLUG in src/lib/flows/flow-bot.ts).
--   2. flows-playbook: three lines (every loop has an agent, list_flows shows
--      each loop's agent, a new agent needs no actions).
--   3. library-playbook: two lines (AI teammates are built on agents; the
--      agent's Customize, on the agent's page).
--
-- Two baselines, one file:
--   PROD   the text as main last wrote it: 302 (anchor) and
--          338_skill_helper_lines.sql (both playbooks; no later migration on
--          main touches these rows). It says "bot".
--   DEV    also has 350_birds_not_bots.sql applied (branch
--          claude/birds-settings, never merged), which reworded the same
--          rows and phrases to "bird" and set the anchor's icon to a bird.
-- Every old phrase is matched in both its bot and its bird wording, so each
-- database ends on the same text.
--
-- Identifiers stay as they are everywhere: column names, tool names and
-- fields (`bot_character`, `list_bot_work`, `bot_id`) and slugs. Each phrase
-- is replaced whole, by exact replace(), by id and slug, system rows only,
-- and only where an old phrase is still there; the rest of each text is
-- untouched. Column comments and the DB functions' exception messages are
-- left alone: the routes answer with their own words.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the playbooks and the anchor keep saying bot (or bird on DEV);
-- nothing else changes.
--
-- Idempotent: every UPDATE is fenced on an old phrase being present, and no
-- new phrase contains an old one, so a second run changes nothing and a row
-- already reading "agent" is never touched. This file holds no backslash
-- anywhere: one MCP transport decodes escapes, so the applied SQL would
-- differ from the file.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '5s';

-- 1. The work-agent anchor (302; 350 on DEV). Not a system recipe (is_system
--    false, workspace_id NULL): matched by its slug and the NULL workspace.
--    Each column changes only where it holds a known old value.
UPDATE public.recipe
SET name = CASE WHEN name IN ('Work bot', 'Work bird') THEN 'Work agent' ELSE name END,
    icon = CASE WHEN icon = '🐦' THEN '🤖' ELSE icon END,
    description = CASE
      WHEN description IN (
        'A bot made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.',
        'A bird made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.')
      THEN 'An agent made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.'
      ELSE description END,
    system_prompt = CASE
      WHEN system_prompt IN (
        'Identity anchor for work bots (bots v3). No run executes this prompt: a work bot speaks from the loops it fronts.',
        'Identity anchor for work birds (bots v3). No run executes this prompt: a work bird speaks from the loops it fronts.')
      THEN 'Identity anchor for work agents. No run executes this prompt: a work agent speaks from the loops it fronts.'
      ELSE system_prompt END,
    updated_at = now()
WHERE slug = 'loop-work-bot'
  AND workspace_id IS NULL
  AND (name IN ('Work bot', 'Work bird')
       OR icon = '🐦'
       OR description IN (
         'A bot made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.',
         'A bird made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.')
       OR system_prompt IN (
         'Identity anchor for work bots (bots v3). No run executes this prompt: a work bot speaks from the loops it fronts.',
         'Identity anchor for work birds (bots v3). No run executes this prompt: a work bird speaks from the loops it fronts.'));

-- 2. flows-playbook (338's text; 350's on DEV).
UPDATE public.recipe
SET system_prompt =
      replace(replace(replace(replace(replace(replace(system_prompt,
        'Every loop has a bot, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.',
        'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.'),
        'Every loop has a bird, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.',
        'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.'),
        'reads every loop with its trigger, actions, conditions, on/off state and bot (bearer tokens are never shown, only whether one is set).',
        'reads every loop with its trigger, actions, conditions, on/off state and agent (bearer tokens are never shown, only whether one is set).'),
        'reads every loop with its trigger, actions, conditions, on/off state and bird (bearer tokens are never shown, only whether one is set).',
        'reads every loop with its trigger, actions, conditions, on/off state and agent (bearer tokens are never shown, only whether one is set).'),
        '  - On or off, a new name or a new bot: leave `actions` out.',
        '  - On or off, a new name or a new agent: leave `actions` out.'),
        '  - On or off, a new name or a new bird: leave `actions` out.',
        '  - On or off, a new name or a new agent: leave `actions` out.'),
    updated_at = now()
WHERE id = '1ef0c12f-5d78-41ef-ab12-714512fa03cd'::uuid
  AND slug = 'flows-playbook'
  AND is_system
  AND (strpos(system_prompt, 'Every loop has a bot, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.') > 0
       OR strpos(system_prompt, 'Every loop has a bird, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.') > 0
       OR strpos(system_prompt, 'reads every loop with its trigger, actions, conditions, on/off state and bot (bearer tokens are never shown, only whether one is set).') > 0
       OR strpos(system_prompt, 'reads every loop with its trigger, actions, conditions, on/off state and bird (bearer tokens are never shown, only whether one is set).') > 0
       OR strpos(system_prompt, '  - On or off, a new name or a new bot: leave `actions` out.') > 0
       OR strpos(system_prompt, '  - On or off, a new name or a new bird: leave `actions` out.') > 0);

-- 3. library-playbook (338's text; 350's on DEV).
UPDATE public.recipe
SET system_prompt =
      replace(replace(replace(replace(system_prompt,
        'Bots, custom chat agents and live-meeting agents are built on agents.',
        'AI teammates, custom chat agents and live-meeting agents are built on agents.'),
        'Birds, custom chat agents and live-meeting agents are built on agents.',
        'AI teammates, custom chat agents and live-meeting agents are built on agents.'),
        'point the person to the bot''s Customize (About on the bot''s page) or the Agents & skills page',
        'point the person to the agent''s Customize (About on the agent''s page) or the Agents & skills page'),
        'point the person to the bird''s Customize (About on the bird''s page) or the Agents & skills page',
        'point the person to the agent''s Customize (About on the agent''s page) or the Agents & skills page'),
    updated_at = now()
WHERE id = '800dc79b-a55f-4ef5-802d-8a6945e38460'::uuid
  AND slug = 'library-playbook'
  AND is_system
  AND (strpos(system_prompt, 'Bots, custom chat agents and live-meeting agents are built on agents.') > 0
       OR strpos(system_prompt, 'Birds, custom chat agents and live-meeting agents are built on agents.') > 0
       OR strpos(system_prompt, 'point the person to the bot''s Customize (About on the bot''s page) or the Agents & skills page') > 0
       OR strpos(system_prompt, 'point the person to the bird''s Customize (About on the bird''s page) or the Agents & skills page') > 0);
