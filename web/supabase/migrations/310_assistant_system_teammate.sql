-- Migration 310: the Assistant, a system teammate for AI work no other teammate
-- takes on (docs/plans/bots-v4.md, Phase 5; decisions 2 and 7). The plan
-- calls it migration 308; 305 to 309 went to other phases first.
--
-- WHY: prospecting, eval, onboarding-research and enrichment runs, and a
-- person's own loop and coding runs, run with no teammate, so they show as
-- lanes on the Agents page and no bot speaks for them. The app now routes each
-- such run to a bot (src/lib/work/system-teammates.ts workTeammateId): the
-- teammate that holds the run's skill, else the workspace's role teammate
-- (the Researcher for prospecting, enrichment and onboarding research; the
-- Developer for coding runs and evals), else this Assistant. ATTRIBUTION ONLY:
-- the chosen teammate is stamped on the ledger row (`tracked_job`), never on
-- the agent run, so no run's persona, limits, grants or memory change.
--
-- What lands:
--   recipe 'loop-assistant'
--                  the Assistant's identity anchor, the pattern of migration
--                  283's four and 302's work-bot anchor: workspace_id NULL,
--                  visibility 'personal', created_by NULL, is_system false.
--                  Invisible to every session read (recipe_select_visibility),
--                  so no persona list shows it, and it fails every
--                  "workspace-or-system agent" check, so nothing can bind it as
--                  a persona. No run executes its prompt: the Assistant speaks
--                  from its job (teammate-chat.ts). The `loop-` prefix is the
--                  anchors' (loop-work-bot too), which 305's guard reads.
--   ai_team_member_system_key_check
--                  gains 'assistant'.
--   default_bot_character
--                  the Assistant starts on `chat` (the catalogue's Assistant).
--   free_bot_character
--                  skips `chat`: it is reserved for the Assistant (decision
--                  7), so no other teammate starts on it. The app's free order
--                  (src/lib/bots/teammate-faces.ts) skips it too;
--                  teammate-faces-parity.test.ts holds the two together.
--   ai_team_member_guard_limits (migration 305)
--                  a signed-in caller may add an `assistant` system teammate
--                  on its anchor, as seeding makes it (a workspace made by a
--                  signed-in user seeds its system teammates as that user).
--                  Every other check is unchanged, word for word.
--   seed_system_teammates
--                  seeds the Assistant fifth, on the workspace's default team,
--                  on `chat`. Unchanged otherwise.
--   back-fill      every existing workspace gets its Assistant.
--
-- What the Assistant is, as every system teammate is: role NULL (283's
-- ai_team_member_system_not_routable CHECK), so never routed and not
-- assignable (the workspace route and the action PATCH leave system teammates
-- out); autonomy and allowed_side_effects keep their column defaults
-- ('propose', {read}); and 283's ai_team_member_protect_system freezes its
-- is_system, system_key and agent, and refuses its delete while its team and
-- workspace stand. It is always reachable (callerCanReachTeammate's rule for
-- a system teammate). Its chat is read plus propose-only (chat-ceiling.ts).
--
-- NOT here: the work bots already on `chat` (v3's back-fill named most of them
-- "Assistant"). They move to their workspace's next free character, renamed to
-- match, by scripts/backfill-assistant-face.ts after this migration (DEV
-- first; PROD only on Liam's word). Until it runs, a workspace's Assistant and
-- such a work bot share the face, and the crew draws them as one bot with a
-- switcher, as it does any two teammates on one face.
--
-- Applied by hand from this file: DEV first; PROD on Liam's word, before the
-- PR that reads it merges (the routing looks the Assistant up by its key; on a
-- database without it, its self-heal seed finds no anchor and the row is
-- written with no teammate, as today).
--
-- Idempotent: ON CONFLICT DO NOTHING on the recipe and the seed, the CHECK
-- dropped by name and added again, CREATE OR REPLACE. A second run changes
-- nothing.
--
-- 310 is now the newest definition of default_bot_character,
-- free_bot_character, ai_team_member_guard_limits and seed_system_teammates.
-- It needs 305 applied first; re-applying 305 (or 294, 297) after it would
-- put back the older bodies (305's guard admits only the four keys, and
-- refuses a signed-in creator's Assistant), so apply 310 again after any of
-- them.
--
-- It takes ai_team_member's lock (the CHECK, the seed) and waits at most 5 s
-- for it: a long transaction holding the table fails this fast instead of
-- queueing every teammate read behind it. Run it again once that's done.

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The Assistant's identity anchor
-- ═══════════════════════════════════════════════════════════════════════════
-- Bare ON CONFLICT DO NOTHING, as 283 and 302: the system-slug partial index
-- (workspace_id IS NULL) is the one a re-run hits.

insert into public.recipe (
  name, slug, icon, color, description, system_prompt,
  category, is_system, visibility, sort_order, workspace_id, created_by
)
values
  ('Assistant', 'loop-assistant', '💬', '#8b5cf6',
   'Brings you the AI work no other teammate takes on: prospecting, research, evals and your own runs.',
   'Identity anchor for the Assistant system teammate. No run executes this prompt: the work it speaks for runs its own paths.',
   'agent', false, 'personal', 905, null, null)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The system key
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_team_member drop constraint if exists ai_team_member_system_key_check;
alter table public.ai_team_member add constraint ai_team_member_system_key_check
  check (
    system_key is null
    or (is_system and system_key in ('triage', 'extraction', 'email_drafts', 'reconciler', 'assistant'))
  );

comment on column public.ai_team_member.system_key is
  'For a system teammate, the built-in job it stands for (triage | extraction | email_drafts | reconciler | assistant); the ledger writers look it up by this key. NULL for every other teammate.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Its face, and the face no one else starts on
-- ═══════════════════════════════════════════════════════════════════════════

-- 297's rule, with the Assistant on `chat`.
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
      when 'assistant' then 'chat'
    end,
    case p_role
      when 'researcher' then 'research'
      when 'writer' then 'writer'
      when 'correspondent' then 'mail'
      when 'developer' then 'dev'
    end
  )
$$;

-- 297's rule, without `chat`: the first in the crew's order, past the reserved
-- face, that nobody in the workspace wears yet; NULL once all are worn.
create or replace function public.free_bot_character(p_workspace_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select f.face
  from unnest(array[
    'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
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
-- 4. 305's guard: a signed-in caller may seed the Assistant too
-- ═══════════════════════════════════════════════════════════════════════════
-- 305's body, unchanged but for step (c)'s system teammate: the key list gains
-- 'assistant', whose anchor is 'loop-assistant' by the same slug rule, and
-- the message no longer counts four.

create or replace function public.ai_team_member_guard_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- (a) Everyone, the server included: a teammate's team is one of its
  -- workspace's teams.
  if not exists (
    select 1 from public.team t
    where t.id = new.team_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'a teammate''s team must be one of its workspace''s teams (ai_team_member %)', new.id
      using errcode = 'check_violation';
  end if;

  -- (b) The server (service role) and the database itself (no request) check
  -- who may first. A request with no sign-in ('anon') is not trusted.
  if coalesce(auth.role(), '') in ('', 'service_role') then
    return new;
  end if;

  -- (c) Anyone signed in: a teammate stays in its workspace...
  if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
    raise exception 'a teammate stays in its workspace (ai_team_member %)', old.id
      using errcode = 'insufficient_privilege';
  end if;
  -- ...and a system teammate is only ever one seeding would make: one of the
  -- built-in five, on its own anchor recipe (seed_system_teammates, migration
  -- 310). A workspace made by a signed-in user seeds them as that user.
  if tg_op = 'INSERT' and new.is_system and not (
    new.system_key in ('triage', 'extraction', 'email_drafts', 'reconciler', 'assistant')
    and exists (
      select 1 from public.recipe r
      where r.id = new.agent_recipe_id
        and r.slug = 'loop-' || replace(new.system_key, '_', '-')
        and r.workspace_id is null
        and r.category = 'agent'
    )
  ) then
    raise exception 'a system teammate is one of the built-in five, on its own anchor recipe (ai_team_member %)', new.id
      using errcode = 'insufficient_privilege';
  end if;

  -- (d) A workspace owner or admin.
  if public.get_member_role(new.workspace_id) in ('owner', 'admin') then
    return new;
  end if;

  -- (e) Anyone else adds a teammate with the defaults: it can only look.
  if tg_op = 'INSERT' then
    if new.allowed_side_effects is distinct from '{read}'::text[]
       or new.autonomy is distinct from 'propose'
       or new.role is not null
       or new.tool_allowlist is not null
       or new.can_delegate_to is distinct from '{}'::text[]
       or new.fronts_only then
      raise exception 'only a workspace owner or admin sets what a teammate may do on its own (ai_team_member)'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.allowed_side_effects is distinct from old.allowed_side_effects
     or new.autonomy is distinct from old.autonomy
     or new.role is distinct from old.role
     or new.tool_allowlist is distinct from old.tool_allowlist
     or new.can_delegate_to is distinct from old.can_delegate_to
     or new.fronts_only is distinct from old.fronts_only
     -- A work bot's persona: the agent it speaks for, or the loop anchor.
     or (old.fronts_only and new.agent_recipe_id is distinct from old.agent_recipe_id) then
    raise exception 'only a workspace owner or admin changes what a teammate may do on its own, or what a work bot speaks for (ai_team_member %)', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke execute on function public.ai_team_member_guard_limits() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. seed_system_teammates: the Assistant, fifth
-- ═══════════════════════════════════════════════════════════════════════════
-- 294's body, unchanged but for the fifth row. Its face comes through
-- default_bot_character, as the other four's do.

create or replace function public.seed_system_teammates(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
  v_count integer;
begin
  select t.id into v_team
  from public.team t
  where t.workspace_id = p_workspace_id
  order by t.created_at asc, t.id asc
  limit 1;
  if v_team is null then
    return 0;
  end if;

  insert into public.ai_team_member (workspace_id, team_id, name, agent_recipe_id, is_system, system_key, bot_character)
  select p_workspace_id, v_team, s.name, r.id, true, s.system_key,
    case
      when s.system_key = 'email_drafts' and exists (
        select 1 from public.ai_team_member a
        where a.workspace_id = p_workspace_id and a.role = 'correspondent'
      ) then null
      else public.default_bot_character(s.system_key, null)
    end
  from (values
    ('triage', 'Triage', 'loop-triage', 1),
    ('extraction', 'Extraction', 'loop-extraction', 2),
    ('email_drafts', 'Email drafts', 'loop-email-drafts', 3),
    ('reconciler', 'Reconciler', 'loop-reconciler', 4),
    ('assistant', 'Assistant', 'loop-assistant', 5)
  ) as s(system_key, name, slug, ord)
  join public.recipe r
    on r.slug = s.slug
   and r.workspace_id is null
   and r.category = 'agent'
  order by s.ord
  on conflict (workspace_id, system_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.seed_system_teammates(uuid) from public, anon, authenticated;
grant execute on function public.seed_system_teammates(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Back-fill: every existing workspace gets its Assistant
-- ═══════════════════════════════════════════════════════════════════════════
-- The seed is idempotent on (workspace_id, system_key), so each workspace
-- gains exactly its Assistant (and, as the app's self-heal would, any system
-- teammate it had lost with its default team). A workspace with no team gets
-- none, as before.

select public.seed_system_teammates(w.id)
from public.workspace w;

-- ═══════════════════════════════════════════════════════════════════════════
-- Check, after applying:
--   select count(*) from public.recipe
--   where slug = 'loop-assistant' and workspace_id is null and category = 'agent';   → 1
--   select count(*) from public.workspace w
--   where exists (select 1 from public.team t where t.workspace_id = w.id)
--     and not exists (select 1 from public.ai_team_member a
--                     where a.workspace_id = w.id and a.system_key = 'assistant');   → 0
--   select bot_character, role, autonomy, allowed_side_effects, count(*)
--   from public.ai_team_member where system_key = 'assistant' group by 1, 2, 3, 4;
--     → one row: chat, NULL, propose, {read}
--   select public.free_bot_character(gen_random_uuid());                              → research
-- ═══════════════════════════════════════════════════════════════════════════
