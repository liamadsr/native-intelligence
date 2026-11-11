-- DB-level test for migrations 562-563 (push for the iOS app): a person
-- registers and removes only their own installs, nobody reads the table, a
-- token moves to whoever signs in on the phone next, and the badge counts a
-- person's team chat unread as the channel list does.
-- The TS tests (src/lib/push/__tests__/migration-562.test.ts) pin the files'
-- text; this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/562_push_tokens.sql
-- Prints one line per probe and "562 push_tokens: all checks passed".
-- Everything runs in one transaction that is rolled back: throwaway users
-- (each gets a workspace of their own from handle_new_user), a channel, a
-- team channel, a DM and their messages. Each probe runs as one caller (role
-- authenticated with that user's JWT claims) inside its own block that
-- always rolls back, so one probe never sees another's writes.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000562001'; -- Ana, member of W1, in the team
  u_b constant uuid := '00000000-0000-4000-8000-000000562002'; -- Ben, member of W1, not in the team, in the DM
  u_c constant uuid := '00000000-0000-4000-8000-000000562003'; -- Cy, member of W1, not in the DM
  u_x constant uuid := '00000000-0000-4000-8000-000000562004'; -- outsider: their own workspace only
  tok_a constant text := repeat('a1', 32);
  tok_b constant text := repeat('b2', 32);
  w1 uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid;
  ch_open uuid; ch_team uuid; ch_dm uuid;
  root_a uuid;
  t0 timestamptz := now() - interval '1 hour';
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP or CLI); false: raise only when a check fails.
  v_raise_report constant boolean := false;
begin
  create temp table t562_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller and return 'rows=N' (the last statement's row
  -- count) or 'refused [SQLSTATE] message'.
  create function pg_temp.t562_probe(p_uid uuid, p_sqls text[])
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
      raise exception using errcode = 'ZP562', message = 'rows=' || n;
    exception
      when sqlstate 'ZP562' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t562_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t562_probe(p_uid, p_sqls);
  begin
    insert into t562_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- A check made as postgres (the service role's view: no RLS).
  create function pg_temp.t562_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t562_results (label, expected, got, pass) values (p_label, p_expect, p_got, p_got = p_expect);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't562-ana@example.invalid', '{"full_name":"t562ana"}'),
    (u_b, 't562-ben@example.invalid', '{"full_name":"t562ben"}'),
    (u_c, 't562-cy@example.invalid',  '{"full_name":"t562cy"}'),
    (u_x, 't562-out@example.invalid', '{"full_name":"t562outsider"}');

  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't562ben'),
    (u_c, w1, 'member', 't562cy');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  update public.member set created_at = t0 where id in (m_a, m_b, m_c);

  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't562 team', 't562-team', 'TQY') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a);

  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't562-general', m_a) returning id into ch_open;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't562-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_b::text then m_a::text || ':' || m_b::text else m_b::text || ':' || m_a::text end, m_a) returning id into ch_dm;
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at) values (ch_dm, m_a, w1, t0), (ch_dm, m_b, w1, t0);

  -- #general: Ana's root mentioning Cy, Ben's reply in its thread, a deleted
  -- one, and Ben's agent's reply. #team: Ana's, for the team only. The DM: Ana's.
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, mentions, created_at)
  values (ch_open, w1, m_a, 'the plan is ready for t562cy', array[m_c], t0 + interval '10 minutes') returning id into root_a;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id, created_at)
  values (ch_open, w1, m_b, 'looks good to me', root_a, t0 + interval '20 minutes');
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at, deleted_at)
  values (ch_open, w1, m_a, '', t0 + interval '11 minutes', now());
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, agent_for_member_id, agent_name, body, created_at)
  values (ch_open, w1, 'agent', m_b, 'Juniper', 'an answer from the agent', t0 + interval '30 minutes');
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, mentions, created_at)
  values (ch_team, w1, m_a, 'budget for the team only, cc t562ben', array[m_b], t0 + interval '10 minutes');
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
  values (ch_dm, w1, m_a, 'between us', t0 + interval '10 minutes');

  -- ── Registering an install ────────────────────────────────────────────────
  perform pg_temp.t562_run('a person registers their install', 'rows=1', u_a,
    array[format('select public.push_token_register(%L, %L, %L, %L)', tok_a, 'sandbox', 'com.example.app', 'Ana''s iPhone')]);
  perform pg_temp.t562_run('… the token is stored lower-cased, theirs, live', 'rows=1', u_a,
    array[
      format('select public.push_token_register(%L, %L, %L, %L)', upper(tok_a), 'production', 'com.example.app', 'Ana''s iPhone'),
      format('set local role postgres'),
      format('select 1 from public.push_token where token = %L and user_id = %L and environment = %L and disabled_at is null', tok_a, u_a, 'production')
    ]);
  perform pg_temp.t562_run('registering again keeps one row and starts a stopped token again', 'rows=1', u_a,
    array[
      format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'sandbox', 'com.example.app'),
      'set local role postgres',
      format('update public.push_token set disabled_at = now(), disabled_reason = %L where token = %L', 'Unregistered', tok_a),
      format('set local role authenticated'),
      format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'sandbox', 'com.example.app'),
      'set local role postgres',
      format('select 1 from public.push_token where token = %L and disabled_at is null and disabled_reason is null', tok_a)
    ]);
  perform pg_temp.t562_run('a token another person had is the new person''s (one install, one person)', 'rows=1', u_b,
    array[
      'set local role postgres',
      format('insert into public.push_token (user_id, token, environment, bundle_id) values (%L, %L, %L, %L)', u_a, tok_b, 'sandbox', 'com.example.app'),
      'set local role authenticated',
      format('select public.push_token_register(%L, %L, %L, null)', tok_b, 'sandbox', 'com.example.app'),
      'set local role postgres',
      format('select 1 from public.push_token where token = %L and user_id = %L', tok_b, u_b)
    ]);
  perform pg_temp.t562_run('something that is not a token is refused', 'refused', u_a,
    array[format('select public.push_token_register(%L, %L, %L, null)', 'not-a-token', 'sandbox', 'com.example.app')]);
  perform pg_temp.t562_run('an unknown environment is refused', 'refused', u_a,
    array[format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'staging', 'com.example.app')]);
  perform pg_temp.t562_run('a bundle id with spaces or markup is refused', 'refused', u_a,
    array[format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'sandbox', 'com example <app>')]);
  perform pg_temp.t562_run('ANON cannot register', 'refused', null,
    array[format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'sandbox', 'com.example.app')]);

  -- ── Nobody reads or writes the table directly ─────────────────────────────
  perform pg_temp.t562_run('a person cannot read the table (not even their own row)', 'refused', u_a,
    array[
      format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'sandbox', 'com.example.app'),
      'select * from public.push_token'
    ]);
  perform pg_temp.t562_run('a person cannot insert a row directly', 'refused', u_a,
    array[format('insert into public.push_token (user_id, token, environment, bundle_id) values (%L, %L, %L, %L)', u_a, tok_a, 'sandbox', 'com.example.app')]);
  perform pg_temp.t562_run('ANON cannot read the table', 'refused', null,
    array['select * from public.push_token']);

  -- ── Removing an install ───────────────────────────────────────────────────
  perform pg_temp.t562_run('a person removes their own install', 'rows=1', u_a,
    array[
      format('select public.push_token_register(%L, %L, %L, null)', tok_a, 'sandbox', 'com.example.app'),
      format('select 1 where public.push_token_remove(%L)', tok_a),
      'set local role postgres',
      format('select 1 where not exists (select 1 from public.push_token where token = %L)', tok_a)
    ]);
  perform pg_temp.t562_run('ANOTHER person cannot remove it (false, and it stays)', 'rows=1', u_c,
    array[
      'set local role postgres',
      format('insert into public.push_token (user_id, token, environment, bundle_id) values (%L, %L, %L, %L)', u_a, tok_a, 'sandbox', 'com.example.app'),
      'set local role authenticated',
      format('select 1 where not public.push_token_remove(%L)', tok_a),
      'set local role postgres',
      format('select 1 from public.push_token where token = %L and user_id = %L', tok_a, u_a)
    ]);
  perform pg_temp.t562_run('ANON cannot remove', 'refused', null,
    array[format('select public.push_token_remove(%L)', tok_a)]);

  -- ── The badge ─────────────────────────────────────────────────────────────
  -- Cy: Ana's root and Ben's agent's reply in #general (thread replies are the thread's; the deleted one is gone).
  perform pg_temp.t562_run('the badge counts the channel''s own unread from others', 'rows=1', u_c,
    array['select 1 where public.team_chat_badge() = 2']);
  -- Ben: #general's two, and Ana's DM; not #team (not in the team), not his own reply.
  perform pg_temp.t562_run('a signed-in caller gets their own count, whoever they name', 'rows=1', u_b,
    array[format('select 1 where public.team_chat_badge(%L) = 3', u_c)]);
  perform pg_temp.t562_run('a muted channel counts only what mentions them', 'rows=1', u_c,
    array[
      format('select public.team_chat_set_notify(%L, %L)', ch_open, 'muted'),
      'select 1 where public.team_chat_badge() = 1'
    ]);
  perform pg_temp.t562_run('reading the channel clears it', 'rows=1', u_c,
    array[
      format('select public.team_chat_mark_read(%L)', ch_open),
      'select 1 where public.team_chat_badge() = 0'
    ]);
  -- Ana: Ben's reply in her thread, and Ben's agent's message; her own root is not hers to read.
  perform pg_temp.t562_run('a thread''s unread reply is in the badge of the people in it', 'rows=1', u_a,
    array['select 1 where public.team_chat_badge() = 2']);
  perform pg_temp.t562_run('… and reading the thread takes it out', 'rows=1', u_a,
    array[
      format('select public.team_chat_mark_thread_read(%L)', root_a),
      'select 1 where public.team_chat_badge() = 1'
    ]);
  perform pg_temp.t562_run('another workspace''s person counts nothing of it', 'rows=1', u_x,
    array['select 1 where public.team_chat_badge() = 0']);
  perform pg_temp.t562_run('ANON cannot count', 'refused', null,
    array[format('select public.team_chat_badge(%L)', u_c)]);
  perform pg_temp.t562_check('the service role names the person', '2', public.team_chat_badge(u_c)::text);
  perform pg_temp.t562_check('the service role, someone in no workspace: 0', '0', public.team_chat_badge('00000000-0000-4000-8000-0000005620ff')::text);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t562_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '562 push_tokens: % of % check(s) failed: %', v_fail, (select count(*) from t562_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t562_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '562 push_tokens: all % checks passed', (select count(*) from t562_results) using detail = v_report;
  end if;
  raise notice '562 push_tokens: all checks passed';
end
$probe$;

rollback;
