-- Migration 318: work and notices record their area; the utility agents fold
-- into the area faces; a conversation can be focused on an area
-- (docs/plans/one-agent-and-chat-pages.md, Part 3 "Faces", "Folding in the
-- utility agents"; decisions 2, 8 and 9; Phase S3).
--
-- WHY: one main agent runs the show, with an expertise pack per area. The
-- four utility teammates (Triage, Extraction, Reconciler, Email drafts) were
-- faces put on pipeline work, never agents. Decision 2 folds them into the
-- area that owns their work: Captures and Mail. Decision 9 keeps one face per
-- area that has work, with the area recorded on the work itself, so a later
-- move to ONE face is a display change, not a data migration.
--
-- What lands:
--   tracked_job.area      the area a unit of work belongs to (one of the 16
--                         area keys of src/lib/packs/registry.ts, as 316's
--                         recipe.area; NULL: none, or not known). The writers
--                         stamp it (src/lib/work/work-area.ts); older rows get
--                         it from scripts/backfill-work-area.ts.
--   chat_conversations.focus_area
--                         a main-chat conversation focused on an area (the
--                         agent menu's areas, and an area face's page): the
--                         main agent, full tools, attended, with the area's
--                         pack in its prompt from the first turn. Never a
--                         teammate's thread or a bot conversation (CHECK).
--   recipes 'loop-captures', 'loop-mail', 'loop-prospecting', 'loop-evals',
--           'loop-crm'
--                         the area faces' identity anchors, the pattern of
--                         283's and 310's (workspace_id NULL, visibility
--                         'personal', is_system false): invisible to every
--                         session read, so no persona list shows them. No run
--                         executes their prompt.
--   system keys           the area faces: captures, mail, prospecting, evals,
--                         crm, and the Assistant (kept: the main agent's face,
--                         and work with no area). triage, extraction,
--                         reconciler and email_drafts go.
--   the fold (data)       Triage's row becomes Captures and Email drafts'
--                         becomes Mail, in place (same id: its history,
--                         notices, threads, seen marks and the desktop's
--                         cast stay valid). Every reference to Extraction and
--                         Reconciler moves to the workspace's Captures row
--                         (ledger, agent runs, loops, memory, skills, relays,
--                         bot conversations, threads, notices' metadata,
--                         cards' payloads), then those two rows go. The
--                         renamed rows' notices take the new name and area. A
--                         folded thread nobody said anything in goes; one that
--                         has messages and would collide with the person's
--                         Captures thread (one thread per person per bot)
--                         becomes a Captures-focused main-chat conversation
--                         instead, so nothing said is lost.
--   default_bot_character the area faces' starting faces: Captures keeps
--                         Triage's `triage`, Mail `mail`, Prospecting
--                         `scout`, Evals `coach`, CRM `deals`, the
--                         Assistant `chat`.
--   free_bot_character    skips the reserved faces: chat, triage, scout,
--                         coach, deals (teammate-faces.ts RESERVED, held by
--                         teammate-faces-parity.test.ts).
--   ai_team_member_default_bot_character
--                         294's insert default, Mail in Email drafts' place.
--   ai_team_member_guard_limits
--                         310's body, the key list swapped. Unchanged
--                         otherwise, word for word.
--   seed_system_teammates seeds the six. A face someone in the workspace
--                         already wears falls back to the next free one, so a
--                         new area face never shares a face with a work bot.
--   seed_role_teammates   294's body: the Correspondent takes the email face
--                         off Mail, as it did off Email drafts.
--   flow_check_ai_team_member
--                         302's body: Captures is the system teammate that
--                         fronts loops (the seeded Triage and Commitment
--                         reconciler loops both map to it).
--   back-fill             every workspace gets its area faces.
--
-- 311's team_keep_system_teammates reads `is_system`, not a key list, so it
-- keeps the six as it kept the five; it is not redefined here.
--
-- The old anchor recipes (loop-triage, loop-extraction, loop-reconciler,
-- loop-email-drafts) stay: nothing binds them after this, and a recipe delete
-- would have to chase every reference. They are invisible as before.
--
-- Applied by hand from this file, WHOLE, as one transaction (BEGIN ... COMMIT
-- below; one `apply_migration` of the entire file, never statement by
-- statement: the fold switches 283's guard off and drops the key CHECK, and
-- only the transaction guarantees both come back, and `set local` and the
-- `on commit drop` temp tables only hold inside it). Needs 316 and 317
-- first. DEV first; PROD on Liam's word, BEFORE the deploy of the code that
-- reads it (the ledger writers insert `area`; a database without the column
-- refuses the insert, and the work goes unrecorded until it lands). Then
-- scripts/backfill-work-area.ts (dry run first).
--
-- Idempotent: ON CONFLICT DO NOTHING on the recipes and the seed, ADD COLUMN
-- IF NOT EXISTS, CHECKs dropped by name and added again, CREATE OR REPLACE,
-- and the fold only touches rows still on an old key. A second run changes
-- nothing.
--
-- 318 is now the newest definition of default_bot_character,
-- free_bot_character, ai_team_member_default_bot_character,
-- ai_team_member_guard_limits, seed_system_teammates, seed_role_teammates and
-- flow_check_ai_team_member. Re-applying 294, 302, 305 or 310 after it would
-- put back the older key lists; apply 318 again after any of them.
--
-- It takes ai_team_member's lock (the CHECK, the fold) and waits at most 5 s
-- for it, as 310 does.

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The columns
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tracked_job add column if not exists area text;
alter table public.tracked_job drop constraint if exists tracked_job_area_check;
alter table public.tracked_job add constraint tracked_job_area_check check (
  area is null or area in ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library')
);
comment on column public.tracked_job.area is
  'The area of Dial8 this work belongs to (one of the 16 area keys; NULL: none). The face it shows with is picked from it (one-agent plan, decision 9).';

alter table public.chat_conversations add column if not exists focus_area text;
alter table public.chat_conversations drop constraint if exists chat_conversations_focus_area_check;
alter table public.chat_conversations add constraint chat_conversations_focus_area_check check (
  focus_area is null or (
    focus_area in ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library')
    and ai_team_member_id is null
    and agent_teammate_id is null
  )
);
comment on column public.chat_conversations.focus_area is
  'A main-chat conversation focused on an area: the main agent with that area''s pack from the first turn. Fixed when it starts. Never a thread or a bot conversation.';

-- An area face's page reopens the person's latest conversation focused on it.
create index if not exists idx_chat_conversations_focus
  on public.chat_conversations (user_id, workspace_id, focus_area, updated_at desc)
  where focus_area is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The area faces' identity anchors
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.recipe (
  name, slug, icon, color, description, system_prompt,
  category, is_system, visibility, sort_order, workspace_id, created_by
)
values
  ('Captures', 'loop-captures', '🎙️', '#6366f1',
   'Files what was said in each capture and decides what its proposals become.',
   'Identity anchor for the Captures area face. No run executes this prompt: the work it speaks for runs its own paths.',
   'agent', false, 'personal', 906, null, null),
  ('Mail', 'loop-mail', '✉️', '#0ea5e9',
   'Drafts replies to the threads that need one, and brings your mail import.',
   'Identity anchor for the Mail area face. No run executes this prompt: the work it speaks for runs its own paths.',
   'agent', false, 'personal', 907, null, null),
  ('Prospecting', 'loop-prospecting', '🔭', '#f59e0b',
   'Finds the companies and people that fit what you sell.',
   'Identity anchor for the Prospecting area face. No run executes this prompt: the work it speaks for runs its own paths.',
   'agent', false, 'personal', 908, null, null),
  ('Evals', 'loop-evals', '📏', '#14b8a6',
   'Runs your evals and tells you how they did.',
   'Identity anchor for the Evals area face. No run executes this prompt: the work it speaks for runs its own paths.',
   'agent', false, 'personal', 909, null, null),
  ('CRM', 'loop-crm', '📇', '#ec4899',
   'Imports and enriches your contacts and companies.',
   'Identity anchor for the CRM area face. No run executes this prompt: the work it speaks for runs its own paths.',
   'agent', false, 'personal', 910, null, null)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The faces they start on, and the faces no one else starts on
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.default_bot_character(p_system_key text, p_role text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    case p_system_key
      when 'captures' then 'triage'
      when 'mail' then 'mail'
      when 'prospecting' then 'scout'
      when 'evals' then 'coach'
      when 'crm' then 'deals'
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

-- 310's rule, past every reserved face: chat (the Assistant), triage
-- (Captures), scout (Prospecting), coach (Evals), deals (CRM).
create or replace function public.free_bot_character(p_workspace_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select f.face
  from unnest(array[
    'research', 'reconciler', 'sprout', 'writer', 'extraction', 'berry',
    'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'dew',
    'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom'
  ]) with ordinality as f(face, ord)
  where not exists (
    select 1 from public.ai_team_member a
    where a.workspace_id = p_workspace_id and a.bot_character = f.face
  )
  order by f.ord
  limit 1
$$;

-- 294's insert default: Mail stays faceless where a Correspondent wears the
-- one email face, as Email drafts did.
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
    if new.system_key = 'mail' and exists (
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

revoke execute on function public.ai_team_member_default_bot_character() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. 310's guard, with the new key list
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- built-in ones, on its own anchor recipe (seed_system_teammates, migration
  -- 318). A workspace made by a signed-in user seeds them as that user.
  if tg_op = 'INSERT' and new.is_system and not (
    new.system_key in ('captures', 'mail', 'prospecting', 'evals', 'crm', 'assistant')
    and exists (
      select 1 from public.recipe r
      where r.id = new.agent_recipe_id
        and r.slug = 'loop-' || replace(new.system_key, '_', '-')
        and r.workspace_id is null
        and r.category = 'agent'
    )
  ) then
    raise exception 'a system teammate is one of the built-in ones, on its own anchor recipe (ai_team_member %)', new.id
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
-- 5. seed_system_teammates: the area faces and the Assistant
-- ═══════════════════════════════════════════════════════════════════════════
-- 310's body with the six. A face already worn in the workspace (by a work
-- bot that took it before it was reserved) gives way to the next free one.

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
      when s.system_key = 'mail' and exists (
        select 1 from public.ai_team_member a
        where a.workspace_id = p_workspace_id and a.role = 'correspondent'
      ) then null
      when exists (
        select 1 from public.ai_team_member a
        where a.workspace_id = p_workspace_id
          and a.bot_character = public.default_bot_character(s.system_key, null)
      ) then public.free_bot_character(p_workspace_id)
      else public.default_bot_character(s.system_key, null)
    end
  from (values
    ('captures', 'Captures', 'loop-captures', 1),
    ('mail', 'Mail', 'loop-mail', 2),
    ('prospecting', 'Prospecting', 'loop-prospecting', 3),
    ('evals', 'Evals', 'loop-evals', 4),
    ('crm', 'CRM', 'loop-crm', 5),
    ('assistant', 'Assistant', 'loop-assistant', 6)
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
-- 6. 302's loop check: Captures fronts the built-in loops
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.flow_check_ai_team_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mate record;
  v_editor uuid := auth.uid();
  v_run_as uuid;
  v_seed_key text;
begin
  if new.ai_team_member_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- A loop moved to another workspace leaves its bot behind (never a
    -- pointer across workspaces): its editor there asks for one.
    if new.workspace_id is distinct from old.workspace_id
       and new.ai_team_member_id is not distinct from old.ai_team_member_id then
      new.ai_team_member_id := null;
      return new;
    end if;
    -- Nothing the checks read changed: the bot, the workspace, the seed key.
    if new.ai_team_member_id is not distinct from old.ai_team_member_id
       and new.seed_key is not distinct from old.seed_key then
      return new;
    end if;
  end if;

  select atm.workspace_id, atm.team_id, atm.is_system, atm.system_key, t.is_private
    into v_mate
  from public.ai_team_member atm
  left join public.team t on t.id = atm.team_id
  where atm.id = new.ai_team_member_id;
  if not found then
    -- The FK reports a missing row too; this only keeps the message readable.
    raise exception 'that bot no longer exists' using errcode = 'check_violation';
  end if;

  if v_mate.workspace_id is distinct from new.workspace_id then
    raise exception 'a loop''s bot must be one of its own workspace''s teammates'
      using errcode = 'check_violation';
  end if;

  if v_mate.is_system then
    if v_mate.system_key is null or v_mate.system_key not in ('captures') then
      raise exception 'this built-in teammate does not front loops'
        using errcode = 'check_violation';
    end if;
    v_seed_key := case new.seed_key
      when 'seed:triage' then 'captures'
      when 'seed:reconcile' then 'captures'
    end;
    if v_seed_key is not null and v_seed_key <> v_mate.system_key then
      raise exception 'a built-in loop keeps its own teammate'
        using errcode = 'check_violation';
    end if;
    -- A system teammate is readable across private teams (280): everyone reaches it.
    return new;
  end if;

  -- Only an explicit false is public (callerCanReachTeammate's rule).
  if v_mate.is_private is false then
    return new;
  end if;

  if v_editor is not null and not exists (
    select 1
    from public.team_member tm
    join public.member m on m.id = tm.member_id
    where tm.team_id = v_mate.team_id
      and m.user_id = v_editor
      and m.workspace_id = new.workspace_id
  ) then
    raise exception 'that bot is on a private team you are not on'
      using errcode = 'check_violation';
  end if;

  -- The run-as member (run-as-member.ts): the creator while still a member,
  -- else the workspace owner.
  select m.id into v_run_as
  from public.member m
  where m.workspace_id = new.workspace_id
    and m.user_id = new.created_by
  limit 1;
  if v_run_as is null then
    select m.id into v_run_as
    from public.member m
    where m.workspace_id = new.workspace_id
      and m.role = 'owner'
    order by m.created_at asc
    limit 1;
  end if;
  if v_run_as is null or not exists (
    select 1 from public.team_member tm
    where tm.team_id = v_mate.team_id
      and tm.member_id = v_run_as
  ) then
    raise exception 'the person this loop runs as can''t see that bot (it is on a private team they are not on)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.flow_check_ai_team_member() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6b. 294's seed_role_teammates: the one email face moves off Mail
-- ═══════════════════════════════════════════════════════════════════════════
-- 294's body, the system key swapped (email_drafts → mail). Unchanged
-- otherwise.

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
    -- The one email face moves to the Correspondent: off Mail (Email drafts
    -- before 318), only while Mail still wears it.
    if s.role = 'correspondent' then
      update public.ai_team_member
      set bot_character = null
      where workspace_id = p_workspace_id
        and system_key = 'mail'
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
-- 7. The fold
-- ═══════════════════════════════════════════════════════════════════════════
-- 283's ai_team_member_protect_system freezes system_key and a system row's
-- agent, and refuses deleting a system row. The fold is exactly that, once,
-- so the guard is off for this transaction only (the ALTER is transactional:
-- a failure anywhere below rolls it back with everything else).

alter table public.ai_team_member drop constraint if exists ai_team_member_system_key_check;
alter table public.ai_team_member disable trigger ai_team_member_protect_system;

-- 7a. Triage becomes Captures, Email drafts becomes Mail, in place. A name
-- someone gave it stays; the default name becomes the area's. What is renamed
-- is read first (area_rename), so its notices can follow below.
create temp table area_rename on commit drop as
select a.id,
       a.name as old_name,
       case
         when a.system_key = 'triage' and a.name = 'Triage' then 'Captures'
         when a.system_key = 'email_drafts' and a.name = 'Email drafts' then 'Mail'
         else a.name
       end as new_name,
       case a.system_key when 'triage' then 'captures' else 'mail' end as to_key
from public.ai_team_member a
where a.system_key in ('triage', 'email_drafts')
  and not exists (
    select 1 from public.ai_team_member c
    where c.workspace_id = a.workspace_id
      and c.system_key = case a.system_key when 'triage' then 'captures' else 'mail' end
  );

update public.ai_team_member a
set system_key = m.to_key,
    agent_recipe_id = r.id,
    name = m.new_name
from area_rename m, public.recipe r
where a.id = m.id
  and r.slug = 'loop-' || m.to_key and r.workspace_id is null and r.category = 'agent';

-- Their notices say the new name (bot-notice.ts: `teammate_name`, and the
-- title the bot's name was written into) and carry the area. The teammate id
-- is the same row, so it stays.
update public.notification n
set metadata = n.metadata
      || case when n.metadata ? 'teammate_name' then jsonb_build_object('teammate_name', m.new_name) else '{}'::jsonb end
      || jsonb_build_object('area', m.to_key),
    title = case when n.title = m.old_name then m.new_name else n.title end
from area_rename m
where n.metadata->>'teammate_id' = m.id::text;

-- 7b. Every workspace gets the faces it lacks (a workspace with no Triage
-- gets a fresh Captures; every one gets Prospecting, Evals and CRM).
select public.seed_system_teammates(w.id)
from public.workspace w;

-- 7c. What folds into what: Extraction and Reconciler (and any old-key row
-- left beside an area row) into the workspace's Captures or Mail row.
create temp table area_fold on commit drop as
select f.id as from_id, f.name as from_name, c.id as to_id, c.name as to_name, c.system_key as to_key
from public.ai_team_member f
join public.ai_team_member c
  on c.workspace_id = f.workspace_id
 and c.system_key = case when f.system_key = 'email_drafts' then 'mail' else 'captures' end
where f.system_key in ('triage', 'extraction', 'reconciler', 'email_drafts');

update public.tracked_job t set ai_team_member_id = m.to_id from area_fold m where t.ai_team_member_id = m.from_id;
update public.agent_run t set ai_team_member_id = m.to_id from area_fold m where t.ai_team_member_id = m.from_id;
update public.flow t set ai_team_member_id = m.to_id from area_fold m where t.ai_team_member_id = m.from_id;
update public.actions t set assignee_ai_member_id = m.to_id from area_fold m where t.assignee_ai_member_id = m.from_id;
update public.agent_memory t set ai_team_member_id = m.to_id from area_fold m where t.ai_team_member_id = m.from_id;
update public.bot_relay t set teammate_id = m.to_id from area_fold m where t.teammate_id = m.from_id;
update public.chat_conversations t set agent_teammate_id = m.to_id from area_fold m where t.agent_teammate_id = m.from_id;

insert into public.ai_team_member_skill (ai_team_member_id, skill_recipe_id, sort_order)
select m.to_id, s.skill_recipe_id, s.sort_order
from public.ai_team_member_skill s
join area_fold m on m.from_id = s.ai_team_member_id
on conflict (ai_team_member_id, skill_recipe_id) do nothing;

-- Threads: one per person per bot. A folded thread nobody said anything in
-- (no message, no staged change, no relay) goes: opening a bot's chat makes
-- its thread, so most are empty, and an empty one turned into a conversation
-- would only clutter the history. Of the rest, the newest of a person with
-- no thread on the area row moves there; every other becomes a main-chat
-- conversation focused on the area, under the default title (not the old
-- bot's name, which would read as a chat with a bot that is gone), out of
-- the eve session it was built in, so its next turn starts fresh on the main
-- agent, primed with its history.
delete from public.chat_conversations cc
using area_fold m
where cc.ai_team_member_id = m.from_id
  and not exists (select 1 from public.chat_messages x where x.conversation_id = cc.id)
  and not exists (select 1 from public.proposed_change x where x.conversation_id = cc.id)
  and not exists (select 1 from public.bot_relay x where x.conversation_id = cc.id or x.thread_conversation_id = cc.id);

with ranked as (
  select cc.id, m.to_id, m.to_key,
         row_number() over (partition by cc.user_id, m.to_id order by cc.updated_at desc, cc.id) as rn,
         exists (
           select 1 from public.chat_conversations own
           where own.user_id = cc.user_id and own.ai_team_member_id = m.to_id
         ) as has_own
  from public.chat_conversations cc
  join area_fold m on m.from_id = cc.ai_team_member_id
)
update public.chat_conversations cc
set ai_team_member_id = case when r.rn = 1 and not r.has_own then r.to_id else null end,
    focus_area = case when r.rn = 1 and not r.has_own then null else r.to_key end,
    eve_session_id = case when r.rn = 1 and not r.has_own then cc.eve_session_id else null end,
    title = case when r.rn = 1 and not r.has_own then cc.title else 'New conversation' end
from ranked r
where cc.id = r.id;

-- Notices speak as the area face now (bot-notice.ts: metadata.teammate_id,
-- teammate_name, and the title the bot's name was written into).
update public.notification n
set metadata = n.metadata
      || jsonb_build_object('teammate_id', m.to_id::text)
      || case when n.metadata ? 'teammate_name' then jsonb_build_object('teammate_name', m.to_name) else '{}'::jsonb end
      || jsonb_build_object('area', m.to_key),
    title = case when n.title = m.from_name then m.to_name else n.title end
from area_fold m
where n.metadata->>'teammate_id' = m.from_id::text;

-- Cards name their raiser, a fallback owner and a proposed assignee in JSON.
update public.attention_item a
set payload = a.payload || jsonb_build_object('raised_by_ai_member_id', m.to_id::text)
from area_fold m
where a.payload->>'raised_by_ai_member_id' = m.from_id::text;
update public.attention_item a
set payload = a.payload || jsonb_build_object('fallback_owner_ai_member_id', m.to_id::text)
from area_fold m
where a.payload->>'fallback_owner_ai_member_id' = m.from_id::text;
update public.attention_item a
set payload = a.payload || jsonb_build_object('assignee_ai_member_id', m.to_id::text)
from area_fold m
where a.payload->>'assignee_ai_member_id' = m.from_id::text;

-- Nothing points at them now: the folded rows go (their skills and memory,
-- copied above, go with them by cascade).
delete from public.ai_team_member a using area_fold m where a.id = m.from_id;

alter table public.ai_team_member enable trigger ai_team_member_protect_system;

alter table public.ai_team_member add constraint ai_team_member_system_key_check
  check (
    system_key is null
    or (is_system and system_key in ('captures', 'mail', 'prospecting', 'evals', 'crm', 'assistant'))
  );

comment on column public.ai_team_member.system_key is
  'For a system teammate, the area face it is (captures | mail | prospecting | evals | crm) or the Assistant (assistant); the ledger writers look it up by this key. NULL for every other teammate.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Check, after applying:
--   select system_key, count(*) from public.ai_team_member where is_system group by 1;
--     → captures, mail, prospecting, evals, crm, assistant: one per workspace with a team
--   select count(*) from public.ai_team_member
--   where system_key in ('triage', 'extraction', 'reconciler', 'email_drafts');            → 0
--   select count(*) from public.notification n
--   where n.metadata ? 'teammate_id'
--     and not exists (select 1 from public.ai_team_member a where a.id::text = n.metadata->>'teammate_id');
--     → no more than before (no notice left pointing at a folded row)
--   select count(*) from public.chat_conversations where focus_area is not null;            → the converted threads (only ones with messages)
--   select tgenabled from pg_trigger where tgname = 'ai_team_member_protect_system';         → O (283's guard back on)
--   select public.free_bot_character(gen_random_uuid());                                    → research
-- ═══════════════════════════════════════════════════════════════════════════
