-- ============================================================
-- 562: Push (the iOS app): the devices a person's notifications go to.
-- 563 counts the badge a push carries.
-- ============================================================
--   push_token        one row per app install: its APNs device token, the
--                     platform ('ios'), Apple's environment it was issued in
--                     ('sandbox' for a development build, 'production' for
--                     TestFlight and the App Store), the app's bundle id (the
--                     sender pushes only to its own topic), the device's
--                     name as its owner calls it, when the app last
--                     registered it, and when the sender stopped using it
--                     (Apple said it is gone: 410 or BadDeviceToken). Per
--                     person, not per workspace: one install gets every
--                     workspace's pushes, and each push names its workspace.
--                     A token is one install, so it belongs to one person at
--                     a time: a second person signing in on the same phone
--                     takes it over.
--                     No client reads or writes the table: the person's
--                     own app goes through the two functions below, and the
--                     sender (src/lib/push) uses the service role. Nobody
--                     reads another's tokens, nor their own (the app keeps
--                     its token itself).
--   push_token_register(token, environment, bundle_id, device_name)  the
--                     caller's install registered (or seen again: last seen
--                     moves, a stopped token starts again). A token another
--                     person had is the caller's now: the one row moves, so
--                     the previous person has no install left on that
--                     phone. A person keeps at most 10 live installs: past
--                     that, the ones seen longest ago are disabled
--                     ('Superseded'). The app registers on every signed-in
--                     launch and return while notifications are allowed, so
--                     last_seen_at is how recently the phone said it still
--                     wants pushes (the sender pushes only to installs seen
--                     within 30 days: src/lib/push/send.ts). Returns its id.
--   push_token_remove(token)  the caller's install taken off (sign-out, or
--                     notifications turned off in iOS Settings). True when
--                     there was one; never another person's.
--   push_token_forget(token)  an install taken off when the session has
--                     already ended (it expired, its refresh failed): no
--                     sign-in needed, so it is granted to anon too. The
--                     device token is the credential: only the phone that
--                     holds it (and the server) know it, and all it can do
--                     is stop pushes to that one phone. Nothing is read
--                     back. True when there was one.
--
-- Additive. Idempotent. Safe on a live database: one new table, no rows
-- touched elsewhere. No backslashes anywhere in this file (one MCP transport
-- decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.push_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- An APNs device token, as hex (32 bytes today; Apple may lengthen it).
  token text not null check (token ~ '^[0-9a-f]{64,200}$'),
  platform text not null default 'ios' check (platform in ('ios')),
  environment text not null check (environment in ('sandbox', 'production')),
  bundle_id text not null check (char_length(bundle_id) between 1 and 155 and bundle_id ~ '^[A-Za-z0-9.-]+$'),
  device_name text check (device_name is null or char_length(device_name) <= 100),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 60)
);

create unique index if not exists push_token_token_key on public.push_token (token);
create index if not exists push_token_user_live_idx on public.push_token (user_id) where disabled_at is null;

alter table public.push_token enable row level security;
revoke all on table public.push_token from public, anon, authenticated;
grant select, insert, update, delete on table public.push_token to service_role;

comment on table public.push_token is
  'The iOS app installs a person''s pushes go to (562): one row per APNs device token. Written by push_token_register and push_token_remove as the person, read and disabled by the sender (service role). No client reads it.';

-- The caller's install, registered or seen again.
create or replace function public.push_token_register(device_token text, token_environment text, app_bundle_id text, name_of_device text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  tok text := lower(btrim(coalesce(device_token, '')));
  id_out uuid;
begin
  if me is null then
    raise exception 'push: sign in first' using errcode = '42501';
  end if;
  if tok !~ '^[0-9a-f]{64,200}$' then
    raise exception 'push: that is not a device token' using errcode = '22023';
  end if;
  if token_environment is null or token_environment not in ('sandbox', 'production') then
    raise exception 'push: the environment is sandbox or production' using errcode = '22023';
  end if;
  insert into public.push_token (user_id, token, platform, environment, bundle_id, device_name)
  values (me, tok, 'ios', token_environment, btrim(coalesce(app_bundle_id, '')), nullif(left(btrim(coalesce(name_of_device, '')), 100), ''))
  on conflict (token) do update
     set user_id = excluded.user_id,
         environment = excluded.environment,
         bundle_id = excluded.bundle_id,
         device_name = excluded.device_name,
         last_seen_at = now(),
         disabled_at = null,
         disabled_reason = null
  returning id into id_out;
  -- At most 10 live installs a person: the ones seen longest ago stop.
  update public.push_token
     set disabled_at = now(), disabled_reason = 'Superseded'
   where user_id = me
     and disabled_at is null
     and id not in (
       select t.id from public.push_token t
        where t.user_id = me and t.disabled_at is null
        order by t.last_seen_at desc, t.created_at desc
        limit 10
     );
  return id_out;
end;
$$;

-- The caller's install taken off. Never another person's.
create or replace function public.push_token_remove(device_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then
    raise exception 'push: sign in first' using errcode = '42501';
  end if;
  delete from public.push_token
   where token = lower(btrim(coalesce(device_token, '')))
     and user_id = me;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- An install taken off once its session has ended: by its token alone.
create or replace function public.push_token_forget(device_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tok text := lower(btrim(coalesce(device_token, '')));
  n integer;
begin
  if tok !~ '^[0-9a-f]{64,200}$' then
    return false;
  end if;
  delete from public.push_token where token = tok;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.push_token_register(text, text, text, text) from public, anon;
revoke all on function public.push_token_remove(text) from public, anon;
grant execute on function public.push_token_register(text, text, text, text) to authenticated;
grant execute on function public.push_token_remove(text) to authenticated;
-- Explicitly anon too (the session is gone when it is called); its header says why.
revoke all on function public.push_token_forget(text) from public;
grant execute on function public.push_token_forget(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
