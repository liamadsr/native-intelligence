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

-- The stage must be one of the deal's pipeline's, and the stage, owner and
-- company the deal's own workspace's; closed_at and stage_changed_at follow
-- the stage. SECURITY DEFINER so RLS can't hide a row from the check (a
-- company with no contact the writer can see). Inside a workspace merge
-- (_wsmerge_active, 402) the merge itself keeps these true, a table at a time.
create or replace function public.deal_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  st record;
begin
  if public._wsmerge_active() then
    return new;
  end if;
  if new.owner_id is not null
     and not exists (select 1 from public.member m where m.id = new.owner_id and m.workspace_id = new.workspace_id) then
    raise exception 'deal owner belongs to another workspace' using errcode = '23514';
  end if;
  if new.company_id is not null
     and not exists (select 1 from public.company c where c.id = new.company_id and c.workspace_id = new.workspace_id) then
    raise exception 'deal company belongs to another workspace' using errcode = '23514';
  end if;

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

revoke all on function public.deal_before_write() from public, anon, authenticated;

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
grant select, insert, update, delete on table public.deal_pipeline, public.deal_stage, public.deal, public.custom_field_definition to authenticated;
-- The change log is append-only for a member: they add a change and mark one
-- undone, never rewrite or delete history. (Undo reads only deal fields from
-- it, src/lib/crm/deals.ts, so a hand-made event can't reach other columns.)
revoke update, delete on table public.deal_event from authenticated;
grant select, insert on table public.deal_event to authenticated;
grant update (undone_at) on table public.deal_event to authenticated;
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

-- ------------------------------------------------------------
-- 9. Workspace merge (402) with the new deal tables
-- ------------------------------------------------------------
-- 402, 403 and 408 reach a legacy `deal` (team_id / status_id, an old DEV
-- table that no database has now) through to_regclass guards, which this
-- migration's `deal` would make true. Their legacy branches now also need
-- the legacy column; the integrity sweep checks the new shape instead; and
-- the generic re-stamp first runs _wsmerge_deals, which folds the source's
-- pipelines and stages into the destination's by name (the default into the
-- default), carries its deals across with their stages mapped, and merges
-- custom field definitions by key (values live on the records, keyed the
-- same, so they keep working). Bodies are otherwise unchanged copies of
-- their newest definitions (402, 403, 408, 421).

CREATE OR REPLACE FUNCTION public._wsmerge_deals(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p record;
  s record;
  v_dst_pipeline uuid;
  v_dst_stage uuid;
  v_pos int;
  n_deals int := 0;
  n_fields int := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp._wsmerge_deal_stages;
  CREATE TEMP TABLE _wsmerge_deal_stages (src uuid PRIMARY KEY, dst uuid NOT NULL, dst_pipeline uuid NOT NULL) ON COMMIT DROP;

  FOR p IN SELECT * FROM public.deal_pipeline WHERE workspace_id = p_source ORDER BY is_default DESC, position LOOP
    SELECT d.id INTO v_dst_pipeline FROM public.deal_pipeline d
      WHERE d.workspace_id = p_dest AND ((p.is_default AND d.is_default) OR lower(d.name) = lower(p.name))
      ORDER BY (p.is_default AND d.is_default) DESC, d.position
      LIMIT 1;
    IF v_dst_pipeline IS NULL THEN
      -- No counterpart: the pipeline moves whole, and stays the default only
      -- where the destination has none.
      UPDATE public.deal_pipeline
         SET workspace_id = p_dest,
             is_default = p.is_default AND NOT EXISTS (SELECT 1 FROM public.deal_pipeline d WHERE d.workspace_id = p_dest AND d.is_default)
       WHERE id = p.id;
      UPDATE public.deal_stage SET workspace_id = p_dest WHERE pipeline_id = p.id;
      INSERT INTO pg_temp._wsmerge_deal_stages SELECT id, id, p.id FROM public.deal_stage WHERE pipeline_id = p.id;
    ELSE
      FOR s IN SELECT * FROM public.deal_stage WHERE pipeline_id = p.id ORDER BY position LOOP
        SELECT d.id INTO v_dst_stage FROM public.deal_stage d
          WHERE d.pipeline_id = v_dst_pipeline AND lower(d.name) = lower(s.name)
          LIMIT 1;
        IF v_dst_stage IS NULL THEN
          SELECT coalesce(max(position), -1) + 1 INTO v_pos FROM public.deal_stage WHERE pipeline_id = v_dst_pipeline;
          UPDATE public.deal_stage SET workspace_id = p_dest, pipeline_id = v_dst_pipeline, position = v_pos WHERE id = s.id;
          v_dst_stage := s.id;
        END IF;
        INSERT INTO pg_temp._wsmerge_deal_stages VALUES (s.id, v_dst_stage, v_dst_pipeline);
      END LOOP;
    END IF;
  END LOOP;

  -- Contacts the merge folded into the destination's (_wsmerge_contacts):
  -- the deal follows them to the surviving contact.
  IF to_regclass('pg_temp._wsmerge_contacts') IS NOT NULL THEN
    UPDATE public.deal d
       SET contact_ids = (SELECT array_agg(DISTINCT coalesce(m.dst, c)) FROM unnest(d.contact_ids) c
                            LEFT JOIN pg_temp._wsmerge_contacts m ON m.src = c)
     WHERE d.workspace_id = p_source
       AND d.contact_ids && (SELECT coalesce(array_agg(src), '{}') FROM pg_temp._wsmerge_contacts);
  END IF;

  UPDATE public.deal d
     SET workspace_id = p_dest, stage_id = m.dst, pipeline_id = m.dst_pipeline
    FROM pg_temp._wsmerge_deal_stages m
   WHERE d.workspace_id = p_source AND d.stage_id = m.src;
  GET DIAGNOSTICS n_deals = ROW_COUNT;
  -- What is left in the source (folded pipelines and their emptied stages) goes.
  DELETE FROM public.deal_pipeline WHERE workspace_id = p_source;

  DELETE FROM public.custom_field_definition f
   WHERE f.workspace_id = p_source
     AND EXISTS (SELECT 1 FROM public.custom_field_definition d
                  WHERE d.workspace_id = p_dest AND d.entity_type = f.entity_type AND d.key = f.key);
  GET DIAGNOSTICS n_fields = ROW_COUNT;

  RETURN jsonb_build_object('deals_moved', n_deals, 'custom_fields_folded', n_fields);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_deals(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n int; v_out jsonb := '{}'::jsonb;
BEGIN
  -- Deals first (473): pipelines and stages fold by name, so a deal is never
  -- re-stamped while its stage is still the other workspace's.
  v_out := v_out || public._wsmerge_deals(p_source, p_dest);
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge', 'cloud_browser')
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET workspace_id = $1 WHERE workspace_id = $2', r.table_name) USING p_dest, p_source;
      GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'merge cannot re-stamp %: a uniqueness this merge does not resolve (%)', r.table_name, SQLERRM
        USING ERRCODE = 'P0008';
    END;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object(r.table_name, n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_teams_finish(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE tm record; v_base int; v_cycles int := 0; v_cycles_demoted int := 0; v_deleted int := 0; n int;
BEGIN
  FOR tm IN SELECT * FROM pg_temp._wsmerge_teams WHERE mode = 'fold' ORDER BY ord LOOP
    SELECT COALESCE(max(number), 0) INTO v_base FROM public.cycle WHERE team_id = tm.dst;

    UPDATE public.cycle c
    SET team_id = tm.dst,
        number = v_base + x.rn,
        status = CASE WHEN c.status = 'active' AND EXISTS (SELECT 1 FROM public.cycle d WHERE d.team_id = tm.dst AND d.status = 'active')
                      THEN 'upcoming'::public.cycle_status ELSE c.status END
    FROM (SELECT id, row_number() OVER (ORDER BY number, created_at, id) AS rn FROM public.cycle WHERE team_id = tm.src) x
    WHERE c.id = x.id;
    GET DIAGNOSTICS n = ROW_COUNT; v_cycles := v_cycles + n;

    UPDATE public.team_member t SET team_id = tm.dst
    WHERE t.team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.team_member d WHERE d.team_id = tm.dst AND d.member_id = t.member_id);
    DELETE FROM public.team_member WHERE team_id = tm.src;

    UPDATE public.contact_share s SET shared_with_team_id = tm.dst
    WHERE s.shared_with_team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.contact_share d WHERE d.contact_id = s.contact_id AND d.shared_with_team_id = tm.dst);
    DELETE FROM public.contact_share WHERE shared_with_team_id = tm.src;

    UPDATE public.knowledge_package_share s SET shared_with_team_id = tm.dst
    WHERE s.shared_with_team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.knowledge_package_share d WHERE d.package_id = s.package_id AND d.shared_with_team_id = tm.dst);
    DELETE FROM public.knowledge_package_share WHERE shared_with_team_id = tm.src;

    IF to_regclass('public.deal') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'deal' AND column_name = 'team_id') THEN
      EXECUTE 'UPDATE public.deal d
               SET team_id = $2,
                   status_id = COALESCE((SELECT s.dst FROM pg_temp._wsmerge_states s WHERE s.src = d.status_id), d.status_id)
               WHERE d.team_id = $1' USING tm.src, tm.dst;
    END IF;

    -- projects scoped to the folded team follow it (408): migration 018 added projects.team_id
    -- (ON DELETE SET NULL) and 019 dropped it again, so this runs only on a database that still has it
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'team_id') THEN
      EXECUTE 'UPDATE public.projects SET team_id = $2 WHERE team_id = $1' USING tm.src, tm.dst;
    END IF;

    PERFORM public._wsmerge_assert_no_refs('team', ARRAY[tm.src], ARRAY['workflow_state']);
    DELETE FROM public.team WHERE id = tm.src;
    v_deleted := v_deleted + 1;
  END LOOP;

  RETURN jsonb_build_object('folded_teams_deleted', v_deleted, 'cycles_refiled', v_cycles);
END;
$$;

CREATE OR REPLACE FUNCTION public.workspace_integrity_sweep(p_workspace uuid)
RETURNS TABLE (check_name text, violations bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH checks AS (
    SELECT 'actions.team_workspace' AS c, count(*) AS n FROM public.actions a JOIN public.team t ON t.id = a.team_id
      WHERE a.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.status_team', count(*) FROM public.actions a JOIN public.workflow_state s ON s.id = a.status_id
      WHERE a.workspace_id = p_workspace AND s.team_id <> a.team_id
    UNION ALL SELECT 'actions.assignee_member', count(*) FROM public.actions a JOIN public.member m ON m.id = a.assignee_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.assignee_ai_member', count(*) FROM public.actions a JOIN public.ai_team_member m ON m.id = a.assignee_ai_member_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.assignee_contact', count(*) FROM public.actions a JOIN public.contact c ON c.id = a.assignee_contact_id
      WHERE a.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.project', count(*) FROM public.actions a JOIN public.projects p ON p.id = a.project_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.milestone_project', count(*) FROM public.actions a JOIN public.milestone ms ON ms.id = a.milestone_id JOIN public.projects p ON p.id = ms.project_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.cycle_team', count(*) FROM public.actions a JOIN public.cycle cy ON cy.id = a.cycle_id
      WHERE a.workspace_id = p_workspace AND cy.team_id <> a.team_id
    UNION ALL SELECT 'actions.parent', count(*) FROM public.actions a JOIN public.actions p ON p.id = a.parent_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.source_capture', count(*) FROM public.actions a JOIN public.captures c ON c.id = a.source_capture_id
      WHERE a.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'action_assignee.member', count(*) FROM public.action_assignee x JOIN public.actions a ON a.id = x.action_id JOIN public.member m ON m.id = x.member_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'action_label.label', count(*) FROM public.action_label x JOIN public.actions a ON a.id = x.action_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_label.label', count(*) FROM public.capture_label x JOIN public.captures a ON a.id = x.capture_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'project_label.label', count(*) FROM public.project_label x JOIN public.projects a ON a.id = x.project_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'initiative_label.label', count(*) FROM public.initiative_label x JOIN public.initiative a ON a.id = x.initiative_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'email_thread_label.label', count(*) FROM public.email_thread_label x JOIN public.email_thread_index a ON a.id = x.thread_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'action_relation.ends', count(*) FROM public.action_relation r JOIN public.actions a ON a.id = r.action_id JOIN public.actions b ON b.id = r.related_action_id
      WHERE a.workspace_id = p_workspace AND b.workspace_id <> p_workspace
    UNION ALL SELECT 'action_document.ends', count(*) FROM public.action_document r JOIN public.actions a ON a.id = r.action_id JOIN public.document d ON d.id = r.document_id
      WHERE a.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'action_external_task.action', count(*) FROM public.action_external_task x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'action_github_pr.action', count(*) FROM public.action_github_pr x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'agent_run.action', count(*) FROM public.agent_run x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_chunks.capture', count(*) FROM public.capture_chunks x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_references.capture', count(*) FROM public.capture_references x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'extraction_pass.capture', count(*) FROM public.extraction_pass x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_participant.member', count(*) FROM public.capture_participant x JOIN public.captures c ON c.id = x.capture_id JOIN public.member m ON m.id = x.member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_participant.contact', count(*) FROM public.capture_participant x JOIN public.captures c ON c.id = x.capture_id JOIN public.contact ct ON ct.id = x.contact_id
      WHERE c.workspace_id = p_workspace AND ct.workspace_id <> p_workspace
    UNION ALL SELECT 'captures.team', count(*) FROM public.captures c JOIN public.team t ON t.id = c.team_id
      WHERE c.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'captures.project', count(*) FROM public.captures c JOIN public.projects p ON p.id = c.project_id
      WHERE c.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'document_chunks.document', count(*) FROM public.document_chunks x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document_revision.document', count(*) FROM public.document_revision x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document_draft.document', count(*) FROM public.document_draft x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document.team', count(*) FROM public.document d JOIN public.team t ON t.id = d.team_id
      WHERE d.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'document.project', count(*) FROM public.document d JOIN public.projects p ON p.id = d.project_id
      WHERE d.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'document.created_by', count(*) FROM public.document d JOIN public.member m ON m.id = d.created_by
      WHERE d.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'claim_chunks.claim', count(*) FROM public.claim_chunks x JOIN public.claim c ON c.id = x.claim_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'claim_source.claim', count(*) FROM public.claim_source x JOIN public.claim c ON c.id = x.claim_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'claim.created_by', count(*) FROM public.claim c JOIN public.member m ON m.id = c.created_by
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'attachments.parent', count(*) FROM public.attachments x
      LEFT JOIN public.captures c ON c.id = x.note_id LEFT JOIN public.actions a ON a.id = x.action_id LEFT JOIN public.projects p ON p.id = x.project_id
      WHERE x.workspace_id = p_workspace AND COALESCE(c.workspace_id, a.workspace_id, p.workspace_id) <> p_workspace
    UNION ALL SELECT 'attachment_chunks.attachment', count(*) FROM public.attachment_chunks x JOIN public.attachments a ON a.id = x.attachment_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'anchor_embedding.project', count(*) FROM public.anchor_embedding x JOIN public.projects p ON p.id = x.entity_id AND x.entity_type = 'project'
      WHERE x.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.initiative', count(*) FROM public.projects p JOIN public.initiative i ON i.id = p.initiative_id
      WHERE p.workspace_id = p_workspace AND i.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.parent', count(*) FROM public.projects p JOIN public.projects q ON q.id = p.parent_project_id
      WHERE p.workspace_id = p_workspace AND q.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.lead', count(*) FROM public.projects p JOIN public.member m ON m.id = p.lead_id
      WHERE p.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.capture', count(*) FROM public.proposed_change x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.team', count(*) FROM public.proposed_change x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.assignee', count(*) FROM public.proposed_change x JOIN public.member m ON m.id = x.assignee_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'decision.project', count(*) FROM public.decision d JOIN public.captures c ON c.id = d.capture_id JOIN public.projects p ON p.id = d.project_id
      WHERE c.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'decision.decided_by', count(*) FROM public.decision d JOIN public.captures c ON c.id = d.capture_id JOIN public.member m ON m.id = d.decided_by
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'chat_conversations.capture', count(*) FROM public.chat_conversations x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'chat_conversations.teammate', count(*) FROM public.chat_conversations x JOIN public.ai_team_member m ON m.id = x.ai_team_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'share.shareable', count(*) FROM public.share s
      LEFT JOIN public.captures c ON c.id = s.shareable_id AND s.shareable_type = 'capture'
      LEFT JOIN public.document d ON d.id = s.shareable_id AND s.shareable_type = 'document'
      WHERE s.workspace_id = p_workspace AND s.is_active AND COALESCE(c.workspace_id, d.workspace_id) <> p_workspace
    UNION ALL SELECT 'share.created_by', count(*) FROM public.share s JOIN public.member m ON m.id = s.created_by
      WHERE s.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'email_thread_index.links', count(*) FROM public.email_thread_index e
      LEFT JOIN public.actions a ON a.id = e.linked_action_id LEFT JOIN public.captures c ON c.id = e.linked_capture_id
      LEFT JOIN public.projects p ON p.id = e.linked_project_id LEFT JOIN public.contact ct ON ct.id = e.linked_contact_id
      WHERE e.workspace_id = p_workspace AND (a.workspace_id <> p_workspace OR c.workspace_id <> p_workspace OR p.workspace_id <> p_workspace OR ct.workspace_id <> p_workspace)
    UNION ALL SELECT 'entity_link.ends', count(*) FROM public.entity_link l
      WHERE l.workspace_id = p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.company a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace))
    UNION ALL SELECT 'knowledge_package_item.entity', count(*) FROM public.knowledge_package_item i
      WHERE i.workspace_id = p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace))
    UNION ALL SELECT 'knowledge_package.team', count(*) FROM public.knowledge_package k JOIN public.team t ON t.id = k.team_id
      WHERE k.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'comment.author', count(*) FROM public.comment x JOIN public.member m ON m.id = x.author_id
      WHERE m.workspace_id <> p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace))
    UNION ALL SELECT 'team_member.member', count(*) FROM public.team_member x JOIN public.team t ON t.id = x.team_id JOIN public.member m ON m.id = x.member_id
      WHERE t.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'ai_team_member.team', count(*) FROM public.ai_team_member x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'flow.team', count(*) FROM public.flow x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'flow.teammate', count(*) FROM public.flow x JOIN public.ai_team_member m ON m.id = x.ai_team_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'view.team', count(*) FROM public.view x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.company', count(*) FROM public.contact c JOIN public.company co ON co.id = c.company_id
      WHERE c.workspace_id = p_workspace AND co.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.member', count(*) FROM public.contact c JOIN public.member m ON m.id = c.member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.created_by', count(*) FROM public.contact c JOIN public.member m ON m.id = c.created_by_member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'contact_share.target', count(*) FROM public.contact_share s
      LEFT JOIN public.member m ON m.id = s.shared_with_member_id LEFT JOIN public.team t ON t.id = s.shared_with_team_id
      WHERE s.workspace_id = p_workspace AND (m.workspace_id <> p_workspace OR t.workspace_id <> p_workspace)
    UNION ALL SELECT 'contact_share.contact', count(*) FROM public.contact_share s JOIN public.contact c ON c.id = s.contact_id
      WHERE s.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'initiative.owner', count(*) FROM public.initiative i JOIN public.member m ON m.id = i.owner_id
      WHERE i.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'notification.recipient', count(*) FROM public.notification n JOIN public.member m ON m.id = n.recipient_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'attention_item.member', count(*) FROM public.attention_item n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'tracked_job.member', count(*) FROM public.tracked_job n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'tool_approval.member', count(*) FROM public.tool_approval n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'invite.invited_by', count(*) FROM public.invite n JOIN public.member m ON m.id = n.invited_by
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'connected_account_workspace.home', count(*) FROM public.connected_account_workspace j JOIN public.connected_account a ON a.id = j.account_id
      WHERE j.workspace_id = p_workspace AND a.workspace_id = p_workspace AND j.workspace_id <> a.workspace_id
  )
  SELECT c, n FROM checks WHERE n > 0;

  -- Deals (473): a deal's stage, owner and company are its own workspace's.
  RETURN QUERY
  WITH checks AS (
    SELECT 'deal.stage' AS c, count(*) AS n FROM public.deal d JOIN public.deal_stage s ON s.id = d.stage_id
      WHERE d.workspace_id = p_workspace AND s.workspace_id <> p_workspace
    UNION ALL SELECT 'deal.owner', count(*) FROM public.deal d JOIN public.member m ON m.id = d.owner_id
      WHERE d.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'deal.company', count(*) FROM public.deal d JOIN public.company co ON co.id = d.company_id
      WHERE d.workspace_id = p_workspace AND co.workspace_id <> p_workspace
  )
  SELECT c, n FROM checks WHERE n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.repair_cross_workspace_drift(p_workspace uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_run uuid := gen_random_uuid();
  v_out jsonb := '{}'::jsonb;
  n int;
  r record;
  v_remaining jsonb;
BEGIN
  -- ══ 1. children follow their parent's workspace ═════════════════════════════
  -- attachments: home = capture, else action, else project (the sweep's order)
  WITH fixed AS (
    UPDATE public.attachments x SET workspace_id = sub.home
    FROM (SELECT x2.id, x2.workspace_id AS old_ws, COALESCE(c.workspace_id, a.workspace_id, p.workspace_id) AS home
          FROM public.attachments x2
          LEFT JOIN public.captures c ON c.id = x2.note_id
          LEFT JOIN public.actions a ON a.id = x2.action_id
          LEFT JOIN public.projects p ON p.id = x2.project_id) sub
    WHERE x.id = sub.id AND sub.home IS NOT NULL AND sub.home <> sub.old_ws
      AND (p_workspace IS NULL OR sub.home = p_workspace OR sub.old_ws = p_workspace)
    RETURNING x.id, sub.old_ws, sub.home)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'child_follows_parent', 'attachments', jsonb_build_object('id', id), home, jsonb_build_object('workspace_id', old_ws), jsonb_build_object('workspace_id', home) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('attachments.restamped', n); END IF;
  -- an attachment's secondary pointers outside its home are cleared (a parent always remains: the home came from one)
  WITH fixed AS (
    UPDATE public.attachments x SET project_id = NULL
    FROM public.projects p
    WHERE p.id = x.project_id AND p.workspace_id <> x.workspace_id AND (x.note_id IS NOT NULL OR x.action_id IS NOT NULL)
      AND (p_workspace IS NULL OR x.workspace_id = p_workspace)
    RETURNING x.id, x.workspace_id, p.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'attachments', jsonb_build_object('id', id), workspace_id, jsonb_build_object('project_id', old_target), jsonb_build_object('project_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('attachments.project_id.cleared', n); END IF;
  WITH fixed AS (
    UPDATE public.attachments x SET action_id = NULL
    FROM public.actions a
    WHERE a.id = x.action_id AND a.workspace_id <> x.workspace_id AND x.note_id IS NOT NULL
      AND (p_workspace IS NULL OR x.workspace_id = p_workspace)
    RETURNING x.id, x.workspace_id, a.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'attachments', jsonb_build_object('id', id), workspace_id, jsonb_build_object('action_id', old_target), jsonb_build_object('action_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('attachments.action_id.cleared', n); END IF;

  -- (child, fk, parent); attachment_chunks after attachments
  FOR r IN SELECT * FROM (VALUES
      ('capture_chunks', 'capture_id', 'captures'),
      ('capture_references', 'capture_id', 'captures'),
      ('extraction_pass', 'capture_id', 'captures'),
      ('proposed_change', 'capture_id', 'captures'),
      ('document_chunks', 'document_id', 'document'),
      ('document_revision', 'document_id', 'document'),
      ('claim_source', 'claim_id', 'claim'),
      ('claim_chunks', 'claim_id', 'claim'),
      ('action_external_task', 'action_id', 'actions'),
      ('action_github_pr', 'action_id', 'actions'),
      ('agent_run', 'action_id', 'actions'),
      ('contact_share', 'contact_id', 'contact'),
      ('attachment_chunks', 'attachment_id', 'attachments')
    ) AS v(child, fk, parent)
  LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I c SET workspace_id = p.workspace_id
        FROM public.%3$I p
        WHERE p.id = c.%2$I AND c.workspace_id IS DISTINCT FROM p.workspace_id
          AND ($1 IS NULL OR p.workspace_id = $1 OR c.workspace_id = $1)
        RETURNING c.id, c.workspace_id AS new_ws)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'child_follows_parent', %4$L, jsonb_build_object('id', f.id), f.new_ws, NULL, jsonb_build_object('workspace_id', f.new_ws) FROM fixed f
    $q$, r.child, r.fk, r.parent, r.child) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.child || '.' || r.fk || '.restamped', n); END IF;
  END LOOP;
  -- document_draft has no id: keyed by (document_id, author_user_id)
  WITH fixed AS (
    UPDATE public.document_draft c SET workspace_id = d.workspace_id
    FROM public.document d
    WHERE d.id = c.document_id AND c.workspace_id IS DISTINCT FROM d.workspace_id
      AND (p_workspace IS NULL OR d.workspace_id = p_workspace OR c.workspace_id = p_workspace)
    RETURNING c.document_id, c.author_user_id, c.workspace_id AS new_ws)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'child_follows_parent', 'document_draft', jsonb_build_object('document_id', document_id, 'author_user_id', author_user_id), new_ws, NULL, jsonb_build_object('workspace_id', new_ws) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document_draft.restamped', n); END IF;
  -- anchor embeddings of projects: the key includes the workspace. Keep the newest out-of-place row
  -- per project (unless the project's workspace already has one), drop the rest, re-key the keeper.
  WITH ranked AS (
    SELECT e.workspace_id AS old_ws, e.entity_id, p.workspace_id AS home,
           row_number() OVER (PARTITION BY e.entity_id ORDER BY e.updated_at DESC, e.workspace_id) AS rn,
           EXISTS (SELECT 1 FROM public.anchor_embedding d WHERE d.workspace_id = p.workspace_id AND d.entity_type = 'project' AND d.entity_id = p.id) AS home_has_one
    FROM public.anchor_embedding e JOIN public.projects p ON p.id = e.entity_id
    WHERE e.entity_type = 'project' AND e.workspace_id <> p.workspace_id
      AND (p_workspace IS NULL OR p.workspace_id = p_workspace OR e.workspace_id = p_workspace)
  ),
  gone AS (
    DELETE FROM public.anchor_embedding e USING ranked k
    WHERE e.entity_type = 'project' AND e.entity_id = k.entity_id AND e.workspace_id = k.old_ws AND (k.rn > 1 OR k.home_has_one)
    RETURNING e.entity_id, e.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'duplicate_dropped', 'anchor_embedding', jsonb_build_object('entity_type', 'project', 'entity_id', entity_id, 'workspace_id', workspace_id), workspace_id, NULL, NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('anchor_embedding.duplicates_dropped', n); END IF;
  WITH fixed AS (
    UPDATE public.anchor_embedding e SET workspace_id = p.workspace_id
    FROM public.projects p
    WHERE e.entity_type = 'project' AND p.id = e.entity_id AND e.workspace_id <> p.workspace_id
      AND (p_workspace IS NULL OR p.workspace_id = p_workspace OR e.workspace_id = p_workspace)
    RETURNING e.entity_id, e.workspace_id AS new_ws)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'child_follows_parent', 'anchor_embedding', jsonb_build_object('entity_type', 'project', 'entity_id', entity_id), new_ws, NULL, jsonb_build_object('workspace_id', new_ws) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('anchor_embedding.restamped', n); END IF;

  -- ══ 2. member references ════════════════════════════════════════════════════
  -- jobs about to be dropped: the children that lose their parent pointer are logged first
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'cascade.parent_cleared', 'tracked_job', jsonb_build_object('id', c.id), c.workspace_id,
         jsonb_build_object('parent_id', c.parent_id, 'root_id', c.root_id), NULL
  FROM public.tracked_job c
  WHERE EXISTS (SELECT 1 FROM public.tracked_job t JOIN public.member m ON m.id = t.member_id
                WHERE m.workspace_id <> t.workspace_id AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
                  AND NOT EXISTS (SELECT 1 FROM public.member x WHERE x.workspace_id = t.workspace_id AND x.user_id = m.user_id)
                  AND t.id IN (c.parent_id, c.root_id));
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('tracked_job.children_orphaned', n); END IF;

  -- (table, column, what to do when the person is not in the row's workspace)
  FOR r IN SELECT * FROM (VALUES
      ('actions', 'assignee_id', 'null'),
      ('projects', 'lead_id', 'null'),
      ('initiative', 'owner_id', 'null'),
      ('document', 'last_edited_by', 'null'),
      ('document_revision', 'author_id', 'null'),
      ('claim', 'created_by', 'null'),
      ('claim', 'subject_member_id', 'null'),
      ('contact', 'member_id', 'null'),
      ('contact', 'created_by_member_id', 'null'),
      ('proposed_change', 'assignee_member_id', 'null'),
      ('proposed_change', 'applied_by', 'null'),
      ('campaign', 'owner_member_id', 'null'),
      ('notification', 'actor_id', 'null'),
      ('entity_link', 'created_by', 'null'),
      ('notification', 'recipient_id', 'delete'),
      ('attention_item', 'member_id', 'delete'),
      ('tracked_job', 'member_id', 'delete'),
      ('tool_approval', 'member_id', 'delete'),
      ('lens_finding', 'member_id', 'delete'),
      ('invite', 'invited_by', 'owner'),
      ('share', 'created_by', 'owner'),
      ('contact_share', 'shared_by_member_id', 'owner')
    ) AS v(tbl, col, on_miss)
  LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I t SET %2$I = x.id
        FROM public.member m, public.member x
        WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
          AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id
          AND ($1 IS NULL OR t.workspace_id = $1)
        RETURNING t.id, t.workspace_id, m.id AS old_member, x.id AS new_member)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'member_ref.translated', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
             jsonb_build_object(%4$L, f.old_member), jsonb_build_object(%4$L, f.new_member)
      FROM fixed f
    $q$, r.tbl, r.col, r.tbl, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col || '.translated', n); END IF;

    IF r.on_miss = 'null' THEN
      EXECUTE format($q$
        WITH fixed AS (
          UPDATE public.%1$I t SET %2$I = NULL
          FROM public.member m
          WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
            AND ($1 IS NULL OR t.workspace_id = $1)
          RETURNING t.id, t.workspace_id, m.id AS old_member)
        INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
        SELECT $2, 'member_ref.cleared', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
               jsonb_build_object(%4$L, f.old_member), jsonb_build_object(%4$L, NULL)
        FROM fixed f
      $q$, r.tbl, r.col, r.tbl, r.col) USING p_workspace, v_run;
    ELSIF r.on_miss = 'owner' THEN
      EXECUTE format($q$
        WITH fixed AS (
          UPDATE public.%1$I t SET %2$I = public._wsrepair_owner(t.workspace_id)
          FROM public.member m
          WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
            AND public._wsrepair_owner(t.workspace_id) IS NOT NULL
            AND ($1 IS NULL OR t.workspace_id = $1)
          RETURNING t.id, t.workspace_id, m.id AS old_member, t.%2$I AS new_member)
        INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
        SELECT $2, 'member_ref.reassigned_to_owner', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
               jsonb_build_object(%4$L, f.old_member), jsonb_build_object(%4$L, f.new_member)
        FROM fixed f
      $q$, r.tbl, r.col, r.tbl, r.col) USING p_workspace, v_run;
    ELSE
      EXECUTE format($q$
        WITH gone AS (
          DELETE FROM public.%1$I t
          USING public.member m
          WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
            AND ($1 IS NULL OR t.workspace_id = $1)
          RETURNING t.*)
        INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
        SELECT $2, 'member_ref.row_dropped', %3$L, jsonb_build_object('id', g.id), g.workspace_id, to_jsonb(g), NULL FROM gone g
      $q$, r.tbl, r.col, r.tbl) USING p_workspace, v_run;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col || '.' || CASE r.on_miss WHEN 'null' THEN 'cleared' WHEN 'owner' THEN 'to_owner' ELSE 'dropped' END, n); END IF;
  END LOOP;

  -- document.created_by: translate unless the person already holds the same personal canon key here;
  -- then that key goes (the twin keeps it) and the translation follows; the rest is cleared
  WITH fixed AS (
    UPDATE public.document t SET created_by = x.id
    FROM public.member m, public.member x
    WHERE m.id = t.created_by AND m.workspace_id <> t.workspace_id
      AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id
      AND NOT (t.canon_key ~ '^(person|content-brief):'
               AND EXISTS (SELECT 1 FROM public.document d2 WHERE d2.workspace_id = t.workspace_id AND d2.created_by = x.id AND d2.canon_key = t.canon_key AND d2.id <> t.id))
      AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING t.id, t.workspace_id, m.id AS old_member, x.id AS new_member)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated', 'document', jsonb_build_object('id', id), workspace_id, jsonb_build_object('created_by', old_member), jsonb_build_object('created_by', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document.created_by.translated', n); END IF;
  WITH fixed AS (
    UPDATE public.document t SET created_by = x.id, canon_key = NULL
    FROM public.member m, public.member x
    WHERE m.id = t.created_by AND m.workspace_id <> t.workspace_id
      AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id
      AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING t.id, t.workspace_id, m.id AS old_member, x.id AS new_member)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated_canon_released', 'document', jsonb_build_object('id', id), workspace_id, jsonb_build_object('created_by', old_member), jsonb_build_object('created_by', new_member, 'canon_key', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document.created_by.translated_canon_released', n); END IF;
  WITH fixed AS (
    UPDATE public.document t SET created_by = NULL
    FROM public.member m
    WHERE m.id = t.created_by AND m.workspace_id <> t.workspace_id AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING t.id, t.workspace_id, m.id AS old_member)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.cleared', 'document', jsonb_build_object('id', id), workspace_id, jsonb_build_object('created_by', old_member), jsonb_build_object('created_by', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document.created_by.cleared', n); END IF;

  -- action_assignee (key action_id + member_id; workspace through the action); one row per target key
  WITH fixed AS (
    UPDATE public.action_assignee aa SET member_id = sub.new_member
    FROM (SELECT aa2.action_id, aa2.member_id AS old_member, x.id AS new_member, a.workspace_id,
                 row_number() OVER (PARTITION BY aa2.action_id, x.id ORDER BY aa2.created_at, aa2.member_id) AS rn
          FROM public.action_assignee aa2
          JOIN public.actions a ON a.id = aa2.action_id
          JOIN public.member m ON m.id = aa2.member_id
          JOIN public.member x ON x.workspace_id = a.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> a.workspace_id
            AND NOT EXISTS (SELECT 1 FROM public.action_assignee y WHERE y.action_id = aa2.action_id AND y.member_id = x.id)) sub
    WHERE aa.action_id = sub.action_id AND aa.member_id = sub.old_member AND sub.rn = 1
      AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING aa.action_id, sub.old_member, sub.new_member, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated', 'action_assignee', jsonb_build_object('action_id', action_id, 'member_id', new_member), workspace_id,
         jsonb_build_object('member_id', old_member), jsonb_build_object('member_id', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_assignee.translated', n); END IF;
  WITH gone AS (
    DELETE FROM public.action_assignee aa
    USING public.actions a, public.member m
    WHERE a.id = aa.action_id AND m.id = aa.member_id AND m.workspace_id <> a.workspace_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING aa.action_id, aa.member_id, a.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.row_dropped', 'action_assignee', jsonb_build_object('action_id', action_id, 'member_id', member_id), workspace_id,
         jsonb_build_object('member_id', member_id), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_assignee.dropped', n); END IF;

  -- team_member (workspace through the team); one row per target key
  WITH fixed AS (
    UPDATE public.team_member tm SET member_id = sub.new_member
    FROM (SELECT tm2.id, tm2.member_id AS old_member, x.id AS new_member, t.workspace_id,
                 row_number() OVER (PARTITION BY tm2.team_id, x.id ORDER BY tm2.joined_at, tm2.id) AS rn
          FROM public.team_member tm2
          JOIN public.team t ON t.id = tm2.team_id
          JOIN public.member m ON m.id = tm2.member_id
          JOIN public.member x ON x.workspace_id = t.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> t.workspace_id
            AND NOT EXISTS (SELECT 1 FROM public.team_member y WHERE y.team_id = tm2.team_id AND y.member_id = x.id)) sub
    WHERE tm.id = sub.id AND sub.rn = 1 AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING tm.id, sub.old_member, sub.new_member, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated', 'team_member', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('member_id', old_member), jsonb_build_object('member_id', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('team_member.translated', n); END IF;
  WITH gone AS (
    DELETE FROM public.team_member tm
    USING public.team t, public.member m
    WHERE t.id = tm.team_id AND m.id = tm.member_id AND m.workspace_id <> t.workspace_id
      AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING tm.id, tm.team_id, tm.member_id, tm.team_role, t.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.row_dropped', 'team_member', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('team_id', team_id, 'member_id', member_id, 'team_role', team_role), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('team_member.dropped', n); END IF;

  -- capture_participant.member_id (workspace through the capture); a participant keeps a name (CHECK: member or external_name)
  WITH fixed AS (
    UPDATE public.capture_participant cp
    SET member_id = sub.new_member,
        external_name = CASE WHEN sub.new_member IS NULL THEN COALESCE(cp.external_name, sub.display_name, 'Former member') ELSE cp.external_name END
    FROM (SELECT cp2.id, cp2.member_id AS old_member, x.id AS new_member, c.workspace_id, m.display_name
          FROM public.capture_participant cp2
          JOIN public.captures c ON c.id = cp2.capture_id
          JOIN public.member m ON m.id = cp2.member_id
          LEFT JOIN public.member x ON x.workspace_id = c.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> c.workspace_id) sub
    WHERE cp.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING cp.id, sub.old_member, cp.member_id AS new_member, cp.external_name, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_member IS NULL THEN 'member_ref.cleared' ELSE 'member_ref.translated' END, 'capture_participant',
         jsonb_build_object('id', id), workspace_id, jsonb_build_object('member_id', old_member), jsonb_build_object('member_id', new_member, 'external_name', external_name) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('capture_participant.member', n); END IF;

  -- decision.decided_by (workspace through the capture)
  WITH fixed AS (
    UPDATE public.decision d SET decided_by = sub.new_member
    FROM (SELECT d2.id, d2.decided_by AS old_member, x.id AS new_member, c.workspace_id
          FROM public.decision d2
          JOIN public.captures c ON c.id = d2.capture_id
          JOIN public.member m ON m.id = d2.decided_by
          LEFT JOIN public.member x ON x.workspace_id = c.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> c.workspace_id) sub
    WHERE d.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING d.id, sub.old_member, d.decided_by AS new_member, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_member IS NULL THEN 'member_ref.cleared' ELSE 'member_ref.translated' END, 'decision',
         jsonb_build_object('id', id), workspace_id, jsonb_build_object('decided_by', old_member), jsonb_build_object('decided_by', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('decision.decided_by', n); END IF;

  -- comment.author_id (workspace through the commentable); an untranslatable author keeps the name, as 320 does on departure
  WITH target AS (
    SELECT cm.id AS comment_id, cm.author_id, cm.author_name AS old_name, cm.author_avatar_url AS old_avatar,
           COALESCE(a.workspace_id, c.workspace_id, d.workspace_id, p.workspace_id, ct.workspace_id) AS ws
    FROM public.comment cm
    LEFT JOIN public.actions a ON cm.commentable_type = 'action' AND a.id = cm.commentable_id
    LEFT JOIN public.captures c ON cm.commentable_type = 'capture' AND c.id = cm.commentable_id
    LEFT JOIN public.document d ON cm.commentable_type = 'document' AND d.id = cm.commentable_id
    LEFT JOIN public.projects p ON cm.commentable_type = 'project' AND p.id = cm.commentable_id
    LEFT JOIN public.contact ct ON cm.commentable_type = 'contact' AND ct.id = cm.commentable_id
    WHERE cm.author_id IS NOT NULL
  ),
  fixed AS (
    UPDATE public.comment cm
    SET author_id = x.id,
        author_name = CASE WHEN x.id IS NULL THEN COALESCE(cm.author_name, m.display_name) ELSE cm.author_name END,
        author_avatar_url = CASE WHEN x.id IS NULL THEN COALESCE(cm.author_avatar_url, m.avatar_url) ELSE cm.author_avatar_url END
    FROM target tg
    JOIN public.member m ON m.id = tg.author_id
    LEFT JOIN public.member x ON x.user_id = m.user_id AND x.workspace_id = tg.ws
    WHERE cm.id = tg.comment_id AND tg.ws IS NOT NULL AND m.workspace_id <> tg.ws
      AND (p_workspace IS NULL OR tg.ws = p_workspace)
    RETURNING cm.id, m.id AS old_member, cm.author_id AS new_member, tg.old_name, tg.old_avatar, cm.author_name, cm.author_avatar_url, tg.ws)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_member IS NULL THEN 'member_ref.cleared' ELSE 'member_ref.translated' END, 'comment',
         jsonb_build_object('id', id), ws,
         jsonb_build_object('author_id', old_member, 'author_name', old_name, 'author_avatar_url', old_avatar),
         jsonb_build_object('author_id', new_member, 'author_name', author_name, 'author_avatar_url', author_avatar_url) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('comment.author', n); END IF;

  -- shares addressed to a member of another workspace (unique per contact / package): one row per target key, the rest dropped
  FOR r IN SELECT * FROM (VALUES ('contact_share', 'contact_id'), ('knowledge_package_share', 'package_id')) AS v(tbl, scope_col) LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I s SET shared_with_member_id = sub.new_member
        FROM (SELECT s2.id, s2.shared_with_member_id AS old_member, x.id AS new_member, s2.workspace_id,
                     row_number() OVER (PARTITION BY s2.%2$I, x.id ORDER BY s2.created_at, s2.id) AS rn
              FROM public.%1$I s2
              JOIN public.member m ON m.id = s2.shared_with_member_id
              JOIN public.member x ON x.workspace_id = s2.workspace_id AND x.user_id = m.user_id
              WHERE m.workspace_id <> s2.workspace_id
                AND NOT EXISTS (SELECT 1 FROM public.%1$I y WHERE y.%2$I = s2.%2$I AND y.shared_with_member_id = x.id)) sub
        WHERE s.id = sub.id AND sub.rn = 1 AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING s.id, sub.workspace_id, sub.old_member, sub.new_member)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'member_ref.translated', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
             jsonb_build_object('shared_with_member_id', f.old_member), jsonb_build_object('shared_with_member_id', f.new_member) FROM fixed f
    $q$, r.tbl, r.scope_col, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.shared_with.translated', n); END IF;
    EXECUTE format($q$
      WITH gone AS (
        DELETE FROM public.%1$I s USING public.member m
        WHERE m.id = s.shared_with_member_id AND m.workspace_id <> s.workspace_id AND ($1 IS NULL OR s.workspace_id = $1)
        RETURNING s.*)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'member_ref.row_dropped', %2$L, jsonb_build_object('id', g.id), g.workspace_id, to_jsonb(g), NULL FROM gone g
    $q$, r.tbl, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.shared_with.dropped', n); END IF;
  END LOOP;

  -- ══ 3. team pointers ════════════════════════════════════════════════════════
  -- an action on another workspace's team: its own workspace's first team (222's trigger remaps the status; old status logged)
  WITH fixed AS (
    UPDATE public.actions a SET team_id = sub.new_team
    FROM (SELECT a2.id, a2.workspace_id, a2.team_id AS old_team, a2.status_id AS old_status, public._wsrepair_first_team(a2.workspace_id) AS new_team
          FROM public.actions a2 JOIN public.team t ON t.id = a2.team_id
          WHERE t.workspace_id <> a2.workspace_id) sub
    WHERE a.id = sub.id AND sub.new_team IS NOT NULL AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING a.id, sub.workspace_id, sub.old_team, sub.old_status, a.team_id AS new_team, a.status_id AS new_status)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'team_ref.refiled', 'actions', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('team_id', old_team, 'status_id', old_status), jsonb_build_object('team_id', new_team, 'status_id', new_status) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.team.refiled', n); END IF;
  -- a teammate on another workspace's team
  WITH fixed AS (
    UPDATE public.ai_team_member a SET team_id = public._wsrepair_first_team(a.workspace_id)
    FROM public.team t
    WHERE t.id = a.team_id AND t.workspace_id <> a.workspace_id
      AND public._wsrepair_first_team(a.workspace_id) IS NOT NULL
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING a.id, a.workspace_id, t.id AS old_team, a.team_id AS new_team)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'team_ref.refiled', 'ai_team_member', jsonb_build_object('id', id), workspace_id, jsonb_build_object('team_id', old_team), jsonb_build_object('team_id', new_team) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('ai_team_member.team.refiled', n); END IF;
  -- nullable team pointers into another workspace: cleared
  FOR r IN SELECT * FROM (VALUES ('captures'), ('document'), ('proposed_change'), ('knowledge_package'), ('flow'), ('view')) AS v(tbl) LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I x SET team_id = NULL
        FROM public.team t
        WHERE t.id = x.team_id AND t.workspace_id <> x.workspace_id
          AND ($1 IS NULL OR x.workspace_id = $1)
        RETURNING x.id, x.workspace_id, t.id AS old_team)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'team_ref.cleared', %2$L, jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object('team_id', f.old_team), jsonb_build_object('team_id', NULL) FROM fixed f
    $q$, r.tbl, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.team.cleared', n); END IF;
  END LOOP;
  -- a cycle from another team (after the refile above)
  WITH fixed AS (
    UPDATE public.actions a SET cycle_id = NULL
    FROM public.cycle cy
    WHERE cy.id = a.cycle_id AND cy.team_id <> a.team_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING a.id, a.workspace_id, cy.id AS old_cycle)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'actions', jsonb_build_object('id', id), workspace_id, jsonb_build_object('cycle_id', old_cycle), jsonb_build_object('cycle_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.cycle.cleared', n); END IF;
  -- team shares into another workspace's team
  FOR r IN SELECT * FROM (VALUES ('contact_share'), ('knowledge_package_share')) AS v(tbl) LOOP
    EXECUTE format($q$
      WITH gone AS (
        DELETE FROM public.%1$I s USING public.team t
        WHERE t.id = s.shared_with_team_id AND t.workspace_id <> s.workspace_id
          AND ($1 IS NULL OR s.workspace_id = $1)
        RETURNING s.*)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'team_ref.row_dropped', %2$L, jsonb_build_object('id', g.id), g.workspace_id, to_jsonb(g), NULL FROM gone g
    $q$, r.tbl, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.shared_with_team.dropped', n); END IF;
  END LOOP;

  -- ══ 4. pointers across workspaces ═══════════════════════════════════════════
  -- mail copies first: the sibling copy in the entity's workspace takes a link where it has none (logged), then the copy's own link is cleared
  FOR r IN SELECT * FROM (VALUES
      ('linked_action_id', 'actions'), ('linked_capture_id', 'captures'), ('linked_project_id', 'projects')
    ) AS v(col, target)
  LOOP
    EXECUTE format($q$
      WITH moved AS (
        UPDATE public.email_thread_index s SET %1$I = e.%1$I
        FROM public.email_thread_index e
        JOIN public.%2$I tg ON tg.id = e.%1$I
        WHERE tg.workspace_id <> e.workspace_id
          AND s.workspace_id = tg.workspace_id AND s.provider_thread_id = e.provider_thread_id
          AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND s.%1$I IS NULL
          AND ($1 IS NULL OR e.workspace_id = $1)
        RETURNING s.id, s.workspace_id, e.id AS from_copy, s.%1$I AS link)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'mail_link.sibling_took_link', 'email_thread_index', jsonb_build_object('id', mv.id), mv.workspace_id,
             jsonb_build_object(%3$L, NULL, 'from_copy', mv.from_copy), jsonb_build_object(%3$L, mv.link) FROM moved mv
    $q$, r.col, r.target, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.' || r.col || '.sibling_took_link', n); END IF;
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.email_thread_index e SET %1$I = NULL
        FROM (SELECT e2.id, tg.id AS old_target, e2.workspace_id,
                     EXISTS (SELECT 1 FROM public.email_thread_index s WHERE s.workspace_id = tg.workspace_id AND s.provider_thread_id = e2.provider_thread_id
                             AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e2.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
                             AND s.%1$I = tg.id) AS sibling_has
              FROM public.email_thread_index e2 JOIN public.%2$I tg ON tg.id = e2.%1$I
              WHERE tg.workspace_id <> e2.workspace_id) sub
        WHERE e.id = sub.id AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING e.id, sub.workspace_id, sub.old_target, sub.sibling_has)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, CASE WHEN f.sibling_has THEN 'mail_link.moved_to_sibling' ELSE 'mail_link.cleared' END, 'email_thread_index',
             jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object(%3$L, f.old_target), jsonb_build_object(%3$L, NULL) FROM fixed f
    $q$, r.col, r.target, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.' || r.col || '.cleared', n); END IF;
  END LOOP;
  -- a mail copy linking another workspace's contact: sibling takes it (logged), then re-point locally by email, else clear
  WITH moved AS (
    UPDATE public.email_thread_index s SET linked_contact_id = e.linked_contact_id
    FROM public.email_thread_index e JOIN public.contact ct ON ct.id = e.linked_contact_id
    WHERE ct.workspace_id <> e.workspace_id
      AND s.workspace_id = ct.workspace_id AND s.provider_thread_id = e.provider_thread_id
      AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND s.linked_contact_id IS NULL
      AND (p_workspace IS NULL OR e.workspace_id = p_workspace)
    RETURNING s.id, s.workspace_id, e.id AS from_copy, s.linked_contact_id AS link)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'mail_link.sibling_took_link', 'email_thread_index', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('linked_contact_id', NULL, 'from_copy', from_copy), jsonb_build_object('linked_contact_id', link) FROM moved;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.linked_contact_id.sibling_took_link', n); END IF;
  WITH fixed AS (
    UPDATE public.email_thread_index e SET linked_contact_id = sub.new_target
    FROM (SELECT e2.id, ct.id AS old_target, e2.workspace_id,
                 (SELECT c2.id FROM public.contact c2 WHERE c2.workspace_id = e2.workspace_id AND c2.email IS NOT NULL
                   AND lower(c2.email) = lower(ct.email) AND c2.merged_into_contact_id IS NULL ORDER BY c2.created_at LIMIT 1) AS new_target,
                 EXISTS (SELECT 1 FROM public.email_thread_index s WHERE s.workspace_id = ct.workspace_id AND s.provider_thread_id = e2.provider_thread_id
                         AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e2.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
                         AND s.linked_contact_id = ct.id) AS sibling_has
          FROM public.email_thread_index e2 JOIN public.contact ct ON ct.id = e2.linked_contact_id
          WHERE ct.workspace_id <> e2.workspace_id) sub
    WHERE e.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING e.id, sub.workspace_id, sub.old_target, sub.new_target, sub.sibling_has)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NOT NULL THEN 'mail_link.relinked_by_email' WHEN sibling_has THEN 'mail_link.moved_to_sibling' ELSE 'mail_link.cleared' END,
         'email_thread_index', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('linked_contact_id', old_target), jsonb_build_object('linked_contact_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.linked_contact_id', n); END IF;

  -- pointers nothing can resolve: cut
  FOR r IN SELECT * FROM (VALUES
      ('actions', 'project_id', 'projects'),
      ('actions', 'parent_id', 'actions'),
      ('actions', 'source_capture_id', 'captures'),
      ('actions', 'assignee_ai_member_id', 'ai_team_member'),
      ('projects', 'initiative_id', 'initiative'),
      ('projects', 'parent_project_id', 'projects'),
      ('captures', 'project_id', 'projects'),
      ('document', 'project_id', 'projects'),
      ('chat_conversations', 'capture_id', 'captures'),
      ('chat_conversations', 'ai_team_member_id', 'ai_team_member'),
      ('flow', 'ai_team_member_id', 'ai_team_member')
    ) AS v(tbl, col, target)
  LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I x SET %2$I = NULL
        FROM public.%3$I tg
        WHERE tg.id = x.%2$I AND tg.workspace_id <> x.workspace_id
          AND ($1 IS NULL OR x.workspace_id = $1)
        RETURNING x.id, x.workspace_id, tg.id AS old_target)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'pointer.cleared', %4$L, jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object(%5$L, f.old_target), jsonb_build_object(%5$L, NULL) FROM fixed f
    $q$, r.tbl, r.col, r.target, r.tbl, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col || '.cleared', n); END IF;
  END LOOP;
  -- actions.milestone_id (through the milestone's project)
  WITH fixed AS (
    UPDATE public.actions a SET milestone_id = NULL
    FROM public.milestone ms JOIN public.projects p ON p.id = ms.project_id
    WHERE ms.id = a.milestone_id AND p.workspace_id <> a.workspace_id AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING a.id, a.workspace_id, ms.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'actions', jsonb_build_object('id', id), workspace_id, jsonb_build_object('milestone_id', old_target), jsonb_build_object('milestone_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.milestone_id.cleared', n); END IF;
  -- decision.project_id (workspace through the capture)
  WITH fixed AS (
    UPDATE public.decision d SET project_id = NULL
    FROM public.captures c, public.projects p
    WHERE c.id = d.capture_id AND p.id = d.project_id AND p.workspace_id <> c.workspace_id AND (p_workspace IS NULL OR c.workspace_id = p_workspace)
    RETURNING d.id, c.workspace_id, p.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'decision', jsonb_build_object('id', id), workspace_id, jsonb_build_object('project_id', old_target), jsonb_build_object('project_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('decision.project_id.cleared', n); END IF;

  -- contact pointers: re-point by email in the row's workspace, else clear
  WITH fixed AS (
    UPDATE public.actions a SET assignee_contact_id = sub.new_target
    FROM (SELECT a2.id, ct.id AS old_target, a2.workspace_id,
                 (SELECT c2.id FROM public.contact c2 WHERE c2.workspace_id = a2.workspace_id AND c2.email IS NOT NULL
                   AND lower(c2.email) = lower(ct.email) AND c2.merged_into_contact_id IS NULL ORDER BY c2.created_at LIMIT 1) AS new_target
          FROM public.actions a2 JOIN public.contact ct ON ct.id = a2.assignee_contact_id
          WHERE ct.workspace_id <> a2.workspace_id) sub
    WHERE a.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING a.id, sub.workspace_id, sub.old_target, sub.new_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NULL THEN 'pointer.cleared' ELSE 'pointer.relinked_by_email' END, 'actions', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('assignee_contact_id', old_target), jsonb_build_object('assignee_contact_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.assignee_contact', n); END IF;

  WITH fixed AS (
    UPDATE public.capture_participant cp SET contact_id = sub.new_target
    FROM (SELECT cp2.id, ct.id AS old_target, c.workspace_id,
                 (SELECT c2.id FROM public.contact c2 WHERE c2.workspace_id = c.workspace_id AND c2.email IS NOT NULL
                   AND lower(c2.email) = lower(ct.email) AND c2.merged_into_contact_id IS NULL ORDER BY c2.created_at LIMIT 1) AS new_target
          FROM public.capture_participant cp2
          JOIN public.captures c ON c.id = cp2.capture_id
          JOIN public.contact ct ON ct.id = cp2.contact_id
          WHERE ct.workspace_id <> c.workspace_id) sub
    WHERE cp.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING cp.id, sub.workspace_id, sub.old_target, sub.new_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NULL THEN 'pointer.cleared' ELSE 'pointer.relinked_by_email' END, 'capture_participant', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('contact_id', old_target), jsonb_build_object('contact_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('capture_participant.contact', n); END IF;

  -- company pointers: re-point by domain, else clear
  WITH fixed AS (
    UPDATE public.contact c SET company_id = sub.new_target
    FROM (SELECT c1.id, co.id AS old_target, c1.workspace_id,
                 (SELECT c2.id FROM public.company c2 WHERE c2.workspace_id = c1.workspace_id AND COALESCE(c2.domain, '') <> ''
                   AND lower(c2.domain) = lower(co.domain) ORDER BY c2.created_at LIMIT 1) AS new_target
          FROM public.contact c1 JOIN public.company co ON co.id = c1.company_id
          WHERE co.workspace_id <> c1.workspace_id) sub
    WHERE c.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING c.id, sub.workspace_id, sub.old_target, sub.new_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NULL THEN 'pointer.cleared' ELSE 'pointer.relinked_by_domain' END, 'contact', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('company_id', old_target), jsonb_build_object('company_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('contact.company', n); END IF;

  -- ══ 5. labels, shares, edges, pins ══════════════════════════════════════════
  FOR r IN SELECT * FROM (VALUES
      ('action_label', 'action_id', 'actions'), ('capture_label', 'capture_id', 'captures'),
      ('project_label', 'project_id', 'projects'), ('initiative_label', 'initiative_id', 'initiative'),
      ('email_thread_label', 'thread_id', 'email_thread_index')
    ) AS v(junction, col, parent)
  LOOP
    -- the same-named label in the entity's workspace; one junction row per target label, the rest dropped below
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I j SET label_id = sub.new_label
        FROM (SELECT j2.%2$I AS entity_id, j2.label_id AS old_label, loc.id AS new_label, e.workspace_id,
                     row_number() OVER (PARTITION BY j2.%2$I, loc.id ORDER BY l.created_at, l.id) AS rn
              FROM public.%1$I j2
              JOIN public.%3$I e ON e.id = j2.%2$I
              JOIN public.label l ON l.id = j2.label_id
              JOIN LATERAL (SELECT l2.id FROM public.label l2 WHERE l2.workspace_id = e.workspace_id AND lower(l2.name) = lower(l.name) ORDER BY l2.created_at LIMIT 1) loc ON true
              WHERE l.workspace_id <> e.workspace_id
                AND NOT EXISTS (SELECT 1 FROM public.%1$I x WHERE x.%2$I = j2.%2$I AND x.label_id = loc.id)) sub
        WHERE j.%2$I = sub.entity_id AND j.label_id = sub.old_label AND sub.rn = 1
          AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING j.%2$I AS entity_id, sub.old_label, sub.new_label, sub.workspace_id)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'label_junction.repointed', %4$L, jsonb_build_object(%5$L, f.entity_id, 'label_id', f.new_label), f.workspace_id,
             jsonb_build_object('label_id', f.old_label), jsonb_build_object('label_id', f.new_label) FROM fixed f
    $q$, r.junction, r.col, r.parent, r.junction, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.junction || '.repointed', n); END IF;
    EXECUTE format($q$
      WITH gone AS (
        DELETE FROM public.%1$I j USING public.%3$I e, public.label l
        WHERE e.id = j.%2$I AND l.id = j.label_id AND l.workspace_id <> e.workspace_id
          AND ($1 IS NULL OR e.workspace_id = $1)
        RETURNING j.%2$I AS entity_id, j.label_id, e.workspace_id)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'label_junction.dropped', %4$L, jsonb_build_object(%5$L, g.entity_id, 'label_id', g.label_id), g.workspace_id, jsonb_build_object('label_id', g.label_id), NULL FROM gone g
    $q$, r.junction, r.col, r.parent, r.junction, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.junction || '.dropped', n); END IF;
  END LOOP;

  -- a share on another workspace's entity: deactivated (221's rule), never deleted
  WITH fixed AS (
    UPDATE public.share s SET is_active = false
    FROM (SELECT s2.id FROM public.share s2
          LEFT JOIN public.captures c ON c.id = s2.shareable_id AND s2.shareable_type = 'capture'
          LEFT JOIN public.document d ON d.id = s2.shareable_id AND s2.shareable_type = 'document'
          WHERE s2.is_active AND COALESCE(c.workspace_id, d.workspace_id) <> s2.workspace_id) bad
    WHERE s.id = bad.id AND (p_workspace IS NULL OR s.workspace_id = p_workspace)
    RETURNING s.id, s.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'share.deactivated', 'share', jsonb_build_object('id', id), workspace_id, jsonb_build_object('is_active', true), jsonb_build_object('is_active', false) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('share.deactivated', n); END IF;

  -- edges with an end outside their workspace
  WITH gone AS (
    DELETE FROM public.entity_link l
    WHERE (p_workspace IS NULL OR l.workspace_id = p_workspace) AND (
         EXISTS (SELECT 1 FROM public.actions a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.document a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.company a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id))
    RETURNING l.*)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'edge.dropped', 'entity_link', jsonb_build_object('id', id), workspace_id, to_jsonb(g), NULL FROM gone g;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('entity_link.dropped', n); END IF;

  -- pins on another workspace's entity
  WITH gone AS (
    DELETE FROM public.knowledge_package_item i
    WHERE (p_workspace IS NULL OR i.workspace_id = p_workspace) AND (
         EXISTS (SELECT 1 FROM public.actions a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id))
    RETURNING i.*)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pin.dropped', 'knowledge_package_item', jsonb_build_object('package_id', package_id, 'entity_type', entity_type, 'entity_id', entity_id), workspace_id, to_jsonb(g), NULL FROM gone g;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('knowledge_package_item.dropped', n); END IF;

  -- action relations and action-document links with ends in different workspaces
  WITH gone AS (
    DELETE FROM public.action_relation ar USING public.actions a, public.actions b
    WHERE a.id = ar.action_id AND b.id = ar.related_action_id AND a.workspace_id <> b.workspace_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace OR b.workspace_id = p_workspace)
    RETURNING ar.id, ar.action_id, ar.related_action_id, ar.type, a.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'edge.dropped', 'action_relation', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('action_id', action_id, 'related_action_id', related_action_id, 'type', type), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_relation.dropped', n); END IF;
  WITH gone AS (
    DELETE FROM public.action_document ad USING public.actions a, public.document d
    WHERE a.id = ad.action_id AND d.id = ad.document_id AND a.workspace_id <> d.workspace_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace OR d.workspace_id = p_workspace)
    RETURNING ad.id, ad.action_id, ad.document_id, a.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'edge.dropped', 'action_document', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('action_id', action_id, 'document_id', document_id), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_document.dropped', n); END IF;

  -- ══ 6. deals (DEV only today) ═══════════════════════════════════════════════
  IF to_regclass('public.deal') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'deal' AND column_name = 'team_id') THEN
    EXECUTE $q$
      WITH fixed AS (
        UPDATE public.deal d SET team_id = sub.new_team, status_id = sub.new_status
        FROM (SELECT d2.id, d2.workspace_id, d2.team_id AS old_team, d2.status_id AS old_status,
                     public._wsrepair_first_team(d2.workspace_id) AS new_team,
                     (SELECT ws.id FROM public.workflow_state ws WHERE ws.team_id = public._wsrepair_first_team(d2.workspace_id) AND ws.is_default ORDER BY ws.sort_order, ws.id LIMIT 1) AS new_status
              FROM public.deal d2 JOIN public.team t ON t.id = d2.team_id
              WHERE t.workspace_id <> d2.workspace_id) sub
        WHERE d.id = sub.id AND sub.new_team IS NOT NULL AND sub.new_status IS NOT NULL
          AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING d.id, sub.workspace_id, sub.old_team, sub.old_status, d.team_id AS new_team, d.status_id AS new_status)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'team_ref.refiled', 'deal', jsonb_build_object('id', f.id), f.workspace_id,
             jsonb_build_object('team_id', f.old_team, 'status_id', f.old_status), jsonb_build_object('team_id', f.new_team, 'status_id', f.new_status) FROM fixed f
    $q$ USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('deal.team.refiled', n); END IF;
    -- a deal whose status belongs to another team: the deal's team's default
    EXECUTE $q$
      WITH fixed AS (
        UPDATE public.deal d SET status_id = sub.new_status
        FROM (SELECT d2.id, d2.workspace_id, d2.status_id AS old_status,
                     (SELECT ws.id FROM public.workflow_state ws WHERE ws.team_id = d2.team_id AND ws.is_default ORDER BY ws.sort_order, ws.id LIMIT 1) AS new_status
              FROM public.deal d2 JOIN public.workflow_state s ON s.id = d2.status_id
              WHERE s.team_id <> d2.team_id) sub
        WHERE d.id = sub.id AND sub.new_status IS NOT NULL AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING d.id, sub.workspace_id, sub.old_status, d.status_id AS new_status)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'status.remapped', 'deal', jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object('status_id', f.old_status), jsonb_build_object('status_id', f.new_status) FROM fixed f
    $q$ USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('deal.status.remapped', n); END IF;
  END IF;

  -- ══ what the sweep still flags, in every workspace this run touched ═════════
  SELECT COALESCE(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'check', s.check_name, 'violations', s.violations)), '[]'::jsonb)
  INTO v_remaining
  FROM public.workspace w CROSS JOIN LATERAL public.workspace_integrity_sweep(w.id) s
  WHERE p_workspace IS NULL
     OR w.id = p_workspace
     OR w.id IN (SELECT DISTINCT lg.workspace_id FROM public.workspace_repair_log lg WHERE lg.run_id = v_run AND lg.workspace_id IS NOT NULL);

  RETURN jsonb_build_object('run_id', v_run, 'repaired', v_out,
                            'rows_logged', (SELECT count(*) FROM public.workspace_repair_log WHERE run_id = v_run),
                            'remaining', v_remaining);
END;
$$;

-- ------------------------------------------------------------
-- 10. A contact merge (132, the CRM's dedup) carries deals along
-- ------------------------------------------------------------
-- merge_contacts records what it moves in contact_merge.moved and
-- unmerge_contacts moves exactly that back. Rather than copy both, two
-- triggers on contact_merge do the deals' part: on the merge row's insert,
-- each deal on the merged-away contact points at the survivor instead (a deal
-- that already has the survivor just drops the loser), and the deal ids go
-- into `moved` (deal_ids, deal_ids_had_target); when the merge is undone
-- (undone_at set), those deals get the restored contact back.

create or replace function public.contact_merge_move_deals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_repointed jsonb;
  v_had_target jsonb;
begin
  if new.source_contact_id is null or new.target_contact_id is null then
    return new;
  end if;

  select coalesce(jsonb_agg(id) filter (where not (contact_ids @> array[new.target_contact_id])), '[]'::jsonb),
         coalesce(jsonb_agg(id) filter (where contact_ids @> array[new.target_contact_id]), '[]'::jsonb)
    into v_repointed, v_had_target
    from public.deal
   where contact_ids @> array[new.source_contact_id];

  -- The survivor takes the loser's place; where it is on the deal already,
  -- the loser just goes.
  update public.deal
     set contact_ids = case
           when contact_ids @> array[new.target_contact_id] then array_remove(contact_ids, new.source_contact_id)
           else array_replace(contact_ids, new.source_contact_id, new.target_contact_id)
         end
   where contact_ids @> array[new.source_contact_id];

  new.moved := coalesce(new.moved, '{}'::jsonb)
    || jsonb_build_object('deal_ids', v_repointed, 'deal_ids_had_target', v_had_target);
  return new;
end;
$$;

revoke all on function public.contact_merge_move_deals() from public, anon, authenticated;

drop trigger if exists contact_merge_move_deals on public.contact_merge;
create trigger contact_merge_move_deals
  before insert on public.contact_merge
  for each row execute function public.contact_merge_move_deals();

create or replace function public.contact_unmerge_restore_deals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_repointed uuid[];
  v_had_target uuid[];
begin
  if old.undone_at is not null or new.undone_at is null
     or new.source_contact_id is null or new.target_contact_id is null then
    return new;
  end if;
  v_repointed := array(select (jsonb_array_elements_text(coalesce(new.moved->'deal_ids', '[]'::jsonb)))::uuid);
  v_had_target := array(select (jsonb_array_elements_text(coalesce(new.moved->'deal_ids_had_target', '[]'::jsonb)))::uuid);

  -- Repointed deals: the survivor hands the place back.
  update public.deal
     set contact_ids = case
           when contact_ids @> array[new.source_contact_id] then array_remove(contact_ids, new.target_contact_id)
           else array_replace(contact_ids, new.target_contact_id, new.source_contact_id)
         end
   where id = any(v_repointed) and contact_ids @> array[new.target_contact_id];
  -- Deals that had both: the restored contact comes back beside the survivor.
  update public.deal
     set contact_ids = array_append(contact_ids, new.source_contact_id)
   where id = any(v_had_target) and not (contact_ids @> array[new.source_contact_id]);
  return new;
end;
$$;

revoke all on function public.contact_unmerge_restore_deals() from public, anon, authenticated;

drop trigger if exists contact_unmerge_restore_deals on public.contact_merge;
create trigger contact_unmerge_restore_deals
  after update of undone_at on public.contact_merge
  for each row execute function public.contact_unmerge_restore_deals();
