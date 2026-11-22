-- DB-level test for migration 691 (project_priority): projects.priority holds
-- the actions' five values or null, and nothing else.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/691_project_priority.sql
-- Prints "691 project_priority: all checks passed". Everything runs in one
-- transaction that is rolled back. Made-up rows only. A failed check raises.

begin;

-- Triggers and foreign keys are skipped throughout (a bare project, no
-- workspace); a check constraint is enforced all the same.
set local session_replication_role = replica;
insert into public.projects (id, user_id, name, workspace_id)
values ('69100000-0000-4000-8000-000000000001', '69100000-0000-4000-8000-0000000000a1', 'Priority check', '69100000-0000-4000-8000-0000000000b1');

do $t$
declare
  v text;
begin
  foreach v in array array['none', 'low', 'medium', 'high', 'urgent'] loop
    update public.projects set priority = v where id = '69100000-0000-4000-8000-000000000001';
  end loop;
  update public.projects set priority = null where id = '69100000-0000-4000-8000-000000000001';

  foreach v in array array['p1', 'High', ' high', 'critical', ''] loop
    begin
      update public.projects set priority = v where id = '69100000-0000-4000-8000-000000000001';
      raise exception 'priority % was accepted', quote_literal(v);
    exception when check_violation then
      null;
    end;
  end loop;
end
$t$;

select '691 project_priority: all checks passed' as result;

rollback;
