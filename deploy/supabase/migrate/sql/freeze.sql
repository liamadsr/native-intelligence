-- Puts a Supabase project into a state where it refuses changes, and can be
-- put back with thaw.sql. Run by freeze-hosted.sh against the HOSTED project,
-- as its postgres role. Nothing here touches a row of the app's data.
--
-- Why: from the moment the final dump is taken, anything written to the
-- hosted project is left behind, and lost on the day that project is retired.
-- Closing Caddy's door stops what comes through sb.<domain>; this stops what
-- does not (an old build of an app, a setting that was never moved), and
-- makes it fail where the person can see it instead of quietly succeeding.
--
-- Four parts, each on its own, each named ni_freeze… so that the dump, the
-- restore and the verification can tell them from the app's own objects:
--
--   1. Data API   a pre-request function that answers 503 to everything
--                 except reads (GET, HEAD, OPTIONS). This is PostgREST's own
--                 mechanism and the one Supabase documents for hosted
--                 projects ("Configure a pre-request function" in their
--                 guide "Securing your API"). It covers REST, RPC and GraphQL,
--                 whatever key is used, and takes effect at once.
--   2. Storage    three restrictive policies on storage.objects: no insert,
--                 update or delete for anyone who is subject to row-level
--                 security. That is every signed-in user; it is not the
--                 service role.
--   3. Storage    a trigger on storage.objects that refuses every insert,
--                 update and delete, the service role's too.
--   4. Accounts   a trigger on auth.users that refuses every change: no
--                 sign-up, no sign-in (a sign-in records its time on the
--                 user), no password or profile change. Sessions that are
--                 already open keep refreshing; their writes are refused by
--                 parts 1 to 3.
--
-- Parts 2 to 4 need rights on tables that belong to Storage and Auth. The
-- Postgres image gives the postgres role exactly those (supautils'
-- policy_grants and drop_trigger_grants name both tables), and this project
-- already has triggers of its own on auth.users. Whether the hosted platform
-- is configured the same way is not something this repository can know, so:
-- REHEARSE ON THE DEV PROJECT FIRST (freeze-hosted.sh on, then off).
-- A part that is refused says so and the rest still applies.
--
-- For parts 3 and 4, a trigger that could be created but not dropped would be
-- a freeze nobody can undo. So each is tried first with a trigger that does
-- nothing: created, then dropped. Only if the drop works is the real one made.
\set QUIET on
set client_min_messages = warning;

-- The project may have a pre-request function of its own. Replacing it would
-- switch off whatever it checks, so that is refused.
do $ni$
declare cur text;
begin
  select pg_catalog.split_part(c, '=', 2) into cur
  from pg_catalog.pg_db_role_setting s
  join pg_catalog.pg_roles r on r.oid = s.setrole
  cross join lateral pg_catalog.unnest(s.setconfig) c
  where r.rolname = 'authenticator' and s.setdatabase = 0 and c like 'pgrst.db_pre_request=%';
  if cur is not null and cur <> 'ni_freeze.refuse_writes' then
    raise exception 'the Data API already has a pre-request function (%). Freezing would replace it; nothing was changed.', cur;
  end if;
end
$ni$;

-- Part 1: the Data API.
create schema if not exists ni_freeze;
comment on schema ni_freeze is 'The freeze put on this project for its move (deploy/supabase/migrate/sql/freeze.sql). Removed by thaw.sql.';

create or replace function ni_freeze.refuse_writes() returns void
language plpgsql as $f$
begin
  if coalesce(pg_catalog.current_setting('request.method', true), '') not in ('GET', 'HEAD', 'OPTIONS') then
    raise sqlstate 'PGRST' using
      message = pg_catalog.json_build_object(
        'code', 'NI503',
        'message', 'This project has moved and no longer accepts changes. Update the app.',
        'details', null, 'hint', null)::text,
      detail = pg_catalog.json_build_object('status', 503, 'headers', pg_catalog.json_build_object())::text;
  end if;
end
$f$;

create or replace function ni_freeze.refuse() returns trigger
language plpgsql as $f$
begin
  raise exception 'This project has moved and no longer accepts changes.' using errcode = 'P0001';
end
$f$;

create or replace function ni_freeze.nothing() returns trigger
language plpgsql as $f$
begin
  return null;
end
$f$;

grant usage on schema ni_freeze to anon, authenticated, service_role;
grant execute on function ni_freeze.refuse_writes() to anon, authenticated, service_role;
alter role authenticator set pgrst.db_pre_request = 'ni_freeze.refuse_writes';
notify pgrst, 'reload config';

-- Part 2: Storage, for everyone under row-level security.
do $ni$
begin
  drop policy if exists ni_freeze_insert on storage.objects;
  drop policy if exists ni_freeze_update on storage.objects;
  drop policy if exists ni_freeze_delete on storage.objects;
  create policy ni_freeze_insert on storage.objects as restrictive for insert to public with check (false);
  create policy ni_freeze_update on storage.objects as restrictive for update to public using (false);
  create policy ni_freeze_delete on storage.objects as restrictive for delete to public using (false);
exception when others then
  raise warning 'NOT APPLIED, part 2 (Storage policies): %', sqlerrm;
end
$ni$;

-- Parts 3 and 4: the triggers, each tried with a harmless one first.
do $ni$
declare
  t record;
begin
  for t in select * from (values (3, 'storage.objects', 'ni_freeze_objects'), (4, 'auth.users', 'ni_freeze_users')) v(part, tab, trig)
  loop
    begin
      execute pg_catalog.format('drop trigger if exists %I on %s', t.trig, t.tab);
      execute pg_catalog.format('drop trigger if exists ni_freeze_probe on %s', t.tab);
      execute pg_catalog.format('create trigger ni_freeze_probe before truncate on %s for each statement execute function ni_freeze.nothing()', t.tab);
      execute pg_catalog.format('drop trigger ni_freeze_probe on %s', t.tab);
      execute pg_catalog.format('create trigger %I before insert or update or delete on %s for each statement execute function ni_freeze.refuse()', t.trig, t.tab);
    exception when others then
      raise warning 'NOT APPLIED, part % (trigger on %): %', t.part, t.tab, sqlerrm;
    end;
  end loop;
end
$ni$;
