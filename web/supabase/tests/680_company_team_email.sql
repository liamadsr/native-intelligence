-- DB-level test for migration 680 (a company's email, shared with the team)
-- and the company parts of 679. The TS tests pin the files' text; this runs
-- the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/680_company_team_email.sql
-- Prints "680 company_team_email: all checks passed". Everything runs in one
-- transaction that is rolled back. Made-up people only (example.test).
-- A failed check raises and aborts.

begin;

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $f$;

create or replace function pg_temp.as_service() returns void language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $f$;

create or replace function pg_temp.seen(p_company uuid, p_user uuid) returns text[] language sql as $f$
  select coalesce(array_agg(t.provider_thread_id order by t.provider_thread_id), '{}')
    from public.company_team_email_threads(p_company, p_user) t;
$f$;

do $probe$
declare
  u_alice constant uuid := '00000000-0000-4000-8000-000000680001';
  u_bob   constant uuid := '00000000-0000-4000-8000-000000680002';
  u_carol constant uuid := '00000000-0000-4000-8000-000000680003';
  u_eve   constant uuid := '00000000-0000-4000-8000-000000680004';
  u_gus   constant uuid := '00000000-0000-4000-8000-000000680005';
  m_gus uuid; teamco uuid; own uuid;
  ws uuid; ws2 uuid;
  m_alice uuid; m_bob uuid; m_carol uuid; m_eve uuid;
  acme uuid; beta uuid; other uuid;
  acct_alice uuid; acct_bob uuid; acct_carol uuid;
  t_private uuid;
  got text[];
  st jsonb;
  failed boolean;
  n int;
begin
  insert into auth.users (id, email) values
    (u_alice, 'alice@team.example.test'), (u_bob, 'bob@team.example.test'),
    (u_carol, 'carol@team.example.test'), (u_eve, 'eve@elsewhere.example.test'),
    (u_gus, 'gus@outside.example.test');
  insert into public.workspace (name, slug) values ('Probe Team 680', 'probe-team-680-' || substr(md5(random()::text), 1, 8)) returning id into ws;
  insert into public.workspace (name, slug) values ('Probe Other 680', 'probe-other-680-' || substr(md5(random()::text), 1, 8)) returning id into ws2;

  -- 679: a new workspace gets the default stages.
  if (select array_agg(name order by position) from public.company_stage where workspace_id = ws) is distinct from array['Lead', 'Demo', 'Customer', 'Churned'] then
    raise exception 'FAIL: a new workspace has Lead, Demo, Customer, Churned';
  end if;

  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'admin', 'Alice Probe') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob Probe') returning id into m_bob;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_carol, ws, 'member', 'Carol Probe') returning id into m_carol;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_eve, ws2, 'owner', 'Eve Probe') returning id into m_eve;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_gus, ws, 'guest', 'Gus Probe') returning id into m_gus;

  insert into public.connected_account (user_id, workspace_id, provider, capability, account_email)
  values (u_alice, ws, 'google', 'email', 'alice@team.example.test') returning id into acct_alice;
  insert into public.connected_account (user_id, workspace_id, provider, capability, account_email)
  values (u_bob, ws, 'google', 'email', 'bob@team.example.test') returning id into acct_bob;
  insert into public.connected_account (user_id, workspace_id, provider, capability, account_email)
  values (u_carol, ws, 'google', 'email', 'carol@team.example.test') returning id into acct_carol;

  -- Acme: a person everyone sees. Beta: only a private person Alice made.
  insert into public.company (workspace_id, name, domain) values (ws, 'Acme Probe', 'acme.example.test') returning id into acme;
  insert into public.contact (workspace_id, full_name, email, company_id, visibility, created_by_member_id)
  values (ws, 'Pat Example', 'pat@acme.example.test', acme, 'workspace', m_alice);
  insert into public.company (workspace_id, name, domain) values (ws, 'Beta Probe', 'beta.example.test') returning id into beta;
  insert into public.contact (workspace_id, full_name, email, company_id, visibility, created_by_member_id)
  values (ws, 'Robin Example', 'robin@beta.example.test', beta, 'private', m_alice);
  insert into public.company (workspace_id, name, domain) values (ws2, 'Acme Probe Elsewhere', 'acme.example.test') returning id into other;
  -- Bob is also on record as a contact at Acme (a teammate who is a contact).
  insert into public.contact (workspace_id, full_name, email, company_id, visibility, created_by_member_id, member_id)
  values (ws, 'Bob Probe', 'bob@team.example.test', acme, 'workspace', m_alice, m_bob);
  -- A company on the team's own domain, and the workspace's own company.
  insert into public.company (workspace_id, name, domain) values (ws, 'Team Probe Co', 'team.example.test') returning id into teamco;
  insert into public.contact (workspace_id, full_name, email, company_id, visibility, created_by_member_id)
  values (ws, 'Team Desk', 'desk@team.example.test', teamco, 'workspace', m_alice);
  -- (Its domain would be the team's too; one company per domain, so it has none here: its flag decides.)
  insert into public.company (workspace_id, name, is_workspace_company) values (ws, 'Probe Team 680 (us)', true) returning id into own;
  insert into public.contact (workspace_id, full_name, email, company_id, visibility, created_by_member_id)
  values (ws, 'Outside Example', 'pat@acme-partner.example.test', own, 'workspace', m_alice);

  -- Threads (pointers only, as the index holds them).
  insert into public.email_thread_index (workspace_id, user_id, account_id, provider, provider_thread_id, participant_emails, last_message_at, folder) values
    (ws, u_alice, acct_alice, 'google', 'a-with-pat', array['alice@team.example.test', 'pat@acme.example.test', 'bob@team.example.test'], now() - interval '1 day', 'inbox'),
    (ws, u_alice, acct_alice, 'google', 'a-domain-only', array['alice@team.example.test', 'sam@sales.acme.example.test'], now() - interval '2 days', 'sent'),
    (ws, u_alice, acct_alice, 'google', 'a-private', array['alice@team.example.test', 'pat@acme.example.test'], now() - interval '3 days', 'inbox'),
    (ws, u_alice, acct_alice, 'google', 'a-trash', array['alice@team.example.test', 'pat@acme.example.test'], now() - interval '4 days', 'trash'),
    (ws, u_alice, acct_alice, 'google', 'a-unrelated', array['alice@team.example.test', 'kim@nowhere.example.test'], now() - interval '5 days', 'inbox'),
    (ws, u_alice, acct_alice, 'google', 'a-lookalike', array['alice@team.example.test', 'x@notacme.example.test'], now() - interval '5 days', 'inbox'),
    (ws, u_alice, acct_alice, 'google', 'a-internal', array['alice@team.example.test', 'bob@team.example.test', 'carol@team.example.test'], now() - interval '1 hour', 'inbox'),
    (ws, u_alice, acct_alice, 'google', 'a-with-robin', array['alice@team.example.test', 'robin@beta.example.test'], now() - interval '6 days', 'inbox'),
    (ws, u_bob, acct_bob, 'google', 'b-with-pat', array['bob@team.example.test', 'pat@acme.example.test'], now() - interval '1 day', 'inbox'),
    (ws, u_carol, acct_carol, 'google', 'c-with-pat', array['carol@team.example.test', 'pat@acme.example.test'], now() - interval '1 day', 'inbox');
  select id into t_private from public.email_thread_index where provider_thread_id = 'a-private';

  -- Off by default: nothing, consent or not.
  if exists (select 1 from public.company where id = acme and share_email_with_team) then raise exception 'FAIL: the switch is off by default'; end if;
  perform pg_temp.as_user(u_alice);
  perform public.set_company_email_consent(acme, true);
  perform public.set_email_thread_team_private(t_private, true);
  perform pg_temp.as_service();
  if cardinality(pg_temp.seen(acme, u_bob)) <> 0 then raise exception 'FAIL: switch off lists nothing'; end if;

  -- Bob turns it on. Bob never agreed; Carol agrees, then stops.
  perform pg_temp.as_user(u_bob);
  perform public.set_company_email_sharing(acme, true);
  perform pg_temp.as_user(u_carol);
  perform public.set_company_email_consent(acme, true);
  perform public.set_company_email_consent(acme, false);
  perform pg_temp.as_service();

  -- The service-role path (the agent, MCP) names Bob.
  got := pg_temp.seen(acme, u_bob);
  if got is distinct from array['a-domain-only', 'a-with-pat'] then
    raise exception 'FAIL: Bob sees only Alice''s agreed, non-private, non-trash threads with Acme; got %', got;
  end if;

  -- Bob signed in sees the same; asking as Alice gets nothing.
  perform pg_temp.as_user(u_bob);
  got := pg_temp.seen(acme, u_bob);
  if got is distinct from array['a-domain-only', 'a-with-pat'] then raise exception 'FAIL: Bob signed in sees the same; got %', got; end if;
  if cardinality(pg_temp.seen(acme, u_alice)) <> 0 then raise exception 'FAIL: a signed-in caller asks only about themself'; end if;
  -- Bob can't read Alice's index rows or private marks directly.
  if exists (select 1 from public.email_thread_index where user_id = u_alice) then raise exception 'FAIL: the index stays own-only'; end if;
  if exists (select 1 from public.email_thread_team_private) then raise exception 'FAIL: private marks are the owner''s own'; end if;
  -- Bob sees who shares (Alice), not Carol (stopped).
  select count(*) into n from public.company_email_consent where company_id = acme and revoked_at is null;
  if n <> 1 then raise exception 'FAIL: Bob sees one live consent, got %', n; end if;
  -- Bob can't mark Alice's thread private, nor share for Beta (he can't see it).
  failed := false;
  begin perform public.set_email_thread_team_private(t_private, false); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: only the owner marks a thread'; end if;
  failed := false;
  begin perform public.set_company_email_sharing(beta, true); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a company Bob can''t see can''t be switched by him'; end if;
  perform pg_temp.as_service();

  -- The team members on a thread: Alice and Bob on a-with-pat.
  select t.team_member_ids into got from public.company_team_email_threads(acme, u_bob) t where t.provider_thread_id = 'a-with-pat';
  if not (got @> array[m_alice::text, m_bob::text] and cardinality(got) = 2) then raise exception 'FAIL: team on the thread is Alice and Bob; got %', got; end if;

  -- One thread by id: in the set or nothing.
  if not exists (select 1 from public.company_team_email_threads(acme, u_bob, true, 50, (select id from public.email_thread_index where provider_thread_id = 'a-with-pat'))) then
    raise exception 'FAIL: a listed thread reads by id';
  end if;
  if exists (select 1 from public.company_team_email_threads(acme, u_bob, true, 50, t_private)) then
    raise exception 'FAIL: a private thread never reads by id';
  end if;

  -- Beta: Alice agrees and the switch is on, but Bob can't see Beta.
  perform pg_temp.as_user(u_alice);
  perform public.set_company_email_sharing(beta, true);
  perform public.set_company_email_consent(beta, true);
  perform pg_temp.as_service();
  if cardinality(pg_temp.seen(beta, u_alice)) <> 1 then raise exception 'FAIL: Alice sees her Beta thread'; end if;
  if cardinality(pg_temp.seen(beta, u_bob)) <> 0 then raise exception 'FAIL: a company the reader can''t see lists nothing'; end if;
  if public.company_email_sharing_status(beta, u_bob) is not null then raise exception 'FAIL: no status for a company Bob can''t see'; end if;

  -- Another workspace: Eve sees nothing of Acme, and her own Acme lists nothing.
  if cardinality(pg_temp.seen(acme, u_eve)) <> 0 then raise exception 'FAIL: another workspace sees nothing'; end if;
  update public.company set share_email_with_team = true where id = other;
  if cardinality(pg_temp.seen(other, u_eve)) <> 0 then raise exception 'FAIL: a same-domain company elsewhere lists nothing'; end if;
  perform pg_temp.as_user(u_eve);
  if exists (select 1 from public.company_email_consent) then raise exception 'FAIL: Eve reads no consent of another workspace'; end if;
  perform pg_temp.as_service();

  -- No requester: nothing.
  if cardinality(pg_temp.seen(acme, null)) <> 0 then raise exception 'FAIL: no requester, nothing'; end if;

  -- Status for Bob: on, he didn't agree, Alice shares.
  st := public.company_email_sharing_status(acme, u_bob);
  if not (st ->> 'enabled')::boolean or (st ->> 'my_consent')::boolean or jsonb_array_length(st -> 'sharers') <> 1 then
    raise exception 'FAIL: status for Bob; got %', st;
  end if;

  -- Internal mail never rides on a company: not through a teammate who is a
  -- contact at it (a-internal is with Bob, on record at Acme, above), and not
  -- on a company whose domain is the team's.
  perform pg_temp.as_user(u_alice);
  perform public.set_company_email_consent(teamco, true);
  perform public.set_company_email_sharing(teamco, true);
  perform pg_temp.as_service();
  if cardinality(pg_temp.seen(teamco, u_bob)) <> 0 then raise exception 'FAIL: internal threads on the team''s domain stay off a company'; end if;
  if 'a-internal' = any (pg_temp.seen(acme, u_bob)) then raise exception 'FAIL: a thread among teammates is not with Acme'; end if;
  -- The workspace's own company can't be switched on; forced on, it lists nothing.
  perform pg_temp.as_user(u_alice);
  failed := false;
  begin perform public.set_company_email_sharing(own, true); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: the workspace''s own company refuses the switch'; end if;
  perform public.set_company_email_consent(own, true);
  perform pg_temp.as_service();
  update public.company set share_email_with_team = true where id = own;
  if cardinality(pg_temp.seen(own, u_bob)) <> 0 then raise exception 'FAIL: the own company lists nothing'; end if;

  -- A guest reads no team mail: not on Acme (they see it through Pat), not on
  -- Beta shared to them by a grant; they can't switch it or agree, and get no status.
  insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by)
  values (ws, 'company', beta, 'member', m_gus, 'view', m_alice);
  if not public.company_visible_to(beta, u_gus) then raise exception 'SETUP: the grant shows Gus Beta'; end if;
  if cardinality(pg_temp.seen(acme, u_gus)) <> 0 or cardinality(pg_temp.seen(beta, u_gus)) <> 0 then
    raise exception 'FAIL: a guest reads no team mail';
  end if;
  if public.company_email_sharing_status(beta, u_gus) is not null then raise exception 'FAIL: no status for a guest'; end if;
  perform pg_temp.as_user(u_gus);
  failed := false;
  begin perform public.set_company_email_sharing(acme, false); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a guest can''t switch it'; end if;
  failed := false;
  begin perform public.set_company_email_consent(acme, true); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a guest can''t agree'; end if;
  perform pg_temp.as_service();

  -- Alice makes the thread shareable again; then stops sharing everything.
  perform pg_temp.as_user(u_alice);
  perform public.set_email_thread_team_private(t_private, false);
  perform pg_temp.as_service();
  if cardinality(pg_temp.seen(acme, u_bob)) <> 3 then raise exception 'FAIL: an un-privated thread is listed again'; end if;
  perform pg_temp.as_user(u_alice);
  perform public.stop_sharing_my_company_email(ws);
  perform pg_temp.as_service();
  if cardinality(pg_temp.seen(acme, u_bob)) <> 0 then raise exception 'FAIL: stopping ends every share at once'; end if;

  -- An owner who leaves the workspace shares nothing more.
  perform pg_temp.as_user(u_alice);
  perform public.set_company_email_consent(acme, true);
  perform pg_temp.as_service();
  delete from public.member where id = m_alice;
  if cardinality(pg_temp.seen(acme, u_bob)) <> 0 then raise exception 'FAIL: a departed member''s mail is not listed'; end if;

  -- The switch off hides everything again.
  update public.company set share_email_with_team = false where id = acme;

  -- 679: stages, owner and revenue keep to their workspace.
  failed := false;
  begin update public.company set stage_id = (select id from public.company_stage where workspace_id = ws2 limit 1) where id = acme;
  exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: another workspace''s stage is refused'; end if;
  failed := false;
  begin update public.company set owner_member_id = m_eve where id = acme; exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: an owner from another workspace is refused'; end if;
  failed := false;
  begin update public.company set revenue = '{"amount": "ten", "currency": "USD"}' where id = acme; exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: revenue is {amount, currency}'; end if;
  update public.company set stage_id = (select id from public.company_stage where workspace_id = ws and name = 'Demo'),
                            owner_member_id = m_bob, revenue = '{"amount": 120000, "currency": "EUR"}' where id = acme;
  if (select stage_changed_at from public.company where id = acme) is null then raise exception 'FAIL: a stage change is stamped'; end if;
  -- Deleting the stage moves the company to No stage.
  delete from public.company_stage where workspace_id = ws and name = 'Demo';
  if (select stage_id from public.company where id = acme) is not null then raise exception 'FAIL: a deleted stage leaves No stage'; end if;
  -- Reset: the defaults back, a custom stage gone.
  insert into public.company_stage (workspace_id, name, position) values (ws, 'Pilot', 9);
  perform public.reset_company_stages(ws);
  if (select array_agg(name order by position) from public.company_stage where workspace_id = ws) is distinct from array['Lead', 'Demo', 'Customer', 'Churned'] then
    raise exception 'FAIL: reset gives the defaults';
  end if;
  -- A member who is not an admin can't add a stage.
  perform pg_temp.as_user(u_bob);
  failed := false;
  begin insert into public.company_stage (workspace_id, name, position) values (ws, 'Bob stage', 5); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: only an owner or admin edits stages'; end if;
  perform pg_temp.as_service();

  raise notice '680 company_team_email: all checks passed';
end;
$probe$;

rollback;
