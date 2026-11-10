-- One line per part of the freeze: <part> <TAB> on|off. Read-only.
-- Used by freeze-hosted.sh, 00-preflight.sh and (as one line) verify.sql.
select part, state from (
select 1 as o, 'Data API (pre-request function)' as part,
       case when exists (
         select 1 from pg_catalog.pg_db_role_setting s
         join pg_catalog.pg_roles r on r.oid = s.setrole
         cross join lateral pg_catalog.unnest(s.setconfig) c
         where r.rolname = 'authenticator' and s.setdatabase = 0
           and c = 'pgrst.db_pre_request=ni_freeze.refuse_writes')
         and pg_catalog.to_regprocedure('ni_freeze.refuse_writes()') is not null
       then 'on' else 'off' end
union all
select 2 as o, 'Storage, signed-in users (policies)',
       case (select count(*) from pg_catalog.pg_policy p
             where p.polrelid = pg_catalog.to_regclass('storage.objects') and p.polname like 'ni\_freeze\_%')
         when 3 then 'on' when 0 then 'off' else 'PARTLY' end
union all
select 3 as o, 'Storage, everyone (trigger)',
       case when exists (select 1 from pg_catalog.pg_trigger t
                         where t.tgrelid = pg_catalog.to_regclass('storage.objects') and t.tgname = 'ni_freeze_objects' and t.tgenabled <> 'D')
       then 'on' else 'off' end
union all
select 4 as o, 'Accounts (trigger on auth.users)',
       case when exists (select 1 from pg_catalog.pg_trigger t
                         where t.tgrelid = pg_catalog.to_regclass('auth.users') and t.tgname = 'ni_freeze_users' and t.tgenabled <> 'D')
       then 'on' else 'off' end
) s (o, part, state)
order by o;
