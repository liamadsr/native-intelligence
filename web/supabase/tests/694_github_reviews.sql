-- DB-level test for migration 694 (github_reviews): who reads and writes the
-- pull-request automation's tables (docs/plans/github-reviews.md, phase 2).
--   - github_identity: a person reads their own row only, writes none; it goes
--     with their last GitHub connection.
--   - workspace_github_repo: members read, owners and admins add (as
--     themselves, lower case, one row per repo) and remove, in their own
--     workspace only.
--   - action_github_branch: read as its action is (a private team's stays its
--     members'); no client writes.
--   - action_github_pr: a member still links and renames, but can't write the
--     automation's memory (status_before_id, auto_step, author...).
--   - team.github_automation: owners, admins and leads only (the team policy).
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/694_github_reviews.sql
-- Prints "694 github_reviews: all N checks passed". One transaction, rolled
-- back. Made-up people only (example.com). A failed check raises.
-- Rehearsed on a local Postgres 16 holding the baseline's definitions of the
-- tables, functions and policies it touches (no other triggers), with
-- Supabase's roles, auth.uid() and _wsmerge_active() stood in: 24 checks passed.

begin;

-- Fixtures (as postgres): A owns ws1, B is a member of ws1, C owns ws2. Both workspaces have a team ENG.
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','a@example.com'),('00000000-0000-0000-0000-00000000000b','b@example.com'),('00000000-0000-0000-0000-00000000000c','c@example.com');
insert into workspace (id,name,slug) values ('11111111-0000-0000-0000-000000000001','One','one'),('11111111-0000-0000-0000-000000000002','Two','two');
insert into member (id,user_id,workspace_id,role,display_name) values
 ('22222222-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','owner','A'),
 ('22222222-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000001','member','B'),
 ('22222222-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c','11111111-0000-0000-0000-000000000002','owner','C');
insert into team (id,workspace_id,name,slug,issue_prefix,is_private) values
 ('33333333-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Eng','eng','ENG',false),
 ('33333333-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','Secret','sec','SEC',true),
 ('33333333-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000002','Eng','eng','ENG',false);
insert into team_member (team_id, member_id, team_role) values ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-00000000000a','lead');
insert into workflow_state (id,team_id,name,category,sort_order) values
 ('44444444-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','Ready','unstarted',1),
 ('44444444-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000002','Ready','unstarted',1),
 ('44444444-0000-0000-0000-000000000003','33333333-0000-0000-0000-000000000003','Ready','unstarted',1);
insert into actions (id,user_id,title,workspace_id,team_id,status_id,identifier) values
 ('55555555-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','Public','11111111-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000001','ENG-1'),
 ('55555555-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','Private','11111111-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000002','SEC-1'),
 ('55555555-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000000c','Other ws','11111111-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000003','ENG-1');
insert into connected_account (id,user_id,workspace_id,provider,capability,account_email) values
 ('66666666-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','github','github','a@github'),
 ('66666666-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000002','github','github','a2@github');
-- Server-side writes (service role)
set local role service_role; select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into github_identity (user_id, github_user_id, login) values ('00000000-0000-0000-0000-00000000000a', 101, 'aa'), ('00000000-0000-0000-0000-00000000000b', 102, 'bb');
insert into action_github_branch (workspace_id, action_id, repo_full_name, branch) values
 ('11111111-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001','acme/app','eng-1-x'),
 ('11111111-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000002','acme/app','sec-1-x');
insert into action_github_pr (workspace_id, action_id, pr_url, repo_full_name, pr_number, author_github_id, auto_step) values
 ('11111111-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001','https://github.com/acme/app/pull/1','acme/app',1,101,'review');
reset role; select set_config('request.jwt.claims', '', true);

create temp table results (name text, ok boolean);
grant all on results to authenticated, service_role;

-- B (member of ws1, not on the private team)
set local role authenticated; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
insert into results select 'B reads only own identity', (select array_agg(login order by login) from github_identity) = array['bb'];
insert into results select 'B sees the public branch only', (select array_agg(branch) from action_github_branch) = array['eng-1-x'];
do $$ begin insert into github_identity values ('00000000-0000-0000-0000-00000000000b', 999, 'evil'); insert into results values ('B cannot write identity', false); exception when insufficient_privilege then insert into results values ('B cannot write identity', true); end $$;
do $$ begin update github_identity set login='x'; insert into results values ('B cannot update identity', false); exception when insufficient_privilege then insert into results values ('B cannot update identity', true); end $$;
do $$ begin insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000001','acme/app','00000000-0000-0000-0000-00000000000b'); insert into results values ('member cannot add a repo', false); exception when insufficient_privilege then insert into results values ('member cannot add a repo', true); end $$;
do $$ begin update action_github_pr set status_before_id = '44444444-0000-0000-0000-000000000001'; insert into results values ('member cannot forge automation memory', false); exception when insufficient_privilege then insert into results values ('member cannot forge automation memory', true); end $$;
do $$ begin update action_github_pr set auto_step = null; insert into results values ('member cannot clear auto_step', false); exception when insufficient_privilege then insert into results values ('member cannot clear auto_step', true); end $$;
update action_github_pr set pr_title = 'renamed';
insert into results select 'member may still refresh a title', (select pr_title from action_github_pr limit 1) = 'renamed';
insert into action_github_pr (workspace_id, action_id, pr_url, repo_full_name, pr_number, author_github_id, auto_step, status_before_id) values ('11111111-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001','https://github.com/acme/app/pull/2','acme/app',2,555,'done','44444444-0000-0000-0000-000000000001');
insert into results select 'member insert has the automation fields cleared', (select author_github_id is null and auto_step is null and status_before_id is null from action_github_pr where pr_number = 2);
update team set github_automation = false where id = '33333333-0000-0000-0000-000000000001';
reset role; select set_config('request.jwt.claims', '', true);
insert into results select 'member cannot flip the team switch', (select github_automation from team where id = '33333333-0000-0000-0000-000000000001');

-- A (owner of ws1)
set local role authenticated; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
insert into results select 'A sees both branches (on the private team)', (select count(*) from action_github_branch) = 2;
do $$ begin insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000001','Acme/App','00000000-0000-0000-0000-00000000000a'); insert into results values ('repo names kept lower case', false); exception when check_violation then insert into results values ('repo names kept lower case', true); end $$;
insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000001','acme/app','00000000-0000-0000-0000-00000000000a');
do $$ begin insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000001','acme/app','00000000-0000-0000-0000-00000000000a'); insert into results values ('one row per repo', false); exception when unique_violation then insert into results values ('one row per repo', true); end $$;
do $$ begin insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000002','acme/app','00000000-0000-0000-0000-00000000000a'); insert into results values ('owner of ws1 cannot add to ws2', false); exception when insufficient_privilege then insert into results values ('owner of ws1 cannot add to ws2', true); end $$;
do $$ begin insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000001','acme/other','00000000-0000-0000-0000-00000000000c'); insert into results values ('added_by is the caller', false); exception when insufficient_privilege then insert into results values ('added_by is the caller', true); end $$;
do $$ begin insert into workspace_github_repo (workspace_id, repo_full_name, added_by) values ('11111111-0000-0000-0000-000000000001','not a repo','00000000-0000-0000-0000-00000000000a'); insert into results values ('repo name checked', false); exception when check_violation then insert into results values ('repo name checked', true); end $$;
update team set github_automation = false where id = '33333333-0000-0000-0000-000000000001';
reset role; select set_config('request.jwt.claims', '', true);
insert into results select 'owner flips the team switch', not (select github_automation from team where id = '33333333-0000-0000-0000-000000000001');

-- C (ws2) sees nothing of ws1
set local role authenticated; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
insert into results select 'C sees no ws1 repos or branches', (select count(*) from workspace_github_repo) = 0 and (select count(*) from action_github_branch) = 0;
reset role; select set_config('request.jwt.claims', '', true);

-- A workspace merge: a repository both added folds into one row; outside a merge a row keeps its workspace.
insert into workspace_github_repo (workspace_id, repo_full_name) values ('11111111-0000-0000-0000-000000000002', 'acme/app'), ('11111111-0000-0000-0000-000000000002', 'acme/other');
select set_config('dial8.workspace_merge', 'rehearsal', true);
update workspace_github_repo set workspace_id = '11111111-0000-0000-0000-000000000001' where workspace_id = '11111111-0000-0000-0000-000000000002';
select set_config('dial8.workspace_merge', '', true);
insert into results select 'a merge folds a repository both added', (select count(*) from workspace_github_repo where workspace_id = '11111111-0000-0000-0000-000000000001' and repo_full_name = 'acme/app') = 1 and (select count(*) from workspace_github_repo where workspace_id = '11111111-0000-0000-0000-000000000002') = 0;
insert into workspace_github_repo (workspace_id, repo_full_name) values ('11111111-0000-0000-0000-000000000002', 'acme/app');
do $$ begin update workspace_github_repo set workspace_id = '11111111-0000-0000-0000-000000000001' where workspace_id = '11111111-0000-0000-0000-000000000002'; insert into results values ('outside a merge, no fold', false); exception when unique_violation then insert into results values ('outside a merge, no fold', true); end $$;

-- An action moved to another workspace drops its branches; a merge keeps them.
update actions set workspace_id = '11111111-0000-0000-0000-000000000002' where id = '55555555-0000-0000-0000-000000000001';
insert into results select 'a moved action drops its branches', not exists (select 1 from action_github_branch where action_id = '55555555-0000-0000-0000-000000000001');
select set_config('dial8.workspace_merge', 'rehearsal', true);
update actions set workspace_id = '11111111-0000-0000-0000-000000000002' where id = '55555555-0000-0000-0000-000000000002';
select set_config('dial8.workspace_merge', '', true);
insert into results select 'a merge keeps them (it moves them itself)', exists (select 1 from action_github_branch where action_id = '55555555-0000-0000-0000-000000000002');

-- Disconnecting: identity stays while one GitHub connection is left, goes with the last.
delete from connected_account where id = '66666666-0000-0000-0000-000000000001';
insert into results select 'identity kept while another connection is left', exists (select 1 from github_identity where user_id = '00000000-0000-0000-0000-00000000000a');
delete from connected_account where id = '66666666-0000-0000-0000-000000000002';
insert into results select 'identity gone with the last connection', not exists (select 1 from github_identity where user_id = '00000000-0000-0000-0000-00000000000a');

do $$ declare bad text; begin
  select string_agg(name, '; ') into bad from results where not ok;
  if bad is not null then raise exception '694 github_reviews failed: %', bad; end if;
  raise notice '694 github_reviews: all % checks passed', (select count(*) from results);
end $$;

rollback;
