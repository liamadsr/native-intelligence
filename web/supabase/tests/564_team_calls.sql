-- DB-level test for migrations 564-565 (team calls): one live call per
-- channel, who may start, see and ring a call, a person's rings are theirs
-- alone, answering once, LiveKit's events applied in order whatever order
-- they arrive in, and a call's end. The TS tests
-- (src/lib/team-calls/__tests__/migration-564.test.ts) pin the files' text;
-- this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/564_team_calls.sql
-- Prints one line per probe and "564 team_calls: all checks passed".
-- Everything runs in one transaction that is rolled back: throwaway users
-- (each gets a workspace of their own from handle_new_user), a channel, a
-- team channel, a DM and their calls. A probe runs as one caller (role
-- authenticated with that user's JWT claims) inside its own block that
-- always rolls back; t564_as runs as a caller and keeps what it did (the
-- calls the later probes are about).

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000564001'; -- Ana, W1, in the team, in the DM
  u_b constant uuid := '00000000-0000-4000-8000-000000564002'; -- Ben, W1, not in the team, in the DM
  u_c constant uuid := '00000000-0000-4000-8000-000000564003'; -- Cy, W1, not in the DM, not in the team
  u_x constant uuid := '00000000-0000-4000-8000-000000564004'; -- outsider: their own workspace only
  w1 uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid; m_x uuid;
  ch_open uuid; ch_team uuid; ch_dm uuid;
  call_open uuid; call_dm uuid; call_again uuid;
  room_open text; room_dm text;
  msg_open uuid;
  ring_b uuid; ring_c uuid;
  t0 timestamptz := now() - interval '30 minutes';
  v_got text;
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP or CLI); false: raise only when a check fails.
  v_raise_report constant boolean := true;
begin
  create temp table t564_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller and return 'rows=N' (the last statement's row
  -- count) or 'refused [SQLSTATE] message'. Always rolled back.
  create function pg_temp.t564_probe(p_uid uuid, p_sqls text[])
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
      raise exception using errcode = 'ZP564', message = 'rows=' || n;
    exception
      when sqlstate 'ZP564' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t564_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t564_probe(p_uid, p_sqls);
  begin
    insert into t564_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- Run one query as a caller and KEEP what it did: its first column, as text.
  create function pg_temp.t564_as(p_uid uuid, p_sql text)
  returns text language plpgsql as $f$
  declare
    v text;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    execute p_sql into v;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    return v;
  end $f$;

  -- A check made as postgres (the service role's view: no RLS).
  create function pg_temp.t564_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t564_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't564-ana@example.invalid', '{"full_name":"t564ana"}'),
    (u_b, 't564-ben@example.invalid', '{"full_name":"t564ben"}'),
    (u_c, 't564-cy@example.invalid',  '{"full_name":"t564cy"}'),
    (u_x, 't564-out@example.invalid', '{"full_name":"t564outsider"}');

  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  select id into m_x from public.member where user_id = u_x;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't564ben'),
    (u_c, w1, 'member', 't564cy');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  update public.member set display_name = 't564ana' where id = m_a;

  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't564 team', 't564-team', 'TQY') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a);

  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't564-general', m_a) returning id into ch_open;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't564-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_b::text then m_a::text || ':' || m_b::text else m_b::text || ':' || m_a::text end, m_a) returning id into ch_dm;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch_dm, m_a, w1), (ch_dm, m_b, w1);

  -- ── The words of an ended call ────────────────────────────────────────────
  perform pg_temp.t564_check('a DM nobody answered', 'Missed call', public.team_call_summary('dm', 30, 1));
  perform pg_temp.t564_check('nobody joined', 'Call ended', public.team_call_summary('channel', 0, 0));
  perform pg_temp.t564_check('twelve and a half minutes, three people', 'Call ended · 12 min · 3 people', public.team_call_summary('channel', 754, 3));
  perform pg_temp.t564_check('over an hour', 'Call ended · 1 h 5 min · 2 people', public.team_call_summary('dm', 3900, 2));
  perform pg_temp.t564_check('under a minute, one person', 'Call ended · under a minute · 1 person', public.team_call_summary('channel', 45, 1));
  perform pg_temp.t564_check('exactly two hours', 'Call ended · 2 h · 4 people', public.team_call_summary('channel', 7200, 4));

  -- ── Starting ──────────────────────────────────────────────────────────────
  perform pg_temp.t564_run('a member starts a call in an open channel: a new one', 'rows=1', u_a,
    array[format('select 1 from public.team_call_start(%L) where created', ch_open)]);
  perform pg_temp.t564_run('… and its message is in the channel: a call, its words', 'rows=1', u_a,
    array[
      format('select * from public.team_call_start(%L)', ch_open),
      format('select 1 from public.team_call c join public.team_chat_message m on m.id = c.message_id where c.channel_id = %L and c.status = %L and m.kind = %L and m.call_id = c.id and m.body = %L and m.author_member_id = %L', ch_open, 'live', 'call', 'Started a call', m_a)
    ]);

  call_open := pg_temp.t564_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_open))::uuid;
  select room, message_id into room_open, msg_open from public.team_call where id = call_open;
  -- It started half an hour ago (the events below are timed from then).
  update public.team_call set started_at = t0 where id = call_open;
  perform pg_temp.t564_check('its room is named for it', 'tc-' || call_open::text, room_open);

  perform pg_temp.t564_run('a second start in the channel joins the live call, never a second', 'rows=1', u_b,
    array[format('select 1 from public.team_call_start(%L) where call_id = %L and not created', ch_open, call_open)]);
  perform pg_temp.t564_check('one live call in the channel', '1',
    (select count(*)::text from public.team_call where channel_id = ch_open and status = 'live'));
  begin
    insert into public.team_call (workspace_id, channel_id, room) values (w1, ch_open, 'tc-t564-second');
    perform pg_temp.t564_check('the database refuses a second live call in a channel', 'refused', 'written');
  exception when unique_violation then
    perform pg_temp.t564_check('the database refuses a second live call in a channel', 'refused', 'refused');
  end;
  perform pg_temp.t564_run('a member outside the team cannot start a call in its channel', 'refused', u_c,
    array[format('select * from public.team_call_start(%L)', ch_team)]);
  perform pg_temp.t564_run('a member outside the DM cannot start a call in it', 'refused', u_c,
    array[format('select * from public.team_call_start(%L)', ch_dm)]);
  perform pg_temp.t564_run('NON-MEMBER cannot start a call in the workspace', 'refused', u_x,
    array[format('select * from public.team_call_start(%L)', ch_open)]);

  -- ── A call's message is the call's ────────────────────────────────────────
  perform pg_temp.t564_run('its author cannot edit a call''s message', 'refused', u_a,
    array[format('update public.team_chat_message set body = %L where id = %L', 'hello', msg_open)]);
  perform pg_temp.t564_run('its author cannot delete a call''s message', 'refused', u_a,
    array[format('update public.team_chat_message set deleted_at = now() where id = %L', msg_open)]);
  perform pg_temp.t564_run('a member cannot post a call''s message themselves', 'refused', u_a,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, kind) values (%L, %L, %L, %L, %L)', ch_open, w1, m_a, 'fake call', 'call')]);
  perform pg_temp.t564_run('a member cannot hang a call on a plain message', 'refused', u_a,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, call_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_a, 'fake call', call_open)]);
  perform pg_temp.t564_run('a plain message is still posted as before', 'rows=1', u_a,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_open, w1, m_a, 't564 plain')]);
  perform pg_temp.t564_run('a reply in a thread under a call''s message is fine', 'rows=1', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_b, 't564 about the call', msg_open)]);

  -- ── Who sees a call ───────────────────────────────────────────────────────
  call_dm := pg_temp.t564_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_dm))::uuid;
  select room into room_dm from public.team_call where id = call_dm;
  perform pg_temp.t564_run('a member sees the call in an open channel', 'rows=1', u_c,
    array[format('select 1 from public.team_call where id = %L', call_open)]);
  perform pg_temp.t564_run('NON-MEMBER sees no call of the workspace', 'rows=0', u_x,
    array[format('select 1 from public.team_call where workspace_id = %L', w1)]);
  perform pg_temp.t564_run('a member outside the DM does not see its call', 'rows=0', u_c,
    array[format('select 1 from public.team_call where id = %L', call_dm)]);
  perform pg_temp.t564_run('the other person in the DM sees its call', 'rows=1', u_b,
    array[format('select 1 from public.team_call where id = %L', call_dm)]);
  perform pg_temp.t564_run('nobody writes a call directly', 'refused', u_a,
    array[format('update public.team_call set status = %L, ended_at = now(), ended_reason = %L where id = %L', 'ended', 'finished', call_open)]);
  perform pg_temp.t564_run('nobody makes a call directly', 'refused', u_a,
    array[format('insert into public.team_call (workspace_id, channel_id, room) values (%L, %L, %L)', w1, ch_team, 'tc-t564-direct')]);
  perform pg_temp.t564_run('nobody writes who is in a call', 'refused', u_a,
    array[format('insert into public.team_call_participant (call_id, member_id, workspace_id, channel_id, state, first_joined_at, joined_at, last_event_at) values (%L, %L, %L, %L, %L, now(), now(), now())', call_open, m_a, w1, ch_open, 'joined')]);
  perform pg_temp.t564_run('nobody reads the webhook ids', 'refused', u_a,
    array['select 1 from public.team_call_webhook_event']);

  -- ── Ringing ───────────────────────────────────────────────────────────────
  perform pg_temp.t564_run('the caller rings the other person in the DM', 'rows=1', u_a,
    array[format('select 1 from public.team_call_ring_members(%L, array[%L, %L]::uuid[]) where member_id = %L and state = %L', call_dm, m_b, m_a, m_b, 'ringing')]);
  ring_b := pg_temp.t564_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm, m_b))::uuid;
  perform pg_temp.t564_check('the ring carries who calls and from where', 't564ana/dm',
    (select caller_name || '/' || channel_kind from public.team_call_ring where id = ring_b));
  perform pg_temp.t564_check('the call says who is being rung', 'true',
    (select (m_b = any (ringing))::text from public.team_call where id = call_dm));
  perform pg_temp.t564_run('ringing them again while it rings makes no second ring', 'rows=0', u_a,
    array[format('select 1 from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm, m_b)]);
  perform pg_temp.t564_run('ringing someone who may not read the DM rings nobody', 'rows=0', u_a,
    array[format('select 1 from public.team_call_ring_members(%L, array[%L, %L]::uuid[])', call_dm, m_c, m_x)]);
  perform pg_temp.t564_run('the rung person sees their ring', 'rows=1', u_b,
    array[format('select 1 from public.team_call_ring where id = %L and state = %L', ring_b, 'ringing')]);
  perform pg_temp.t564_run('the caller does not see the other person''s ring', 'rows=0', u_a,
    array[format('select 1 from public.team_call_ring where id = %L', ring_b)]);
  perform pg_temp.t564_run('nobody else sees it', 'rows=0', u_c,
    array[format('select 1 from public.team_call_ring where id = %L', ring_b)]);
  perform pg_temp.t564_run('nobody writes a ring directly', 'refused', u_b,
    array[format('update public.team_call_ring set state = %L where id = %L', 'accepted', ring_b)]);
  perform pg_temp.t564_run('a member who may not read the call cannot ring for it', 'refused', u_c,
    array[format('select * from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm, m_b)]);
  perform pg_temp.t564_run('more than 20 at once is refused', 'refused', u_a,
    array[format('select * from public.team_call_ring_members(%L, array_fill(%L::uuid, array[21]))', call_open, m_b)]);

  -- ── Answering ─────────────────────────────────────────────────────────────
  perform pg_temp.t564_run('the caller cannot answer the other person''s ring', 'refused', u_a,
    array[format('select * from public.team_call_answer(%L, true)', ring_b)]);
  v_got := pg_temp.t564_as(u_b, format('select state from public.team_call_answer(%L, false)', ring_b));
  perform pg_temp.t564_check('the rung person declines', 'declined', v_got);
  v_got := pg_temp.t564_as(u_b, format('select state from public.team_call_answer(%L, true)', ring_b));
  perform pg_temp.t564_check('answering again (another tab) changes nothing and says how it was settled', 'declined', v_got);
  perform pg_temp.t564_check('the call says who declined, and rings nobody now', 'true/0',
    (select (m_b = any (declined))::text || '/' || cardinality(ringing)::text from public.team_call where id = call_dm));

  -- ── LiveKit's events, in any order ────────────────────────────────────────
  perform pg_temp.t564_check('a join', 'joined', public.team_call_participant_event(room_open, m_b, 'PA_b1', true, t0 + interval '1 minute', t0 + interval '1 minute'));
  perform pg_temp.t564_check('the same join again (a repeat)', 'same', public.team_call_participant_event(room_open, m_b, 'PA_b1', true, t0 + interval '1 minute', t0 + interval '1 minute'));
  perform pg_temp.t564_check('a second person joins', 'joined', public.team_call_participant_event(room_open, m_a, 'PA_a1', true, t0 + interval '2 minutes', t0 + interval '2 minutes'));
  perform pg_temp.t564_check('two in it, peak two', '2/2',
    (select participant_count::text || '/' || peak_participants::text from public.team_call where id = call_open));
  perform pg_temp.t564_check('a leave', 'left', public.team_call_participant_event(room_open, m_b, 'PA_b1', false, t0 + interval '5 minutes', t0 + interval '1 minute'));
  perform pg_temp.t564_check('that session''s join arriving late is stale', 'stale', public.team_call_participant_event(room_open, m_b, 'PA_b1', true, t0 + interval '1 minute', t0 + interval '1 minute'));
  perform pg_temp.t564_check('… and leaves them out', 'left',
    (select state from public.team_call_participant where call_id = call_open and member_id = m_b));
  perform pg_temp.t564_check('a new session joins (rejoined)', 'joined', public.team_call_participant_event(room_open, m_b, 'PA_b2', true, t0 + interval '6 minutes', t0 + interval '6 minutes'));
  perform pg_temp.t564_check('the old session''s leave arriving late is stale', 'stale', public.team_call_participant_event(room_open, m_b, 'PA_b1', false, t0 + interval '5 minutes', t0 + interval '1 minute'));
  perform pg_temp.t564_check('… and keeps them in, on the new session', 'joined/PA_b2',
    (select state || '/' || session_sid from public.team_call_participant where call_id = call_open and member_id = m_b));
  perform pg_temp.t564_check('a reconnect: the new session joins', 'joined', public.team_call_participant_event(room_open, m_b, 'PA_b3', true, t0 + interval '6 minutes 40 seconds', t0 + interval '6 minutes 40.250 seconds'));
  perform pg_temp.t564_check('… and the old one’s leave lands in the same second: stale', 'stale', public.team_call_participant_event(room_open, m_b, 'PA_b2', false, t0 + interval '6 minutes 40 seconds', t0 + interval '6 minutes'));
  perform pg_temp.t564_check('… so they are still in, on the new session', 'joined/PA_b3',
    (select state || '/' || session_sid from public.team_call_participant where call_id = call_open and member_id = m_b));
  perform pg_temp.t564_check('a leave that arrives before its join', 'left', public.team_call_participant_event(room_open, m_c, 'PA_c9', false, t0 + interval '8 minutes', t0 + interval '7 minutes 30 seconds'));
  perform pg_temp.t564_check('… makes that join stale when it comes', 'stale', public.team_call_participant_event(room_open, m_c, 'PA_c9', true, t0 + interval '7 minutes', t0 + interval '7 minutes 30 seconds'));
  perform pg_temp.t564_check('a room that is no call of ours', 'unknown', public.team_call_participant_event('some-other-room', m_a, 'PA_z', true, now(), now()));
  perform pg_temp.t564_check('an identity that is no member of the call''s workspace', 'unknown', public.team_call_participant_event(room_open, m_x, 'PA_x', true, now(), now()));
  perform pg_temp.t564_check('two in it, peak two (Cy never counted)', '2/2',
    (select participant_count::text || '/' || peak_participants::text from public.team_call where id = call_open));
  perform pg_temp.t564_run('a person cannot report who is in a call', 'refused', u_a,
    array[format('select public.team_call_participant_event(%L, %L, %L, true, now(), now())', room_open, m_c, 'PA_fake')]);

  -- Joining answers a ring; a person in a call is busy for another.
  ring_c := pg_temp.t564_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_c))::uuid;
  perform pg_temp.t564_check('a channel''s member is rung', 'ringing', (select state from public.team_call_ring where id = ring_c));
  perform pg_temp.t564_check('Cy joins on another session', 'joined', public.team_call_participant_event(room_open, m_c, 'PA_c10', true, t0 + interval '9 minutes', t0 + interval '9 minutes'));
  perform pg_temp.t564_check('… and their ring is answered by it', 'accepted', (select state from public.team_call_ring where id = ring_c));
  perform pg_temp.t564_check('three in it, peak three', '3/3',
    (select participant_count::text || '/' || peak_participants::text from public.team_call where id = call_open));
  perform pg_temp.t564_run('ringing someone already in the call rings nobody', 'rows=0', u_b,
    array[format('select 1 from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_c)]);
  perform pg_temp.t564_run('ringing someone in another call: a quiet notice, not a ring', 'rows=1', u_a,
    array[format('select 1 from public.team_call_ring_members(%L, array[%L]::uuid[]) where state = %L', call_dm, m_b, 'busy')]);

  -- ── Rings that run out ────────────────────────────────────────────────────
  ring_b := pg_temp.t564_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm, m_b))::uuid;
  perform pg_temp.t564_check('nothing runs out early', '0', (select count(*)::text from public.team_call_expire_rings(ring_b)));
  update public.team_call_ring set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where id = ring_b;
  perform pg_temp.t564_run('answering a ring past its time: missed, and it stays open for its timer', 'rows=1', u_b,
    array[
      format('select 1 from public.team_call_answer(%L, true) where state = %L', ring_b, 'missed'),
      format('select 1 from public.team_call_ring where id = %L and state = %L', ring_b, 'busy')
    ]);
  perform pg_temp.t564_check('a ring past its time is missed, and said so', '1', (select count(*)::text from public.team_call_expire_rings(ring_b)));
  perform pg_temp.t564_check('… once', '0', (select count(*)::text from public.team_call_expire_rings(null)));
  perform pg_temp.t564_check('… and its state', 'missed', (select state from public.team_call_ring where id = ring_b));
  perform pg_temp.t564_run('a person cannot run rings out', 'refused', u_a,
    array['select * from public.team_call_expire_rings(null)']);

  -- ── The end ───────────────────────────────────────────────────────────────
  ring_c := pg_temp.t564_as(u_a, format('select ring_id::text from public.team_call_ring_members(%L, array[%L]::uuid[])', call_dm, m_b))::uuid;
  perform pg_temp.t564_check('the DM''s caller hangs up: the open ring comes back missed', '1',
    (select count(*)::text from public.team_call_end(call_dm, 'left', now()) where ring_id = ring_c and member_id = m_b and user_id = u_b));
  perform pg_temp.t564_check('… and the DM''s message says it was missed', 'Missed call',
    (select m.body from public.team_chat_message m join public.team_call c on c.message_id = m.id where c.id = call_dm));
  perform pg_temp.t564_check('the people leave at their own times', 'left', public.team_call_participant_event(room_open, m_c, 'PA_c10', false, t0 + interval '12 minutes', t0 + interval '9 minutes'));
  perform pg_temp.t564_check('the room finished: nothing rang', '0',
    (select count(*)::text from public.team_call_end(call_open, 'finished', t0 + interval '20 minutes')));
  perform pg_temp.t564_check('ended, at the last person out (both still in: the event''s time), its duration and peak', 'ended/finished/1200/3',
    (select status || '/' || ended_reason || '/' || duration_seconds::text || '/' || peak_participants::text from public.team_call where id = call_open));
  perform pg_temp.t564_check('everyone in it has left', '0',
    (select count(*)::text from public.team_call_participant where call_id = call_open and state = 'joined'));
  perform pg_temp.t564_check('its message says how it went', 'Call ended · 20 min · 3 people',
    (select body from public.team_chat_message where id = msg_open));
  perform pg_temp.t564_check('ending again does nothing', '0',
    (select count(*)::text from public.team_call_end(call_open, 'swept', now())));
  perform pg_temp.t564_check('… and keeps how it ended', 'finished', (select ended_reason from public.team_call where id = call_open));
  perform pg_temp.t564_check('an event after the end is ignored', 'ended', public.team_call_participant_event(room_open, m_a, 'PA_a2', true, now(), now()));
  perform pg_temp.t564_run('a person cannot end a call', 'refused', u_a,
    array[format('select * from public.team_call_end(%L, %L, now())', call_dm, 'left')]);
  perform pg_temp.t564_run('ringing for an ended call is refused', 'refused', u_a,
    array[format('select * from public.team_call_ring_members(%L, array[%L]::uuid[])', call_open, m_b)]);
  call_again := pg_temp.t564_as(u_b, format('select call_id::text from public.team_call_start(%L)', ch_open))::uuid;
  perform pg_temp.t564_check('after the end, a start makes a new call', 'true', (call_again is not null and call_again <> call_open)::text);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t564_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '564 team_calls: % of % check(s) failed: %', v_fail, (select count(*) from t564_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t564_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '564 team_calls: all % checks passed', (select count(*) from t564_results) using detail = v_report;
  end if;
  raise notice '564 team_calls: all checks passed';
end
$probe$;

rollback;
