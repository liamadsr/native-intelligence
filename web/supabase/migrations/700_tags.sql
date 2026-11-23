-- ============================================================
-- 700: tags. One set of tags on every kind of record (docs/plans/tags.md).
-- ============================================================
-- Tags ARE labels (020's public.label), extended. Nothing already labelled
-- moves: the five join tables that exist keep their rows and their policies.
--
-- What this adds:
--   1. label.owner_user_id: NULL is a workspace tag (every label today); a
--      value is a personal tag, seen and used only by that person.
--      label.created_by: who made it (NULL for older rows).
--      The (workspace_id, name) unique constraint becomes two partial unique
--      indexes, one for workspace tags (today's rule for every existing row)
--      and one per owner for personal tags. Nothing upserts on the old
--      constraint (checked: no ON CONFLICT on it in code or migrations).
--   2. Who may create and change a tag (replacing 020's two label policies):
--      create: any non-guest member (a workspace tag) or any member (a
--      personal one, for themselves). Rename, recolor, regroup, rescope or
--      delete: a workspace tag's creator, or an owner or admin (a row with no
--      creator, i.e. every label before 700: owner or admin, as before); a
--      personal tag: its owner. Personal → workspace by its owner; never back.
--      label_client_guard: the 359/369/675 guard for client writes (current_user
--      authenticated or anon; service role, postgres and SECURITY DEFINER code
--      skip it): id, workspace_id, created_by never change; owner_user_id only
--      from your own id to NULL; a new or changed name is 1 to 64 characters,
--      trimmed, not starting with a hash; color #rrggbb; scopes only known
--      taggable kinds (081's scopes are kinds, not teams).
--   3. Nine join tables in the same pattern as the five (a real foreign key to
--      the record and to the label, on delete cascade; primary key (record,
--      label); an index on label_id): document_label, data_table_label,
--      data_row_label, spreadsheet_label, canvas_label, contact_label,
--      company_label, attachment_label, team_chat_channel_label.
--   4. One rule for every join table, old and new, as RESTRICTIVE policies
--      beside each table's own permissive ones:
--        read    the label is visible to the caller (a workspace tag, or their
--                own) AND the record is visible to the caller under its own
--                row-level security (an EXISTS on the record table, run as the
--                caller: entity_access grants included). On the old tables
--                this also stops a member reading the labels of a private
--                capture they cannot open. (Actions, projects, initiatives and
--                mail: their own policy already is the record's read rule, so
--                only the label check is added there.) No record becomes
--                visible to anyone new.
--        write   (insert, update, delete) the same, and tag_join_allowed: the
--                label is in the record's workspace, and it is the caller's own
--                personal tag, or a workspace tag and the caller is a non-guest
--                member who does not reach the record only through a view grant
--                (512's entity_view_grant_only; for a row, its table's grant;
--                for a file, its capture's or its row's table's).
--      New tables get permissive select / insert / delete for a caller who can
--      read the record; there is no update on them.
--   5. The free-text tags columns of contact, company, document and captures
--      (Decision 1): backfilled into workspace tags (matched case-insensitively
--      to an existing workspace label, else created grey) and join rows; then
--      kept as a mirror both ways, by SECURITY DEFINER triggers:
--        join row added or removed, or a workspace tag renamed or shared
--          → the record's tags column = the names of its WORKSPACE tags
--            (sorted). Personal tags are never written into it.
--        the tags column written directly (CRM import, dedup, old tools,
--          document publish) → each name becomes a workspace tag on the record
--          (created by name if new), and workspace tags no longer named come off.
--      Recursion: each direction sets a transaction-local flag the other reads
--      (ni.tags_mirror, ni.tags_mirror_sync), plus a pg_trigger_depth() fuse.
--      Both directions stand aside during a workspace merge
--      (dial8.workspace_merge, 402), which unions tags and join rows itself.
--   6. Moves and merges.
--      A record of a new kind whose workspace_id changes: its tags follow it to
--      the same-named tag in the destination (a personal one to the same
--      owner's), created there when missing (a personal one only for an owner
--      who is a member there; otherwise it comes off).
--      _wsmove_remap_labels (221, its only definition): matches on the owner
--      as well as the name.
--      _wsmerge_build_maps (402, its only definition): the label map folds a
--      tag only into one of the same kind and owner.
--      _wsmerge_labels (latest 408): the nine new tables in its list.
--      _wsmerge_repoint_entity (402, its only definition): a folded record's
--      tag rows go to the record it folds into.
--      Each is restated whole from main's current definition, with only those
--      changes.
--   7. tagged_records (security_invoker view: every join row the caller can
--      see, as (entity_type, entity_id, label_id, workspace_id)) and
--      records_with_tags(workspace, label ids, 'any' | 'all'), SECURITY
--      INVOKER, over it: nothing comes back that the caller could not read.
--
-- Rollout: applied by the owner, on the server, before the code that needs it.
-- The old app works on the new schema (its label routes and queries are
-- unchanged in shape; a guest or a view-only grantee can no longer add a
-- workspace tag, which the app never offered them). The new app needs it.
--
-- This file has its own begin/commit. Idempotent: create ... if not exists,
-- create or replace, drop policy/trigger if exists; the backfill only adds
-- what is missing. No backslash anywhere in this file.

begin;

-- ------------------------------------------------------------
-- 1. label: owner and creator; uniqueness per kind of tag
-- ------------------------------------------------------------

alter table public.label add column if not exists owner_user_id uuid references auth.users (id) on delete cascade;
alter table public.label add column if not exists created_by uuid default auth.uid();

comment on column public.label.owner_user_id is
  'NULL: a workspace tag. Set: a personal tag, seen and used only by this person (700).';
comment on column public.label.created_by is
  'Who made the tag (auth user id); NULL for labels made before 700.';
comment on column public.label.scopes is
  'Kinds of record where this tag is offered. NULL = every kind. A picker preference, not enforced (081, 700).';

alter table public.label drop constraint if exists label_workspace_id_name_key;
create unique index if not exists label_workspace_name_shared
  on public.label (workspace_id, name) where owner_user_id is null;
create unique index if not exists label_workspace_owner_name
  on public.label (workspace_id, owner_user_id, name) where owner_user_id is not null;
create index if not exists idx_label_owner on public.label (owner_user_id) where owner_user_id is not null;

-- Names: never empty, at most 200 characters (a CRM tag may be long; the
-- client guard below holds new names to 64), no line breaks. NOT VALID: old
-- rows are not checked, every write from now on is.
alter table public.label drop constraint if exists label_name_shape;
alter table public.label add constraint label_name_shape check (
  char_length(btrim(name)) between 1 and 200
  and position(chr(10) in name) = 0 and position(chr(13) in name) = 0
) not valid;

-- The kinds a scope may name, and the kinds that take tags.
create or replace function public.tag_kinds()
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select array['action', 'project', 'initiative', 'email_thread', 'capture', 'document', 'data_table',
               'data_row', 'spreadsheet', 'canvas', 'contact', 'company', 'attachment', 'team_chat_channel']
$$;
revoke execute on function public.tag_kinds() from public, anon;
grant execute on function public.tag_kinds() to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Who may create and change a tag
-- ------------------------------------------------------------

drop policy if exists "Admins can manage labels" on public.label;
drop policy if exists "Workspace members can view labels" on public.label;
drop policy if exists label_select on public.label;
drop policy if exists label_insert on public.label;
drop policy if exists label_update on public.label;
drop policy if exists label_delete on public.label;

create policy label_select on public.label for select
  using (public.is_workspace_member(workspace_id) and (owner_user_id is null or owner_user_id = auth.uid()));

create policy label_insert on public.label for insert
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
    and (owner_user_id = auth.uid()
         or (owner_user_id is null and coalesce(public.get_member_role(workspace_id), 'guest') <> 'guest'))
  );

create policy label_update on public.label for update
  using (
    public.is_workspace_member(workspace_id)
    and (owner_user_id = auth.uid()
         or (owner_user_id is null
             and (public.get_member_role(workspace_id) in ('owner', 'admin')
                  or (created_by = auth.uid() and public.get_member_role(workspace_id) <> 'guest'))))
  )
  with check (owner_user_id is null or owner_user_id = auth.uid());

create policy label_delete on public.label for delete
  using (
    public.is_workspace_member(workspace_id)
    and (owner_user_id = auth.uid()
         or (owner_user_id is null
             and (public.get_member_role(workspace_id) in ('owner', 'admin')
                  or (created_by = auth.uid() and public.get_member_role(workspace_id) <> 'guest'))))
  );

create or replace function public.label_client_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
       or new.created_by is distinct from old.created_by then
      raise exception 'a tag keeps its id, workspace and creator' using errcode = '42501';
    end if;
    if new.owner_user_id is distinct from old.owner_user_id
       and not (old.owner_user_id = auth.uid() and new.owner_user_id is null) then
      raise exception 'only its owner can share a personal tag, and a shared tag cannot become personal' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if new.name is null or new.name <> btrim(new.name) or char_length(new.name) not between 1 and 64
       or left(new.name, 1) = '#' then
      raise exception 'a tag name is 1 to 64 characters, trimmed, not starting with a hash' using errcode = '22023';
    end if;
  end if;
  if (tg_op = 'INSERT' or new.color is distinct from old.color) and new.color !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'a tag color is #rrggbb' using errcode = '22023';
  end if;
  if (tg_op = 'INSERT' or new.scopes is distinct from old.scopes) and new.scopes is not null
     and not (new.scopes <@ public.tag_kinds()) then
    raise exception 'a tag scope is a kind of record that takes tags' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists label_client_guard on public.label;
create trigger label_client_guard
  before insert or update on public.label
  for each row execute function public.label_client_guard();

-- ------------------------------------------------------------
-- 3. The nine new join tables
-- ------------------------------------------------------------

create table if not exists public.document_label (
  document_id uuid not null references public.document (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (document_id, label_id)
);
create table if not exists public.data_table_label (
  data_table_id uuid not null references public.data_table (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (data_table_id, label_id)
);
create table if not exists public.data_row_label (
  data_row_id uuid not null references public.data_row (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (data_row_id, label_id)
);
create table if not exists public.spreadsheet_label (
  spreadsheet_id uuid not null references public.spreadsheet (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (spreadsheet_id, label_id)
);
create table if not exists public.canvas_label (
  canvas_id uuid not null references public.canvas (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (canvas_id, label_id)
);
create table if not exists public.contact_label (
  contact_id uuid not null references public.contact (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (contact_id, label_id)
);
create table if not exists public.company_label (
  company_id uuid not null references public.company (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (company_id, label_id)
);
create table if not exists public.attachment_label (
  attachment_id uuid not null references public.attachments (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (attachment_id, label_id)
);
create table if not exists public.team_chat_channel_label (
  team_chat_channel_id uuid not null references public.team_chat_channel (id) on delete cascade,
  label_id uuid not null references public.label (id) on delete cascade,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (team_chat_channel_id, label_id)
);

-- ------------------------------------------------------------
-- 4. One rule for every join table
-- ------------------------------------------------------------

-- The workspace of record p_id of kind p_kind (no visibility: callers pair it
-- with the record's own row-level security).
create or replace function public.tag_record_workspace(p_kind text, p_id uuid)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case p_kind
    when 'action' then (select workspace_id from public.actions where id = p_id)
    when 'project' then (select workspace_id from public.projects where id = p_id)
    when 'initiative' then (select workspace_id from public.initiative where id = p_id)
    when 'email_thread' then (select workspace_id from public.email_thread_index where id = p_id)
    when 'capture' then (select workspace_id from public.captures where id = p_id)
    when 'document' then (select workspace_id from public.document where id = p_id)
    when 'data_table' then (select workspace_id from public.data_table where id = p_id)
    when 'data_row' then (select workspace_id from public.data_row where id = p_id)
    when 'spreadsheet' then (select workspace_id from public.spreadsheet where id = p_id)
    when 'canvas' then (select workspace_id from public.canvas where id = p_id)
    when 'contact' then (select workspace_id from public.contact where id = p_id)
    when 'company' then (select workspace_id from public.company where id = p_id)
    when 'attachment' then (select workspace_id from public.attachments where id = p_id)
    when 'team_chat_channel' then (select workspace_id from public.team_chat_channel where id = p_id)
  end
$$;
revoke execute on function public.tag_record_workspace(text, uuid) from public, anon;
grant execute on function public.tag_record_workspace(text, uuid) to authenticated, service_role;

-- Whether the caller reaches the record only through a VIEW grant (512).
create or replace function public.tag_view_grant_only(p_kind text, p_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(case
    when p_kind in ('document', 'capture', 'contact', 'company', 'data_table', 'spreadsheet', 'canvas')
      then public.entity_view_grant_only(p_kind, p_id)
    when p_kind = 'data_row'
      then public.entity_view_grant_only('data_table', (select r.table_id from public.data_row r where r.id = p_id))
    when p_kind = 'attachment' then (
      select coalesce(case
               when a.note_id is not null then public.entity_view_grant_only('capture', a.note_id)
               when a.data_row_id is not null then public.entity_view_grant_only('data_table',
                 (select r.table_id from public.data_row r where r.id = a.data_row_id))
             end, false)
        from public.attachments a where a.id = p_id)
    else false
  end, false)
$$;
revoke execute on function public.tag_view_grant_only(text, uuid) from public, anon;
grant execute on function public.tag_view_grant_only(text, uuid) to authenticated, service_role;

-- Whether the caller may put tag p_label on (or take it off) record p_id.
create or replace function public.tag_join_allowed(p_kind text, p_id uuid, p_label uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.label l
     where l.id = p_label
       and l.workspace_id = public.tag_record_workspace(p_kind, p_id)
       and public.is_workspace_member(l.workspace_id)
       and (l.owner_user_id = auth.uid()
            or (l.owner_user_id is null
                and coalesce(public.get_member_role(l.workspace_id), 'guest') <> 'guest'
                and not public.tag_view_grant_only(p_kind, p_id))))
$$;
revoke execute on function public.tag_join_allowed(text, uuid, uuid) from public, anon;
grant execute on function public.tag_join_allowed(text, uuid, uuid) to authenticated, service_role;

do $$
declare
  t record;
begin
  for t in select * from (values
      ('action', 'action_label', 'action_id', 'actions', false),
      ('project', 'project_label', 'project_id', 'projects', false),
      ('initiative', 'initiative_label', 'initiative_id', 'initiative', false),
      ('email_thread', 'email_thread_label', 'thread_id', 'email_thread_index', false),
      ('capture', 'capture_label', 'capture_id', 'captures', false),
      ('document', 'document_label', 'document_id', 'document', true),
      ('data_table', 'data_table_label', 'data_table_id', 'data_table', true),
      ('data_row', 'data_row_label', 'data_row_id', 'data_row', true),
      ('spreadsheet', 'spreadsheet_label', 'spreadsheet_id', 'spreadsheet', true),
      ('canvas', 'canvas_label', 'canvas_id', 'canvas', true),
      ('contact', 'contact_label', 'contact_id', 'contact', true),
      ('company', 'company_label', 'company_id', 'company', true),
      ('attachment', 'attachment_label', 'attachment_id', 'attachments', true),
      ('team_chat_channel', 'team_chat_channel_label', 'team_chat_channel_id', 'team_chat_channel', true)
    ) as v(kind, jt, col, rt, is_new)
  loop
    execute format('alter table public.%I enable row level security', t.jt);
    -- the old five already index label_id (020, 038, 044, 045, 108)
    if t.is_new then
      execute format('create index if not exists %I on public.%I (label_id)', t.jt || '_label_idx', t.jt);
    end if;

    -- restrictive: the label is visible, and so is the record (as the caller).
    -- Actions, projects, initiatives and mail: their own permissive policy already
    -- is the record's read rule (member of its workspace; mail: its owner), so the
    -- record check is left out there (it doubled the per-row cost of a list).
    -- Captures can be private, so theirs is checked like every new kind's.
    execute format('drop policy if exists tag_join_read on public.%I', t.jt);
    if t.kind in ('action', 'project', 'initiative', 'email_thread') then
      execute format($p$create policy tag_join_read on public.%1$I as restrictive for select
        using (label_id in (select l.id from public.label l))$p$, t.jt);
    else
      execute format($p$create policy tag_join_read on public.%1$I as restrictive for select
        using (label_id in (select l.id from public.label l)
               and exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col);
    end if;

    execute format('drop policy if exists tag_join_write on public.%I', t.jt);
    execute format($p$create policy tag_join_write on public.%1$I as restrictive for insert
      with check (public.tag_join_allowed(%4$L, %3$I, label_id)
                  and exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col, t.kind);

    execute format('drop policy if exists tag_join_update on public.%I', t.jt);
    execute format($p$create policy tag_join_update on public.%1$I as restrictive for update
      using (public.tag_join_allowed(%4$L, %3$I, label_id)
             and exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))
      with check (public.tag_join_allowed(%4$L, %3$I, label_id)
                  and exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col, t.kind);

    execute format('drop policy if exists tag_join_remove on public.%I', t.jt);
    execute format($p$create policy tag_join_remove on public.%1$I as restrictive for delete
      using (public.tag_join_allowed(%4$L, %3$I, label_id)
             and exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col, t.kind);

    if t.is_new then
      -- permissive: whoever can read the record (the restrictive rules above narrow it)
      execute format('drop policy if exists %I on public.%I', t.jt || '_select', t.jt);
      execute format($p$create policy %4$I on public.%1$I for select
        using (exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col, t.jt || '_select');
      execute format('drop policy if exists %I on public.%I', t.jt || '_insert', t.jt);
      execute format($p$create policy %4$I on public.%1$I for insert
        with check (exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col, t.jt || '_insert');
      execute format('drop policy if exists %I on public.%I', t.jt || '_delete', t.jt);
      execute format($p$create policy %4$I on public.%1$I for delete
        using (exists (select 1 from public.%2$I r where r.id = %1$I.%3$I))$p$, t.jt, t.rt, t.col, t.jt || '_delete');
      execute format('revoke all on public.%I from anon', t.jt);
      execute format('grant select, insert, delete on public.%I to authenticated', t.jt);
      execute format('grant all on public.%I to service_role', t.jt);
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 5. The free-text tags columns: backfill, then the mirror
-- ------------------------------------------------------------

-- Backfill: every distinct name (trimmed, spaces collapsed, 1 to 200 long)
-- becomes a workspace tag, matched case-insensitively to the oldest existing
-- workspace label, else created grey; then the join rows. The columns
-- themselves are not rewritten here.
do $$
declare
  v_created int;
  v_rows int;
begin
  create temp table _tag_names on commit drop as
  select distinct s.workspace_id, s.kind, s.id, n.name
    from (
      select workspace_id, 'contact'::text as kind, id, tags from public.contact where cardinality(tags) > 0
      union all select workspace_id, 'company', id, tags from public.company where cardinality(tags) > 0
      union all select workspace_id, 'document', id, tags from public.document where cardinality(tags) > 0
      union all select workspace_id, 'capture', id, tags from public.captures where cardinality(tags) > 0 and workspace_id is not null
    ) s
    cross join lateral (
      select btrim(regexp_replace(e, '[[:space:]]+', ' ', 'g')) as name from unnest(s.tags) e
    ) n
   where char_length(n.name) between 1 and 200;

  insert into public.label (workspace_id, name, created_by)
  select distinct on (t.workspace_id, lower(t.name)) t.workspace_id, t.name, null::uuid
    from _tag_names t
   where not exists (select 1 from public.label l
                      where l.workspace_id = t.workspace_id and l.owner_user_id is null and lower(l.name) = lower(t.name))
   order by t.workspace_id, lower(t.name), t.name
  on conflict do nothing;
  get diagnostics v_created = row_count;

  create temp table _tag_map on commit drop as
  select distinct on (t.kind, t.id, l.id) t.kind, t.id, l.id as label_id
    from _tag_names t
    join lateral (
      select l.id from public.label l
       where l.workspace_id = t.workspace_id and l.owner_user_id is null and lower(l.name) = lower(t.name)
       order by l.created_at, l.id limit 1) l on true;

  insert into public.contact_label (contact_id, label_id, created_by) select id, label_id, null from _tag_map where kind = 'contact' on conflict do nothing;
  insert into public.company_label (company_id, label_id, created_by) select id, label_id, null from _tag_map where kind = 'company' on conflict do nothing;
  insert into public.document_label (document_id, label_id, created_by) select id, label_id, null from _tag_map where kind = 'document' on conflict do nothing;
  insert into public.capture_label (capture_id, label_id) select id, label_id from _tag_map where kind = 'capture' on conflict do nothing;
  select count(*) into v_rows from _tag_map;

  raise notice '700 backfill: % workspace tags created, % record tags from the text columns', v_created, v_rows;
end;
$$;

-- The mirror. Each direction raises a transaction-local flag the other reads,
-- and restores it after. Both stand aside during a workspace merge.

create or replace function public._tags_mirror_off()
returns boolean
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('dial8.workspace_merge', true), '') <> '' or pg_trigger_depth() > 6
$$;

-- join rows → the record's tags column (workspace tags only, sorted)
create or replace function public._tags_mirror_write(p_kind text, p_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_jt text; v_col text; v_rt text; v_names text[]; v_prev text;
begin
  select jt, col, rt into v_jt, v_col, v_rt from (values
      ('contact', 'contact_label', 'contact_id', 'contact'),
      ('company', 'company_label', 'company_id', 'company'),
      ('document', 'document_label', 'document_id', 'document'),
      ('capture', 'capture_label', 'capture_id', 'captures')) v(kind, jt, col, rt)
   where kind = p_kind;
  if v_jt is null or p_id is null then return; end if;

  execute format($q$
    select coalesce(array_agg(l.name order by lower(l.name), l.name), '{}'::text[])
      from public.%I j join public.label l on l.id = j.label_id and l.owner_user_id is null
     where j.%I = $1$q$, v_jt, v_col)
    into v_names using p_id;

  v_prev := coalesce(current_setting('ni.tags_mirror', true), '');
  perform set_config('ni.tags_mirror', '1', true);
  execute format('update public.%I set tags = $1 where id = $2 and tags is distinct from $1', v_rt) using v_names, p_id;
  perform set_config('ni.tags_mirror', v_prev, true);
end;
$$;
revoke execute on function public._tags_mirror_write(text, uuid) from public, anon, authenticated;
grant execute on function public._tags_mirror_write(text, uuid) to service_role;

-- the record's tags column → join rows (workspace tags, created by name)
create or replace function public._tags_from_names(p_kind text, p_id uuid, p_workspace uuid, p_names text[])
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_jt text; v_col text; v_name text; v_label uuid; v_keep uuid[] := '{}'; v_prev text;
begin
  select jt, col into v_jt, v_col from (values
      ('contact', 'contact_label', 'contact_id'),
      ('company', 'company_label', 'company_id'),
      ('document', 'document_label', 'document_id'),
      ('capture', 'capture_label', 'capture_id')) v(kind, jt, col)
   where kind = p_kind;
  if v_jt is null or p_id is null or p_workspace is null then return; end if;

  v_prev := coalesce(current_setting('ni.tags_mirror_sync', true), '');
  perform set_config('ni.tags_mirror_sync', '1', true);

  for v_name in
    select distinct on (lower(n)) n
      from (select btrim(regexp_replace(e, '[[:space:]]+', ' ', 'g')) as n from unnest(coalesce(p_names, '{}'::text[])) e) x
     where char_length(n) between 1 and 200
     order by lower(n), n
  loop
    select l.id into v_label from public.label l
     where l.workspace_id = p_workspace and l.owner_user_id is null and lower(l.name) = lower(v_name)
     order by l.created_at, l.id limit 1;
    if v_label is null then
      insert into public.label (workspace_id, name, created_by) values (p_workspace, v_name, null)
      on conflict do nothing
      returning id into v_label;
      if v_label is null then
        select l.id into v_label from public.label l
         where l.workspace_id = p_workspace and l.owner_user_id is null and l.name = v_name;
      end if;
    end if;
    if v_label is not null then
      v_keep := v_keep || v_label;
      execute format('insert into public.%I (%I, label_id) values ($1, $2) on conflict do nothing', v_jt, v_col)
        using p_id, v_label;
    end if;
  end loop;

  -- workspace tags no longer named come off; personal tags are untouched
  execute format($q$
    delete from public.%I j using public.label l
     where j.%I = $1 and l.id = j.label_id and l.owner_user_id is null and not (j.label_id = any ($2))$q$, v_jt, v_col)
    using p_id, v_keep;

  perform set_config('ni.tags_mirror_sync', v_prev, true);
  perform public._tags_mirror_write(p_kind, p_id);
end;
$$;
revoke execute on function public._tags_from_names(text, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public._tags_from_names(text, uuid, uuid, text[]) to service_role;

create or replace function public._tags_record_tags_changed()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('ni.tags_mirror', true), '') = '1' or public._tags_mirror_off() then
    return null;
  end if;
  perform public._tags_from_names(tg_argv[0], new.id, new.workspace_id, new.tags);
  return null;
end;
$$;

create or replace function public._tags_join_changed()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_label uuid := case when tg_op = 'DELETE' then old.label_id else new.label_id end;
  v_id uuid;
begin
  if coalesce(current_setting('ni.tags_mirror_sync', true), '') = '1' or public._tags_mirror_off() then
    return null;
  end if;
  -- a personal tag never reaches the column (a label already gone: a cascade, recompute)
  if exists (select 1 from public.label l where l.id = v_label and l.owner_user_id is not null)
     and (tg_op <> 'UPDATE' or not exists (select 1 from public.label l where l.id = old.label_id and l.owner_user_id is null)) then
    return null;
  end if;
  v_id := (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> tg_argv[1])::uuid;
  perform public._tags_mirror_write(tg_argv[0], v_id);
  if tg_op = 'UPDATE' then
    v_id := (to_jsonb(old) ->> tg_argv[1])::uuid;
    perform public._tags_mirror_write(tg_argv[0], v_id);
  end if;
  return null;
end;
$$;

create or replace function public._tags_label_changed()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if public._tags_mirror_off() then return null; end if;
  for r in
    select 'contact' as kind, contact_id as id from public.contact_label where label_id = new.id
    union all select 'company', company_id from public.company_label where label_id = new.id
    union all select 'document', document_id from public.document_label where label_id = new.id
    union all select 'capture', capture_id from public.capture_label where label_id = new.id
  loop
    perform public._tags_mirror_write(r.kind, r.id);
  end loop;
  return null;
end;
$$;

do $$
declare
  t record;
begin
  for t in select * from (values
      ('contact', 'contact', 'contact_label', 'contact_id'),
      ('company', 'company', 'company_label', 'company_id'),
      ('document', 'document', 'document_label', 'document_id'),
      ('capture', 'captures', 'capture_label', 'capture_id')) v(kind, rt, jt, col)
  loop
    execute format('drop trigger if exists tags_mirror_insert on public.%I', t.rt);
    execute format($q$create trigger tags_mirror_insert after insert on public.%I
      for each row when (cardinality(new.tags) > 0)
      execute function public._tags_record_tags_changed(%L)$q$, t.rt, t.kind);
    execute format('drop trigger if exists tags_mirror_update on public.%I', t.rt);
    execute format($q$create trigger tags_mirror_update after update of tags on public.%I
      for each row when (old.tags is distinct from new.tags)
      execute function public._tags_record_tags_changed(%L)$q$, t.rt, t.kind);
    execute format('drop trigger if exists tags_mirror_join on public.%I', t.jt);
    execute format($q$create trigger tags_mirror_join after insert or update or delete on public.%I
      for each row execute function public._tags_join_changed(%L, %L)$q$, t.jt, t.kind, t.col);
  end loop;
end;
$$;

drop trigger if exists tags_mirror_label on public.label;
create trigger tags_mirror_label
  after update of name, owner_user_id on public.label
  for each row when (old.name is distinct from new.name or old.owner_user_id is distinct from new.owner_user_id)
  execute function public._tags_label_changed();

-- ------------------------------------------------------------
-- 6. Moves and merges
-- ------------------------------------------------------------

-- A record of a new kind moved to another workspace: its tags follow by name.
create or replace function public._tags_follow_move()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_jt text := tg_argv[0]; v_col text := tg_argv[1];
  r record; v_dst uuid;
begin
  if public._tags_mirror_off() then return null; end if;
  for r in execute format($q$
      select j.label_id, l.name, l.color, l.owner_user_id
        from public.%I j join public.label l on l.id = j.label_id
       where j.%I = $1 and l.workspace_id is distinct from $2$q$, v_jt, v_col)
    using new.id, new.workspace_id
  loop
    select d.id into v_dst from public.label d
     where d.workspace_id = new.workspace_id and lower(d.name) = lower(r.name)
       and d.owner_user_id is not distinct from r.owner_user_id
     order by d.created_at, d.id limit 1;
    if v_dst is null and (r.owner_user_id is null
        or exists (select 1 from public.member m where m.workspace_id = new.workspace_id and m.user_id = r.owner_user_id)) then
      insert into public.label (workspace_id, name, color, owner_user_id, created_by)
      values (new.workspace_id, r.name, r.color, r.owner_user_id, null)
      on conflict do nothing returning id into v_dst;
      if v_dst is null then
        select d.id into v_dst from public.label d
         where d.workspace_id = new.workspace_id and d.name = r.name and d.owner_user_id is not distinct from r.owner_user_id;
      end if;
    end if;
    if v_dst is not null then
      execute format('insert into public.%I (%I, label_id) values ($1, $2) on conflict do nothing', v_jt, v_col)
        using new.id, v_dst;
    end if;
    execute format('delete from public.%I where %I = $1 and label_id = $2', v_jt, v_col) using new.id, r.label_id;
  end loop;
  return null;
end;
$$;

do $$
declare
  t record;
begin
  for t in select * from (values
      ('document', 'document_label', 'document_id'),
      ('data_table', 'data_table_label', 'data_table_id'),
      ('data_row', 'data_row_label', 'data_row_id'),
      ('spreadsheet', 'spreadsheet_label', 'spreadsheet_id'),
      ('canvas', 'canvas_label', 'canvas_id'),
      ('contact', 'contact_label', 'contact_id'),
      ('company', 'company_label', 'company_id'),
      ('attachments', 'attachment_label', 'attachment_id'),
      ('team_chat_channel', 'team_chat_channel_label', 'team_chat_channel_id')) v(rt, jt, col)
  loop
    execute format('drop trigger if exists tags_follow_move on public.%I', t.rt);
    execute format($q$create trigger tags_follow_move after update of workspace_id on public.%I
      for each row when (old.workspace_id is distinct from new.workspace_id)
      execute function public._tags_follow_move(%L, %L)$q$, t.rt, t.jt, t.col);
  end loop;
end;
$$;

-- 221's _wsmove_remap_labels (its only definition), matching the owner too.
CREATE OR REPLACE FUNCTION public._wsmove_remap_labels(p_junction text, p_entity_col text, p_entity_ids uuid[], p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_remapped int := 0;
  v_deleted int := 0;
BEGIN
  IF p_junction NOT IN ('action_label', 'capture_label', 'project_label', 'initiative_label')
     OR p_entity_col NOT IN ('action_id', 'capture_id', 'project_id', 'initiative_id') THEN
    RAISE EXCEPTION 'invalid label junction' USING ERRCODE = '22023';
  END IF;
  IF p_entity_ids IS NULL OR cardinality(p_entity_ids) = 0 THEN
    RETURN jsonb_build_object('remapped', 0, 'deleted', 0);
  END IF;

  EXECUTE format($q$
    WITH map AS (
      SELECT DISTINCT ON (j.%2$I, dl.id)
        j.%2$I AS entity_id, j.label_id AS old_label, dl.id AS new_label
      FROM public.%1$I j
      JOIN public.label sl ON sl.id = j.label_id AND sl.workspace_id = $2
      JOIN public.label dl ON dl.workspace_id = $3 AND lower(dl.name) = lower(sl.name)
                          AND dl.owner_user_id IS NOT DISTINCT FROM sl.owner_user_id
      WHERE j.%2$I = ANY($1)
      ORDER BY j.%2$I, dl.id, sl.name ASC
    ),
    updated AS (
      UPDATE public.%1$I j
      SET label_id = m.new_label
      FROM map m
      WHERE j.%2$I = m.entity_id AND j.label_id = m.old_label
        AND NOT EXISTS (
          SELECT 1 FROM public.%1$I x
          WHERE x.%2$I = m.entity_id AND x.label_id = m.new_label
        )
      RETURNING 1
    )
    SELECT count(*) FROM updated
  $q$, p_junction, p_entity_col)
  INTO v_remapped
  USING p_entity_ids, p_source, p_dest;

  EXECUTE format($q$
    WITH deleted AS (
      DELETE FROM public.%1$I j
      USING public.label sl
      WHERE j.%2$I = ANY($1)
        AND sl.id = j.label_id
        AND sl.workspace_id = $2
      RETURNING 1
    )
    SELECT count(*) FROM deleted
  $q$, p_junction, p_entity_col)
  INTO v_deleted
  USING p_entity_ids, p_source;

  RETURN jsonb_build_object('remapped', v_remapped, 'deleted', v_deleted);
END;
$$;

-- 402's _wsmerge_build_maps (its only definition); only the label map changes:
-- a tag folds into a twin of the same kind and owner.
CREATE OR REPLACE FUNCTION public._wsmerge_build_maps(p_source uuid, p_dest uuid, p_plan jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- people in both workspaces: source member → destination member
  DROP TABLE IF EXISTS pg_temp._wsmerge_members;
  CREATE TABLE pg_temp._wsmerge_members (src uuid PRIMARY KEY, dst uuid NOT NULL, user_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_members
  SELECT s.id, d.id, s.user_id
  FROM public.member s
  JOIN public.member d ON d.user_id = s.user_id AND d.workspace_id = p_dest
  WHERE s.workspace_id = p_source;

  -- teams: own (dst = itself, renamed) or fold (dst = the chosen team)
  DROP TABLE IF EXISTS pg_temp._wsmerge_teams;
  CREATE TABLE pg_temp._wsmerge_teams (
    src uuid PRIMARY KEY, dst uuid NOT NULL, mode text NOT NULL,
    old_name text, new_name text, old_slug text, new_slug text,
    old_prefix text NOT NULL, new_prefix text NOT NULL, ord int
  ) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_teams
  SELECT t.id,
         CASE WHEN e.v->>'mode' = 'fold' THEN (e.v->>'destination_team_id')::uuid ELSE t.id END,
         e.v->>'mode',
         t.name, COALESCE(e.v->>'name', t.name),
         t.slug, COALESCE(e.v->>'slug', t.slug),
         t.issue_prefix,
         CASE WHEN e.v->>'mode' = 'fold'
              THEN (SELECT d.issue_prefix FROM public.team d WHERE d.id = (e.v->>'destination_team_id')::uuid)
              ELSE e.v->>'prefix' END,
         e.ord
  FROM jsonb_array_elements(p_plan->'teams') WITH ORDINALITY e(v, ord)
  JOIN public.team t ON t.id = (e.v->>'source_team_id')::uuid AND t.workspace_id = p_source;

  -- workflow states of folded teams: the engine ladder (name → category →
  -- default → first), so dst is never NULL (the plan already required a
  -- default state). Columns common to DEV and PROD only: PROD's
  -- workflow_state has no entity_kind.
  DROP TABLE IF EXISTS pg_temp._wsmerge_states;
  CREATE TABLE pg_temp._wsmerge_states (src uuid PRIMARY KEY, dst uuid) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_states
  SELECT s.id, COALESCE(
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst AND lower(d.name) = lower(s.name) ORDER BY d.sort_order, d.id LIMIT 1),
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst AND d.category = s.category ORDER BY d.sort_order, d.id LIMIT 1),
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst AND d.is_default ORDER BY d.sort_order, d.id LIMIT 1),
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst ORDER BY d.sort_order, d.id LIMIT 1))
  FROM public.workflow_state s
  JOIN pg_temp._wsmerge_teams tm ON tm.src = s.team_id AND tm.mode = 'fold';

  -- labels by name, case-insensitively (oldest destination twin wins); a tag
  -- folds only into one of the same kind and owner (700)
  DROP TABLE IF EXISTS pg_temp._wsmerge_labels;
  CREATE TABLE pg_temp._wsmerge_labels (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_labels
  SELECT DISTINCT ON (s.id) s.id, d.id
  FROM public.label s
  JOIN public.label d ON d.workspace_id = p_dest AND lower(d.name) = lower(s.name)
                    AND d.owner_user_id IS NOT DISTINCT FROM s.owner_user_id
  WHERE s.workspace_id = p_source
  ORDER BY s.id, d.created_at, d.id;

  -- system teammates by system_key
  DROP TABLE IF EXISTS pg_temp._wsmerge_teammates;
  CREATE TABLE pg_temp._wsmerge_teammates (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_teammates
  SELECT s.id, d.id
  FROM public.ai_team_member s
  JOIN public.ai_team_member d ON d.workspace_id = p_dest AND d.system_key = s.system_key
  WHERE s.workspace_id = p_source AND s.is_system AND s.system_key IS NOT NULL;

  -- contacts by email (both live, i.e. not already merged tombstones)
  DROP TABLE IF EXISTS pg_temp._wsmerge_contacts;
  CREATE TABLE pg_temp._wsmerge_contacts (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_contacts
  SELECT DISTINCT ON (s.id) s.id, d.id
  FROM public.contact s
  JOIN public.contact d ON d.workspace_id = p_dest AND d.email IS NOT NULL AND lower(d.email) = lower(s.email)
                        AND d.merged_into_contact_id IS NULL
  WHERE s.workspace_id = p_source AND s.email IS NOT NULL AND s.merged_into_contact_id IS NULL
  ORDER BY s.id, d.created_at, d.id;

  -- companies by domain
  DROP TABLE IF EXISTS pg_temp._wsmerge_companies;
  CREATE TABLE pg_temp._wsmerge_companies (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_companies
  SELECT DISTINCT ON (s.id) s.id, d.id
  FROM public.company s
  JOIN public.company d ON d.workspace_id = p_dest AND COALESCE(d.domain, '') <> '' AND lower(d.domain) = lower(s.domain)
  WHERE s.workspace_id = p_source AND COALESCE(s.domain, '') <> ''
  ORDER BY s.id, d.created_at, d.id;

  -- the per-person hidden '__default__' project, by person
  DROP TABLE IF EXISTS pg_temp._wsmerge_projects;
  CREATE TABLE pg_temp._wsmerge_projects (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_projects
  SELECT s.id, d.id
  FROM public.projects s
  JOIN public.projects d ON d.workspace_id = p_dest AND d.name = '__default__' AND d.user_id = s.user_id
  WHERE s.workspace_id = p_source AND s.name = '__default__';

  -- seeded loops by seed_key (the destination's keeps running)
  DROP TABLE IF EXISTS pg_temp._wsmerge_flows;
  CREATE TABLE pg_temp._wsmerge_flows (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_flows
  SELECT s.id, d.id
  FROM public.flow s
  JOIN public.flow d ON d.workspace_id = p_dest AND d.seed_key = s.seed_key
  WHERE s.workspace_id = p_source AND s.seed_key IS NOT NULL;

  -- providers both sides have connected: the destination's wins
  DROP TABLE IF EXISTS pg_temp._wsmerge_shared_providers;
  CREATE TABLE pg_temp._wsmerge_shared_providers (kind text, provider text, PRIMARY KEY (kind, provider)) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_shared_providers
  SELECT 'tasks', s.provider FROM public.task_sync_state s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.task_sync_state d WHERE d.workspace_id = p_dest AND d.provider = s.provider)
  GROUP BY s.provider;
  INSERT INTO pg_temp._wsmerge_shared_providers
  SELECT 'crm', s.provider FROM public.crm_sync_state s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.crm_sync_state d WHERE d.workspace_id = p_dest AND d.provider = s.provider)
  GROUP BY s.provider;

  -- every id that changes meaning, for the JSON rewriters
  DROP TABLE IF EXISTS pg_temp._wsmerge_ids;
  CREATE TABLE pg_temp._wsmerge_ids (src uuid, dst uuid) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_ids
  SELECT src, dst FROM pg_temp._wsmerge_members
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_teams WHERE mode = 'fold'
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_states WHERE dst IS NOT NULL
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_labels
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_teammates
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_projects
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_flows;
END;
$$;

-- 408's _wsmerge_labels (the latest), with the nine new join tables.
CREATE OR REPLACE FUNCTION public._wsmerge_labels(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE j record; v_folded int := 0; v_moved int := 0;
BEGIN
  FOR j IN SELECT * FROM (VALUES
      ('action_label', 'action_id'), ('capture_label', 'capture_id'), ('project_label', 'project_id'),
      ('initiative_label', 'initiative_id'), ('email_thread_label', 'thread_id'),
      -- 700
      ('document_label', 'document_id'), ('data_table_label', 'data_table_id'), ('data_row_label', 'data_row_id'),
      ('spreadsheet_label', 'spreadsheet_id'), ('canvas_label', 'canvas_id'), ('contact_label', 'contact_id'),
      ('company_label', 'company_id'), ('attachment_label', 'attachment_id'),
      ('team_chat_channel_label', 'team_chat_channel_id')) AS v(junction, col)
  LOOP
    EXECUTE format($q$
      UPDATE public.%1$I x SET label_id = m.dst
      FROM pg_temp._wsmerge_labels m
      WHERE x.label_id = m.src
        AND NOT EXISTS (SELECT 1 FROM public.%1$I y WHERE y.%2$I = x.%2$I AND y.label_id = m.dst)
    $q$, j.junction, j.col);
    EXECUTE format($q$
      DELETE FROM public.%1$I x USING pg_temp._wsmerge_labels m WHERE x.label_id = m.src
    $q$, j.junction);
  END LOOP;

  UPDATE public.label d
  -- NULL scopes = visible everywhere (081): a universal side keeps the union universal (408)
  SET scopes = CASE WHEN d.scopes IS NULL OR s.scopes IS NULL THEN NULL
                    ELSE (SELECT array_agg(DISTINCT e) FROM unnest(d.scopes || s.scopes) e) END,
      group_name = COALESCE(d.group_name, s.group_name)
  FROM pg_temp._wsmerge_labels m
  JOIN public.label s ON s.id = m.src
  WHERE d.id = m.dst;

  PERFORM public._wsmerge_assert_no_refs('label', (SELECT array_agg(src) FROM pg_temp._wsmerge_labels), '{}');
  DELETE FROM public.label l USING pg_temp._wsmerge_labels m WHERE l.id = m.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;
  UPDATE public.label SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('labels_folded', v_folded, 'labels_moved', v_moved);
END;
$$;

-- 402's _wsmerge_repoint_entity (its only definition), plus a folded record's
-- tag rows going to the record it folds into.
CREATE OR REPLACE FUNCTION public._wsmerge_repoint_entity(p_type text, p_src uuid, p_dst uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_jt text; v_col text;
BEGIN
  -- evidence (unique claim_id, source_type, source_id, source_uri)
  DELETE FROM public.claim_source s
  WHERE s.source_type = p_type AND s.source_id = p_src
    AND EXISTS (SELECT 1 FROM public.claim_source d WHERE d.claim_id = s.claim_id AND d.source_type = p_type
                AND d.source_id = p_dst AND d.source_uri IS NOT DISTINCT FROM s.source_uri);
  UPDATE public.claim_source SET source_id = p_dst WHERE source_type = p_type AND source_id = p_src;

  -- edges (six-column key): re-point where that edge is new, drop the rest
  UPDATE public.entity_link l SET source_id = p_dst
  WHERE l.source_type = p_type AND l.source_id = p_src
    AND NOT EXISTS (SELECT 1 FROM public.entity_link d WHERE d.workspace_id = l.workspace_id AND d.source_type = p_type AND d.source_id = p_dst
                    AND d.target_type = l.target_type AND d.target_id = l.target_id AND d.relation = l.relation);
  DELETE FROM public.entity_link WHERE source_type = p_type AND source_id = p_src;
  UPDATE public.entity_link l SET target_id = p_dst
  WHERE l.target_type = p_type AND l.target_id = p_src
    AND NOT EXISTS (SELECT 1 FROM public.entity_link d WHERE d.workspace_id = l.workspace_id AND d.target_type = p_type AND d.target_id = p_dst
                    AND d.source_type = l.source_type AND d.source_id = l.source_id AND d.relation = l.relation);
  DELETE FROM public.entity_link WHERE target_type = p_type AND target_id = p_src;

  -- package pins (PK package_id, entity_type, entity_id)
  INSERT INTO public.knowledge_package_item (package_id, workspace_id, entity_type, entity_id, added_by, created_at)
  SELECT package_id, workspace_id, entity_type, p_dst, added_by, created_at
  FROM public.knowledge_package_item WHERE entity_type = p_type AND entity_id = p_src
  ON CONFLICT DO NOTHING;
  DELETE FROM public.knowledge_package_item WHERE entity_type = p_type AND entity_id = p_src;

  UPDATE public.work_touch SET entity_id = p_dst WHERE entity_type = p_type AND entity_id = p_src;
  UPDATE public.notification SET target_id = p_dst WHERE target_type = p_type AND target_id = p_src;
  UPDATE public.notification SET context_id = p_dst WHERE context_type = p_type AND context_id = p_src;
  UPDATE public.attention_item SET entity_id = p_dst WHERE entity_type = p_type AND entity_id = p_src;

  -- pending reminders: one per person per entity
  DELETE FROM public.reminder s
  WHERE s.entity_type = p_type AND s.entity_id = p_src AND s.delivered_at IS NULL
    AND EXISTS (SELECT 1 FROM public.reminder d WHERE d.user_id = s.user_id AND d.entity_type = p_type AND d.entity_id = p_dst AND d.delivered_at IS NULL);
  UPDATE public.reminder SET entity_id = p_dst WHERE entity_type = p_type AND entity_id = p_src;

  IF p_type IN ('action', 'capture', 'document', 'project', 'contact') THEN
    UPDATE public.comment SET commentable_id = p_dst WHERE commentable_type::text = p_type AND commentable_id = p_src;
  END IF;

  -- tags (700): the folded record's tags go to the record it folds into
  SELECT v.jt, v.col INTO v_jt, v_col FROM (VALUES
      ('action', 'action_label', 'action_id'), ('project', 'project_label', 'project_id'),
      ('initiative', 'initiative_label', 'initiative_id'), ('capture', 'capture_label', 'capture_id'),
      ('document', 'document_label', 'document_id'), ('data_table', 'data_table_label', 'data_table_id'),
      ('data_row', 'data_row_label', 'data_row_id'), ('spreadsheet', 'spreadsheet_label', 'spreadsheet_id'),
      ('canvas', 'canvas_label', 'canvas_id'), ('contact', 'contact_label', 'contact_id'),
      ('company', 'company_label', 'company_id'), ('attachment', 'attachment_label', 'attachment_id'),
      ('team_chat_channel', 'team_chat_channel_label', 'team_chat_channel_id')) AS v(kind, jt, col)
  WHERE v.kind = p_type;
  IF v_jt IS NOT NULL THEN
    EXECUTE format('INSERT INTO public.%1$I (%2$I, label_id) SELECT $2, label_id FROM public.%1$I WHERE %2$I = $1 ON CONFLICT DO NOTHING', v_jt, v_col)
      USING p_src, p_dst;
    EXECUTE format('DELETE FROM public.%1$I WHERE %2$I = $1', v_jt, v_col) USING p_src;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 7. Read paths for search
-- ------------------------------------------------------------

create or replace view public.tagged_records with (security_invoker = true) as
  select 'action'::text as entity_type, j.action_id as entity_id, j.label_id, l.workspace_id
    from public.action_label j join public.label l on l.id = j.label_id
  union all select 'project', j.project_id, j.label_id, l.workspace_id
    from public.project_label j join public.label l on l.id = j.label_id
  union all select 'initiative', j.initiative_id, j.label_id, l.workspace_id
    from public.initiative_label j join public.label l on l.id = j.label_id
  union all select 'email_thread', j.thread_id, j.label_id, l.workspace_id
    from public.email_thread_label j join public.label l on l.id = j.label_id
  union all select 'capture', j.capture_id, j.label_id, l.workspace_id
    from public.capture_label j join public.label l on l.id = j.label_id
  union all select 'document', j.document_id, j.label_id, l.workspace_id
    from public.document_label j join public.label l on l.id = j.label_id
  union all select 'data_table', j.data_table_id, j.label_id, l.workspace_id
    from public.data_table_label j join public.label l on l.id = j.label_id
  union all select 'data_row', j.data_row_id, j.label_id, l.workspace_id
    from public.data_row_label j join public.label l on l.id = j.label_id
  union all select 'spreadsheet', j.spreadsheet_id, j.label_id, l.workspace_id
    from public.spreadsheet_label j join public.label l on l.id = j.label_id
  union all select 'canvas', j.canvas_id, j.label_id, l.workspace_id
    from public.canvas_label j join public.label l on l.id = j.label_id
  union all select 'contact', j.contact_id, j.label_id, l.workspace_id
    from public.contact_label j join public.label l on l.id = j.label_id
  union all select 'company', j.company_id, j.label_id, l.workspace_id
    from public.company_label j join public.label l on l.id = j.label_id
  union all select 'attachment', j.attachment_id, j.label_id, l.workspace_id
    from public.attachment_label j join public.label l on l.id = j.label_id
  union all select 'team_chat_channel', j.team_chat_channel_id, j.label_id, l.workspace_id
    from public.team_chat_channel_label j join public.label l on l.id = j.label_id;

revoke all on public.tagged_records from public, anon;
grant select on public.tagged_records to authenticated, service_role;

-- The records in a workspace carrying any (or all) of some tags, as the caller sees them.
create or replace function public.records_with_tags(p_workspace uuid, p_label_ids uuid[], p_match text default 'any')
returns table (entity_type text, entity_id uuid)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select t.entity_type, t.entity_id
    from public.tagged_records t
   where t.workspace_id = p_workspace
     and t.label_id = any (p_label_ids)
   group by t.entity_type, t.entity_id
  having p_match is distinct from 'all'
      or count(distinct t.label_id) = (select count(distinct x) from unnest(p_label_ids) x)
$$;
revoke execute on function public.records_with_tags(uuid, uuid[], text) from public, anon;
grant execute on function public.records_with_tags(uuid, uuid[], text) to authenticated, service_role;

commit;
