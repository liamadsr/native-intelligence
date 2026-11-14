-- ============================================================
-- 650: A call's audio file (one recorder per call, phase 4). Until now a call
-- heard by the call recorder kept its transcript and nothing of its sound.
-- With this, the producer of a feed (the call recorder today) mixes what it
-- heard into one file per take, and hands it to the app through the feed:
-- the app grants a one-time upload to a path it chooses, the producer
-- uploads, the app checks the file is there and keeps it beside the capture
-- for 30 days, then deletes it. Only the file goes: the capture, its
-- transcript and its notes stay. src/lib/capture-feed/audio.ts is the app's
-- side, src/lib/capture-feed/audio-retention.ts the daily sweep.
-- ============================================================
--   capture_audio     one audio file of one feed session: its take (the
--                     producer's own key for the file, so a retry finds the
--                     same row, and a producer that left a session and came
--                     back to it later makes a second take, never a second
--                     row for the first), its part (0, 1, ... in the order
--                     the takes were granted), offset_ms (where the file's
--                     time zero sits in the session's clock: a take starts
--                     where the producer started hearing, and from there the
--                     file's time is the transcript's time, silence where
--                     nobody spoke), its path in the bucket
--                     team-call-recordings (<channel>/<call>/audio/<id>.m4a,
--                     so 569's sweep of files whose call is gone takes it
--                     too), state 'pending' (granted, not yet seen in
--                     Storage), 'stored' (seen, with its size), 'deleted'
--                     (removed: at its time, or with its call). expires_at is
--                     the session's start plus 30 days, for every take of it:
--                     the same day for everyone, no setting, no tier. From
--                     then on the file is not played or linked any more (the
--                     read policy and the app's route both say so), whenever
--                     the daily sweep gets to removing it. grants counts the
--                     upload links given for the take.
--                     deleted_at is kept, so the capture can say when.
--                     Server only: the capture's page reads it through the
--                     app's route, which first reads the capture as the
--                     person (RLS).
--   capture_feed_audio_grant(...)  the producer asks to upload a take: the
--                     row made (or found again), its path; 'not_wanted' when
--                     the source has no place for it (not a call, the call or
--                     its row gone) or it is already past its 30 days;
--                     'stored' when that take is in already; 'taken' when the
--                     session is another producer's; 'too_large'; 'too_many'
--                     (a session takes at most 10 takes, a take at most 200
--                     links: whoever holds the feed's secret cannot pile files
--                     onto a capture); 'unknown'. The app signs each link for
--                     that one path, without overwrite: a file once uploaded
--                     is never replaced.
--   capture_feed_audio_stored(...)  the producer says it uploaded: the row is
--                     'stored' only if Storage has the object (its size from
--                     Storage's own row) with the type the grant named, else
--                     'missing' (upload again) or 'invalid' (not the file the
--                     take said it would be: dropped, swept at its 30 days).
--   capture_audio_settle(max_rows)  the sweep: a pending row whose object
--                     landed an hour ago is stored (the producer died between
--                     its upload and its word), on stored's own checks; one
--                     that fails them is answered 'invalid' (the sweep removes
--                     its object and marks it deleted, never kept).
--   capture_audio_due(max_rows)  the sweep: rows past their 30 days, oldest
--                     first, whose object the sweep removes before it marks
--                     them deleted.
--   capture_audio_orphans(max_rows)  the sweep: audio objects no row keeps
--                     (their capture was deleted, which deletes the row).
--   capture_audio_capture_of(name)  for the read policy below only: the
--                     capture a stored audio object belongs to, while it is
--                     kept. A signed-in person may call it (the policy runs as
--                     them); it leaks nothing they could use: it answers only
--                     for a whole path, whose last part is a random id handed
--                     to nobody but the capture's readers (in their signed
--                     links), and what it answers is a capture id, which the
--                     captures table's own RLS still keeps from anyone else.
--   storage policy "team call audio read"  a stored audio object is read by
--                     whoever may read its capture now (the captures table's
--                     own RLS, as them: for a call's notes, the owner and the
--                     conversation's readers, 566's fence), through a signed
--                     link the app makes as them after its own read. Nobody
--                     else; never a public link. Clients never write here.
--
-- RLS on the new table; no client has a grant on it. Additive. Idempotent,
-- also over its own earlier forms (pushed on this change's branch before it
-- was merged; a development database may hold one): the grants column comes
-- in if it is missing, and the one function whose result changed shape
-- (capture_audio_settle, once a count) is dropped before it is made again.
-- Safe on a live database with the deployed app running: one new empty
-- table, new functions, one new read policy on storage.objects that matches
-- no object yet. No backslashes anywhere in this file (one MCP transport
-- decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── The files ───────────────────────────────────────────────────────────────

create table if not exists public.capture_audio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  capture_id uuid not null references public.captures(id) on delete cascade,
  session_id uuid not null references public.capture_feed_session(id) on delete cascade,
  take_key text not null check (take_key ~ '^[A-Za-z0-9._-]{1,80}$'),
  part integer not null check (part >= 0),
  offset_ms bigint not null default 0 check (offset_ms >= 0),
  path text not null check (char_length(path) between 1 and 300),
  content_type text not null check (content_type in ('audio/mp4', 'audio/ogg')),
  grants integer not null default 1 check (grants >= 0),
  state text not null default 'pending' check (state in ('pending', 'stored', 'deleted')),
  bytes bigint check (bytes is null or bytes >= 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  expires_at timestamptz not null,
  stored_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_audio_shape check (
    (state = 'deleted') = (deleted_at is not null)
    and (state <> 'stored' or stored_at is not null)
  )
);

-- An earlier form of this file had no grants column.
alter table public.capture_audio add column if not exists grants integer not null default 1 check (grants >= 0);

-- A take is found again by its key; a path is one file.
create unique index if not exists capture_audio_take on public.capture_audio (session_id, take_key);
create unique index if not exists capture_audio_path on public.capture_audio (path);
create index if not exists capture_audio_capture_idx on public.capture_audio (capture_id, part);
-- The sweep's reads: what is due, and what is still pending.
create index if not exists capture_audio_due_idx on public.capture_audio (expires_at) where state in ('pending', 'stored');

alter table public.capture_audio enable row level security;
revoke all on table public.capture_audio from anon, authenticated;
grant select, insert, update, delete on table public.capture_audio to service_role;

comment on table public.capture_audio is
  'A feed session''s audio files (650): one per take, kept 30 days from the session''s start, then deleted (the capture stays). Server only.';

-- ── The producer asks to upload a take ──────────────────────────────────────

create or replace function public.capture_feed_audio_grant(
  p_session uuid,
  p_producer_id text,
  p_take text,
  p_offset_ms bigint,
  p_duration_ms bigint,
  p_bytes bigint,
  p_content_type text
)
returns table (outcome text, audio_id uuid, path text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.capture_feed_session%rowtype;
  a public.capture_audio%rowtype;
  channel uuid;
  keep_until timestamptz;
  next_part integer;
  new_id uuid;
  new_path text;
begin
  select * into s from public.capture_feed_session x where x.id = p_session for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if s.producer_id is distinct from p_producer_id then
    return query select 'taken'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if p_take is null or p_take !~ '^[A-Za-z0-9._-]{1,80}$'
     or p_content_type is null or p_content_type not in ('audio/mp4', 'audio/ogg')
     or coalesce(p_offset_ms, -1) < 0 or coalesce(p_duration_ms, -1) < 0 then
    return query select 'invalid'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  -- 2 GB, the bucket's own limit (566): a larger file could never be stored.
  if coalesce(p_bytes, 0) < 1 or p_bytes > 2147483648 then
    return query select 'too_large'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  keep_until := s.started_at + interval '30 days';

  select * into a from public.capture_audio x where x.session_id = s.id and x.take_key = p_take for update;
  if found then
    if a.state = 'stored' then
      return query select 'stored'::text, a.id, a.path, a.expires_at;
      return;
    end if;
    if a.state = 'deleted' or now() >= a.expires_at then
      return query select 'not_wanted'::text, a.id, null::text, a.expires_at;
      return;
    end if;
    -- A retry asks for a fresh link every time; a few days of them at most.
    if a.grants >= 200 then
      return query select 'too_many'::text, a.id, null::text, a.expires_at;
      return;
    end if;
    -- The file it will be: its size and length may be said again; its type is the first grant's.
    update public.capture_audio x
       set bytes = p_bytes, duration_ms = p_duration_ms, grants = x.grants + 1, updated_at = now()
     where x.id = a.id;
    return query select 'granted'::text, a.id, a.path, a.expires_at;
    return;
  end if;

  if now() >= keep_until then
    return query select 'not_wanted'::text, null::uuid, null::text, keep_until;
    return;
  end if;

  -- Where the file goes: a call's folder in the recordings bucket (566's naming, so 569's sweep of
  -- files whose call is gone takes it as well). A source kind with no such place keeps no audio yet.
  if s.source_kind <> 'team_call' then
    return query select 'not_wanted'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  select t.channel_id into channel from public.team_call t where t.id = s.source_ref;
  if channel is null then
    return query select 'not_wanted'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select coalesce(max(x.part), -1) + 1 into next_part from public.capture_audio x where x.session_id = s.id;
  -- A bound on takes per session (a producer leaving and coming back, each time a new file).
  if next_part >= 10 then
    return query select 'too_many'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  new_id := gen_random_uuid();
  new_path := channel::text || '/' || s.source_ref::text || '/audio/' || new_id::text
    || case when p_content_type = 'audio/ogg' then '.ogg' else '.m4a' end;
  insert into public.capture_audio (id, workspace_id, capture_id, session_id, take_key, part, offset_ms, path, content_type, bytes, duration_ms, expires_at)
  values (new_id, s.workspace_id, s.capture_id, s.id, p_take, next_part, p_offset_ms, new_path, p_content_type, p_bytes, p_duration_ms, keep_until);
  return query select 'granted'::text, new_id, new_path, keep_until;
end;
$$;

-- ── The producer says it uploaded ───────────────────────────────────────────

create or replace function public.capture_feed_audio_stored(p_session uuid, p_producer_id text, p_take text)
returns table (outcome text, audio_id uuid, bytes bigint, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.capture_feed_session%rowtype;
  a public.capture_audio%rowtype;
  size bigint;
  kind text;
begin
  select * into s from public.capture_feed_session x where x.id = p_session;
  if not found then
    return query select 'unknown'::text, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;
  if s.producer_id is distinct from p_producer_id then
    return query select 'taken'::text, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;
  select * into a from public.capture_audio x where x.session_id = s.id and x.take_key = p_take for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;
  if a.state = 'stored' then
    return query select 'stored'::text, a.id, a.bytes, a.expires_at;
    return;
  end if;
  if a.state = 'deleted' then
    return query select 'not_wanted'::text, a.id, null::bigint, a.expires_at;
    return;
  end if;
  -- Storage's own row says it is there, and how large.
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into size, kind
    from storage.objects o
   where o.bucket_id = 'team-call-recordings' and o.name = a.path;
  if size is null or size < 1 then
    return query select 'missing'::text, a.id, null::bigint, a.expires_at;
    return;
  end if;
  if kind is distinct from a.content_type or size > 2147483648 then
    return query select 'invalid'::text, a.id, null::bigint, a.expires_at;
    return;
  end if;
  update public.capture_audio x
     set state = 'stored', bytes = size, stored_at = now(), updated_at = now()
   where x.id = a.id;
  return query select 'stored'::text, a.id, size, a.expires_at;
end;
$$;

-- ── The daily sweep ─────────────────────────────────────────────────────────

-- A pending take whose object landed over an hour ago (its producer never said so) is stored, on the
-- same checks as capture_feed_audio_stored: the type its grant named, a size within the bucket's
-- limit (the path is the take's own: the object is found by it). One that fails them is answered
-- 'invalid', its row left as it is: the sweep removes the object, then marks the row deleted
-- (never kept, so the capture shows nothing of it). One difference on purpose: an object with no
-- size (or 0) is 'missing' to stored, which the producer answers by uploading again, and
-- 'invalid' here, where nobody is left to upload it (Storage writes an object's row only once
-- its body is in, with its size, so such a row is never an upload still on its way).
-- An earlier form answered a count: Postgres cannot change a function's result in place.
drop function if exists public.capture_audio_settle(integer);
create or replace function public.capture_audio_settle(max_rows integer)
returns table (outcome text, id uuid, path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with landed as (
    select a.id, a.path, (o.metadata ->> 'size')::bigint as size,
           ((o.metadata ->> 'mimetype') is not distinct from a.content_type
            and coalesce((o.metadata ->> 'size')::bigint, 0) between 1 and 2147483648) as fits
      from public.capture_audio a
      join storage.objects o on o.bucket_id = 'team-call-recordings' and o.name = a.path
     where a.state = 'pending'
       and a.created_at < now() - interval '1 hour'
     order by a.created_at
     limit greatest(1, least(coalesce(max_rows, 200), 1000))
  ),
  kept as (
    update public.capture_audio x
       set state = 'stored', bytes = l.size, stored_at = now(), updated_at = now()
      from landed l
     where x.id = l.id and l.fits
    returning x.id, x.path
  )
  select 'stored'::text, k.id, k.path from kept k
  union all
  select 'invalid'::text, l.id, l.path from landed l where not l.fits;
end;
$$;

-- Past their 30 days: the sweep removes each object, then marks the row deleted.
create or replace function public.capture_audio_due(max_rows integer)
returns table (id uuid, path text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.path
    from public.capture_audio a
   where a.state in ('pending', 'stored')
     and a.expires_at <= now()
   order by a.expires_at, a.id
   limit greatest(1, least(coalesce(max_rows, 200), 1000));
$$;

-- Audio objects no row keeps (their capture was deleted, and its rows with it), an hour old or
-- more (a grant always makes its row before the upload, so none is in flight).
create or replace function public.capture_audio_orphans(max_rows integer)
returns table (name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'team-call-recordings'
     and split_part(o.name, '/', 3) = 'audio'
     and o.created_at < now() - interval '1 hour'
     and not exists (
       select 1 from public.capture_audio a where a.path = o.name and a.state <> 'deleted'
     )
   order by o.created_at
   limit greatest(1, least(coalesce(max_rows, 200), 1000));
$$;

-- ── Who may read a stored file ──────────────────────────────────────────────

-- The capture a stored audio object belongs to, while it is kept (past its 30 days it is read by no
-- one, swept or not). Only what the read policy needs: the policy then reads that capture as the
-- person, so the captures table's own RLS decides. Callable by a signed-in person because the
-- policy runs as them; it answers only for an exact path, whose last part is a random id that only
-- the capture's readers are ever handed, so it tells nobody anything they could not read already.
create or replace function public.capture_audio_capture_of(object_name text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.capture_id from public.capture_audio a where a.path = object_name and a.state = 'stored' and a.expires_at > now();
$$;

drop policy if exists "team call audio read" on storage.objects;
create policy "team call audio read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'team-call-recordings'
    and split_part(name, '/', 3) = 'audio'
    and exists (select 1 from public.captures c where c.id = public.capture_audio_capture_of(name))
  );

revoke all on function public.capture_feed_audio_grant(uuid, text, text, bigint, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.capture_feed_audio_stored(uuid, text, text) from public, anon, authenticated;
revoke all on function public.capture_audio_settle(integer) from public, anon, authenticated;
revoke all on function public.capture_audio_due(integer) from public, anon, authenticated;
revoke all on function public.capture_audio_orphans(integer) from public, anon, authenticated;
revoke all on function public.capture_audio_capture_of(text) from public, anon;
grant execute on function public.capture_feed_audio_grant(uuid, text, text, bigint, bigint, bigint, text) to service_role;
grant execute on function public.capture_feed_audio_stored(uuid, text, text) to service_role;
grant execute on function public.capture_audio_settle(integer) to service_role;
grant execute on function public.capture_audio_due(integer) to service_role;
grant execute on function public.capture_audio_orphans(integer) to service_role;
-- The read policy runs as the person: they need to call it there (it answers only for a stored file's path).
grant execute on function public.capture_audio_capture_of(text) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
