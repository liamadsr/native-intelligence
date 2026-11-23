-- DB-level test for migration 695 (github_notifications): the notification
-- checks take the three GitHub types and the github_pr target and keep the
-- rest; github_pull_request is the service role's alone (RLS on, no
-- policies, grants revoked) and keeps repo names lower case.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/695_github_notifications.sql
-- One transaction, rolled back. Rehearsed on a local Postgres 16 with the
-- baseline's notification table: 5 checks passed.

begin;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.com');
insert into workspace (id, name, slug) values ('11111111-0000-0000-0000-000000000001', 'One', 'one-695-test');
insert into member (id, user_id, workspace_id, role, display_name) values ('22222222-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'owner', 'A');
create temp table results (name text, ok boolean);
grant all on results to authenticated, service_role;
insert into notification (workspace_id, recipient_id, type, title, target_type) values ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-00000000000a', 'github_review_requested', 't', 'github_pr');
insert into notification (workspace_id, recipient_id, type, title, target_type) values ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-00000000000a', 'record_shared', 't', 'canvas');
insert into results values ('new types and github_pr accepted, old ones kept', true);
do $$ begin insert into notification (workspace_id, recipient_id, type, title) values ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-00000000000a', 'github_bogus', 't'); insert into results values ('unknown type refused', false); exception when check_violation then insert into results values ('unknown type refused', true); end $$;
set local role service_role; select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into github_pull_request (repo_full_name, pr_number, author_github_id, head_sha) values ('acme/app', 7, 101, 'aaa');
reset role; select set_config('request.jwt.claims', '', true);
do $$ begin insert into github_pull_request (repo_full_name, pr_number) values ('Acme/App', 8); insert into results values ('repo kept lower case', false); exception when check_violation then insert into results values ('repo kept lower case', true); end $$;
set local role authenticated; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
do $$ begin perform 1 from github_pull_request; insert into results values ('a person cannot read github_pull_request', false); exception when insufficient_privilege then insert into results values ('a person cannot read github_pull_request', true); end $$;
do $$ begin insert into github_pull_request (repo_full_name, pr_number) values ('acme/x', 1); insert into results values ('a person cannot write github_pull_request', false); exception when insufficient_privilege then insert into results values ('a person cannot write github_pull_request', true); end $$;
reset role; select set_config('request.jwt.claims', '', true);
do $$ declare bad text; begin
  select string_agg(name, '; ') into bad from results where not ok;
  if bad is not null then raise exception '695 github_notifications failed: %', bad; end if;
  raise notice '695 github_notifications: all % checks passed', (select count(*) from results);
end $$;

rollback;
