-- One description of a Supabase database, as lines of
--   <section> <TAB> <item> <TAB> <value>
-- 04-verify.sh runs this on the hosted project and on this stack and compares
-- the two outputs line by line. Read-only.
--
-- psql variables:
--   :deep     true to add a checksum of each table's content to its row count
--   :managed  the quoted schema list from lib.sh (auth, storage, realtime)
--
-- Two groups of schemas are told apart throughout:
--   skipped   system schemas, and the ones `supabase db dump` moves nothing
--             of: each side builds and fills them itself
--   managed   auth, storage, realtime: their DATA is moved (auth, storage),
--             their tables belong to the services, and only what the app
--             added to them (policies, triggers) is compared
\set QUIET on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '\t'
-- The same rendering of every value on both sides.
set timezone = 'UTC';
set datestyle = 'ISO, MDY';
set intervalstyle = 'postgres';
set extra_float_digits = 1;
set bytea_output = 'hex';
set search_path = '';
set statement_timeout = 0;
set client_min_messages = warning;

create temp table skipped (s text primary key);
insert into skipped values
  ('information_schema'), ('graphql'), ('graphql_public'), ('pgsodium'), ('pgsodium_masks'),
  ('pgtle'), ('repack'), ('vault'), ('etl'), ('extensions'), ('pgbouncer'),
  ('supabase_migrations'), ('_analytics'), ('_realtime'), ('_supavisor'), ('net'), ('cron'),
  ('pgmq'), ('dbdev'), ('topology'), ('tiger'), ('tiger_data'), ('ni_migrate'),
  -- The freeze (freeze.sql): the hosted project's own state for the move,
  -- reported in one line at the end and otherwise left out of every section.
  ('ni_freeze');

-- Every schema that is neither skipped nor a system one, and whether it is
-- managed. supabase_functions counts as managed here: its one table of data
-- is moved, its structure is the platform's.
create temp table sch as
select n.oid, n.nspname as s, n.nspname in (:managed, 'supabase_functions') as managed
from pg_catalog.pg_namespace n
where n.nspname !~ '^pg_' and n.nspname not in (select s from skipped);

-- The columns that a managed table has on BOTH sides. 04-verify.sh works the
-- list out from the two databases and puts it in front of this file; run
-- without it, the table is empty and whole rows are compared.
create temp table if not exists common_col (s text, t text, c text);

-- Tables whose rows are compared: everything in those schemas except
-- realtime's (not moved), the three bookkeeping tables the dump excludes, and
-- tables that belong to an extension.
create temp table tab as
select c.oid, sch.s, c.relname as t, sch.managed
from pg_catalog.pg_class c
join sch on sch.oid = c.relnamespace
where c.relkind in ('r', 'p') and not c.relispartition
  and sch.s <> 'realtime'
  and (sch.s, c.relname) not in (('auth', 'schema_migrations'), ('storage', 'migrations'), ('supabase_functions', 'migrations'))
  and not exists (select 1 from pg_catalog.pg_depend d
                  where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.objid = c.oid and d.deptype = 'e');

-- 1. Row counts for every table (and, with :deep, a checksum of the content:
--    the md5 of every row's md5, sorted, so the order of rows does not matter).
--    storage.objects is counted here and compared column by column below.
--
--    A table of the app is checksummed whole. A table of Auth or Storage is
--    checksummed over the columns both sides have, in name order: the
--    platform's services can be a version ahead of this release's and have a
--    column more, and that alone must not read as "the data differs".
select 'rows', tab.s || '.' || tab.t,
       case
         when not pg_catalog.has_table_privilege(tab.oid, 'SELECT') then 'cannot be read by this role'
         else (pg_catalog.xpath('/row/v/text()', pg_catalog.query_to_xml(
                case
                  when :deep and not (tab.s = 'storage' and tab.t = 'objects') then
                    pg_catalog.format(
                      'select count(*) || '' rows, content '' || md5(coalesce(string_agg(h, '''' order by h), '''')) as v from (select md5(%s::text) as h from %I.%I x) y',
                      coalesce((select 'row(' || pg_catalog.string_agg(pg_catalog.format('x.%I', cc.c), ', ' order by cc.c) || ')'
                                from common_col cc where tab.managed and cc.s = tab.s and cc.t = tab.t), 'x'),
                      tab.s, tab.t)
                  else pg_catalog.format('select count(*) || '' rows'' as v from %I.%I', tab.s, tab.t)
                end, false, true, '')))[1]::text
       end
from tab
order by 2;
-- The columns of each Auth and Storage table. A difference here says the two
-- sides run different versions of that service; it is not a difference in data.
select 'service table columns', tab.s || '.' || tab.t,
       (select pg_catalog.string_agg(a.attname, ', ' order by a.attname)
        from pg_catalog.pg_attribute a where a.attrelid = tab.oid and a.attnum > 0 and not a.attisdropped)
from tab where tab.managed
order by 2;

-- 2. The accounts, spelled out: these two are the ones that must not be off by one.
select 'accounts', 'auth.users',
       count(*) || ' users, ' || count(*) filter (where encrypted_password is not null and encrypted_password <> '') || ' with a password, '
       || count(*) filter (where email_confirmed_at is not null) || ' confirmed, checksum '
       || md5(coalesce(string_agg(md5(id::text || '|' || coalesce(email, '') || '|' || coalesce(encrypted_password, '') || '|' || coalesce(phone, '')
                                      || '|' || created_at::text || '|' || coalesce(raw_app_meta_data::text, '') || '|' || coalesce(raw_user_meta_data::text, '')),
                                  '' order by id), ''))
from auth.users;
select 'accounts', 'auth.identities',
       count(*) || ' identities (' || coalesce((select pg_catalog.string_agg(p || ' ' || n, ', ' order by p)
                                                from (select provider as p, count(*) as n from auth.identities group by provider) g), 'none')
       || '), checksum '
       || md5(coalesce(string_agg(md5(id::text || '|' || user_id::text || '|' || provider || '|' || provider_id || '|' || coalesce(identity_data::text, '')),
                                  '' order by id), ''))
from auth.identities;
select 'accounts', 'sessions and refresh tokens',
       (select count(*) from auth.sessions) || ' sessions, '
       || (select count(*) from auth.refresh_tokens where not revoked) || ' live refresh tokens';

-- 3. Storage: buckets, then one line per file record. `version` (the file's
--    name on disk) and the last-modified time are left out: the copy changes them.
select 'buckets', id,
       'public ' || public || ', size limit ' || coalesce(file_size_limit::text, 'none')
       || ', types ' || coalesce(allowed_mime_types::text, 'any')
from storage.buckets order by id;
select 'files per bucket', b.id,
       count(o.id) || ' files, ' || coalesce(sum((o.metadata ->> 'size')::bigint), 0) || ' bytes'
from storage.buckets b left join storage.objects o on o.bucket_id = b.id
group by b.id order by b.id;
select 'file records', bucket_id || '/' || name,
       'id ' || id || ', owner ' || coalesce(owner::text, '-') || '/' || coalesce(owner_id, '-')
       || ', size ' || coalesce(metadata ->> 'size', '-') || ', etag ' || coalesce(metadata ->> 'eTag', '-')
       || ', type ' || coalesce(metadata ->> 'mimetype', '-') || ', cache ' || coalesce(metadata ->> 'cacheControl', '-')
       || ', user metadata ' || coalesce(user_metadata::text, 'null')
       || ', created ' || created_at || ', updated ' || updated_at
from storage.objects order by 2;

-- 4. Extensions and their versions.
select 'extensions', e.extname, e.extversion || ' in schema ' || n.nspname
from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace
order by 2;

-- 5. Publications: their settings and every table in them.
select 'publications', p.pubname,
       'all tables ' || p.puballtables || ', insert ' || p.pubinsert || ', update ' || p.pubupdate
       || ', delete ' || p.pubdelete || ', truncate ' || p.pubtruncate
       || ', ' || (select count(*) from pg_catalog.pg_publication_tables t where t.pubname = p.pubname) || ' tables'
from pg_catalog.pg_publication p
where p.pubname !~ '^supabase_realtime_' -- Realtime's own, made by the service
order by 2;
select 'publication tables', t.pubname || ': ' || t.schemaname || '.' || t.tablename, 'present'
from pg_catalog.pg_publication_tables t
where t.pubname !~ '^supabase_realtime_'
order by 2;

-- 6. Row-level security: the number of policies, each policy, and each table's switch.
select 'policies', 'number of policies', count(*)::text
from pg_catalog.pg_policies p where p.schemaname in (select s from sch) and p.policyname not like 'ni\_freeze\_%';
select 'policies', p.schemaname || '.' || p.tablename || ': ' || p.policyname,
       p.permissive || ' ' || p.cmd || ' to ' || pg_catalog.array_to_string(p.roles, ',')
       || ' using ' || coalesce(pg_catalog.regexp_replace(p.qual, '\s+', ' ', 'g'), '-')
       || ' with check ' || coalesce(pg_catalog.regexp_replace(p.with_check, '\s+', ' ', 'g'), '-')
from pg_catalog.pg_policies p
where p.schemaname in (select s from sch) and p.policyname not like 'ni\_freeze\_%'
order by 2;
select 'row-level security', tab.s || '.' || tab.t,
       case when c.relrowsecurity then 'on' else 'OFF' end || case when c.relforcerowsecurity then ', forced' else '' end
from tab join pg_catalog.pg_class c on c.oid = tab.oid
where not tab.managed
order by 2;

-- 7. Triggers. In the managed schemas only the app's (those that call a
--    function from outside them); the services' own differ by version.
select 'triggers', n.nspname || '.' || c.relname || ': ' || t.tgname,
       'state ' || t.tgenabled::text || ', ' || pg_catalog.regexp_replace(pg_catalog.pg_get_triggerdef(t.oid, false), '\s+', ' ', 'g')
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
where not t.tgisinternal
  and n.nspname in (select s from sch)
  and (n.nspname not in (:managed) or pn.nspname not in (:managed))
  and t.tgname not like 'ni\_freeze\_%'
order by 2;

-- From here on: the app's own schemas only.
-- 8. Tables: columns (name, type, null, default, generated), then every
--    constraint in full. Postgres writes an expression back in its own words,
--    so a CHECK that differs only in its brackets is the same rule.
select 'table columns', tab.s || '.' || tab.t,
       (select count(*) from pg_catalog.pg_attribute a where a.attrelid = tab.oid and a.attnum > 0 and not a.attisdropped) || ' columns '
       || md5(coalesce((select pg_catalog.string_agg(
                 a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || a.attidentity::text || a.attgenerated::text
                 || ' ' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ';' order by a.attnum)
               from pg_catalog.pg_attribute a
               left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
               where a.attrelid = tab.oid and a.attnum > 0 and not a.attisdropped), ''))
from tab where not tab.managed
order by 2;
select 'constraints', tab.s || '.' || tab.t || ': ' || k.conname,
       pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(k.oid), '\s+', ' ', 'g')
       || case when k.convalidated then '' else ' NOT VALID' end
from tab join pg_catalog.pg_constraint k on k.conrelid = tab.oid
where not tab.managed
order by 2;

-- 9. Indexes, views, functions (with who may call them), types and sequences.
select 'indexes', i.schemaname || '.' || i.indexname, md5(i.indexdef)
from pg_catalog.pg_indexes i
where i.schemaname in (select s from sch where not managed)
order by 2;
select 'views', n.nspname || '.' || c.relname,
       case c.relkind when 'm' then 'materialized ' else '' end || md5(pg_catalog.pg_get_viewdef(c.oid))
       || ' options ' || coalesce(c.reloptions::text, '-')
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v', 'm') and n.nspname in (select s from sch where not managed)
  and not exists (select 1 from pg_catalog.pg_depend d
                  where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.objid = c.oid and d.deptype = 'e')
order by 2;
select 'functions', p.oid::pg_catalog.regprocedure::text,
       case when p.prokind in ('f', 'p') then md5(pg_catalog.pg_get_functiondef(p.oid)) else md5(p.prosrc) end
       || ' callable by '
       || coalesce((select pg_catalog.string_agg(g.who, ',' order by g.who)
                    from (select distinct case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end as who
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) x
                          where x.privilege_type = 'EXECUTE') g), 'nobody')
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname in (select s from sch where not managed)
  and not exists (select 1 from pg_catalog.pg_depend d
                  where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e')
order by 2;
select 'types', n.nspname || '.' || t.typname,
       md5((select pg_catalog.string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid = t.oid))
from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
where t.typtype = 'e' and n.nspname in (select s from sch where not managed)
order by 2;
-- Counters: a sequence left behind hands out ids that are already taken.
select 'sequences', q.schemaname || '.' || q.sequencename, coalesce(q.last_value::text, 'not used yet')
from pg_catalog.pg_sequences q
where q.schemaname in (select s from sch) and q.schemaname <> 'realtime'
order by 2;

-- 10. Who may do what to each table of the app.
select 'table grants', tab.s || '.' || tab.t,
       coalesce((select pg_catalog.string_agg(g.what, ',' order by g.what)
                 from (select distinct case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end
                                       || ':' || x.privilege_type as what
                       from pg_catalog.aclexplode(c.relacl) x) g), 'owner only')
from tab join pg_catalog.pg_class c on c.oid = tab.oid
where not tab.managed
order by 2;

-- 11. Settings stored on roles and on the database, custom roles, cron jobs,
--     and what is known not to move.
select 'role settings', coalesce(r.rolname, 'every role') || coalesce(' in ' || d.datname, ''),
       pg_catalog.array_to_string(array(select c from pg_catalog.unnest(s.setconfig) c
                                        where c <> 'pgrst.db_pre_request=ni_freeze.refuse_writes'), ', ')
from pg_catalog.pg_db_role_setting s
left join pg_catalog.pg_roles r on r.oid = s.setrole
left join pg_catalog.pg_database d on d.oid = s.setdatabase
where coalesce(d.datname, pg_catalog.current_database()) = pg_catalog.current_database()
order by 2;
select 'custom roles', r.rolname,
       'login ' || r.rolcanlogin || ', bypasses row-level security ' || r.rolbypassrls
       || ', member of ' || coalesce((select pg_catalog.string_agg(g.rolname, ',' order by g.rolname)
                                      from pg_catalog.pg_auth_members m join pg_catalog.pg_roles g on g.oid = m.roleid
                                      where m.member = r.oid), 'nothing')
from pg_catalog.pg_roles r
where r.rolname !~ '^(pg_|supabase_|pgsodium_|pgtle_|cli_login_)'
  and r.rolname not in ('postgres', 'anon', 'authenticated', 'authenticator', 'service_role', 'dashboard_user', 'pgbouncer')
order by 2;
\if :has_cron
select 'cron jobs', coalesce(j.jobname, 'job without a name: ' || md5(j.command)),
       j.schedule || case when j.active then ', active, ' else ', PAUSED, ' end || md5(j.command) || ', as ' || j.username
from cron.job j order by 2;
\endif
\if :has_vault
select 'not moved by any step', 'secrets in the vault', count(*)::text from vault.secrets;
\endif
-- The freeze, in one line. At the real switch the hosted side must say "on"
-- and this side "off": 02-restore.sh takes it off the copy.
select 'not moved by any step', 'the freeze (changes refused)',
       coalesce(nullif(pg_catalog.concat_ws(', ',
         case when exists (select 1 from pg_catalog.pg_db_role_setting s
                           join pg_catalog.pg_roles r on r.oid = s.setrole
                           cross join lateral pg_catalog.unnest(s.setconfig) c
                           where r.rolname = 'authenticator' and s.setdatabase = 0
                             and c = 'pgrst.db_pre_request=ni_freeze.refuse_writes')
              then 'Data API' end,
         case when exists (select 1 from pg_catalog.pg_policy p
                           where p.polrelid = pg_catalog.to_regclass('storage.objects') and p.polname like 'ni\_freeze\_%')
              then 'Storage policies' end,
         case when exists (select 1 from pg_catalog.pg_trigger t
                           where t.tgrelid = pg_catalog.to_regclass('storage.objects') and t.tgname = 'ni_freeze_objects')
              then 'Storage trigger' end,
         case when exists (select 1 from pg_catalog.pg_trigger t
                           where t.tgrelid = pg_catalog.to_regclass('auth.users') and t.tgname = 'ni_freeze_users')
              then 'accounts' end), ''), 'off');
select 'not moved by any step', 'event triggers of the app', count(*)::text
from pg_catalog.pg_event_trigger e
join pg_catalog.pg_proc p on p.oid = e.evtfoid
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname in (select s from sch where not managed);
