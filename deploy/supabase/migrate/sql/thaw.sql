-- Takes off everything freeze.sql put on. Safe to run on a project that was
-- never frozen: every statement is "if exists".
--
-- Used in three places:
--   freeze-hosted.sh off   on the hosted project: the first step of going back
--   02-restore.sh          on this stack, inside the restore's transaction.
--                          A dump taken while the hosted project is frozen
--                          carries the freeze's schema and the role setting
--                          that switches it on, and this stack must not start
--                          its life frozen.
--   by hand                pasted into the hosted project's SQL editor, which
--                          needs no stored credentials
\set QUIET on
set client_min_messages = warning;

do $ni$
declare
  t record;
begin
  -- The triggers and policies sit on tables that only exist with Auth and
  -- Storage, and each drop stands alone: one that is refused must not keep
  -- the others from happening.
  for t in select * from (values
      ('drop trigger if exists ni_freeze_users on auth.users'),
      ('drop trigger if exists ni_freeze_probe on auth.users'),
      ('drop trigger if exists ni_freeze_objects on storage.objects'),
      ('drop trigger if exists ni_freeze_probe on storage.objects'),
      ('drop policy if exists ni_freeze_insert on storage.objects'),
      ('drop policy if exists ni_freeze_update on storage.objects'),
      ('drop policy if exists ni_freeze_delete on storage.objects')) v(stmt)
  loop
    begin
      execute t.stmt;
    exception when others then
      raise warning 'NOT REMOVED (%): %', t.stmt, sqlerrm;
    end;
  end loop;
end
$ni$;

-- Only ours: a pre-request function of the project's own is left alone.
do $ni$
begin
  if exists (
    select 1
    from pg_catalog.pg_db_role_setting s
    join pg_catalog.pg_roles r on r.oid = s.setrole
    cross join lateral pg_catalog.unnest(s.setconfig) c
    where r.rolname = 'authenticator' and s.setdatabase = 0
      and c = 'pgrst.db_pre_request=ni_freeze.refuse_writes') then
    alter role authenticator reset pgrst.db_pre_request;
  end if;
end
$ni$;
notify pgrst, 'reload config';

drop schema if exists ni_freeze cascade;
