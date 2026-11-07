-- Migration 308: a bot's own voice (docs/plans/bots-v4.md, Phase B2;
-- decision 11).
--
-- WHY: every bot on screen speaks in a voice of its own, out of the desktop
-- app's text-to-speech voices, dealt from its face (src/lib/bots/bot-voice.ts,
-- bots-v2 decision 8), and nobody could choose it. A bot's voice is now its
-- own choice, like its face and its name: one of the desktop's voices, picked
-- in the one agent editor, or Automatic (the deal, as before).
--
--   ai_team_member.voice  the voice the bot speaks in: a voice id as the
--                  desktop's `tts_voices` lists it, NULL = Automatic. The
--                  desktop's catalogue spells an id in lowercase letters,
--                  digits and hyphens, starting with a letter or digit, at
--                  most 32 long (dial8-desktop, the local-tts catalogue
--                  check). Which voices exist is each device's to say: a
--                  desktop without this one speaks automatically
--                  (bot-voice.ts), so the CHECK holds the shape only. The
--                  routes check the same shape (src/lib/bots/voice-id.ts).
--
-- Not a limits column. Like a bot's face and name, anyone who may edit the
-- bot sets it: owners, admins and its team's leads for a full teammate (the
-- ai-members route, under RLS), whoever may edit what a work bot fronts for a
-- work bot (the work-bots route, botRule). Migration 305's
-- ai_team_member_guard_limits leaves it alone on purpose, so a team lead
-- changes a bot's voice as they change its face.
--
-- Each bot's own (decision 11): nothing copies it across an agent's bots, and
-- a new bot starts on Automatic unless whoever makes it picks one.
--
-- Additive: a nullable column, and a CHECK every existing row (all NULL)
-- passes. Applied by hand from this file: DEV first; PROD on Liam's word,
-- before the PR that reads it merges (the roster read selects the column and
-- fails on a database without it).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the CHECK dropped by name and
-- added again. A second run changes nothing.

alter table public.ai_team_member
  add column if not exists voice text null;

alter table public.ai_team_member drop constraint if exists ai_team_member_voice_check;
alter table public.ai_team_member add constraint ai_team_member_voice_check
  check (voice is null or voice ~ '^[a-z0-9][a-z0-9-]{0,31}$');

comment on column public.ai_team_member.voice is
  'The desktop text-to-speech voice the bot speaks in: a voice id as tts_voices lists it (lowercase letters, digits and hyphens, at most 32). NULL = Automatic, a voice dealt from its face (src/lib/bots/bot-voice.ts). The bot''s own, like its face: never copied across an agent''s bots, and not a limits column (migration 308).';

-- ═══════════════════════════════════════════════════════════════════════════
-- Check (run after applying):
--   select data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'ai_team_member' and column_name = 'voice';
--     → text | YES
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_team_member_voice_check';
--     → CHECK (((voice IS NULL) OR (voice ~ '^[a-z0-9][a-z0-9-]{0,31}$'::text)))
--   select count(*) from public.ai_team_member where voice is not null;  → 0
-- ═══════════════════════════════════════════════════════════════════════════
