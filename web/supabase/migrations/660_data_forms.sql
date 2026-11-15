-- ============================================================
-- 660: Forms (phase 1): a public front door on a table.
-- ============================================================
-- A form takes a submission from someone outside the workspace and writes
-- it as ONE new row of ONE table (src/lib/forms/). Its link can do nothing
-- else: it never reads, edits or deletes a row, and it fills only the
-- columns the form lists.
--
--   1. data_form            one form: its table, the fields it takes (the
--                           row's name and a list of the table's columns,
--                           each with its label and whether it is required),
--                           who may submit (anyone holding the link, or the
--                           workspace's signed-in members), the websites
--                           whose browsers may post, the thank-you line, and
--                           the link's secret as its SHA-256 only. created_by
--                           is who its rows are written as: a submission goes
--                           through apply_data_ops as that person, so it
--                           stops when they can no longer change the table.
--   2. data_form_attempt    one row per submission a form's link tried,
--                           counted for the caps (per form, and per sender as
--                           a keyed hash of their address, never the address),
--                           and the form's own submission id when it sent
--                           one, so a re-posted submission is stored once.
--   3. data_row.from_form   true on a row a form wrote: its text is a
--                           stranger's, so the agent reads it inside the
--                           untrusted fence. Stamped in the row's own insert
--                           (a trigger reading the batch's source), so a row
--                           never exists without it.
--   4. source 'form'        data_change.source and apply_data_ops (540's,
--                           otherwise unchanged) take it.
--   5. trigger 'record_created'  flow.trigger_type takes it (forms phase 2):
--                           a loop that starts when a row is added to one
--                           table, by a form's submission or by a person.
--
-- RLS on, and only the service role reads or writes the two new tables
-- (every reader is on the server; a client must never see key_hash).
-- Re-runnable.
--
-- Must run on PROD before the app code that reads it deploys: every read of
-- a table's rows selects data_row.from_form.
--
-- Apply in a quiet moment. The new tables' foreign keys take a brief SHARE
-- ROW EXCLUSIVE lock on data_table and workspace (reads pass, writes wait),
-- and the new column and the trigger a brief exclusive one on data_row; a
-- table write in flight at that instant can deadlock with the file, and
-- Postgres then stops one of the two. Each statement waits at most 5 s for
-- its lock; one that waits longer rolls the whole file back, and it can
-- simply be applied again.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. data_form
-- ------------------------------------------------------------

create table if not exists public.data_form (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  table_id uuid not null references public.data_table(id) on delete cascade,
  name text not null,
  fields jsonb not null default '[]'::jsonb,
  access text not null default 'public',
  allowed_origins text[] not null default '{}',
  thanks text null,
  active boolean not null default true,
  key_hash text not null,
  key_prefix text not null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_submitted_at timestamptz null
);

comment on table public.data_form is
  'A form (660): a public link that writes one new row of its table per submission, and nothing else. Service role only.';
comment on column public.data_form.fields is
  'What a submission may fill, in order: [{key, label, required}]. key is a column''s key, or "$title" for the row''s name. Anything else posted is dropped.';
comment on column public.data_form.access is
  'public: anyone holding the link. members: only a signed-in member of the workspace.';
comment on column public.data_form.allowed_origins is
  'Browser origins allowed to post (CORS). Empty: any site may (the link is the gate).';
comment on column public.data_form.key_hash is
  'SHA-256 of the secret in the form''s link. The secret itself is shown once and never stored.';
comment on column public.data_form.created_by is
  'Who its rows are written as. Null (their account is gone): the form takes nothing until someone makes its link again.';

alter table public.data_form drop constraint if exists data_form_name_length;
alter table public.data_form
  add constraint data_form_name_length check (char_length(name) between 1 and 200);
alter table public.data_form drop constraint if exists data_form_access_check;
alter table public.data_form
  add constraint data_form_access_check check (access in ('public', 'members'));
alter table public.data_form drop constraint if exists data_form_fields_list;
alter table public.data_form
  add constraint data_form_fields_list check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 40);
alter table public.data_form drop constraint if exists data_form_thanks_length;
alter table public.data_form
  add constraint data_form_thanks_length check (thanks is null or char_length(thanks) <= 500);
alter table public.data_form drop constraint if exists data_form_origins_count;
alter table public.data_form
  add constraint data_form_origins_count check (coalesce(array_length(allowed_origins, 1), 0) <= 10);

create unique index if not exists data_form_key_hash_key on public.data_form (key_hash);
create index if not exists data_form_table_idx on public.data_form (table_id);
create index if not exists data_form_workspace_idx on public.data_form (workspace_id);

-- ------------------------------------------------------------
-- 2. data_form_attempt
-- ------------------------------------------------------------

create table if not exists public.data_form_attempt (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.data_form(id) on delete cascade,
  client_hash text null,
  external_id text null,
  row_id uuid null,
  stored_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.data_form_attempt is
  'A submission a form''s link tried (660), counted to cap the form: per form, and per sender. Service role only.';
comment on column public.data_form_attempt.client_hash is
  'Who tried: a keyed hash of the sender''s address (never the address), so one stranger''s tries count against them, not the form.';
comment on column public.data_form_attempt.external_id is
  'The form''s own submission id, when it sent one: the same id from the same sender is stored once.';
comment on column public.data_form_attempt.row_id is
  'The row this try was to write (its id is chosen before the write); stored_at says it was written.';

alter table public.data_form_attempt drop constraint if exists data_form_attempt_external_id_length;
alter table public.data_form_attempt
  add constraint data_form_attempt_external_id_length check (external_id is null or char_length(external_id) between 1 and 120);

create index if not exists data_form_attempt_form_idx on public.data_form_attempt (form_id, created_at);
create index if not exists data_form_attempt_client_idx on public.data_form_attempt (client_hash, created_at) where client_hash is not null;
-- One sender's submission id is one row. Another sender's same id is a new
-- one: a guessed id never swallows someone else's submission.
create unique index if not exists data_form_attempt_external_key
  on public.data_form_attempt (form_id, coalesce(client_hash, ''), external_id) where external_id is not null;

alter table public.data_form enable row level security;
alter table public.data_form_attempt enable row level security;
revoke all on table public.data_form from anon, authenticated;
revoke all on table public.data_form_attempt from anon, authenticated;
grant all on table public.data_form to service_role;
grant all on table public.data_form_attempt to service_role;

-- ------------------------------------------------------------
-- 3. data_row.from_form
-- ------------------------------------------------------------

alter table public.data_row add column if not exists from_form boolean not null default false;

comment on column public.data_row.from_form is
  'A form wrote this row (660): its text is a stranger''s, read by the agents only as untrusted data. Set by the insert itself, never by a writer.';

-- apply_data_ops sets dial8.data_source for its transaction (520). A row a
-- form's batch inserts is marked here, in the same statement that makes it;
-- no other writer can set the mark, and none can clear it.
create or replace function public.data_row_mark_from_form()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.from_form := coalesce(current_setting('dial8.data_source', true), '') = 'form';
  else
    new.from_form := old.from_form;
  end if;
  return new;
end;
$$;

-- Replaced in place, never dropped first: a drop would take an ACCESS
-- EXCLUSIVE lock on data_row, which holds its reads too.
create or replace trigger data_row_mark_from_form
  before insert or update on public.data_row
  for each row execute function public.data_row_mark_from_form();

-- ------------------------------------------------------------
-- 4. Source 'form'
-- ------------------------------------------------------------

-- Added without a scan, then validated on its own: the validation reads
-- every change while writes go on, where a plain add would hold them all.
alter table public.data_change drop constraint if exists data_change_source_check;
alter table public.data_change
  add constraint data_change_source_check check (source in ('person', 'agent', 'import', 'email', 'capture', 'sms', 'form')) not valid;
alter table public.data_change validate constraint data_change_source_check;

-- 540's apply_data_ops, with 'form' among the sources it takes. Nothing else
-- changes; the signature is the same, so this replaces it in place.
create or replace function public.apply_data_ops(
  p_table_id uuid,
  p_base_version bigint,
  p_ops jsonb,
  p_source text default 'person',
  p_reason text default null,
  p_undo_of uuid default null,
  p_as_user uuid default null,
  p_grants boolean default true,
  p_source_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  t public.data_table%rowtype;
  v_member uuid;
  v_result jsonb;
  v_undone public.data_change%rowtype;
  v_version bigint;
  v_change uuid;
begin
  if v_user is null then
    raise exception 'apply_data_ops: no user' using errcode = '42501';
  end if;
  -- The lock serializes batches on one table: the version check below is exact.
  select * into t from public.data_table where id = p_table_id for update;
  -- Without grants (a guest's or a linked agent's turn), a table the writer
  -- reads only through a grant is not there for them.
  if not found
     or not public.data_table_visible_to(t.id, v_user)
     or (p_grants is false and not public.data_table_visible_ungranted(t.id, v_user)) then
    raise exception 'table not found' using errcode = 'P0002';
  end if;
  if not public.data_table_editable_by(t.id, v_user) then
    raise exception 'you can view this table but not change it' using errcode = '42501';
  end if;
  if p_base_version is not null and p_base_version <> t.version then
    raise exception 'the table changed since version %', p_base_version
      using errcode = 'PT409', detail = t.version::text;
  end if;
  if coalesce(p_source, '') not in ('person', 'agent', 'import', 'email', 'capture', 'sms', 'form') then
    raise exception 'unknown source %', p_source using errcode = '22023';
  end if;
  select m.id into v_member from public.member m where m.user_id = v_user and m.workspace_id = t.workspace_id;

  if p_undo_of is not null then
    select * into v_undone from public.data_change c where c.id = p_undo_of and c.table_id = t.id for update;
    if not found then
      raise exception 'change not found' using errcode = '22023';
    end if;
    if v_undone.undo_of is not null then
      raise exception 'that change was itself an undo' using errcode = '22023';
    end if;
    if v_undone.undone_at is not null then
      raise exception 'that change was already undone' using errcode = '22023';
    end if;
  end if;

  -- The activity log reads the source (521: an import logs no row creations),
  -- and this batch makes no new table. A relation value links without grants
  -- when the batch has none (524). A form's rows are marked from it (660).
  perform set_config('dial8.data_source', p_source, true);
  perform set_config('dial8.data_new_table', '', true);
  perform set_config('dial8.data_grants', case when p_grants is false then 'off' else '' end, true);
  v_result := public._data_apply(t.id, v_user, v_member, p_ops);

  if jsonb_array_length(v_result -> 'changes') = 0 then
    return jsonb_build_object('version', t.version, 'change_id', null, 'inserted_row_ids', '[]'::jsonb, 'created_column_ids', '{}'::jsonb);
  end if;

  update public.data_table set version = version + 1, updated_at = now() where id = t.id returning version into v_version;
  insert into public.data_change (workspace_id, table_id, version, actor_user_id, actor_member_id, source, reason, changes, undo_of, source_ref)
  values (t.workspace_id, t.id, v_version, v_user, v_member, p_source, nullif(btrim(coalesce(p_reason, '')), ''), v_result -> 'changes', p_undo_of,
          left(nullif(btrim(coalesce(p_source_ref, '')), ''), 200))
  returning id into v_change;
  if p_undo_of is not null then
    update public.data_change set undone_at = now() where id = p_undo_of;
  end if;

  return jsonb_build_object(
    'version', v_version,
    'change_id', v_change,
    'inserted_row_ids', v_result -> 'inserted_row_ids',
    'created_column_ids', v_result -> 'created_column_ids'
  );
end;
$$;

revoke all on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Trigger 'record_created'
-- ------------------------------------------------------------
-- Widens 640's flow_trigger_type_check, keeping every earlier value. Added
-- without a scan, then validated on its own, as the source check above.

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created', 'record_created')) not valid;
alter table public.flow validate constraint flow_trigger_type_check;

notify pgrst, 'reload schema';
