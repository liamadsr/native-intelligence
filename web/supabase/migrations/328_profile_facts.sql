-- Migration 328: the profile tier, facts about you (docs/plans/always-on-agent.md
-- §3 "Memory in tiers", slice A2a; decisions 2, 3 and 4).
--
-- One agent that knows you, with a separate room for each workspace (decision
-- 2): how you work (style, preferences, habits, how you like answers) follows
-- you across workspaces; what you work on stays in each workspace as a
-- personal area_memory line (317). This file holds every profile-side table:
--
--   profile_fact       one fact about one person, keyed to the person, never
--                      to a workspace. No workspace can ever read it.
--     status  active   in the chat's profile record (eve memory, below);
--             proposed waits for the person: what the capture pass inferred
--                      (decision 3). Never in the prompt.
--     source  told     the person said it (`remember` with scope profile, or
--                      the capture pass when they stated it outright);
--             learned  inferred by the server (A2c), always proposed first;
--             edited   typed or changed in What Dial8 has learned.
--     importance 1-5   ranks what the prompt carries when the caps bind
--                      (then the newest first).
--     source_workspace_id  where it was said (set null when that workspace
--                      goes): provenance only, never a read scope.
--     superseded_by    the fact that replaced this one (A2c's replace).
--     retired_at       when the server retired it (a supersede sets both).
--                      A retired fact never loads, even if its superseded_by
--                      is later cleared (the newer fact deleted: the FK's SET
--                      NULL), so a replaced fact can't come back to life.
--   One live fact per text per person: a partial unique index on the
--   lower-cased text of live facts closes the writers' read-then-insert race
--   (the writer maps the conflict to "already there").
--   The caps (100 active facts, about 4,000 characters) are the writer's
--   (src/lib/memory/profile-facts.ts), like 317's note caps.
--
--   chat_memory_epoch  one row per eve chat session: the snapshot of active
--                      facts frozen when the session's epoch began (its first
--                      recall, or its last compaction). The chat's `facts`
--                      record is the snapshot, so it changes only at
--                      compaction; `facts-delta` carries what changed since,
--                      keyed per epoch (epoch_seq) and sent only once there is
--                      a change (live_delta_seqs: every delta key sent and not
--                      yet retired, all retired at the next compaction), so
--                      the first told fact appends
--                      at the end of the history and never supersedes a record
--                      near its head. facts_shown: the `facts` record was sent
--                      in this session (so an emptied profile still says so).
--                      Also the capture pass's per-session bookkeeping (A2c):
--                      how far the conversation has been captured, and when.
--   chat_memory_op     every memory operation's result, keyed by eve's
--                      operationId (eve-memory-operation-v1:<session>:...), so
--                      a replayed step returns the same bytes (eve fails the
--                      turn on a mismatch), and a replayed capture runs once.
--                      Pruned past 7 days on write.
--
-- Who may do what:
--   profile_fact       only its own person reads, edits, deletes or adds it
--                      (RLS user_id = auth.uid()). A person never adds a
--                      learned fact, and profile_fact_guard keeps identity,
--                      provenance and supersession the server's.
--   chat_memory_*      the server only (service role): RLS on, no policies.
--
-- Idempotent: create if not exists, add column if not exists, drop policy if
-- exists, create or replace.

SET LOCAL lock_timeout = '5s';

-- ── profile_fact ────────────────────────────────────────────────────────────

create table if not exists public.profile_fact (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 300),
  status text not null default 'active' check (status in ('active', 'proposed')),
  source text not null check (source in ('told', 'learned', 'edited')),
  importance smallint not null default 3 check (importance between 1 and 5),
  source_workspace_id uuid references public.workspace(id) on delete set null,
  superseded_by uuid references public.profile_fact(id) on delete set null,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_fact_not_self_superseded check (superseded_by is distinct from id)
);

comment on table public.profile_fact is
  'Facts about you (328): how a person works, shared across their workspaces and readable only by them. Active, unsuperseded facts reach the chat through the eve memory slot agents/chat-agent/memory/profile.ts.';

alter table public.profile_fact add column if not exists retired_at timestamptz;

-- The load: one person's live facts, the most important and newest first.
drop index if exists public.profile_fact_load_idx;
create index if not exists profile_fact_live_idx
  on public.profile_fact (user_id, status, importance desc, updated_at desc)
  where retired_at is null;

-- One live fact per text per person (the writers' dedupe, held under races).
create unique index if not exists profile_fact_live_text_key
  on public.profile_fact (user_id, lower(btrim(text)))
  where superseded_by is null and retired_at is null;

alter table public.profile_fact enable row level security;

drop policy if exists "profile_fact_select" on public.profile_fact;
create policy "profile_fact_select"
  on public.profile_fact for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "profile_fact_insert" on public.profile_fact;
create policy "profile_fact_insert"
  on public.profile_fact for insert
  to authenticated
  with check (user_id = (select auth.uid()) and source <> 'learned');

drop policy if exists "profile_fact_update" on public.profile_fact;
create policy "profile_fact_update"
  on public.profile_fact for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "profile_fact_delete" on public.profile_fact;
create policy "profile_fact_delete"
  on public.profile_fact for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- A person reads and writes only their own facts (the policies above);
-- Supabase's default grants (truncate, trigger, references…) go. Re-runnable.
revoke all on table public.profile_fact from anon, authenticated;
grant select, insert, update, delete on table public.profile_fact to authenticated;

create or replace function public.profile_fact_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The server: the service role, or no request at all.
  if coalesce(auth.role(), '') in ('', 'service_role') then
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A fact a person adds is theirs, told or typed, active. Learning and
    -- supersession are the server's.
    if new.user_id is distinct from auth.uid() or new.source = 'learned' then
      raise exception 'A fact you add is yours, told or edited, never learned'
        using errcode = 'insufficient_privilege';
    end if;
    if new.superseded_by is not null or new.retired_at is not null then
      raise exception 'Only the server supersedes or retires a fact'
        using errcode = 'insufficient_privilege';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- A foreign key's ON DELETE SET NULL is an UPDATE run inside the delete
  -- (trigger depth > 1), under the deleting caller's role: the newer fact
  -- deleted clears superseded_by, the workspace deleted clears
  -- source_workspace_id. Those are allowed, and nothing else may change with
  -- them. The fact stays retired (retired_at), so it never comes back.
  if pg_trigger_depth() > 1
     and new.id = old.id
     and new.user_id = old.user_id
     and new.text = old.text
     and new.status = old.status
     and new.source = old.source
     and new.importance = old.importance
     and new.created_at = old.created_at
     and new.retired_at is not distinct from old.retired_at
     and (new.superseded_by is not distinct from old.superseded_by or new.superseded_by is null)
     and (new.source_workspace_id is not distinct from old.source_workspace_id or new.source_workspace_id is null) then
    return new;
  end if;

  -- A fact never moves to another person, and keeps where and when it began.
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.source_workspace_id is distinct from old.source_workspace_id
     or new.superseded_by is distinct from old.superseded_by
     or new.retired_at is distinct from old.retired_at then
    raise exception 'A fact cannot move or change where it came from: delete it and add a new one'
      using errcode = 'insufficient_privilege';
  end if;

  -- An accepted fact can't go back to waiting, and a person's change is an edit.
  if old.status = 'active' and new.status = 'proposed' then
    raise exception 'An active fact cannot go back to proposed'
      using errcode = 'check_violation';
  end if;
  if new.source is distinct from old.source and new.source <> 'edited' then
    raise exception 'A changed fact is edited, never told or learned'
      using errcode = 'insufficient_privilege';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function public.profile_fact_guard() is
  'BEFORE INSERT OR UPDATE on profile_fact (328). Unless the caller is the service role or has no request context: a new fact is the caller''s, never learned, superseded or retired; a fact never changes user, created_at, source_workspace_id, superseded_by or retired_at, never goes from active back to proposed, and a changed source can only become edited. A foreign key''s SET NULL (trigger depth > 1) may clear superseded_by or source_workspace_id, and nothing else.';

drop trigger if exists profile_fact_guard on public.profile_fact;
create trigger profile_fact_guard
  before insert or update on public.profile_fact
  for each row execute function public.profile_fact_guard();

-- A trigger function, never called directly.
revoke execute on function public.profile_fact_guard() from public, anon, authenticated;

-- ── chat_memory_epoch ───────────────────────────────────────────────────────

create table if not exists public.chat_memory_epoch (
  -- eve's durable session id (chat_conversations.eve_session_id).
  session_id text primary key check (char_length(session_id) between 1 and 1024),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  conversation_id uuid references public.chat_conversations(id) on delete cascade,
  -- The facts frozen at the epoch's start: [{ "id": uuid, "text": string }].
  snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(snapshot) = 'array'),
  snapshot_hash text not null,
  epoch_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The capture pass's bookkeeping (A2c), per session. Added as columns so a
-- later edit of this file can extend them in place.
alter table public.chat_memory_epoch add column if not exists captured_through_seq integer;
alter table public.chat_memory_epoch add column if not exists captured_through_at timestamptz;
alter table public.chat_memory_epoch add column if not exists last_capture_at timestamptz;

-- What the chat has been shown this session (A2a review): the delta record's
-- key is per epoch (epoch_seq), sent only once a change exists; live_delta_seqs
-- lists every delta key sent and not yet retired (a compaction retires them
-- all, so one a failed compaction left behind is retired by the next);
-- facts_shown says the facts record was ever sent.
alter table public.chat_memory_epoch add column if not exists epoch_seq integer not null default 0;
alter table public.chat_memory_epoch add column if not exists live_delta_seqs integer[] not null default '{}';
alter table public.chat_memory_epoch add column if not exists facts_shown boolean not null default false;

comment on table public.chat_memory_epoch is
  'Profile memory epochs (328): per eve chat session, the facts snapshot frozen at its first recall or last compaction (the `facts` record), plus the capture pass''s position (captured_through_*, last_capture_at). Server only.';

create index if not exists chat_memory_epoch_user_idx
  on public.chat_memory_epoch (user_id, workspace_id);
-- The nightly catch-up (A2c): sessions oldest-captured first.
create index if not exists chat_memory_epoch_capture_idx
  on public.chat_memory_epoch (last_capture_at nulls first);

alter table public.chat_memory_epoch enable row level security;
-- No policies: only the server (service role) reads or writes it.
revoke all on table public.chat_memory_epoch from anon, authenticated;

-- ── chat_memory_op ──────────────────────────────────────────────────────────

create table if not exists public.chat_memory_op (
  -- eve's operationId: stable per session, sequence, turn, phase and slot.
  operation_id text primary key check (char_length(operation_id) between 1 and 2048),
  session_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  op text not null check (op in ('recall', 'capture')),
  phase text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.chat_memory_op is
  'Memory operation results by eve operationId (328): a replayed recall returns the same bytes, a replayed capture runs once. Pruned past 7 days on write. Server only.';

create index if not exists chat_memory_op_created_idx
  on public.chat_memory_op (created_at);

alter table public.chat_memory_op enable row level security;
-- No policies: only the server (service role) reads or writes it.
revoke all on table public.chat_memory_op from anon, authenticated;

-- The prune, on write: one index range scan per insert statement, which finds
-- nothing on almost every call. A replay older than 7 days is long past eve's
-- step retries.
create or replace function public.chat_memory_op_prune()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.chat_memory_op where created_at < now() - interval '7 days';
  return null;
end;
$$;

comment on function public.chat_memory_op_prune() is
  'AFTER INSERT (statement) on chat_memory_op (328): drops results older than 7 days.';

drop trigger if exists chat_memory_op_prune on public.chat_memory_op;
create trigger chat_memory_op_prune
  after insert on public.chat_memory_op
  for each statement execute function public.chat_memory_op_prune();

revoke execute on function public.chat_memory_op_prune() from public, anon, authenticated;

-- ── Recall commit: the memo and the epoch together ──────────────────────────
--
-- A recall's result is stored by operationId and, ONLY IF THIS CALL'S RESULT
-- WON (nothing was stored for the operation yet), the session's epoch is
-- written in the same transaction. A result the provider pinned first (its
-- fallback, after a timeout) wins instead and leaves the epoch alone, so the
-- epoch never advances past what the chat was actually given.
-- p_epoch: null (no epoch change) or the epoch row's new state as JSON.
-- Returns { won, result }: the stored result (this call's, or the winner's).
create or replace function public.chat_memory_recall_commit(
  p_operation_id text,
  p_session_id text,
  p_user_id uuid,
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_phase text,
  p_result jsonb,
  p_epoch jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
  v_result jsonb;
begin
  insert into public.chat_memory_op (operation_id, session_id, user_id, op, phase, result)
  values (p_operation_id, p_session_id, p_user_id, 'recall', p_phase, p_result)
  on conflict (operation_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select result into v_result
      from public.chat_memory_op
     where operation_id = p_operation_id and session_id = p_session_id and user_id = p_user_id and op = 'recall';
    return jsonb_build_object('won', false, 'result', v_result);
  end if;

  if p_epoch is not null then
    insert into public.chat_memory_epoch as e (
      session_id, user_id, workspace_id, conversation_id, snapshot, snapshot_hash,
      epoch_at, epoch_seq, live_delta_seqs, facts_shown, updated_at
    )
    values (
      p_session_id, p_user_id, p_workspace_id, p_conversation_id,
      coalesce(p_epoch->'snapshot', '[]'::jsonb),
      coalesce(p_epoch->>'snapshot_hash', ''),
      coalesce((p_epoch->>'epoch_at')::timestamptz, now()),
      coalesce((p_epoch->>'epoch_seq')::integer, 0),
      coalesce(array(select jsonb_array_elements_text(p_epoch->'live_delta_seqs')::integer), '{}'),
      coalesce((p_epoch->>'facts_shown')::boolean, false),
      now()
    )
    on conflict (session_id) do update set
      snapshot = excluded.snapshot,
      snapshot_hash = excluded.snapshot_hash,
      epoch_at = excluded.epoch_at,
      epoch_seq = excluded.epoch_seq,
      live_delta_seqs = excluded.live_delta_seqs,
      facts_shown = excluded.facts_shown,
      updated_at = now()
    where e.user_id = p_user_id and e.workspace_id = p_workspace_id;
  end if;

  return jsonb_build_object('won', true, 'result', p_result);
end;
$$;

comment on function public.chat_memory_recall_commit(text, text, uuid, uuid, uuid, text, jsonb, jsonb) is
  'Store a recall result by operationId and, only when it won, the session''s new epoch state, in one transaction (328). Server only.';

revoke all on function public.chat_memory_recall_commit(text, text, uuid, uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.chat_memory_recall_commit(text, text, uuid, uuid, uuid, text, jsonb, jsonb) to service_role;

-- ── Workspace walls: does a text name this workspace's things? ──────────────
--
-- A fact about the person follows them into every workspace (decision 2), so
-- one that names a contact, company or project of the workspace it was said
-- in must not become a profile fact (src/lib/memory/workspace-mentions.ts).
-- Whole words only: the text and each name are lower-cased, every run of
-- non-alphanumerics becomes one space, and both are padded with a space, so a
-- name matches only as its own tokens ("Mark" never matches "market", "Email"
-- never matches "emails"). A name must have at least 4 characters, and a
-- one-word contact name at least 5 (first names collide with words). The text
-- is cut at 2,000 characters; each table's scan is bounded to its 5,000 most
-- recent rows. Returns the first name found, or null.
create or replace function public.workspace_entity_mentioned(p_workspace_id uuid, p_text text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (
    select ' ' || regexp_replace(lower(left(coalesce(p_text, ''), 2000)), '[^[:alnum:]]+', ' ', 'g') || ' ' as body
  ),
  names as (
    (select 'contact' as kind, c.full_name as name from public.contact c
      where c.workspace_id = p_workspace_id and c.merged_into_contact_id is null and c.full_name is not null
      order by c.created_at desc nulls last
      limit 5000)
    union all
    (select 'company', co.name from public.company co
      where co.workspace_id = p_workspace_id and co.name is not null
      order by co.created_at desc nulls last
      limit 5000)
    union all
    (select 'project', pr.name from public.projects pr
      where pr.workspace_id = p_workspace_id and pr.name is not null
      order by pr.created_at desc nulls last
      limit 5000)
  ),
  tokens as (
    select kind, name, btrim(regexp_replace(lower(name), '[^[:alnum:]]+', ' ', 'g')) as core from names
  )
  select tokens.name
    from tokens, t
   where char_length(core) >= 4
     and not (kind = 'contact' and position(' ' in core) = 0 and char_length(core) < 5)
     and position(' ' || core || ' ' in t.body) > 0
   limit 1
$$;

comment on function public.workspace_entity_mentioned(uuid, text) is
  'The first contact, company or project name of the workspace found in the text as whole words (names of 4+ characters; one-word contact names 5+), case-insensitive, or null (328). Server only.';

revoke all on function public.workspace_entity_mentioned(uuid, text) from public, anon, authenticated;
grant execute on function public.workspace_entity_mentioned(uuid, text) to service_role;
