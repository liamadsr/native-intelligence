-- DB-level test for migration 474 (team_chat): who may read and write a
-- channel, a DM and their messages. The TS test
-- (src/lib/team-chat/__tests__/migration-474.test.ts) pins the file's text;
-- this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/474_team_chat.sql
-- Prints one line per probe and "474 team_chat: all checks passed". Everything
-- runs in one transaction that is rolled back: throwaway users (each gets a
-- workspace of their own from handle_new_user), a channel, a team channel, a
-- DM and their messages. Each probe runs as one caller (role authenticated
-- with that user's JWT claims) inside its own block that always rolls back,
-- so one probe never sees another's writes.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000474001'; -- Ana, member of W1, in the team
  u_b constant uuid := '00000000-0000-4000-8000-000000474002'; -- Ben, member of W1, not in the team
  u_c constant uuid := '00000000-0000-4000-8000-000000474003'; -- Cy, member of W1, not in the DM
  u_x constant uuid := '00000000-0000-4000-8000-000000474004'; -- outsider: their own workspace only
  w1 uuid; wx uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid; m_x uuid;
  ch_open uuid; ch_team uuid; ch_dm uuid;
  msg_open uuid; msg_team uuid; msg_dm uuid; msg_agent uuid;
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP); false: raise only when a check fails.
  v_raise_report constant boolean := false;
begin
  create temp table t474_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller and return 'rows=N' (the last statement's row
  -- count) or 'value=X' for a select into, or 'refused [SQLSTATE] message'.
  create function pg_temp.t474_probe(p_uid uuid, p_sqls text[])
  returns text language plpgsql as $f$
  declare
    n bigint := 0;
    s text;
  begin
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      foreach s in array p_sqls loop
        execute s;
        get diagnostics n = row_count;
      end loop;
      raise exception using errcode = 'ZP474', message = 'rows=' || n;
    exception
      when sqlstate 'ZP474' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t474_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t474_probe(p_uid, p_sqls);
  begin
    insert into t474_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't474-ana@example.invalid', '{"full_name":"t474ana"}'),
    (u_b, 't474-ben@example.invalid', '{"full_name":"t474ben"}'),
    (u_c, 't474-cy@example.invalid',  '{"full_name":"t474cy"}'),
    (u_x, 't474-out@example.invalid', '{"full_name":"t474outsider"}');

  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  select workspace_id, id into wx, m_x from public.member where user_id = u_x;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't474ben'),
    (u_c, w1, 'member', 't474cy');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;

  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't474 team', 't474-team', 'TQZ') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a);

  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't474-general', m_a) returning id into ch_open;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't474-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_b::text then m_a::text || ':' || m_b::text else m_b::text || ':' || m_a::text end, m_a) returning id into ch_dm;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch_dm, m_a, w1), (ch_dm, m_b, w1);

  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (ch_open, w1, m_a, 'hello all') returning id into msg_open;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (ch_team, w1, m_a, 'team only') returning id into msg_team;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (ch_dm, w1, m_a, 'just us') returning id into msg_dm;
  -- Ana's agent's reply (the service role writes these; here postgres, no request).
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, agent_for_member_id, agent_name, body)
  values (ch_open, w1, 'agent', m_a, 'Juniper', 'a reply') returning id into msg_agent;

  -- ── Reads ─────────────────────────────────────────────────────────────────
  perform pg_temp.t474_run('member reads the open channel', 'rows=1', u_b,
    array[format('select 1 from public.team_chat_channel where id = %L', ch_open)]);
  perform pg_temp.t474_run('member reads its messages (Ana''s and her agent''s)', 'rows=2', u_b,
    array[format('select 1 from public.team_chat_message where channel_id = %L', ch_open)]);
  perform pg_temp.t474_run('NON-MEMBER cannot see the channel', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_channel where id = %L', ch_open)]);
  perform pg_temp.t474_run('NON-MEMBER cannot read its messages', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_message where channel_id = %L', ch_open)]);
  perform pg_temp.t474_run('NON-MEMBER sees no team chat at all', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_message where workspace_id = %L', w1)]);
  perform pg_temp.t474_run('team member reads the team channel', 'rows=1', u_a,
    array[format('select 1 from public.team_chat_message where channel_id = %L', ch_team)]);
  perform pg_temp.t474_run('member outside the team cannot read the team channel', 'rows=0', u_b,
    array[format('select 1 from public.team_chat_message where channel_id = %L', ch_team)]);
  perform pg_temp.t474_run('DM member reads the DM', 'rows=1', u_b,
    array[format('select 1 from public.team_chat_message where channel_id = %L', ch_dm)]);
  perform pg_temp.t474_run('member outside the DM cannot read it', 'rows=0', u_c,
    array[format('select 1 from public.team_chat_message where channel_id = %L', ch_dm)]);
  perform pg_temp.t474_run('member outside the DM cannot see it in the list', 'rows=0', u_c,
    array[format('select 1 from public.team_chat_channel where id = %L', ch_dm)]);
  perform pg_temp.t474_run('nobody reads the agent threads (no grant at all)', 'refused', u_a,
    array['select 1 from public.team_chat_agent_thread']);

  -- ── Writes ────────────────────────────────────────────────────────────────
  perform pg_temp.t474_run('member posts in the open channel', 'rows=1', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_open, w1, m_b, 'hi')]);
  perform pg_temp.t474_run('member cannot post as someone else', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_open, w1, m_a, 'fake')]);
  perform pg_temp.t474_run('member cannot post as an agent', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_kind, agent_for_member_id, agent_name, body) values (%L, %L, %L, %L, %L, %L)', ch_open, w1, 'agent', m_b, 'Joseph', 'fake')]);
  perform pg_temp.t474_run('NON-MEMBER cannot post', 'refused', u_x,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_open, w1, m_x, 'intruder')]);
  perform pg_temp.t474_run('member outside the team cannot post in the team channel', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_team, w1, m_b, 'hi')]);
  perform pg_temp.t474_run('member outside the DM cannot post in it', 'refused', u_c,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_dm, w1, m_c, 'hi')]);
  perform pg_temp.t474_run('member cannot create a channel directly', 'refused', u_b,
    array[format('insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (%L, %L, %L, %L)', w1, 'channel', 'direct', m_b)]);
  perform pg_temp.t474_run('member cannot add themselves to a DM', 'refused', u_c,
    array[format('insert into public.team_chat_member (channel_id, member_id, workspace_id) values (%L, %L, %L)', ch_dm, m_c, w1)]);

  -- ── Edit and delete ───────────────────────────────────────────────────────
  perform pg_temp.t474_run('author edits their message', 'rows=1', u_a,
    array[format('update public.team_chat_message set body = %L where id = %L', 'hello everyone', msg_open)]);
  perform pg_temp.t474_run('another member cannot edit it', 'rows=0', u_b,
    array[format('update public.team_chat_message set body = %L where id = %L', 'hijack', msg_open)]);
  perform pg_temp.t474_run('author cannot move it to another channel', 'refused', u_a,
    array[format('update public.team_chat_message set channel_id = %L where id = %L', ch_dm, msg_open)]);
  perform pg_temp.t474_run('author deletes it: the words are cleared', 'rows=1', u_a,
    array[
      format('update public.team_chat_message set deleted_at = now() where id = %L', msg_open),
      format('select 1 from public.team_chat_message where id = %L and body = %L and deleted_at is not null', msg_open, '')
    ]);

  perform pg_temp.t474_run('author cannot change a message id', 'refused', u_a,
    array[format('update public.team_chat_message set id = gen_random_uuid() where id = %L', msg_team)]);
  perform pg_temp.t474_run('a member''s post gets the server''s clock, never a future one', 'rows=1', u_b,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at, edited_at) values (%L, %L, %L, %L, now() + interval %L, now())', ch_open, w1, m_b, 'from the future', '30 days'),
      format('select 1 from public.team_chat_message where body = %L and created_at <= now() and edited_at is null', 'from the future')
    ]);
  perform pg_temp.t474_run('member deletes their own agent''s reply', 'rows=1', u_a,
    array[
      format('update public.team_chat_message set deleted_at = now() where id = %L', msg_agent),
      format('select 1 from public.team_chat_message where id = %L and body = %L', msg_agent, '')
    ]);
  perform pg_temp.t474_run('member cannot edit their agent''s reply', 'refused', u_a,
    array[format('update public.team_chat_message set body = %L where id = %L', 'put words in its mouth', msg_agent)]);
  perform pg_temp.t474_run('another member cannot delete someone''s agent reply', 'rows=0', u_b,
    array[format('update public.team_chat_message set deleted_at = now() where id = %L', msg_agent)]);

  -- ── Functions ─────────────────────────────────────────────────────────────
  perform pg_temp.t474_run('member creates a channel through the function', 'rows=1', u_b,
    array[format('select public.team_chat_create_channel(%L, %L, null, null)', w1, 't474-new')]);
  perform pg_temp.t474_run('a taken name is refused', 'refused', u_b,
    array[format('select public.team_chat_create_channel(%L, %L, null, null)', w1, 'T474-GENERAL')]);
  perform pg_temp.t474_run('member outside the team cannot make a team channel', 'refused', u_b,
    array[format('select public.team_chat_create_channel(%L, %L, %L, null)', w1, 't474-sneaky', t1)]);
  perform pg_temp.t474_run('NON-MEMBER cannot create a channel', 'refused', u_x,
    array[format('select public.team_chat_create_channel(%L, %L, null, null)', w1, 't474-intruder')]);
  perform pg_temp.t474_run('opening the same DM finds it', 'rows=1', u_b,
    array[format('select 1 where public.team_chat_open_dm(%L, %L) = %L', w1, m_a, ch_dm)]);
  perform pg_temp.t474_run('NON-MEMBER cannot open a DM into the workspace', 'refused', u_x,
    array[format('select public.team_chat_open_dm(%L, %L)', w1, m_a)]);
  perform pg_temp.t474_run('NON-MEMBER cannot mark a channel read', 'refused', u_x,
    array[format('select public.team_chat_mark_read(%L)', ch_open)]);
  perform pg_temp.t474_run('unread counts only what the caller may read', 'rows=1', u_b,
    array[format('select 1 from public.team_chat_unread(%L) where channel_id = %L', w1, ch_dm)]);
  perform pg_temp.t474_run('unread never lists a channel the caller may not read', 'rows=0', u_c,
    array[format('select 1 from public.team_chat_unread(%L) where channel_id in (%L, %L)', w1, ch_team, ch_dm)]);
  perform pg_temp.t474_run('NON-MEMBER gets no unread counts', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_unread(%L)', w1)]);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t474_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '474 team_chat: % of % check(s) failed: %', v_fail, (select count(*) from t474_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t474_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '474 team_chat: all % checks passed', (select count(*) from t474_results) using detail = v_report;
  end if;
  raise notice '474 team_chat: all checks passed';
end
$probe$;

rollback;
