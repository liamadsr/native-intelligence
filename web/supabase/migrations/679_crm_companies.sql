-- ============================================================
-- 679: the CRM around the company (docs: the five gaps the owner asked about).
--   A. A company's own lifecycle stage, owner and revenue; the workspace's
--      stages (Lead, Demo, Customer, Churned by default), which an owner or
--      admin renames, reorders, adds, deletes and resets.
--   B. Discussion on a company: comments, with the company's own visibility.
--   C. Pipelines of companies or contacts, beside the pipelines of deals.
-- ============================================================
-- Redefines ONE existing object: notification_target_type_check (newest in
-- 572), widened by 'company' and nothing else, so a mention on a company is
-- not dropped on insert. Everything else is new: tables, columns, functions,
-- triggers and policies beside the ones there. validate_commentable_exists
-- (057) and entity_activity_comment_insert (489) are NOT redefined: a company
-- comment gets its own target check and its own activity trigger.
--
-- The enum value 'company' is added first. Nothing in this file uses it as
-- an enum literal (every rule compares commentable_type::text), so it is
-- safe inside the same transaction.
--
-- Additive. Idempotent: safe to run twice. No company stage is set on any
-- existing company (every company starts at No stage). No backslashes.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ── A. Stages, owner, revenue ───────────────────────────────────────────────

-- The workspace's company stages, in order. A company's stage is one of
-- these or none ("No stage"). Deleting a stage moves its companies to No
-- stage (the foreign key below sets null).
create table if not exists public.company_stage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists company_stage_name_key on public.company_stage (workspace_id, lower(btrim(name)));
create index if not exists company_stage_workspace_idx on public.company_stage (workspace_id, position);

comment on table public.company_stage is
  'A workspace''s company lifecycle stages, in position order (679). Defaults Lead, Demo, Customer, Churned. A company sits at one or at none (No stage). Read by members; written by an owner or admin.';

alter table public.company_stage enable row level security;
revoke all on table public.company_stage from public, anon;
grant select, insert, update, delete on table public.company_stage to authenticated;
grant select, insert, update, delete on table public.company_stage to service_role;

drop policy if exists company_stage_select on public.company_stage;
create policy company_stage_select on public.company_stage
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists company_stage_insert on public.company_stage;
create policy company_stage_insert on public.company_stage
  for insert to authenticated
  with check (public.get_member_role(workspace_id) in ('owner', 'admin'));

drop policy if exists company_stage_update on public.company_stage;
create policy company_stage_update on public.company_stage
  for update to authenticated
  using (public.get_member_role(workspace_id) in ('owner', 'admin'))
  with check (public.get_member_role(workspace_id) in ('owner', 'admin'));

drop policy if exists company_stage_delete on public.company_stage;
create policy company_stage_delete on public.company_stage
  for delete to authenticated
  using (public.get_member_role(workspace_id) in ('owner', 'admin'));

-- The default stages, in order.
create or replace function public.company_stage_defaults()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array['Lead', 'Demo', 'Customer', 'Churned'];
$$;

grant execute on function public.company_stage_defaults() to authenticated, service_role;

-- Give a workspace the default stages when it has none at all. Internal: the
-- workspace trigger and the backfill below call it.
create or replace function public._seed_company_stages(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.company_stage s where s.workspace_id = p_workspace_id) then return; end if;
  insert into public.company_stage (workspace_id, name, position)
  select p_workspace_id, d.name, d.ord::int - 1
    from unnest(public.company_stage_defaults()) with ordinality d(name, ord)
  on conflict do nothing;
end;
$$;

revoke all on function public._seed_company_stages(uuid) from public, anon, authenticated;

create or replace function public.company_stage_seed_workspace()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._seed_company_stages(new.id);
  return null;
end;
$$;

revoke all on function public.company_stage_seed_workspace() from public, anon, authenticated;

drop trigger if exists company_stage_seed_workspace on public.workspace;
create trigger company_stage_seed_workspace
  after insert on public.workspace
  for each row execute function public.company_stage_seed_workspace();

-- Every workspace that exists has the defaults (a re-run adds nothing: a
-- workspace with any stage is skipped, so an admin's deletions stay deleted).
do $$
declare
  w record;
begin
  for w in select id from public.workspace loop
    perform public._seed_company_stages(w.id);
  end loop;
end;
$$;

-- Reset to the defaults (an owner or admin): a stage named like a default
-- keeps its id (its companies stay on it) and takes the default's name and
-- place; every other stage is deleted (its companies move to No stage); a
-- missing default is added. Returns the stages, in order.
create or replace function public.reset_company_stages(p_workspace_id uuid)
returns setof public.company_stage
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  d record;
  v_id uuid;
begin
  if auth.uid() is not null then
    select m.role into v_role from public.member m where m.workspace_id = p_workspace_id and m.user_id = auth.uid() limit 1;
    if v_role is null or v_role not in ('owner', 'admin') then
      raise exception 'only a workspace owner or admin resets the company stages' using errcode = '42501';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('company_stage:' || p_workspace_id::text, 0));
  -- Out of the way of the defaults' names first (the unique name index).
  delete from public.company_stage s
   where s.workspace_id = p_workspace_id
     and lower(btrim(s.name)) <> all (select lower(x) from unnest(public.company_stage_defaults()) x);
  for d in select x.name, x.ord::int - 1 as pos from unnest(public.company_stage_defaults()) with ordinality x(name, ord) loop
    select s.id into v_id from public.company_stage s
     where s.workspace_id = p_workspace_id and lower(btrim(s.name)) = lower(d.name) limit 1;
    if v_id is null then
      insert into public.company_stage (workspace_id, name, position) values (p_workspace_id, d.name, d.pos);
    else
      update public.company_stage set name = d.name, position = d.pos, updated_at = now() where id = v_id;
    end if;
    v_id := null;
  end loop;
  return query select * from public.company_stage s where s.workspace_id = p_workspace_id order by s.position, s.created_at;
end;
$$;

revoke all on function public.reset_company_stages(uuid) from public, anon;
grant execute on function public.reset_company_stages(uuid) to authenticated, service_role;

-- The company's own fields. revenue is a currency value, the custom fields'
-- shape ({amount, currency}, src/lib/crm/custom-field-types.ts).
alter table public.company add column if not exists stage_id uuid references public.company_stage(id) on delete set null;
alter table public.company add column if not exists stage_changed_at timestamptz;
alter table public.company add column if not exists owner_member_id uuid references public.member(id) on delete set null;
alter table public.company add column if not exists revenue jsonb;

alter table public.company drop constraint if exists company_revenue_shape;
alter table public.company add constraint company_revenue_shape check (
  revenue is null or (
    jsonb_typeof(revenue) = 'object'
    and jsonb_typeof(revenue -> 'amount') = 'number'
    and (revenue ->> 'currency') ~ '^[A-Z]{3}$'
    and abs((revenue ->> 'amount')::numeric) < 1e15
  )
) not valid;
alter table public.company validate constraint company_revenue_shape;

create index if not exists company_stage_id_idx on public.company (workspace_id, stage_id);
create index if not exists company_owner_member_idx on public.company (workspace_id, owner_member_id) where owner_member_id is not null;

comment on column public.company.stage_id is 'The company''s lifecycle stage (679): one of its workspace''s company_stage rows, or null (No stage). Set by people and tools only; nothing moves it automatically.';
comment on column public.company.owner_member_id is 'The workspace member who owns the account (679), or null.';
comment on column public.company.revenue is 'The company''s revenue as {amount, currency} (679), the currency custom field''s shape; null when unknown.';

-- A stage and an owner belong to the company's own workspace; a change of
-- stage is stamped.
create or replace function public.company_crm_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.stage_id is not null and (tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id) then
    if not exists (select 1 from public.company_stage s where s.id = new.stage_id and s.workspace_id = new.workspace_id) then
      raise exception 'that stage is not one of this workspace''s company stages' using errcode = '23503';
    end if;
  end if;
  if new.owner_member_id is not null and (tg_op = 'INSERT' or new.owner_member_id is distinct from old.owner_member_id) then
    if not exists (select 1 from public.member m where m.id = new.owner_member_id and m.workspace_id = new.workspace_id) then
      raise exception 'the owner is not a member of this workspace' using errcode = '23503';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if new.stage_id is not null then new.stage_changed_at := coalesce(new.stage_changed_at, now()); end if;
  elsif new.stage_id is distinct from old.stage_id then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.company_crm_fields_guard() from public, anon, authenticated;

drop trigger if exists company_crm_fields_guard on public.company;
create trigger company_crm_fields_guard
  before insert or update of stage_id, owner_member_id, workspace_id on public.company
  for each row execute function public.company_crm_fields_guard();

-- ── B. Discussion on a company ──────────────────────────────────────────────

alter type public.commentable_type add value if not exists 'company';

-- The company exists (057's trigger has no company branch and stays as it is).
create or replace function public.validate_company_comment_target()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.commentable_type::text = 'company' and not exists (select 1 from public.company c where c.id = new.commentable_id) then
    raise exception 'Referenced company does not exist';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_company_comment_target() from public, anon, authenticated;

drop trigger if exists comment_validate_company_target on public.comment;
create trigger comment_validate_company_target
  before insert or update of commentable_type, commentable_id on public.comment
  for each row execute function public.validate_company_comment_target();

-- Who reads, writes and resolves a company's comments: who can see the
-- company. The subquery runs as the caller, so the company's own row policy
-- (company_select_with_visible_contacts, 493: an owner or admin, a member
-- who sees one of its people, or a grant) decides, as 674 does for a contact.
drop policy if exists comment_company_select on public.comment;
create policy comment_company_select on public.comment
  for select to public
  using (
    commentable_type::text = 'company'
    and exists (
      select 1 from public.company c
       where c.id = comment.commentable_id
         and public.is_workspace_member(c.workspace_id)
    )
  );

drop policy if exists comment_company_insert on public.comment;
create policy comment_company_insert on public.comment
  for insert to public
  with check (
    commentable_type::text = 'company'
    and author_id is not null
    and author_user_id is null
    and exists (
      select 1
        from public.company c
        join public.member m on m.workspace_id = c.workspace_id
       where c.id = comment.commentable_id
         and m.id = comment.author_id
         and m.user_id = auth.uid()
         and public.is_workspace_member(c.workspace_id)
    )
  );

drop policy if exists comment_company_resolve on public.comment;
create policy comment_company_resolve on public.comment
  for update to public
  using (
    commentable_type::text = 'company'
    and exists (
      select 1 from public.company c
       where c.id = comment.commentable_id
         and public.is_workspace_member(c.workspace_id)
    )
  );

-- A company comment is in the company's activity (489's trigger knows no company).
create or replace function public.entity_activity_company_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
  select c.workspace_id, 'company', n.commentable_id, 'commented',
         case when a.actor_kind = 'system' and n.author_id is not null then 'member' else a.actor_kind end,
         case when a.actor_kind = 'system' then n.author_id else m.id end,
         jsonb_build_object('comment_id', n.id)
    from new_rows n
    join public.company c on c.id = n.commentable_id
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = c.workspace_id
   where n.commentable_type::text = 'company'
     and public.entity_activity_writable(c.workspace_id);
  return null;
end;
$$;

revoke all on function public.entity_activity_company_comment_insert() from public, anon, authenticated;

drop trigger if exists entity_activity_company_comment_insert on public.comment;
create trigger entity_activity_company_comment_insert
  after insert on public.comment
  referencing new table as new_rows
  for each statement execute function public.entity_activity_company_comment_insert();

-- A notification may point at a company (572's list, plus 'company').
alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact', 'company',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message', 'team_chat_channel'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

-- ── C. Pipelines of companies or contacts ───────────────────────────────────
-- A pipeline's rows are deals (record_kind null, every pipeline that exists)
-- or records: each row points to one company (its system Company column) or
-- one contact (its system Contacts column, one person). The same record can
-- sit in many pipelines, once in each.

alter table public.data_table add column if not exists record_kind text;
alter table public.data_table drop constraint if exists data_table_record_kind_check;
alter table public.data_table add constraint data_table_record_kind_check
  check (record_kind is null or (record_kind in ('company', 'contact') and table_kind = 'pipeline')) not valid;
alter table public.data_table validate constraint data_table_record_kind_check;
-- The workspace's default pipeline holds deals (the Deals page and the deal
-- tools open it): a pipeline of records is never the default.
alter table public.data_table drop constraint if exists data_table_record_not_default;
alter table public.data_table add constraint data_table_record_not_default
  check (record_kind is null or not is_default) not valid;
alter table public.data_table validate constraint data_table_record_not_default;

comment on column public.data_table.record_kind is
  'A pipeline of records (679): company or contact, each row pointing to one (the system company or contacts column). Null: a pipeline of deals, or not a pipeline.';

-- The record a row points to, kept by the trigger below from the record
-- column (never written by a caller), so one record sits once per pipeline.
alter table public.data_row add column if not exists record_id uuid;
create unique index if not exists data_row_one_record_per_pipeline
  on public.data_row (table_id, record_id)
  where record_id is not null and archived_at is null;

comment on column public.data_row.record_id is
  'The company or contact a row of a record pipeline points to (679), kept from its record column by data_row_record_guard. Null on every other row.';

-- The record column of a pipeline of records.
create or replace function public.pipeline_record_key(p_record_kind text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_record_kind when 'company' then 'company' when 'contact' then 'contacts' end;
$$;

grant execute on function public.pipeline_record_key(text) to authenticated, service_role;

create or replace function public.data_row_record_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_key text;
  v_ids jsonb;
  v_id uuid;
  v_name text;
begin
  select t.record_kind into v_kind from public.data_table t where t.id = new.table_id;
  if v_kind is null then
    new.record_id := null;
    return new;
  end if;
  v_key := public.pipeline_record_key(v_kind);
  v_ids := coalesce(new.custom_fields -> v_key, '[]'::jsonb);
  if jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) <> 1 then
    raise exception 'a row of this pipeline names one %', v_kind using errcode = '23514';
  end if;
  begin
    v_id := (v_ids ->> 0)::uuid;
  exception when others then
    raise exception 'a row of this pipeline names one %', v_kind using errcode = '23514';
  end;
  new.record_id := v_id;
  -- The row's name starts as the record's (a person can rename it).
  if coalesce(btrim(new.title), '') = '' then
    if v_kind = 'company' then
      select c.name into v_name from public.company c where c.id = v_id and c.workspace_id = new.workspace_id;
    else
      select coalesce(nullif(btrim(ct.full_name), ''), ct.email) into v_name from public.contact ct where ct.id = v_id and ct.workspace_id = new.workspace_id;
    end if;
    if v_name is not null then new.title := left(v_name, 500); end if;
  end if;
  -- Once per pipeline. A merge of two people who were both in it (541
  -- rewrites the relation) archives the second row instead of failing the merge.
  if new.archived_at is null and exists (
    select 1 from public.data_row r
     where r.table_id = new.table_id and r.record_id = v_id and r.archived_at is null and r.id <> new.id
  ) then
    if tg_op = 'UPDATE' then
      new.archived_at := now();
    else
      raise exception 'that % is already in this pipeline', v_kind using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.data_row_record_guard() from public, anon, authenticated;

drop trigger if exists data_row_record_guard on public.data_row;
create trigger data_row_record_guard
  before insert or update of custom_fields, archived_at, table_id on public.data_row
  for each row execute function public.data_row_record_guard();

-- A new pipeline of companies or contacts: create_pipeline's checks, columns
-- and system marks (540), then its kind. Stages default per kind.
create or replace function public.create_record_pipeline(
  p_workspace_id uuid,
  p_name text,
  p_record_kind text,
  p_stages jsonb default null,
  p_source text default 'person',
  p_as_user uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_table uuid;
  v_stages jsonb := p_stages;
begin
  if p_record_kind is null or p_record_kind not in ('company', 'contact') then
    raise exception 'a pipeline of records tracks companies or contacts' using errcode = '22023';
  end if;
  if v_stages is null or jsonb_typeof(v_stages) <> 'array' or jsonb_array_length(v_stages) = 0 then
    v_stages := case p_record_kind
      when 'company' then '[{"name": "Identified"}, {"name": "Contacted"}, {"name": "Engaged"}, {"name": "Partner", "outcome": "won"}, {"name": "Passed", "outcome": "lost"}]'::jsonb
      else '[{"name": "New"}, {"name": "Screening"}, {"name": "Interview"}, {"name": "Offer"}, {"name": "Hired", "outcome": "won"}, {"name": "Declined", "outcome": "lost"}]'::jsonb
    end;
  end if;
  v_result := public.create_pipeline(p_workspace_id, p_name, v_stages, p_source, p_as_user, p_reason, false, 'USD');
  v_table := (v_result ->> 'table_id')::uuid;
  update public.data_table set record_kind = p_record_kind where id = v_table;
  return v_result || jsonb_build_object('record_kind', p_record_kind);
end;
$$;

revoke all on function public.create_record_pipeline(uuid, text, text, jsonb, text, uuid, text) from public, anon;
grant execute on function public.create_record_pipeline(uuid, text, text, jsonb, text, uuid, text) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
