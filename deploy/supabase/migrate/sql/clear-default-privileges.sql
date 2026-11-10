-- Run first, inside the restore's transaction, as the role that restores.
--
-- pg_dump writes each object's grants as the difference from Postgres's
-- built-in default. A new Supabase database has default privileges of its own
-- on top of that: whatever the postgres role creates in `public` is granted to
-- anon and authenticated at once. Left in place, every table, sequence and
-- function in schema.sql comes out with those grants added to the ones the
-- dump gives it, including the ones the app revoked on purpose. In the
-- rehearsal that was 129 tables and 220 functions open to roles the hosted
-- project keeps them from.
--
-- So the restoring role's default privileges are cleared in every schema the
-- dump creates objects in, before anything is created. schema.sql ends with
-- the hosted project's own ALTER DEFAULT PRIVILEGES statements, which put
-- back exactly what it has. web/scripts/db-baseline-regenerate.mjs does the
-- same for the baseline, for the same reason.
--
-- :managed is the quoted schema list from lib.sh. The schemas left alone are
-- the ones the dump creates nothing in.
select pg_catalog.format(
         'alter default privileges for role %I in schema %I revoke all on %s from %s',
         pg_catalog.pg_get_userbyid(d.defaclrole), n.nspname,
         case d.defaclobjtype
           when 'r' then 'tables' when 'S' then 'sequences'
           when 'f' then 'functions' when 'T' then 'types'
         end,
         pg_catalog.string_agg(distinct
           case when a.grantee = 0 then 'public'
                else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) end, ', '))
from pg_catalog.pg_default_acl d
join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
cross join lateral pg_catalog.aclexplode(d.defaclacl) a
where pg_catalog.pg_get_userbyid(d.defaclrole) = current_user
  and d.defaclobjtype in ('r', 'S', 'f', 'T')
  and n.nspname !~ '^pg_'
  and n.nspname not in (:managed)
  and n.nspname not in ('information_schema', 'extensions', 'graphql', 'graphql_public', 'vault',
                        'cron', 'net', 'pgbouncer', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgmq',
                        'supabase_functions', 'supabase_migrations', '_analytics', '_realtime', '_supavisor')
group by d.defaclrole, n.nspname, d.defaclobjtype
order by 1
\gexec
