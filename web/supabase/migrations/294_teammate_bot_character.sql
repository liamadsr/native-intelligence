-- 294: a bot face for every AI teammate (docs/plans/bot-characters.md, "Step 3:
-- faces of teammates").
--
-- Applied by hand, from this file: to DEV before its PR merges, and to PROD
-- right after that PR merges and before the PR whose code reads the column
-- merges, then a row read on PROD (the check at the end of this file). The
-- code that selects the column (the Agents page roster, every ledger read's
-- WORK_ITEM_SELECT) ships in that second PR and fails those reads on a
-- database without it; nothing in this file's PR reads it, and everything here
-- is additive, safe ahead of the code.
--
-- What lands:
--   ai_team_member.bot_character  which of the eighteen bot-avatars characters
--                  the teammate wears (src/components/bots/bot-characters.ts),
--                  NULL = no bot.
--   default_bot_character(system_key, role)
--                  the face a system or role teammate starts with, the same in
--                  every workspace so you learn who's who: Triage is Hexagon,
--                  Extraction Drop, Reconciler Circle, Email drafts Square; the
--                  Researcher is Cat, the Writer Ghost, the Correspondent
--                  Square, the Developer Mech.
--   free_bot_character(workspace_id)
--                  the face any other teammate starts with: the first in the
--                  crew's order that nobody in the workspace wears yet.
--   ai_team_member_default_bot_character (BEFORE INSERT)
--                  a teammate inserted with no face gets its starting one,
--                  whichever path inserts it.
--   seed_system_teammates / seed_role_teammates
--                  seed each teammate with its starting face.
--   backfill       every existing teammate gets one.
--
-- Why an insert default as well as the seeds: every insert path gets its
-- starting face without having to know about faces. The ai-members POST route
-- (a teammate people create: no role, no face) gets the first free face; the
-- seeds get the faces they already pass; and a seed that raced this
-- migration's ACCESS EXCLUSIVE lock with the OLD function body (planned before
-- the CREATE OR REPLACE, inserting once the lock is released, after the
-- backfill has run) still lands with faces. An adversarial review found that
-- such a workspace would otherwise keep four faceless system teammates. The
-- trigger fills only a NULL face: an explicit one is never overridden, and
-- faces stay editable (it doesn't fire on UPDATE).
--
-- Faces are where teammates START, not rules. Any of the eighteen can go on any
-- teammate, system ones included, and be changed at any time (the teammate edit
-- surface gets a picker in a later PR). Two teammates of a workspace may wear
-- the same one: the app warns, the database allows it, so there is no unique
-- index. The system-row guard (ai_team_member_protect_system, mig 283) is left
-- as it is.
--
-- Square starts as the one email face. The Email drafts system teammate starts
-- on it only where the workspace has no Correspondent; a Correspondent seeded
-- later takes it over, off the Email drafts row, if that row still wears it.
--
-- Why a column of its own and not avatar_url: about eight renderers hand
-- avatar_url straight to <img src>.
--
-- The app mirrors the starting faces and the crew's order in
-- src/lib/bots/teammate-faces.ts; teammate-faces-parity.test.ts reads this file
-- and holds the two together.
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS + re-ADD,
-- CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE, a backfill that only
-- fills empty faces, so a second run changes nothing).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The column
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_team_member
  add column if not exists bot_character text null;

comment on column public.ai_team_member.bot_character is
  'The bot character the teammate wears (a bot-avatars type: src/components/bots/bot-characters.ts). NULL = no bot. Seeded from default_bot_character / free_bot_character, changeable any time; two teammates may wear the same one.';

-- The eighteen bot-avatars types, in the crew's order.
alter table public.ai_team_member drop constraint if exists ai_team_member_bot_character_check;
alter table public.ai_team_member add constraint ai_team_member_bot_character_check
  check (
    bot_character is null
    or bot_character in (
      'clover', 'cat', 'circle', 'alien', 'ghost', 'hexagon', 'drop', 'flower', 'mech',
      'star', 'pill', 'pebble', 'droid', 'blob', 'triangle', 'cloud', 'puddle', 'square'
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Which face
-- ═══════════════════════════════════════════════════════════════════════════

-- The face a system or role teammate starts with; the system key wins. NULL
-- when neither has one (a teammate people created).
create or replace function public.default_bot_character(p_system_key text, p_role text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    case p_system_key
      when 'triage' then 'hexagon'
      when 'extraction' then 'drop'
      when 'reconciler' then 'circle'
      when 'email_drafts' then 'square'
    end,
    case p_role
      when 'researcher' then 'cat'
      when 'writer' then 'ghost'
      when 'correspondent' then 'square'
      when 'developer' then 'mech'
    end
  )
$$;

-- The face any other teammate starts with: the first in the crew's order that
-- nobody in the workspace wears yet; NULL once all eighteen are worn. A
-- default, not a rule. Reads under the caller's rights: the backfill runs it as
-- the owner, and so does the insert default (3, SECURITY DEFINER).
create or replace function public.free_bot_character(p_workspace_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select f.face
  from unnest(array[
    'clover', 'cat', 'circle', 'alien', 'ghost', 'hexagon', 'drop', 'flower', 'mech',
    'star', 'pill', 'pebble', 'droid', 'blob', 'triangle', 'cloud', 'puddle', 'square'
  ]) with ordinality as f(face, ord)
  where not exists (
    select 1 from public.ai_team_member a
    where a.workspace_id = p_workspace_id and a.bot_character = f.face
  )
  order by f.ord
  limit 1
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Every insert starts on a face
-- ═══════════════════════════════════════════════════════════════════════════
-- BEFORE INSERT, and only when the row brings no face: a system teammate gets
-- its key's face (Email drafts none where the workspace already has a
-- Correspondent, as in the seed); any other teammate its role's face, else the
-- first free one. An explicit face always wins, and UPDATE is left alone.
--
-- SECURITY DEFINER so the free face is picked from every teammate of the
-- workspace: the ai-members POST route inserts on the caller's session, where
-- RLS hides a private team's teammates, and an invoker would pick a face one of
-- them already wears. It reads ai_team_member and sets NEW.bot_character,
-- nothing else; a trigger function can't be called on its own.

create or replace function public.ai_team_member_default_bot_character()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.bot_character is not null then
    return new;
  end if;

  if new.is_system then
    if new.system_key = 'email_drafts' and exists (
      select 1 from public.ai_team_member c
      where c.workspace_id = new.workspace_id and c.role = 'correspondent'
    ) then
      return new;
    end if;
    new.bot_character := public.default_bot_character(new.system_key, null);
  else
    new.bot_character := coalesce(
      public.default_bot_character(null, new.role),
      public.free_bot_character(new.workspace_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists ai_team_member_default_bot_character on public.ai_team_member;
create trigger ai_team_member_default_bot_character
  before insert on public.ai_team_member
  for each row execute function public.ai_team_member_default_bot_character();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. seed_system_teammates (mig 283), seeding each with its face
-- ═══════════════════════════════════════════════════════════════════════════
-- Unchanged but for the face: its key's starting face, except that Email drafts
-- starts on none where the workspace already has a Correspondent, which wears
-- Square (the self-heal re-seeding a workspace whose default team was deleted).
-- Passed explicitly, though the insert default (3) would give the same.

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
    ('reconciler', 'Reconciler', 'loop-reconciler', 4)
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
-- 5. seed_role_teammates (mig 286), seeding each with its face
-- ═══════════════════════════════════════════════════════════════════════════
-- 286's body, unchanged but for the face: the role's starting face (passed
-- explicitly; the insert default would give the same). The Correspondent takes
-- Square off the Email drafts system teammate, but only while that row still
-- wears it: a face someone changed is never overwritten.

create or replace function public.seed_role_teammates(p_workspace_id uuid, p_created_by uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
  v_by uuid;
  v_recipe uuid;
  v_face text;
  v_count integer := 0;
  s record;
begin
  perform pg_advisory_xact_lock(hashtext('seed_role_teammates:' || p_workspace_id::text));

  select t.id into v_team
  from public.team t
  where t.workspace_id = p_workspace_id
  order by t.is_private asc, t.created_at asc, t.id asc
  limit 1;
  if v_team is null then
    return 0;
  end if;

  -- Who the rows are "created by": the person who flipped the switch, else the
  -- workspace's first owner.
  v_by := p_created_by;
  if v_by is null then
    select m.user_id into v_by
    from public.member m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
    order by m.created_at asc
    limit 1;
  end if;

  for s in
    select * from (values
      (
        1, 'researcher', 'Researcher', 'role-researcher', '🔎', '#0ea5e9',
        'Finds out what is true and writes it down, with sources.',
        'You are the workspace''s Researcher. You find out what is actually true and write it down so a person can act on it. Prefer primary sources over summaries of them, cite the URL of every fact you take from the web, and keep what you found separate from what you infer. When you could not establish something, say so plainly instead of guessing. Deliver a document: the answer first, in a few sentences, then the evidence behind it.',
        'attempt', array['read', 'internal-write'], array[]::text[]
      ),
      (
        2, 'writer', 'Writer', 'role-writer', '✍️', '#3b82f6',
        'Drafts documents people can use as they are.',
        'You are the workspace''s Writer. You draft documents people can use with light edits: lead with the point, match the workspace''s tone, and keep it as short as the job allows. Every specific (a name, a date, a number, a commitment) comes from the workspace or the brief; never invent one, and mark anything you had to assume.',
        'attempt', array['read', 'internal-write'], array['researcher']
      ),
      (
        3, 'correspondent', 'Correspondent', 'role-correspondent', '✉️', '#10b981',
        'Drafts emails for a person to review and send.',
        'You are the workspace''s Correspondent. You draft emails for a person to review and send; you never send one yourself. Open with what the recipient needs to know, make one clear ask, and keep paragraphs short. Promise nothing the workspace has not agreed to, and ground every name, date and figure in the workspace or the brief.',
        'attempt', array['read', 'internal-write'], array['researcher']
      ),
      (
        4, 'developer', 'Developer', 'role-developer', '🛠️', '#6366f1',
        'Scopes code changes into a plan an engineer or a coding run can pick up.',
        'You are the workspace''s Developer. You turn a request into a change someone can build: read the linked project, action and discussion, then write down what should change, the files and systems likely involved, how to verify it, and the risks. Be concrete and brief, and say what you could not confirm from the workspace.',
        'propose', array['read'], array['researcher']
      )
    ) as v(ord, role, name, slug, icon, color, description, prompt, autonomy, classes, delegates)
    order by ord
  loop
    if exists (
      select 1 from public.ai_team_member a
      where a.workspace_id = p_workspace_id and a.role = s.role
    ) then
      continue;
    end if;

    select r.id into v_recipe
    from public.recipe r
    where r.workspace_id = p_workspace_id and r.slug = s.slug
    limit 1;
    if v_recipe is null then
      insert into public.recipe (
        workspace_id, name, slug, icon, color, description, system_prompt,
        category, is_system, visibility, created_by
      )
      values (
        p_workspace_id, s.name, s.slug, s.icon, s.color, s.description, s.prompt,
        'agent', false, 'workspace', v_by
      )
      returning id into v_recipe;
    end if;

    v_face := public.default_bot_character(null, s.role);
    if s.role = 'correspondent' then
      update public.ai_team_member
      set bot_character = null
      where workspace_id = p_workspace_id
        and system_key = 'email_drafts'
        and bot_character = v_face;
    end if;

    insert into public.ai_team_member (
      workspace_id, team_id, name, agent_recipe_id, role, autonomy, allowed_side_effects, can_delegate_to, created_by, bot_character
    )
    values (
      p_workspace_id, v_team, s.name, v_recipe, s.role, s.autonomy, s.classes, s.delegates, v_by, v_face
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.seed_role_teammates(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seed_role_teammates(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Backfill: every existing teammate gets a face
-- ═══════════════════════════════════════════════════════════════════════════
-- Deterministic, in three passes, and only ever filling an empty face: a face
-- already given is never changed. Each row written bumps its updated_at (the
-- ai_team_member_updated_at trigger); nothing orders by it or reads it. A
-- second run changes nothing.

-- (a) System teammates start on their key's face, except that Email drafts
-- starts on none where the workspace has a Correspondent (which starts on
-- Square in (b)).
update public.ai_team_member a
set bot_character = public.default_bot_character(a.system_key, null)
where a.is_system
  and a.bot_character is null
  and public.default_bot_character(a.system_key, null) is not null
  and not (
    a.system_key = 'email_drafts'
    and exists (
      select 1 from public.ai_team_member c
      where c.workspace_id = a.workspace_id and c.role = 'correspondent'
    )
  );

-- (b) Each role's default teammate, its oldest holder (created_at, then id: the
-- rule in src/lib/work/role-routing.ts), starts on the role's face.
with oldest as (
  select distinct on (a.workspace_id, a.role)
    a.id, public.default_bot_character(null, a.role) as face
  from public.ai_team_member a
  where a.role is not null
  order by a.workspace_id, a.role, a.created_at, a.id
)
update public.ai_team_member a
set bot_character = o.face
from oldest o
where a.id = o.id
  and a.bot_character is null;

-- (c) Every other teammate (a second holder of a role, one people made) starts
-- on the first face nobody in its workspace wears yet, one at a time, oldest
-- first in each workspace; none once all eighteen are worn. System rows were
-- done in (a): an Email drafts that didn't start on Square starts on none.
do $$
declare
  r record;
  v_face text;
begin
  for r in
    select a.id, a.workspace_id
    from public.ai_team_member a
    where not a.is_system and a.bot_character is null
    order by a.workspace_id, a.created_at, a.id
  loop
    v_face := public.free_bot_character(r.workspace_id);
    if v_face is not null then
      update public.ai_team_member set bot_character = v_face where id = r.id;
    end if;
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it on PROD: the row read
-- ═══════════════════════════════════════════════════════════════════════════
-- Every system teammate wears its face, but for an Email drafts in a workspace
-- with a Correspondent. This must return 0:
--
--   select count(*) from ai_team_member
--   where is_system and bot_character is null
--     and not (system_key = 'email_drafts' and exists (
--       select 1 from ai_team_member c
--       where c.workspace_id = ai_team_member.workspace_id and c.role = 'correspondent'));
--
-- If it doesn't (say the file went in piecemeal rather than as one
-- transaction), run section 6 again as it stands: the backfill only fills empty
-- faces, so it is safe to re-run and a second run changes nothing.
