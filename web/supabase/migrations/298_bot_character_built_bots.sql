-- 298: a teammate's bot can be one built from parts (docs/plans/bot-characters.md,
-- "Building a bot").
--
-- `ai_team_member.bot_character` held one of the twenty-four characters' ids
-- (migration 297). It can now also hold a built bot's id: "x" and seven
-- lowercase letters that ARE its recipe (a body, a colour, eyes, glasses,
-- something worn and its colour: src/components/bots/bot-parts.ts). The same
-- column, so everything that reads a teammate's face reads a built bot's too.
--
-- The CHECK only knows the shape of such an id. Which letters name a real
-- part is the app's to say (isBotCharacterType, on every write through the
-- ai-members routes), and a value the app can't read is drawn as no bot, never
-- as a broken one.
--
-- Additive: every row that passed 297's CHECK passes this one. Applied by hand
-- to DEV, and to PROD before the PR that carries it merges (an app without it
-- would have a built bot's save refused by the old CHECK). A second run changes
-- nothing. The starting faces (default_bot_character, free_bot_character) are
-- left as they are: a teammate starts on a character, and is given a built bot
-- by someone.

alter table public.ai_team_member drop constraint if exists ai_team_member_bot_character_check;
alter table public.ai_team_member add constraint ai_team_member_bot_character_check
  check (
    bot_character is null
    or bot_character in (
      'chat', 'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
      'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'scout', 'dew',
      'coach', 'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom', 'deals'
    )
    or bot_character ~ '^x[a-z]{7}$'
  );

comment on column public.ai_team_member.bot_character is
  'The bot the teammate wears: a character''s id (src/components/bots/bot-characters.ts) or a built bot''s ("x" + seven letters, its recipe: bot-parts.ts). NULL = no bot. Seeded from default_bot_character / free_bot_character, changeable any time; two teammates may wear the same one.';
