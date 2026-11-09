-- ============================================================
-- 473: A full CRM, slice 1 (roadmap #8): deals, pipelines, custom fields
-- ============================================================
-- src/lib/crm/deals.ts and src/lib/crm/custom-fields.ts.
--
--   1. deal_pipeline / deal_stage: a workspace's pipelines, each with ordered
--      stages. A stage's `kind` says whether a deal in it is still open, won or
--      lost. The default pipeline (Lead, Qualified, Proposal, Won, Lost) is
--      seeded on first use by ensure_default_deal_pipeline(), not here.
--   2. deal: name, value + currency, pipeline + stage, expected close date,
--      owner (a member), a company and the contacts it involves
--      (`contact_ids`, an array so the views system filters it with `@>`, the
--      way contact.prospect_list_ids is). A trigger keeps `closed_at` and
--      `stage_changed_at` in step with the stage and checks the stage belongs
--      to the deal's pipeline.
--   3. deal_event: every change to a deal, with each field's before and
--      after, who or what made it (a person, the agent, an email, a meeting, a
--      text) and when it was undone. It is what "apply with undo" undoes.
--   4. custom_field_definition: a workspace's own fields on deals, contacts
--      and companies (text, number, date, select). The values live in a
--      `custom_fields` jsonb on each record, keyed by the definition's `key`.
--   5. view_entity_type gains 'deal' (already there on databases cut from the
--      baseline).
--
-- RLS: any workspace member reads and writes all of it, like company.
-- Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. deal_pipeline, deal_stage
-- ------------------------------------------------------------

create table if not exists public.deal_pipeline (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.deal_pipeline is
  'A workspace''s deal pipelines (473). One is the default; it is seeded on first use.';

alter table public.deal_pipeline drop constraint if exists deal_pipeline_name_length;
alter table public.deal_pipeline
  add constraint deal_pipeline_name_length check (char_length(btrim(name)) between 1 and 80);

create unique index if not exists deal_pipeline_one_default
  on public.deal_pipeline (workspace_id) where is_default;
create index if not exists deal_pipeline_workspace_idx on public.deal_pipeline (workspace_id, position);

create table if not exists public.deal_stage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  pipeline_id uuid not null references public.deal_pipeline(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  kind text not null default 'open',
  color text null,
  created_at timestamptz not null default now()
);

comment on table public.deal_stage is
  'A pipeline''s ordered stages (473). kind: open, won or lost.';

alter table public.deal_stage drop constraint if exists deal_stage_kind_check;
alter table public.deal_stage
  add constraint deal_stage_kind_check check (kind in ('open', 'won', 'lost'));
alter table public.deal_stage drop constraint if exists deal_stage_name_length;
alter table public.deal_stage
  add constraint deal_stage_name_length check (char_length(btrim(name)) between 1 and 60);

create index if not exists deal_stage_pipeline_idx on public.deal_stage (pipeline_id, position);
create index if not exists deal_stage_workspace_idx on public.deal_stage (workspace_id);

-- ------------------------------------------------------------
-- 2. deal
-- ------------------------------------------------------------

create table if not exists public.deal (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null,
  value numeric(14, 2) null,
  currency text not null default 'USD',
  pipeline_id uuid not null references public.deal_pipeline(id) on delete cascade,
  stage_id uuid not null references public.deal_stage(id) on delete restrict,
  expected_close_date date null,
  owner_id uuid null references public.member(id) on delete set null,
  company_id uuid null references public.company(id) on delete set null,
  contact_ids uuid[] not null default '{}',
  notes text null,
  custom_fields jsonb not null default '{}'::jsonb,
  source text not null default 'manual',
  created_by_user_id uuid null references auth.users(id) on delete set null,
  stage_changed_at timestamptz not null default now(),
  closed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.deal is
  'A deal (473): value, pipeline stage, close date, owner, company and contacts. Changes are logged in deal_event.';
comment on column public.deal.contact_ids is
  'The contacts the deal involves. An array so views filter it with @> (like contact.prospect_list_ids); a contact''s delete removes it.';
comment on column public.deal.closed_at is
  'Set by trigger when the deal enters a won or lost stage; cleared when it leaves one.';

alter table public.deal drop constraint if exists deal_name_length;
alter table public.deal
  add constraint deal_name_length check (char_length(btrim(name)) between 1 and 200);
alter table public.deal drop constraint if exists deal_value_nonneg;
alter table public.deal
  add constraint deal_value_nonneg check (value is null or value >= 0);
alter table public.deal drop constraint if exists deal_currency_shape;
alter table public.deal
  add constraint deal_currency_shape check (currency ~ '^[A-Z]{3}$');
alter table public.deal drop constraint if exists deal_source_check;
alter table public.deal
  add constraint deal_source_check check (source in ('manual', 'agent', 'email', 'capture', 'sms', 'import'));
alter table public.deal drop constraint if exists deal_custom_fields_object;
alter table public.deal
  add constraint deal_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
alter table public.deal drop constraint if exists deal_notes_length;
alter table public.deal
  add constraint deal_notes_length check (notes is null or char_length(notes) <= 10000);

create index if not exists deal_workspace_stage_idx on public.deal (workspace_id, stage_id);
create index if not exists deal_workspace_created_idx on public.deal (workspace_id, created_at desc);
create index if not exists deal_company_idx on public.deal (company_id) where company_id is not null;
create index if not exists deal_owner_idx on public.deal (owner_id) where owner_id is not null;
create index if not exists deal_contact_ids_idx on public.deal using gin (contact_ids);

-- The stage must be one of the deal's pipeline's; closed_at and
-- stage_changed_at follow the stage.
create or replace function public.deal_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  st record;
begin
  select pipeline_id, workspace_id, kind into st from public.deal_stage where id = new.stage_id;
  if not found then
    raise exception 'deal stage % does not exist', new.stage_id using errcode = '23503';
  end if;
  if st.workspace_id <> new.workspace_id then
    raise exception 'deal stage belongs to another workspace' using errcode = '23514';
  end if;
  if new.pipeline_id is distinct from st.pipeline_id then
    raise exception 'deal stage belongs to another pipeline' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    new.stage_changed_at := now();
    if st.kind in ('won', 'lost') then
      new.closed_at := coalesce(case when tg_op = 'UPDATE' then old.closed_at end, now());
    else
      new.closed_at := null;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists deal_before_write on public.deal;
create trigger deal_before_write
  before insert or update on public.deal
  for each row execute function public.deal_before_write();

drop trigger if exists deal_pipeline_updated_at on public.deal_pipeline;
create trigger deal_pipeline_updated_at
  before update on public.deal_pipeline
  for each row execute function public.update_updated_at();

-- A contact's delete takes it out of every deal it was on.
create or replace function public.deal_forget_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.deal
     set contact_ids = array_remove(contact_ids, old.id)
   where workspace_id = old.workspace_id
     and contact_ids @> array[old.id];
  return old;
end;
$$;

revoke all on function public.deal_forget_contact() from public, anon, authenticated;

drop trigger if exists deal_forget_contact on public.contact;
create trigger deal_forget_contact
  after delete on public.contact
  for each row execute function public.deal_forget_contact();

-- ------------------------------------------------------------
-- 3. deal_event
-- ------------------------------------------------------------

create table if not exists public.deal_event (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  deal_id uuid not null references public.deal(id) on delete cascade,
  kind text not null,
  changes jsonb not null default '{}'::jsonb,
  source text not null default 'person',
  source_ref text null,
  reason text null,
  actor_user_id uuid null references auth.users(id) on delete set null,
  undone_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.deal_event is
  'Every change to a deal (473): changes = {field: {from, to}}. Undo writes each field''s `from` back.';

alter table public.deal_event drop constraint if exists deal_event_kind_check;
alter table public.deal_event
  add constraint deal_event_kind_check check (kind in ('created', 'updated', 'moved', 'undo'));
alter table public.deal_event drop constraint if exists deal_event_source_check;
alter table public.deal_event
  add constraint deal_event_source_check check (source in ('person', 'agent', 'email', 'capture', 'sms'));
alter table public.deal_event drop constraint if exists deal_event_reason_length;
alter table public.deal_event
  add constraint deal_event_reason_length check (reason is null or char_length(reason) <= 500);
alter table public.deal_event drop constraint if exists deal_event_source_ref_length;
alter table public.deal_event
  add constraint deal_event_source_ref_length check (source_ref is null or char_length(source_ref) <= 200);

create index if not exists deal_event_deal_idx on public.deal_event (deal_id, created_at desc);

-- ------------------------------------------------------------
-- 4. custom_field_definition + custom_fields on contact, company
-- ------------------------------------------------------------

create table if not exists public.custom_field_definition (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  entity_type text not null,
  key text not null,
  label text not null,
  field_type text not null,
  options text[] not null default '{}',
  position integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.custom_field_definition is
  'A workspace''s own fields on deals, contacts and companies (473). Values live in each record''s custom_fields jsonb under `key`.';

alter table public.custom_field_definition drop constraint if exists custom_field_definition_entity_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_entity_check check (entity_type in ('deal', 'contact', 'company'));
alter table public.custom_field_definition drop constraint if exists custom_field_definition_type_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_type_check check (field_type in ('text', 'number', 'date', 'select'));
alter table public.custom_field_definition drop constraint if exists custom_field_definition_key_shape;
alter table public.custom_field_definition
  add constraint custom_field_definition_key_shape check (key ~ '^[a-z][a-z0-9_]{0,39}$');
alter table public.custom_field_definition drop constraint if exists custom_field_definition_label_length;
alter table public.custom_field_definition
  add constraint custom_field_definition_label_length check (char_length(btrim(label)) between 1 and 60);
alter table public.custom_field_definition drop constraint if exists custom_field_definition_options_size;
alter table public.custom_field_definition
  add constraint custom_field_definition_options_size check (cardinality(options) <= 50);

create unique index if not exists custom_field_definition_key
  on public.custom_field_definition (workspace_id, entity_type, key);

alter table public.contact add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table public.company add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table public.contact drop constraint if exists contact_custom_fields_object;
alter table public.contact
  add constraint contact_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
alter table public.company drop constraint if exists company_custom_fields_object;
alter table public.company
  add constraint company_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');

-- ------------------------------------------------------------
-- 5. view_entity_type
-- ------------------------------------------------------------

alter type public.view_entity_type add value if not exists 'deal';

-- ------------------------------------------------------------
-- 6. The default pipeline, seeded on first use
-- ------------------------------------------------------------
-- Returns the workspace's default pipeline id, creating it with its five
-- stages the first time. SECURITY INVOKER: RLS decides who may; the partial
-- unique index makes two first uses at once settle on one pipeline.

create or replace function public.ensure_default_deal_pipeline(p_workspace_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  pid uuid;
begin
  select id into pid from public.deal_pipeline where workspace_id = p_workspace_id and is_default;
  if pid is not null then
    return pid;
  end if;

  insert into public.deal_pipeline (workspace_id, name, is_default, position)
  values (p_workspace_id, 'Sales', true, 0)
  on conflict (workspace_id) where is_default do nothing
  returning id into pid;

  if pid is null then
    select id into pid from public.deal_pipeline where workspace_id = p_workspace_id and is_default;
    return pid;
  end if;

  insert into public.deal_stage (workspace_id, pipeline_id, name, position, kind) values
    (p_workspace_id, pid, 'Lead', 0, 'open'),
    (p_workspace_id, pid, 'Qualified', 1, 'open'),
    (p_workspace_id, pid, 'Proposal', 2, 'open'),
    (p_workspace_id, pid, 'Won', 3, 'won'),
    (p_workspace_id, pid, 'Lost', 4, 'lost');
  return pid;
end;
$$;

revoke all on function public.ensure_default_deal_pipeline(uuid) from public, anon;
grant execute on function public.ensure_default_deal_pipeline(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. RLS
-- ------------------------------------------------------------

alter table public.deal_pipeline enable row level security;
alter table public.deal_stage enable row level security;
alter table public.deal enable row level security;
alter table public.deal_event enable row level security;
alter table public.custom_field_definition enable row level security;

drop policy if exists deal_pipeline_member on public.deal_pipeline;
create policy deal_pipeline_member on public.deal_pipeline
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists deal_stage_member on public.deal_stage;
create policy deal_stage_member on public.deal_stage
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists deal_member on public.deal;
create policy deal_member on public.deal
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists deal_event_member on public.deal_event;
create policy deal_event_member on public.deal_event
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists custom_field_definition_member on public.custom_field_definition;
create policy custom_field_definition_member on public.custom_field_definition
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

revoke all on table public.deal_pipeline, public.deal_stage, public.deal, public.deal_event, public.custom_field_definition from anon;
grant select, insert, update, delete on table public.deal_pipeline, public.deal_stage, public.deal, public.deal_event, public.custom_field_definition to authenticated;
grant all on table public.deal_pipeline, public.deal_stage, public.deal, public.deal_event, public.custom_field_definition to service_role;

-- ------------------------------------------------------------
-- 8. Realtime: the deals board follows other people's moves
-- ------------------------------------------------------------
-- Same treatment as company and campaign (187, 267): FULL replica identity so
-- updates carry the old row, published to the realtime publication.

alter table public.deal replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.deal;
exception when duplicate_object then null;
end $$;
