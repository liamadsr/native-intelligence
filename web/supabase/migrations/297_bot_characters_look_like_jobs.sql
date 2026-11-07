-- 297: the bot characters stop being shapes (docs/plans/bot-characters.md, "The
-- characters").
--
-- The eighteen `bot-avatars` shapes (Clover, Cat, Hexagon…) are replaced by
-- twenty-four characters of our own (src/components/bots/bot-look.ts):
-- seventeen that look like a job (Email is an envelope, Live wears a headset,
-- the Developer is a terminal) and seven critters. `ai_team_member.bot_character`
-- holds their ids.
--
-- Applied by hand, from this file, to DEV and then to PROD just before the PR
-- that carries it merges. The app either side of it never fails: a face it
-- doesn't know reads as no face (asBotCharacter), so between this migration
-- and the deploy a teammate is briefly drawn without its bot, and nothing
-- else. A second run changes nothing.
--
-- What lands:
--   the CHECK      the twenty-four ids, in the crew's order.
--   existing rows  each old shape becomes the character in its place, one for
--                  one: where a shape was a teammate's starting face, the
--                  character is that teammate's job (Hexagon → Triage, Drop →
--                  Extraction, Circle → Reconciler, Square → Email, Cat →
--                  Research, Ghost → Writer, Mech → Developer), and the other
--                  eleven take the character at the same place in the crew.
--   default_bot_character / free_bot_character
--                  the same two rules as migration 294, naming the new
--                  characters. The seeds, the insert default and the
--                  Correspondent's taking the email face off Email drafts all
--                  call these, and are left as they are.
--
-- The app mirrors both functions in src/lib/bots/teammate-faces.ts;
-- teammate-faces-parity.test.ts reads this file and holds the two together.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The rows, then the CHECK
-- ═══════════════════════════════════════════════════════════════════════════
-- The old CHECK goes first (it refuses every new id), the rows move, and the
-- new one is added over rows that already satisfy it.

alter table public.ai_team_member drop constraint if exists ai_team_member_bot_character_check;

update public.ai_team_member a
set bot_character = m.new_face
from (values
  ('clover', 'chat'),
  ('cat', 'research'),
  ('circle', 'reconciler'),
  ('alien', 'sprout'),
  ('ghost', 'writer'),
  ('hexagon', 'triage'),
  ('drop', 'extraction'),
  ('flower', 'berry'),
  ('mech', 'dev'),
  ('star', 'nova'),
  ('pill', 'live'),
  ('pebble', 'flows'),
  ('droid', 'notes'),
  ('blob', 'ember'),
  ('triangle', 'scout'),
  ('cloud', 'dew'),
  ('puddle', 'coach'),
  ('square', 'mail')
) as m(old_face, new_face)
where a.bot_character = m.old_face;

-- The twenty-four characters, in the crew's order.
alter table public.ai_team_member add constraint ai_team_member_bot_character_check
  check (
    bot_character is null
    or bot_character in (
      'chat', 'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
      'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'scout', 'dew',
      'coach', 'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom', 'deals'
    )
  );

comment on column public.ai_team_member.bot_character is
  'The bot character the teammate wears (src/components/bots/bot-characters.ts). NULL = no bot. Seeded from default_bot_character / free_bot_character, changeable any time; two teammates may wear the same one.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Which face
-- ═══════════════════════════════════════════════════════════════════════════

-- The face a system or role teammate starts with: its job's; the system key
-- wins. NULL when neither has one (a teammate people created).
create or replace function public.default_bot_character(p_system_key text, p_role text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    case p_system_key
      when 'triage' then 'triage'
      when 'extraction' then 'extraction'
      when 'reconciler' then 'reconciler'
      when 'email_drafts' then 'mail'
    end,
    case p_role
      when 'researcher' then 'research'
      when 'writer' then 'writer'
      when 'correspondent' then 'mail'
      when 'developer' then 'dev'
    end
  )
$$;

-- The face any other teammate starts with: the first in the crew's order that
-- nobody in the workspace wears yet; NULL once all twenty-four are worn. A
-- default, not a rule.
create or replace function public.free_bot_character(p_workspace_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select f.face
  from unnest(array[
    'chat', 'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
    'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'scout', 'dew',
    'coach', 'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom', 'deals'
  ]) with ordinality as f(face, ord)
  where not exists (
    select 1 from public.ai_team_member a
    where a.workspace_id = p_workspace_id and a.bot_character = f.face
  )
  order by f.ord
  limit 1
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Check, after applying (expect no rows):
--   select bot_character, count(*) from public.ai_team_member
--   where bot_character in ('clover','cat','circle','alien','ghost','hexagon','drop','flower','mech',
--                           'star','pill','pebble','droid','blob','triangle','cloud','puddle','square')
--   group by 1;
-- ═══════════════════════════════════════════════════════════════════════════
