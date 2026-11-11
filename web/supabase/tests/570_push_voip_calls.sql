-- DB-level test for migrations 570-571 (a team call's ring reaches the
-- phone as a call): an install's VoIP token is registered, capped, removed
-- and forgotten by the same functions as its alert token, each kind on its
-- own; a ring is pushed once, only while it rings; its cancel goes once,
-- only for a ring that was pushed and left ringing before its time. The TS
-- tests (src/lib/push/__tests__/migration-570.test.ts) pin the files' text;
-- this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/570_push_voip_calls.sql
-- Prints one line per probe and "570 push_voip_calls: all checks passed".
-- Everything runs in one transaction that is rolled back: throwaway users
-- (each gets a workspace of their own from handle_new_user), a channel, a
-- DM and their calls. A probe runs as one caller (role authenticated with
-- that user's JWT claims, or anon) inside its own block that always rolls
-- back; t570_as runs as a caller and keeps what it did.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000570001'; -- Ana, W1, the caller
  u_b constant uuid := '00000000-0000-4000-8000-000000570002'; -- Ben, W1, in the DM
  u_c constant uuid := '00000000-0000-4000-8000-000000570003'; -- Cy, W1, in the channel
  u_d constant uuid := '00000000-0000-4000-8000-000000570004'; -- Dee, W1, in the channel
  u_e constant uuid := '00000000-0000-4000-8000-000000570005'; -- Eli, W1, in the channel
  u_f constant uuid := '00000000-0000-4000-8000-000000570006'; -- Fay, W1, in the channel
  u_g constant uuid := '00000000-0000-4000-8000-000000570007'; -- Gus, W1, in a DM with Ana
  alert_b constant text := repeat('a1', 32);
  voip_b constant text := repeat('b2', 32);
  w1 uuid;
  m_a uuid; m_b uuid; m_c uuid; m_d uuid; m_e uuid; m_f uuid; m_g uuid;
  ch_open uuid; ch_dm uuid; ch_dm_g uuid;
  call_open uuid; call_dm uuid; call_dm_g uuid;
  room_open text;
  ring_b uuid; ring_c uuid; ring_d uuid; ring_e uuid; ring_f uuid; ring_g uuid;
  i int;
  v_got text;
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP or CLI); false: raise only when a check fails.
  v_raise_report constant boolean := true;
begin
  create temp table t570_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller (null: anon) and return 'rows=N' (the last
  -- statement's row count) or 'refused [SQLSTATE] message'. Always rolled back.
  create function pg_temp.t570_probe(p_uid uuid, p_sqls text[])
  returns text language plpgsql as $f$
  declare
    n bigint := 0;
    s text;
  begin
    begin
      if p_uid is null then
        perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
        perform set_config('role', 'anon', true);
      else
        perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      end if;
      foreach s in array p_sqls loop
        execute s;
        get diagnostics n = row_count;
      end loop;
      raise exception using errcode = 'ZP570', message = 'rows=' || n;
    exception
      when sqlstate 'ZP570' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t570_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t570_probe(p_uid, p_sqls);
  begin
    insert into t570_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- Run one query as a caller (null: anon) and KEEP what it did: its first column, as text.
  create function pg_temp.t570_as(p_uid uuid, p_sql text)
  returns text language plpgsql as $f$
  declare
    v text;
  begin
    if p_uid is null then
      perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      perform set_config('role', 'anon', true);
    else
      perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end if;
    execute p_sql into v;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    return v;
  end $f$;

  -- A check made as postgres (the service role's view: no RLS).
  create function pg_temp.t570_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t570_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't570-ana@example.invalid', '{"full_name":"t570ana"}'),
    (u_b, 't570-ben@example.invalid', '{"full_name":"t570ben"}'),
    (u_c, 't570-cy@example.invalid',  '{"full_name":"t570cy"}'),
    (u_d, 't570-dee@example.invalid', '{"full_name":"t570dee"}'),
    (u_e, 't570-eli@example.invalid', '{"full_name":"t570eli"}'),
    (u_f, 't570-fay@example.invalid', '{"full_name":"t570fay"}'),
    (u_g, 't570-gus@example.invalid', '{"full_name":"t570gus"}');

  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't570ben'),
    (u_c, w1, 'member', 't570cy'),
    (u_d, w1, 'member', 't570dee'),
    (u_e, w1, 'member', 't570eli'),
    (u_f, w1, 'member', 't570fay'),
    (u_g, w1, 'member', 't570gus');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  select id into m_d from public.member where user_id = u_d and workspace_id = w1;
  select id into m_e from public.member where user_id = u_e and workspace_id = w1;
  select id into m_f from public.member where user_id = u_f and workspace_id = w1;
  select id into m_g from public.member where user_id = u_g and workspace_id = w1;
  update public.member set display_name = 't570ana' where id = m_a;

  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't570-general', m_a) returning id into ch_open;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_b::text then m_a::text || ':' || m_b::text else m_b::text || ':' || m_a::text end, m_a) returning id into ch_dm;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_g::text then m_a::text || ':' || m_g::text else m_g::text || ':' || m_a::text end, m_a) returning id into ch_dm_g;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch_dm, m_a, w1), (ch_dm, m_b, w1), (ch_dm_g, m_a, w1), (ch_dm_g, m_g, w1);

  -- ── 570: the VoIP token beside the alert token ────────────────────────────
  perform pg_temp.t570_as(u_b, format('select public.push_token_register(device_token => %L, token_environment => %L, app_bundle_id => %L, name_of_device => %L)::text', alert_b, 'sandbox', 'com.example.app', 't570 phone'));
  perform pg_temp.t570_check('the four arguments the app sent before register an alert token', 'alert',
    (select kind from public.push_token where token = alert_b));
  perform pg_temp.t570_as(u_b, format('select public.push_token_register(%L, %L, %L, %L, %L)::text', voip_b, 'sandbox', 'com.example.app', 't570 phone', 'voip'));
  perform pg_temp.t570_check('the same install''s VoIP token is its own row', 'voip/sandbox/' || u_b::text,
    (select kind || '/' || environment || '/' || user_id::text from public.push_token where token = voip_b));
  perform pg_temp.t570_run('a kind that is neither is refused', 'refused', u_b,
    array[format('select public.push_token_register(%L, %L, %L, %L, %L)', repeat('c3', 32), 'sandbox', 'com.example.app', 'x', 'sms')]);
  perform pg_temp.t570_run('ANON cannot register a VoIP token', 'refused', null,
    array[format('select public.push_token_register(%L, %L, %L, %L, %L)', repeat('c4', 32), 'sandbox', 'com.example.app', 'x', 'voip')]);
  perform pg_temp.t570_run('nobody reads the tokens, their own VoIP token included', 'refused', u_b,
    array['select 1 from public.push_token']);

  -- Ten VoIP installs more: the cap counts each kind on its own.
  for i in 1..10 loop
    perform pg_temp.t570_as(u_b, format('select public.push_token_register(%L, %L, %L, %L, %L)::text', lpad(to_hex(i), 2, '0') || repeat('d', 62), 'production', 'com.example.app', 't570 phone ' || i, 'voip'));
  end loop;
  update public.push_token set last_seen_at = now() - interval '1 day' where token = voip_b;
  perform pg_temp.t570_as(u_b, format('select public.push_token_register(%L, %L, %L, %L, %L)::text', 'ff' || repeat('d', 62), 'production', 'com.example.app', 't570 phone 11', 'voip'));
  perform pg_temp.t570_check('past 10 VoIP installs, the one seen longest ago stops', 'Superseded',
    (select disabled_reason from public.push_token where token = voip_b));
  perform pg_temp.t570_check('… and the alert token is not counted among them', '<null>',
    (select disabled_reason from public.push_token where token = alert_b));
  perform pg_temp.t570_check('10 live VoIP installs, 1 live alert install', '10/1',
    (select count(*) filter (where kind = 'voip')::text || '/' || count(*) filter (where kind = 'alert')::text
       from public.push_token where user_id = u_b and disabled_at is null));
  -- (One transaction: every row's now() is the same, so the others are made older by hand.)
  update public.push_token set last_seen_at = now() - interval '1 hour' where user_id = u_b and token <> voip_b;
  perform pg_temp.t570_as(u_b, format('select public.push_token_register(%L, %L, %L, %L, %L)::text', voip_b, 'sandbox', 'com.example.app', 't570 phone', 'voip'));
  perform pg_temp.t570_check('registering it again starts it again', '<null>',
    (select coalesce(disabled_reason, '<null>') from public.push_token where token = voip_b));
  perform pg_temp.t570_as(u_c, format('select public.push_token_register(%L, %L, %L, %L, %L)::text', voip_b, 'sandbox', 'com.example.app', 't570 phone', 'voip'));
  perform pg_temp.t570_check('another person signing in on the phone takes the VoIP token over', u_c::text,
    (select user_id::text from public.push_token where token = voip_b));
  perform pg_temp.t570_run('the person before cannot remove it now', 'rows=1', u_b,
    array[format('select 1 where not public.push_token_remove(%L)', voip_b)]);
  perform pg_temp.t570_run('its person removes their VoIP token', 'rows=1', u_c,
    array[format('select 1 where public.push_token_remove(%L)', voip_b)]);
  perform pg_temp.t570_check('ANON forgets a VoIP token by the token alone (the session ended)', 'true',
    pg_temp.t570_as(null, format('select public.push_token_forget(%L)::text', 'ff' || repeat('d', 62))));
  perform pg_temp.t570_check('… and it is gone', '0', (select count(*)::text from public.push_token where token = 'ff' || repeat('d', 62)));

  -- ── 571: a ring pushed once, cancelled once ───────────────────────────────
  call_dm := pg_temp.t570_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_dm))::uuid;
  ring_b := pg_temp.t570_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm, m_b))::uuid;
  perform pg_temp.t570_check('a ringing ring may be pushed: what the push says', 't570ana/dm/' || u_b::text || '/' || call_dm::text,
    (select caller_name || '/' || channel_kind || '/' || user_id::text || '/' || call_id::text from public.team_call_ring_push_claim(ring_b)));
  perform pg_temp.t570_check('… once (a retried request sends nothing)', '0',
    (select count(*)::text from public.team_call_ring_push_claim(ring_b)));
  perform pg_temp.t570_check('no cancel while it still rings', '0',
    (select count(*)::text from public.team_call_ring_push_cancel(array[ring_b], null, null)));
  perform pg_temp.t570_check('the person declines (on the web, say)', 'declined',
    pg_temp.t570_as(u_b, format('select state from public.team_call_answer(%L, false)', ring_b)));
  perform pg_temp.t570_check('its cancel may go now, saying how it was settled', 'declined/' || u_b::text,
    (select state || '/' || user_id::text from public.team_call_ring_push_cancel(array[ring_b], null, null)));
  perform pg_temp.t570_check('… once', '0',
    (select count(*)::text from public.team_call_ring_push_cancel(array[ring_b], null, null)));
  perform pg_temp.t570_check('a settled ring is never pushed', '0',
    (select count(*)::text from public.team_call_ring_push_claim(ring_b)));

  -- A channel's call: one ring each (a person declined or missed is not rung again for a call).
  call_open := pg_temp.t570_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_open))::uuid;
  select room into room_open from public.team_call where id = call_open;

  ring_d := pg_temp.t570_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_d))::uuid;
  perform pg_temp.t570_check('a ring nobody pushed is answered', 'accepted',
    pg_temp.t570_as(u_d, format('select state from public.team_call_answer(%L, true)', ring_d)));
  perform pg_temp.t570_check('… and no cancel goes for it', '0',
    (select count(*)::text from public.team_call_ring_push_cancel(array[ring_d], null, null)));

  ring_e := pg_temp.t570_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_e))::uuid;
  perform pg_temp.t570_check('pushed', '1', (select count(*)::text from public.team_call_ring_push_claim(ring_e)));
  update public.team_call_ring set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where id = ring_e;
  perform pg_temp.t570_check('it ran out and is missed', '1', (select count(*)::text from public.team_call_expire_rings(ring_e)));
  perform pg_temp.t570_check('a ring that ran out gets no cancel (the phone''s own clock stopped it)', '0',
    (select count(*)::text from public.team_call_ring_push_cancel(array[ring_e], null, null)));

  ring_f := pg_temp.t570_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_f))::uuid;
  update public.team_call_ring set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where id = ring_f;
  perform pg_temp.t570_check('a ring past its time is never pushed', '0',
    (select count(*)::text from public.team_call_ring_push_claim(ring_f)));

  -- Cy rung, pushed, then joins on the web (LiveKit's webhook).
  ring_c := pg_temp.t570_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_c))::uuid;
  perform pg_temp.t570_check('Cy''s ring is pushed', '1', (select count(*)::text from public.team_call_ring_push_claim(ring_c)));
  perform pg_temp.t570_check('Cy joins elsewhere', 'joined', public.team_call_participant_event(room_open, m_c, 'PA_c1', true, now(), now()));
  perform pg_temp.t570_check('the join''s cancel goes, found by call and member', ring_c::text || '/accepted',
    (select ring_id::text || '/' || state from public.team_call_ring_push_cancel(null, call_open, m_c)));
  perform pg_temp.t570_check('nothing to find with neither rings nor a call and member', '0',
    (select count(*)::text from public.team_call_ring_push_cancel(null, call_open, null)));

  -- The caller hangs up a DM: the open ring is missed before its time, and its cancel goes.
  call_dm_g := pg_temp.t570_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_dm_g))::uuid;
  ring_g := pg_temp.t570_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm_g, m_g))::uuid;
  perform pg_temp.t570_check('Gus''s ring is pushed', '1', (select count(*)::text from public.team_call_ring_push_claim(ring_g)));
  perform pg_temp.t570_check('the caller hangs up', '1', (select count(*)::text from public.team_call_end(call_dm_g, 'left', now()) where ring_id = ring_g));
  perform pg_temp.t570_check('its cancel goes: missed', 'missed', (select state from public.team_call_ring_push_cancel(array[ring_g], null, null)));

  -- The fence.
  perform pg_temp.t570_run('a person cannot claim a ring''s push', 'refused', u_b,
    array[format('select * from public.team_call_ring_push_claim(%L)', ring_b)]);
  perform pg_temp.t570_run('a person cannot send a cancel', 'refused', u_b,
    array[format('select * from public.team_call_ring_push_cancel(array[%L]::uuid[], null, null)', ring_b)]);
  perform pg_temp.t570_run('ANON cannot send a cancel', 'refused', null,
    array[format('select * from public.team_call_ring_push_cancel(array[%L]::uuid[], null, null)', ring_b)]);
  perform pg_temp.t570_run('nobody reads which rings were pushed, their own included', 'refused', u_b,
    array['select 1 from public.team_call_ring_push']);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t570_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '570 push_voip_calls: % of % check(s) failed: %', v_fail, (select count(*) from t570_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t570_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '570 push_voip_calls: all % checks passed', (select count(*) from t570_results) using detail = v_report;
  end if;
  raise notice '570 push_voip_calls: all checks passed';
end
$probe$;

rollback;
