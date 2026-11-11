-- DB-level test for migrations 560-561 (team chat, phase 2: messages reach
-- you): how loud each channel is, who a message may notify, reading clears
-- notifications, and the search that finds only what the caller may read.
-- The TS tests (src/lib/team-chat/__tests__/migration-560.test.ts) pin the
-- files' text; this runs the SQL.
--
-- The DEV run (the Supabase CLI: one statement) raises its report instead; a
-- copy with v_raise_report true.
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/560_team_chat_reach.sql
-- Prints one line per probe and "560 team_chat_reach: all checks passed".
-- Everything runs in one transaction that is rolled back: throwaway users
-- (each gets a workspace of their own from handle_new_user), a channel, a
-- team channel, a DM and their messages. Each probe runs as one caller (role
-- authenticated with that user's JWT claims) inside its own block that
-- always rolls back, so one probe never sees another's writes.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000560001'; -- Ana, member of W1, in the team
  u_b constant uuid := '00000000-0000-4000-8000-000000560002'; -- Ben, member of W1, not in the team, in the DM
  u_c constant uuid := '00000000-0000-4000-8000-000000560003'; -- Cy, member of W1, not in the DM
  u_x constant uuid := '00000000-0000-4000-8000-000000560004'; -- outsider: their own workspace only
  w1 uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid; m_x uuid;
  ch_open uuid; ch_team uuid; ch_dm uuid;
  root_a uuid; reply_b uuid; msg_team uuid; msg_dm uuid; msg_gone uuid; msg_agent uuid;
  t0 timestamptz := now() - interval '1 hour';
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP or CLI); false: raise only when a check fails.
  v_raise_report constant boolean := false;
begin
  create temp table t560_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller and return 'rows=N' (the last statement's row
  -- count) or 'refused [SQLSTATE] message'.
  create function pg_temp.t560_probe(p_uid uuid, p_sqls text[])
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
      raise exception using errcode = 'ZP560', message = 'rows=' || n;
    exception
      when sqlstate 'ZP560' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t560_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t560_probe(p_uid, p_sqls);
  begin
    insert into t560_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- A check made as postgres (the service role's view: no RLS).
  create function pg_temp.t560_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t560_results (label, expected, got, pass) values (p_label, p_expect, p_got, p_got = p_expect);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't560-ana@example.invalid', '{"full_name":"t560ana"}'),
    (u_b, 't560-ben@example.invalid', '{"full_name":"t560ben"}'),
    (u_c, 't560-cy@example.invalid',  '{"full_name":"t560cy"}'),
    (u_x, 't560-out@example.invalid', '{"full_name":"t560outsider"}');

  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  select id into m_x from public.member where user_id = u_x;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't560ben'),
    (u_c, w1, 'member', 't560cy');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  update public.member set created_at = t0 where id in (m_a, m_b, m_c);

  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't560 team', 't560-team', 'TQZ') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a);

  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't560-general', m_a) returning id into ch_open;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't560-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_b::text then m_a::text || ':' || m_b::text else m_b::text || ':' || m_a::text end, m_a) returning id into ch_dm;
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at) values (ch_dm, m_a, w1, t0), (ch_dm, m_b, w1, t0);

  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, mentions, created_at)
  values (ch_open, w1, m_a, 'the zebrafish launch plan is ready for t560cy', array[m_c], t0 + interval '10 minutes') returning id into root_a;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id, created_at)
  values (ch_open, w1, m_b, 'zebrafish looks good to me', root_a, t0 + interval '20 minutes') returning id into reply_b;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, mentions, created_at)
  values (ch_team, w1, m_a, 'zebrafish budget for the team only, cc t560ben', array[m_b], t0 + interval '10 minutes') returning id into msg_team;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
  values (ch_dm, w1, m_a, 'zebrafish secret between us', t0 + interval '10 minutes') returning id into msg_dm;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at, deleted_at)
  values (ch_open, w1, m_a, '', t0 + interval '11 minutes', now()) returning id into msg_gone;
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, agent_for_member_id, agent_name, body, created_at)
  values (ch_open, w1, 'agent', m_b, 'Juniper', 'zebrafish answer from the agent', t0 + interval '30 minutes') returning id into msg_agent;

  -- ── How loud a channel is (team_chat_set_notify) ──────────────────────────
  perform pg_temp.t560_run('a member sets a channel to all messages (the level in effect comes back)', 'rows=1', u_c,
    array[format('select 1 where public.team_chat_set_notify(%L, %L) = %L', ch_open, 'all', 'all')]);
  perform pg_temp.t560_run('a first row keeps the unread count where it was (read from when they joined)', 'rows=1', u_c,
    array[
      format('select public.team_chat_set_notify(%L, %L)', ch_open, 'muted'),
      format('select 1 from public.team_chat_member where channel_id = %L and notify_level = %L and last_read_at = %L::timestamptz', ch_open, 'muted', t0)
    ]);
  perform pg_temp.t560_run('null puts the default back: mentions for a channel', 'rows=1', u_c,
    array[format('select 1 where public.team_chat_set_notify(%L, null) = %L', ch_open, 'mentions')]);
  perform pg_temp.t560_run('null puts the default back: all for a DM', 'rows=1', u_b,
    array[format('select 1 where public.team_chat_set_notify(%L, null) = %L', ch_dm, 'all')]);
  perform pg_temp.t560_run('an unknown level is refused', 'refused', u_c,
    array[format('select public.team_chat_set_notify(%L, %L)', ch_open, 'loud')]);
  perform pg_temp.t560_run('NON-MEMBER cannot set a channel of the workspace', 'refused', u_x,
    array[format('select public.team_chat_set_notify(%L, %L)', ch_open, 'all')]);
  perform pg_temp.t560_run('a member outside the DM cannot set it', 'refused', u_c,
    array[format('select public.team_chat_set_notify(%L, %L)', ch_dm, 'all')]);
  perform pg_temp.t560_run('a member outside the team cannot set its channel', 'refused', u_b,
    array[format('select public.team_chat_set_notify(%L, %L)', ch_team, 'all')]);
  perform pg_temp.t560_run('nobody writes the level directly', 'refused', u_b,
    array[format('update public.team_chat_member set notify_level = %L where channel_id = %L', 'muted', ch_dm)]);

  -- ── Who a message may notify (service role only) ──────────────────────────
  perform pg_temp.t560_run('a person cannot ask who a message notifies', 'refused', u_a,
    array[format('select * from public.team_chat_notify_candidates(%L)', msg_dm)]);

  -- As postgres (the service role's view).
  perform pg_temp.t560_check('a DM message: the other person, in the DM, may read, not its author', 'b',
    (select string_agg(case when member_id = m_b and in_dm and can_read and not is_author then 'b' when member_id = m_a and is_author then '' else 'x' end, '' order by member_id)
       from public.team_chat_notify_candidates(msg_dm)));
  perform pg_temp.t560_check('a channel message: the person it mentions, may read', 'mentioned',
    (select string_agg(case when mentioned and can_read then 'mentioned' else 'x' end, ',') from public.team_chat_notify_candidates(root_a) where member_id = m_c));
  perform pg_temp.t560_check('a team channel''s mention of someone outside the team: may not read', 'false',
    (select can_read::text from public.team_chat_notify_candidates(msg_team) where member_id = m_b));
  perform pg_temp.t560_check('a thread''s reply: the root''s author is in the thread, Cy (mentioned in the root) is not', 'a:true,c:none',
    'a:' || coalesce((select in_thread::text from public.team_chat_notify_candidates(reply_b) where member_id = m_a), 'none')
    || ',c:' || coalesce((select in_thread::text from public.team_chat_notify_candidates(reply_b) where member_id = m_c), 'none'));
  perform pg_temp.t560_check('the agent''s reply: the person who asked', 'asked',
    (select case when asked and not is_author then 'asked' else 'x' end from public.team_chat_notify_candidates(msg_agent) where member_id = m_b));
  perform pg_temp.t560_check('a deleted message notifies nobody', '0',
    (select count(*)::text from public.team_chat_notify_candidates(msg_gone)));
  -- Read past it: the DM read up to now.
  update public.team_chat_member set last_read_at = now() where channel_id = ch_dm and member_id = m_b;
  perform pg_temp.t560_check('someone who already read past it is said to', 'true',
    (select read_past::text from public.team_chat_notify_candidates(msg_dm) where member_id = m_b));
  -- A channel set to all: its members are candidates, with their level.
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at, notify_level) values (ch_open, m_b, w1, t0, 'all');
  perform pg_temp.t560_check('a member who set the channel to all is a candidate, at that level', 'all',
    (select notify_level from public.team_chat_notify_candidates(root_a) where member_id = m_b));
  perform pg_temp.t560_check('nobody else is a candidate for a plain channel message', '2',
    (select count(*)::text from public.team_chat_notify_candidates(root_a)));

  -- ── Notifications: the type, one per message per person ───────────────────
  insert into public.notification (workspace_id, recipient_id, type, title, target_type, target_id, context_type, context_id, group_key)
  values (w1, m_b, 'team_chat_message', 't560', 'team_chat_message', msg_dm, 'team_chat_channel', ch_dm, 'team_chat:' || ch_dm::text);
  begin
    insert into public.notification (workspace_id, recipient_id, type, title, target_type, target_id, group_key)
    values (w1, m_b, 'team_chat_message', 't560 again', 'team_chat_message', msg_dm, 'team_chat:' || ch_dm::text);
    perform pg_temp.t560_check('a second notification of the same message for the same person is refused', 'refused', 'written');
  exception when unique_violation then
    perform pg_temp.t560_check('a second notification of the same message for the same person is refused', 'refused', 'refused');
  end;
  insert into public.notification (workspace_id, recipient_id, type, title, target_type, target_id, context_type, context_id, group_key) values
    (w1, m_b, 'team_chat_message', 't560 thread', 'team_chat_message', reply_b, 'team_chat_channel', ch_open, 'team_chat_thread:' || root_a::text),
    (w1, m_a, 'team_chat_message', 't560 ana', 'team_chat_message', msg_dm, 'team_chat_channel', ch_dm, 'team_chat:' || ch_dm::text),
    (w1, m_c, 'team_chat_message', 't560 cy', 'team_chat_message', root_a, 'team_chat_channel', ch_open, 'team_chat:' || ch_open::text);
  insert into public.reach_notice (user_id, workspace_id, ref_type, ref_id, channel)
  values (u_b, w1, 'team_chat_notification', gen_random_uuid(), 'email');
  perform pg_temp.t560_check('the email claims a team chat notification on reach_notice', '1',
    (select count(*)::text from public.reach_notice where user_id = u_b and ref_type = 'team_chat_notification' and channel = 'email'));

  -- ── Reading clears them ───────────────────────────────────────────────────
  perform pg_temp.t560_run('reading the DM reads its notifications, the person''s own only', 'rows=1', u_b,
    array[
      format('select public.team_chat_mark_read(%L)', ch_dm),
      format('select 1 from public.notification where recipient_id = %L and target_id = %L and is_read', m_b, msg_dm)
    ]);
  perform pg_temp.t560_run('… and leaves a thread''s notifications unread', 'rows=1', u_b,
    array[
      format('select public.team_chat_mark_read(%L)', ch_dm),
      format('select public.team_chat_mark_read(%L)', ch_open),
      format('select 1 from public.notification where recipient_id = %L and target_id = %L and not is_read', m_b, reply_b)
    ]);
  perform pg_temp.t560_run('… and another person''s stay as they were', 'rows=1', u_b,
    array[
      format('select public.team_chat_mark_read(%L)', ch_dm),
      format('select set_config(%L, %L, true)', 'request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text),
      format('select 1 from public.notification where recipient_id = %L and target_id = %L and not is_read', m_a, msg_dm)
    ]);
  perform pg_temp.t560_run('reading the thread reads its notifications', 'rows=1', u_b,
    array[
      format('select public.team_chat_mark_thread_read(%L)', root_a),
      format('select 1 from public.notification where recipient_id = %L and target_id = %L and is_read', m_b, reply_b)
    ]);
  perform pg_temp.t560_run('a channel they may not read is still refused', 'refused', u_c,
    array[format('select public.team_chat_mark_read(%L)', ch_dm)]);

  -- ── Search: only what the caller may read, never a deleted message ────────
  perform pg_temp.t560_run('a member finds the channel''s messages by a word''s start', 'rows=3', u_c,
    array[format('select * from public.team_chat_search(%L, %L, 25)', w1, 'zebra')]);
  perform pg_temp.t560_run('… every word typed must match', 'rows=1', u_c,
    array[format('select * from public.team_chat_search(%L, %L, 25)', w1, 'zebrafish launch')]);
  perform pg_temp.t560_run('a hit says where and who, and the passage that matched', 'rows=1', u_c,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where id = %L and place = %L and author_name = %L and snippet like %L and thread_root_id is null', w1, 'launch', root_a, '#t560-general', 't560ana', '%launch%')]);
  perform pg_temp.t560_run('a reply in a thread says its root', 'rows=1', u_c,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where id = %L and thread_root_id = %L', w1, 'looks good', reply_b, root_a)]);
  perform pg_temp.t560_run('NON-MEMBER of a private team channel finds nothing of it', 'rows=0', u_b,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where channel_id = %L', w1, 'zebrafish budget', ch_team)]);
  perform pg_temp.t560_run('the team''s member does find it', 'rows=1', u_a,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where id = %L', w1, 'budget', msg_team)]);
  perform pg_temp.t560_run('a DM OUTSIDER finds nothing of the DM', 'rows=0', u_c,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where channel_id = %L', w1, 'secret', ch_dm)]);
  perform pg_temp.t560_run('one of the DM''s two finds it, named by the other person', 'rows=1', u_b,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where id = %L and place = %L', w1, 'secret', msg_dm, 't560ana')]);
  perform pg_temp.t560_run('another workspace''s member finds nothing at all', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_search(%L, %L, 25)', w1, 'zebrafish')]);
  perform pg_temp.t560_run('a deleted message is never found', 'rows=0', u_a,
    array[
      format('update public.team_chat_message set deleted_at = now() where id = %L', root_a),
      format('select 1 from public.team_chat_search(%L, %L, 25) where id = %L', w1, 'launch', root_a)
    ]);
  perform pg_temp.t560_run('nothing typed, only stop words, or only punctuation: nothing, and no error', 'rows=0', u_a,
    array[
      format('select 1 from public.team_chat_search(%L, %L, 25)', w1, ''),
      format('select 1 from public.team_chat_search(%L, %L, 25)', w1, 'the'),
      format('select 1 from public.team_chat_search(%L, %L, 25)', w1, ':*&|!()')
    ]);
  perform pg_temp.t560_run('query grammar typed is only letters to the search', 'rows=1', u_c,
    array[format('select 1 from public.team_chat_search(%L, %L, 25) where id = %L', w1, 'zebrafish & !looks:* | (good', reply_b)]);
  perform pg_temp.t560_run('at most lim rows', 'rows=1', u_c,
    array[format('select * from public.team_chat_search(%L, %L, 1)', w1, 'zebrafish')]);

  -- ── A notification says the message as it is now ─────────────────────────
  perform pg_temp.t560_check('a notification is written with the message''s own words, whatever the writer sent', 'zebrafish secret between us',
    (select body from public.notification where recipient_id = m_b and target_id = msg_dm));
  perform pg_temp.t560_run('pasted a secret, then edited it out: the notification no longer holds it', 'rows=1', u_a,
    array[
      format('update public.team_chat_message set body = %L where id = %L', 'nothing to see here', msg_dm),
      format('select set_config(%L, %L, true)', 'request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text),
      format('select 1 from public.notification where recipient_id = %L and target_id = %L and body = %L', m_b, msg_dm, 'nothing to see here')
    ]);
  perform pg_temp.t560_run('a deleted message''s notifications go, everyone''s', 'rows=0', u_a,
    array[
      format('update public.team_chat_message set deleted_at = now() where id = %L', msg_dm),
      format('select set_config(%L, %L, true)', 'request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text),
      format('select 1 from public.notification where target_id = %L', msg_dm)
    ]);
  insert into public.notification (workspace_id, recipient_id, type, title, body, target_type, target_id, group_key)
  values (w1, m_c, 'team_chat_message', 't560 late', 'the words before the delete', 'team_chat_message', msg_gone, 'team_chat:' || ch_open::text);
  perform pg_temp.t560_check('a notification of a message already deleted is never written (the fan-out racing a delete)', '0',
    (select count(*)::text from public.notification where target_id = msg_gone));

  -- ── What the away email may read (service role only) ─────────────────────
  perform pg_temp.t560_run('a person cannot ask what someone may read', 'refused', u_a,
    array[format('select * from public.team_chat_readable_messages(%L, array[%L]::uuid[])', m_a, root_a)]);
  perform pg_temp.t560_check('only the messages the member may read now: not the team channel''s, not a DM they''re outside, not a deleted one', 'agent,root',
    (select string_agg(case id when root_a then 'root' when msg_agent then 'agent' else id::text end, ',' order by case id when root_a then 'root' when msg_agent then 'agent' else id::text end)
       from public.team_chat_readable_messages(m_c, array[root_a, msg_dm, msg_team, msg_gone, msg_agent])));
  perform pg_temp.t560_check('a team member reads the team channel''s message, with its words now', 'zebrafish budget for the team only, cc t560ben',
    (select body from public.team_chat_readable_messages(m_a, array[msg_team])));
  -- Removed from the private channel's team before the email goes: nothing of it.
  delete from public.team_member where team_id = t1 and member_id = m_a;
  perform pg_temp.t560_check('mentioned, then removed from the private channel: the email reads nothing of it', '0',
    (select count(*)::text from public.team_chat_readable_messages(m_a, array[msg_team])));
  -- Left the workspace: nothing at all.
  delete from public.member where id = m_c;
  perform pg_temp.t560_check('no longer a member of the workspace: nothing at all', '0',
    (select count(*)::text from public.team_chat_readable_messages(m_c, array[root_a, msg_agent])));

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t560_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '560 team_chat_reach: % of % check(s) failed: %', v_fail, (select count(*) from t560_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t560_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '560 team_chat_reach: all % checks passed', (select count(*) from t560_results) using detail = v_report;
  end if;
  raise notice '560 team_chat_reach: all checks passed';
end
$probe$;

rollback;
