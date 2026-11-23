-- ============================================================
-- 704: Imports of work from other tools (docs/plans/imports.md).
-- ============================================================
-- Tasks from a CSV, issues from Linear, pages and databases from a Notion
-- export. Each import is planned and previewed before it writes anything,
-- applied in order, and undone as a whole. Contact imports keep their own
-- tables (462): this is the journal for the other three sources.
--
-- What lands, all of it new (no existing table, policy, function,
-- constraint or trigger is touched):
--   work_import        one import: its workspace, who ran it (user and
--                      member), its source ('task_csv', 'linear', 'notion'),
--                      a label, its status (staged → running → done or
--                      failed → undoing → undone; or discarded while
--                      staged), where it goes (destination), its counts,
--                      the preview's notes, its summary and error, and its
--                      times. A staged import IS the preview: nothing has
--                      been written to the workspace yet.
--   work_import_item   one thing it brings in, in the order it is applied
--                      (seq): its ref (what later items name it by), its
--                      kind, the source's own id (external_id: a Linear
--                      issue id, a Notion page id, a CSV row), the planned
--                      record (what the preview shows and apply writes),
--                      an existing record it matched (matched_id), what
--                      applying it did (outcome) and the record it made
--                      (entity_id), and how its undo went. The undo journal.
--
-- Who does what:
--   reads     the user who ran an import, while still a member of its
--             workspace, reads the import and its items. Nobody else: the
--             items hold the planned records, someone's file contents.
--   writes    none from a client. The routes (src/app/api/account/imports)
--             check the caller themselves and write the journal on the
--             service role; every RECORD an import makes or undoes (a task,
--             a document, a table, a folder) is written on the person's own
--             session client, under that record's own row security, so an
--             import can neither make nor remove what its person couldn't.
--   guards    in the 359/369/675 style, a before-write trigger (not a
--             definer; the service role and a database owner are not held
--             to it) as a second fence behind the missing write policies:
--             a client inserts no import or item, and on an update never
--             changes an import's workspace, user, source or made time, or
--             an item's import, workspace, seq, ref, kind or record.
--
-- Undo never reaches beyond the import: it acts only on items whose outcome
-- is 'created' (never 'matched'), and keeps a made record someone changed
-- since (undo_outcome 'kept'). That rule is the app's
-- (src/lib/imports/undo.ts); this file records the outcome.
--
-- No realtime publication. Re-runnable. Its own transaction (begin ...
-- commit), so it is all or nothing however it is applied: apply it WITHOUT
-- --single-transaction. No backslashes anywhere in this file.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

-- ── A. Imports ──────────────────────────────────────────────────────────────

create table if not exists public.work_import (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid references public.member(id) on delete set null,
  source text not null,
  label text,
  status text not null default 'staged',
  destination jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  summary text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  undone_at timestamptz
);

alter table public.work_import drop constraint if exists work_import_source_check;
alter table public.work_import
  add constraint work_import_source_check check (source in ('task_csv', 'linear', 'notion'));
alter table public.work_import drop constraint if exists work_import_status_check;
alter table public.work_import
  add constraint work_import_status_check check (status in ('staged', 'running', 'done', 'failed', 'undoing', 'undone', 'discarded'));
alter table public.work_import drop constraint if exists work_import_text_lengths;
alter table public.work_import
  add constraint work_import_text_lengths check (
    (label is null or char_length(label) <= 200)
    and (summary is null or char_length(summary) <= 2000)
    and (error is null or char_length(error) <= 1000)
  );

create index if not exists work_import_workspace_idx
  on public.work_import (workspace_id, created_at desc);
create index if not exists work_import_user_idx
  on public.work_import (user_id, created_at desc);

comment on table public.work_import is
  'One import of work from another tool (704): a task CSV, Linear, a Notion export. Previewed while staged, undone as a whole.';

-- ── B. Items: the undo journal ──────────────────────────────────────────────

create table if not exists public.work_import_item (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.work_import(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  seq integer not null,
  ref text not null,
  kind text not null,
  external_id text,
  record jsonb not null,
  matched_id uuid,
  outcome text not null default 'pending',
  entity_id uuid,
  error text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  undone_at timestamptz,
  undo_outcome text
);

alter table public.work_import_item drop constraint if exists work_import_item_kind_check;
alter table public.work_import_item
  add constraint work_import_item_kind_check check (kind in ('label', 'project', 'workflow_state', 'action', 'drive_folder', 'document', 'data_table', 'asset'));
alter table public.work_import_item drop constraint if exists work_import_item_outcome_check;
alter table public.work_import_item
  add constraint work_import_item_outcome_check check (outcome in ('pending', 'created', 'matched', 'skipped', 'failed'));
alter table public.work_import_item drop constraint if exists work_import_item_undo_outcome_check;
alter table public.work_import_item
  add constraint work_import_item_undo_outcome_check check (undo_outcome is null or undo_outcome in ('removed', 'kept', 'none'));
alter table public.work_import_item drop constraint if exists work_import_item_text_lengths;
alter table public.work_import_item
  add constraint work_import_item_text_lengths check (
    char_length(ref) between 1 and 100
    and (external_id is null or char_length(external_id) <= 300)
    and (error is null or char_length(error) <= 500)
  );

create unique index if not exists work_import_item_seq_key
  on public.work_import_item (import_id, seq);
create unique index if not exists work_import_item_ref_key
  on public.work_import_item (import_id, ref);
create index if not exists work_import_item_pending_idx
  on public.work_import_item (import_id, seq) where outcome = 'pending';
create index if not exists work_import_item_entity_idx
  on public.work_import_item (entity_id) where entity_id is not null;
-- A second import of the same Linear team finds what an earlier one brought in.
create index if not exists work_import_item_external_idx
  on public.work_import_item (workspace_id, kind, external_id) where external_id is not null and outcome = 'created';

comment on table public.work_import_item is
  'One thing an import (704) brings in, in order: the planned record, what it matched or made, and how its undo went. The undo journal.';

-- ── C. Row security ─────────────────────────────────────────────────────────

alter table public.work_import enable row level security;
alter table public.work_import_item enable row level security;

-- Is this the caller's own import, in a workspace they are still a member
-- of? (Definer, so it reads the import and the member row whatever their own
-- policies say; it answers only for the caller.)
create or replace function public.work_import_is_mine(p_import_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.work_import i
      join public.member m on m.workspace_id = i.workspace_id and m.user_id = i.user_id
     where i.id = p_import_id
       and i.user_id = auth.uid()
  );
$$;

revoke all on function public.work_import_is_mine(uuid) from public, anon;
grant execute on function public.work_import_is_mine(uuid) to authenticated, service_role;

drop policy if exists work_import_select_own on public.work_import;
create policy work_import_select_own on public.work_import
  for select to authenticated
  using (user_id = auth.uid() and public.work_import_is_mine(id));

drop policy if exists work_import_item_select_own on public.work_import_item;
create policy work_import_item_select_own on public.work_import_item
  for select to authenticated
  using (public.work_import_is_mine(import_id));

-- No insert, update or delete policy: a client writes neither table.
revoke insert, update, delete, truncate on public.work_import from anon, authenticated;
revoke insert, update, delete, truncate on public.work_import_item from anon, authenticated;
grant select on public.work_import to authenticated;
grant select on public.work_import_item to authenticated;
grant all on public.work_import to service_role;
grant all on public.work_import_item to service_role;

-- ── D. Guards (the second fence) ────────────────────────────────────────────

create or replace function public.work_import_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      raise exception 'An import is made by the app, not a client.' using errcode = '42501';
    end if;
    if new.workspace_id is distinct from old.workspace_id
       or new.user_id is distinct from old.user_id
       or new.source is distinct from old.source
       or new.created_at is distinct from old.created_at then
      raise exception 'Whose an import is, and where from, never change.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists work_import_before_write on public.work_import;
create trigger work_import_before_write
  before insert or update on public.work_import
  for each row execute function public.work_import_before_write();

create or replace function public.work_import_item_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      raise exception 'An import''s items are written by the app, not a client.' using errcode = '42501';
    end if;
    if new.import_id is distinct from old.import_id
       or new.workspace_id is distinct from old.workspace_id
       or new.seq is distinct from old.seq
       or new.ref is distinct from old.ref
       or new.kind is distinct from old.kind
       or new.record is distinct from old.record then
      raise exception 'An import''s planned items never change.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    -- An item's workspace is always its import's.
    select i.workspace_id into v_ws from public.work_import i where i.id = new.import_id;
    if v_ws is null or v_ws <> new.workspace_id then
      raise exception 'An item belongs to its import''s workspace.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists work_import_item_before_write on public.work_import_item;
create trigger work_import_item_before_write
  before insert or update on public.work_import_item
  for each row execute function public.work_import_item_before_write();

commit;

notify pgrst, 'reload schema';
