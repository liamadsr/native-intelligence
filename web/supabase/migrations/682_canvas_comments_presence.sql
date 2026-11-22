-- ============================================================
-- 682: comments on a canvas, and who may hear who is on one.
-- ============================================================
-- On top of 676 (canvases). Two things, both the owner's decisions of
-- 2026-11-22 (docs/plans/canvas.md):
--
--   A. Comments. The app's comment table names its targets in an enum and a
--      validator that a new kind would have to redefine, so a canvas keeps its
--      threads in a table of its own, as spreadsheets do (675's
--      spreadsheet_comment). A thread is about the canvas, or about one item
--      on it (item_id, with the point it was pinned at). Readers of the canvas
--      read and write comments; a guard keeps a comment's words to its author
--      and records whoever resolves a thread as themself.
--
--   B. Presence. Cursors, names and selections travel on a Realtime broadcast
--      channel, `canvas-presence:<canvas id>`. A channel's name is no secret:
--      without a rule, any holder of the anon key who knew a canvas's id could
--      listen in, on a private canvas too. The editor joins it as a PRIVATE
--      channel, and these realtime.messages policies let in only whoever may
--      open the canvas (676's canvas_visible_to), for broadcast only. The
--      topic is parsed as text before any cast, so a malformed topic is
--      refused, never an error inside a policy (559's rule).
--
-- It redefines NO existing function and NO existing policy: new table, new
-- functions, new policies. Additive. Idempotent. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` is atomic too.

begin;

SET LOCAL lock_timeout = '5s';

-- ── A. Comments ─────────────────────────────────────────────────────────────

create table if not exists public.canvas_comment (
  id uuid primary key default gen_random_uuid(),
  canvas_id uuid not null references public.canvas(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- A reply names the thread's first comment; the first comment names nothing.
  parent_id uuid references public.canvas_comment(id) on delete cascade,
  -- What the thread is about: one item on the canvas, or (null) the canvas.
  -- Not a foreign key: an item that is deleted leaves its thread readable.
  item_id text,
  -- Where on the canvas it was pinned, in canvas units.
  x double precision,
  y double precision,
  body text not null,
  mentions jsonb not null default '[]'::jsonb,
  author_id uuid references public.member(id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint canvas_comment_body_check check (char_length(body) between 1 and 10000),
  constraint canvas_comment_item_check check (item_id is null or char_length(item_id) between 1 and 64),
  constraint canvas_comment_mentions_array check (jsonb_typeof(mentions) = 'array')
);

comment on table public.canvas_comment is
  'A comment on a canvas (682): a thread about the canvas or one of its items, and its replies. Read and written by whoever may open the canvas; a comment''s words are its author''s.';

create index if not exists canvas_comment_canvas_idx
  on public.canvas_comment (canvas_id, created_at);
create index if not exists canvas_comment_parent_idx
  on public.canvas_comment (parent_id) where parent_id is not null;

-- What a client may change in a comment. The update policy lets every reader
-- of the canvas update a comment's row, because every reader resolves a
-- thread; without this a reader could also rewrite another person's words or
-- sign them as someone else. So for a client:
--   - the canvas, the workspace, the author, the thread, what it is about and
--     the time it was written never change;
--   - the words and the mentions are the author's alone to change;
--   - whoever resolves a thread is recorded as themself.
create or replace function public.canvas_comment_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_me uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.canvas_id is distinct from old.canvas_id
     or new.workspace_id is distinct from old.workspace_id
     or new.author_id is distinct from old.author_id
     or new.parent_id is distinct from old.parent_id
     or new.item_id is distinct from old.item_id
     or new.created_at is distinct from old.created_at then
    raise exception 'A comment keeps its canvas, its author, its thread and its time.' using errcode = '42501';
  end if;
  v_me := public.current_member_id(old.workspace_id);
  if (new.body is distinct from old.body or new.mentions is distinct from old.mentions)
     and (v_me is null or old.author_id is distinct from v_me) then
    raise exception 'Only its author changes a comment.' using errcode = '42501';
  end if;
  if new.resolved_by is distinct from old.resolved_by
     and new.resolved_by is not null
     and (v_me is null or new.resolved_by is distinct from v_me) then
    raise exception 'A thread is resolved as oneself.' using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.canvas_comment_guard() is
  'What a client update may change in a canvas comment (682): never its canvas, author, thread or time; its words only by its author; a resolver is recorded as themself.';

drop trigger if exists canvas_comment_guard on public.canvas_comment;
create trigger canvas_comment_guard
  before update on public.canvas_comment
  for each row execute function public.canvas_comment_guard();

drop trigger if exists canvas_comment_updated_at on public.canvas_comment;
create trigger canvas_comment_updated_at
  before update on public.canvas_comment
  for each row execute function public.update_updated_at();

-- Whether a reply's parent is the first comment of a thread on that canvas.
-- A function, not a subquery in the insert policy: a policy on canvas_comment
-- that reads canvas_comment recurses (42P17). It runs as its owner, so it
-- checks for itself that the caller can open the canvas: it never says
-- whether a comment exists on a canvas the caller cannot open. (A caller with
-- no person behind it, the service role, is not held to that.)
create or replace function public.canvas_comment_is_thread(p_parent uuid, p_canvas uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.canvas_comment p
     where p.id = p_parent
       and p.canvas_id = p_canvas
       and p.parent_id is null
       and ((select auth.uid()) is null or public.canvas_visible_to(p_canvas, (select auth.uid())))
  );
$$;

comment on function public.canvas_comment_is_thread(uuid, uuid) is
  'Whether a comment is the first of a thread on that canvas (682): what a reply may name as its parent.';

revoke all on function public.canvas_comment_is_thread(uuid, uuid) from public, anon;
grant execute on function public.canvas_comment_is_thread(uuid, uuid) to authenticated, service_role;

alter table public.canvas_comment enable row level security;

-- Read with the canvas (676's one lookup per query).
drop policy if exists canvas_comment_select on public.canvas_comment;
create policy canvas_comment_select on public.canvas_comment
  for select to authenticated
  using (canvas_id = any ((select public.my_canvas_ids())::uuid[]));

-- Written as the caller's own member of the canvas's workspace, on a canvas
-- they can open. A reply stays on its thread's canvas.
drop policy if exists canvas_comment_insert on public.canvas_comment;
create policy canvas_comment_insert on public.canvas_comment
  for insert to authenticated
  with check (
    author_id is not null
    and author_id = public.current_member_id(workspace_id)
    and public.canvas_visible_to(canvas_id, (select auth.uid()))
    and exists (
      select 1 from public.canvas c
       where c.id = canvas_comment.canvas_id
         and c.workspace_id = canvas_comment.workspace_id
    )
    and (
      parent_id is null
      or public.canvas_comment_is_thread(parent_id, canvas_id)
    )
  );

-- Anyone who can open the canvas resolves a thread; canvas_comment_guard keeps
-- a comment's words, its author and its place to what they were.
drop policy if exists canvas_comment_update on public.canvas_comment;
create policy canvas_comment_update on public.canvas_comment
  for update to authenticated
  using (canvas_id = any ((select public.my_canvas_ids())::uuid[]))
  with check (public.canvas_visible_to(canvas_id, (select auth.uid())));

-- Its author takes a comment back.
drop policy if exists canvas_comment_delete on public.canvas_comment;
create policy canvas_comment_delete on public.canvas_comment
  for delete to authenticated
  using (
    author_id is not null
    and author_id = public.current_member_id(workspace_id)
    and canvas_id = any ((select public.my_canvas_ids())::uuid[])
  );

revoke all on table public.canvas_comment from anon, authenticated;
grant select, insert, update, delete on table public.canvas_comment to authenticated;
grant all on table public.canvas_comment to service_role;

-- Other people's comments arrive live.
alter table public.canvas_comment replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.canvas_comment;
exception when duplicate_object then null;
end $$;

-- ── B. Presence: who may hear, and say, who is on a canvas ──────────────────

-- The canvas a presence topic is for, or null for any other topic. Compared
-- as text before the cast, so a malformed topic never raises inside a policy.
create or replace function public.canvas_presence_canvas(topic text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when topic ~ '^canvas-presence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(topic, ':', 2)::uuid
  end;
$$;

comment on function public.canvas_presence_canvas(text) is
  'The canvas a Realtime presence topic (canvas-presence:<uuid>) is for, or null for anything else (682).';

revoke all on function public.canvas_presence_canvas(text) from public, anon;
grant execute on function public.canvas_presence_canvas(text) to authenticated;

-- Hear and say are the same rule: whoever may open the canvas. A viewer's
-- cursor is as much "who is here" as an editor's. Broadcast only.
drop policy if exists "canvas_presence_hear" on realtime.messages;
create policy "canvas_presence_hear" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() like 'canvas-presence:%'
    and realtime.messages.extension = 'broadcast'
    and public.canvas_visible_to(public.canvas_presence_canvas(realtime.topic()), (select auth.uid()))
  );

drop policy if exists "canvas_presence_say" on realtime.messages;
create policy "canvas_presence_say" on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() like 'canvas-presence:%'
    and realtime.messages.extension = 'broadcast'
    and public.canvas_visible_to(public.canvas_presence_canvas(realtime.topic()), (select auth.uid()))
  );

commit;

notify pgrst, 'reload schema';
