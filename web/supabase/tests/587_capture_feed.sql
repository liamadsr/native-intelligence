-- DB-level test for migrations 587-588 (the capture feed: one recorder per
-- call). A call's one capture, made when notes go on (private, its
-- conversation's, shared with it and no one else; a meeting's is its host's
-- whoever started the call); a producer's session per round of notes, made
-- once, taken up again after a restart and not by a second producer while
-- the first heartbeats; who joined and left, refused for anyone who may not
-- read the conversation, one label per person; segments taken once each and
-- appended in the order said, none said after notes went off, none of a
-- guest who has not said go to this round; a quiet producer lost and back;
-- the recorder's work; the end (locked, or no capture when nothing was said);
-- a roster's row the server's alone; the service role's functions refused to
-- a person. The TS tests (src/lib/capture-feed/__tests__/migration-587-588
-- .test.ts) pin the files' text; this runs the SQL.
--
-- Run against a database with 564-588 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/587_capture_feed.sql
-- Everything runs in one transaction that is rolled back. A probe runs as one
-- caller (role authenticated with that user's JWT claims) inside its own
-- block that always rolls back; t587_as runs as a caller and keeps what it did.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000587001'; -- Ana, in the team, starts the call
  u_b constant uuid := '00000000-0000-4000-8000-000000587002'; -- Ben, in the team; hosts the meeting
  u_c constant uuid := '00000000-0000-4000-8000-000000587003'; -- Cy, in the workspace, not in the team
  u_d constant uuid := '00000000-0000-4000-8000-000000587004'; -- Dee, in the team, Ana's name too
  u_x constant uuid := '00000000-0000-4000-8000-000000587005'; -- outsider: their own workspace only
  w1 uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid; m_d uuid; m_x uuid;
  ch_team uuid; ch_quiet uuid; ch_meet uuid; mt uuid;
  call_t uuid; room_t text; call_m uuid; room_m text; call_s uuid;
  cap uuid; cap_m uuid; cap_s uuid;
  s1 uuid; s2 uuid; s_m uuid; s_s uuid;
  g1 uuid;
  v text;
  v_report text;
  v_fail int;
  v_raise_report constant boolean := true;
begin
  create temp table t587_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  create function pg_temp.t587_probe(p_uid uuid, p_sqls text[])
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
      raise exception using errcode = 'ZP587', message = 'rows=' || n;
    exception
      when sqlstate 'ZP587' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t587_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t587_probe(p_uid, p_sqls);
  begin
    insert into t587_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  create function pg_temp.t587_as(p_uid uuid, p_sql text)
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

  create function pg_temp.t587_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t587_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  -- A roster event and a segment, as 588 reads them.
  create function pg_temp.ev(p_key text, p_speaker text, p_kind text, p_ms int, p_ident jsonb)
  returns jsonb language sql as $f$
    select jsonb_strip_nulls(jsonb_build_object('key', p_key, 'speaker', p_speaker, 'kind', p_kind, 'at_ms', p_ms, 'identity', p_ident));
  $f$;
  create function pg_temp.sg(p_key text, p_speaker text, p_text text, p_start int, p_end int)
  returns jsonb language sql as $f$
    select jsonb_build_object('key', p_key, 'speaker', p_speaker, 'text', p_text, 'start_ms', p_start, 'end_ms', p_end);
  $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't587-ana@example.invalid', '{"full_name":"t587ana"}'),
    (u_b, 't587-ben@example.invalid', '{"full_name":"t587ben"}'),
    (u_c, 't587-cy@example.invalid',  '{"full_name":"t587cy"}'),
    (u_d, 't587-dee@example.invalid', '{"full_name":"t587dee"}'),
    (u_x, 't587-out@example.invalid', '{"full_name":"t587outsider"}');
  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  select id into m_x from public.member where user_id = u_x;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't587ben'),
    (u_c, w1, 'member', 't587cy'),
    (u_d, w1, 'member', 't587ana');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  select id into m_d from public.member where user_id = u_d and workspace_id = w1;
  update public.member set display_name = 't587ana' where id = m_a;
  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't587 team', 't587-team', 'TQF') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a), (t1, m_b), (t1, m_d);
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't587-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't587-quiet', m_b) returning id into ch_quiet;

  call_t := pg_temp.t587_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_team))::uuid;
  select room into room_t from public.team_call where id = call_t;

  -- ── The call's capture ────────────────────────────────────────────────────
  perform pg_temp.t587_check('no capture while notes are off', '<null>', public.team_call_capture_ensure(call_t, 'Call in #t587-team')::text);
  perform pg_temp.t587_check('no feed while notes are off', 'not_wanted',
    (select outcome from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec1', 'x')));
  perform pg_temp.t587_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call_t));
  cap := public.team_call_capture_ensure(call_t, 'Call in #t587-team');
  perform pg_temp.t587_check('notes on: one capture, the call links to it while capturing', cap::text || '/capturing',
    (select capture_id::text || '/' || notes_state from public.team_call where id = call_t));
  perform pg_temp.t587_check('… private, its starter''s, its conversation''s, open and live', u_a::text || '/private/' || ch_team::text || '/false/live/team_call',
    (select user_id::text || '/' || visibility || '/' || notes_channel_id::text || '/' || (ended_at is not null)::text || '/' || (metadata ->> 'notes_recorder') || '/' || (metadata ->> 'source')
       from public.captures where id = cap));
  perform pg_temp.t587_check('… shared with its conversation to view, and no one else', '1/channel/view/team_call',
    (select count(*)::text || '/' || min(grantee_kind) || '/' || min(level) || '/' || min(source) from public.entity_access where entity_type = 'capture' and entity_id = cap));
  perform pg_temp.t587_check('the same capture every time', cap::text, public.team_call_capture_ensure(call_t, 'other')::text);

  -- ── A producer's session ──────────────────────────────────────────────────
  select session_id into s1 from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec1', 'x') where outcome = 'started';
  perform pg_temp.t587_check('the first start: a session for round 1, into the capture', 'live/1/' || cap::text,
    (select status || '/' || round::text || '/' || capture_id::text from public.capture_feed_session where id = s1));
  perform pg_temp.t587_check('started again by the same producer (a restart): taken up', 'resumed/' || s1::text,
    (select outcome || '/' || session_id::text from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec1', 'x')));
  perform pg_temp.t587_check('another producer while it heartbeats: busy', 'busy',
    (select outcome from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec2', 'x')));
  perform pg_temp.t587_check('a kind of source there is none of: unknown', 'unknown',
    (select outcome from public.capture_feed_start('meeting_bot', call_t, 'livekit_recorder', 'rec1', 'x')));

  -- ── Who is in it ──────────────────────────────────────────────────────────
  perform pg_temp.t587_check('members who may read the conversation are in; others are refused; a stranger without a name is unknown',
    'r1:applied,r2:applied,r3:refused,r4:refused,r5:unknown_speaker,r6:applied',
    (select string_agg(key || ':' || outcome, ',' order by key) from public.capture_feed_roster(s1, 'rec1', jsonb_build_array(
      pg_temp.ev('r1', m_a::text, 'joined', 100, jsonb_build_object('member_id', m_a)),
      pg_temp.ev('r2', m_b::text, 'joined', 200, jsonb_build_object('member_id', m_b)),
      pg_temp.ev('r3', m_c::text, 'joined', 300, jsonb_build_object('member_id', m_c)),
      pg_temp.ev('r4', m_x::text, 'joined', 300, jsonb_build_object('member_id', m_x)),
      pg_temp.ev('r5', 'nobody', 'left', 400, null),
      pg_temp.ev('r6', m_d::text, 'joined', 500, jsonb_build_object('member_id', m_d))))));
  perform pg_temp.t587_check('one row each, labels unique, the owner''s the self row; every member''s voice attested',
    't587ana/organizer/true/confirmed/call_roster,t587ana (2)/attendee/false/confirmed/call_roster,t587ben/attendee/false/confirmed/call_roster',
    (select string_agg(speaker_label || '/' || role || '/' || is_self::text || '/' || self_binding || '/' || source, ',' order by speaker_label)
       from public.capture_participant where capture_id = cap));
  perform pg_temp.t587_check('an older event after a newer one: stale', 'stale',
    (select outcome from public.capture_feed_roster(s1, 'rec1', jsonb_build_array(pg_temp.ev('r7', m_b::text, 'joined', 150, null)))));
  perform pg_temp.t587_check('another producer''s roster: taken', 'taken',
    (select outcome from public.capture_feed_roster(s1, 'rec2', jsonb_build_array(pg_temp.ev('r8', m_b::text, 'left', 900, null)))));

  -- ── What was said ─────────────────────────────────────────────────────────
  perform pg_temp.t587_check('segments arriving out of order are appended in the order said; an unknown speaker''s dropped', 'applied/2/0/1',
    (select outcome || '/' || accepted || '/' || duplicate || '/' || dropped from public.capture_feed_append(s1, 'rec1', jsonb_build_array(
      pg_temp.sg('k2', m_a::text, 'Then let us begin.', 2000, 2600),
      pg_temp.sg('k1', m_b::text, '  Good   morning. ', 1000, 1500),
      pg_temp.sg('k3', 'nobody', 'Who am I', 1200, 1300)))));
  perform pg_temp.t587_check('… as [Label] lines', '[t587ben] Good morning.' || chr(10) || '[t587ana] Then let us begin.',
    (select transcript from public.captures where id = cap));
  perform pg_temp.t587_check('the same batch again (a retry): duplicates, nothing appended twice', 'applied/0/2',
    (select outcome || '/' || accepted || '/' || duplicate from public.capture_feed_append(s1, 'rec1', jsonb_build_array(
      pg_temp.sg('k2', m_a::text, 'Then let us begin.', 2000, 2600), pg_temp.sg('k1', m_b::text, 'Good morning.', 1000, 1500)))));
  perform pg_temp.t587_check('… the transcript as it was', '2', (select (length(transcript) - length(replace(transcript, '[', '')))::text from public.captures where id = cap));
  perform pg_temp.t587_check('another producer''s segments: taken', 'taken',
    (select outcome from public.capture_feed_append(s1, 'rec2', jsonb_build_array(pg_temp.sg('k9', m_a::text, 'x', 3000, 3100)))));

  -- ── A roster's row is the server's ────────────────────────────────────────
  perform pg_temp.t587_run('its owner cannot relabel a roster row', 'refused', u_a,
    array[format('update public.capture_participant set speaker_label = %L where capture_id = %L and member_id = %L', 'someone else', cap, m_b)]);
  perform pg_temp.t587_run('… nor take a confirmed voice away to someone else', 'refused', u_a,
    array[format('update public.capture_participant set member_id = %L where capture_id = %L and member_id = %L', m_a, cap, m_d)]);
  perform pg_temp.t587_run('… nor write a roster row of their own', 'refused', u_a,
    array[format('insert into public.capture_participant (capture_id, member_id, speaker_label, self_binding, source) values (%L, %L, %L, %L, %L)', cap, m_c, 'Fake', 'confirmed', 'call_roster')]);
  perform pg_temp.t587_run('… a row''s other details stay theirs to edit', 'rows=1', u_a,
    array[format('update public.capture_participant set job_title = %L where capture_id = %L and member_id = %L', 'Design', cap, m_b)]);

  -- ── Notes off: the round ends at that moment ──────────────────────────────
  perform public.team_call_participant_event(room_t, m_a, 'PA_a', true, now(), now());
  perform pg_temp.t587_as(u_a, format('select notes::text from public.team_call_set_notes(%L, false)', call_t));
  perform pg_temp.t587_check('notes off: the round''s session ended, why, and when', 'ended/notes_off/true',
    (select status || '/' || end_reason || '/' || (ended_at is not null)::text from public.capture_feed_session where id = s1));
  update public.capture_feed_session set ended_at = started_at + interval '10 seconds' where id = s1;
  perform pg_temp.t587_check('the producer''s last words before it are taken; anything said after it never', 'applied/1/1',
    (select outcome || '/' || accepted || '/' || dropped from public.capture_feed_append(s1, 'rec1', jsonb_build_array(
      pg_temp.sg('k4', m_b::text, 'Last thing.', 9000, 9800), pg_temp.sg('k5', m_b::text, 'After notes went off.', 11000, 11500)))));
  perform pg_temp.t587_check('the heartbeat tells the producer to stop', 'false/notes_off',
    (select keep::text || '/' || reason from public.capture_feed_heartbeat('rec1', array[s1])));

  -- ── Round 2, a producer gone quiet and back ───────────────────────────────
  perform pg_temp.t587_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call_t));
  select session_id into s2 from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec1', 'x') where outcome = 'started';
  perform pg_temp.t587_check('notes on again: a new round, the same capture', '2/' || cap::text,
    (select round::text || '/' || capture_id::text from public.capture_feed_session where id = s2));
  perform pg_temp.t587_check('a heartbeat keeps it', 'true', (select keep::text from public.capture_feed_heartbeat('rec1', array[s2])));
  perform pg_temp.t587_check('the recorder''s work: nothing while it heartbeats this one', '0',
    (select count(*)::text from public.team_call_recorder_work('rec1', array[call_t], 20) w where w.call_id = call_t));
  perform pg_temp.t587_check('… its own call again when it says it is not running it (a restart)', '1',
    (select count(*)::text from public.team_call_recorder_work('rec1', '{}', 20) w where w.call_id = call_t));
  perform pg_temp.t587_check('… never to another producer while it heartbeats', '0',
    (select count(*)::text from public.team_call_recorder_work('rec2', '{}', 20) w where w.call_id = call_t));
  update public.capture_feed_session set heartbeat_at = now() - interval '5 minutes' where id = s2;
  -- (Each call is its own statement: a statement's other reads see the database as it was when it began.)
  v := (select count(*)::text from public.capture_feed_mark_lost(90) l where l.session_id = s2);
  perform pg_temp.t587_check('quiet past the bound: lost, the moment kept, the capture says so', '1/lost/1/lost',
    v || '/' || (select status || '/' || jsonb_array_length(gaps)::text from public.capture_feed_session where id = s2)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap));
  perform pg_temp.t587_check('… then any producer may take it', '1',
    (select count(*)::text from public.team_call_recorder_work('rec2', '{}', 20) w where w.call_id = call_t));
  v := (select keep::text from public.capture_feed_heartbeat('rec1', array[s2]));
  perform pg_temp.t587_check('back: live, the gap closed, the capture live again', 'true/live/true/live',
    v || '/' || (select status || '/' || ((gaps -> 0) ? 'to')::text from public.capture_feed_session where id = s2)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap));

  -- ── The fence: the conversation's readers, and no wider ───────────────────
  perform pg_temp.t587_run('a teammate in the conversation reads the live capture', 'rows=1', u_b, array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t587_run('someone outside the conversation does not', 'rows=0', u_c, array[format('select 1 from public.captures where id = %L', cap)]);
  delete from public.team_member where team_id = t1 and member_id = m_d;
  perform pg_temp.t587_run('taken off the team: no longer', 'rows=0', u_d, array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t587_check('… and their words are refused from then on', 'refused',
    (select outcome from public.capture_feed_roster(s2, 'rec1', jsonb_build_array(pg_temp.ev('r9', 'other-key', 'joined', 50, jsonb_build_object('member_id', m_d))))));

  -- ── The end ───────────────────────────────────────────────────────────────
  perform public.team_call_end(call_t, 'finished', now());
  perform pg_temp.t587_check('the call ended: every feed of it ended; the notes are being finished', 'ended/call_ended/transcribing',
    (select status || '/' || end_reason from public.capture_feed_session where id = s2) || '/' || (select notes_state from public.team_call where id = call_t));
  perform pg_temp.t587_check('a lock written from fewer segments than there are: changed, write it again', 'changed',
    (select outcome from public.team_call_capture_lock(call_t, 'x', '', 1)));
  perform pg_temp.t587_check('locked: the ordered transcript, the preamble, ended, the owner''s, something said', 'ready/' || u_a::text || '/true',
    (select outcome || '/' || owner_user::text || '/' || spoke::text from public.team_call_capture_lock(call_t, '[t587ben] Good morning.', 'Notes were on for 1 min of the 2 min call.', 3)));
  perform pg_temp.t587_check('… the capture as Stop leaves one', '[t587ben] Good morning./Notes were on for 1 min of the 2 min call./true/true/done/ready',
    (select transcript || '/' || user_notes || '/' || (ended_at is not null)::text || '/' || is_transcript_locked::text || '/' || (metadata ->> 'notes_recorder') from public.captures where id = cap)
      || '/' || (select notes_state from public.team_call where id = call_t));
  perform pg_temp.t587_check('… everyone still in it has left at the end', '0',
    (select count(*)::text from public.capture_participant where capture_id = cap and joined_at is not null and left_at is null));
  perform pg_temp.t587_check('locking again changes nothing', 'ready', (select outcome from public.team_call_capture_lock(call_t, 'other', 'other', -1)));
  perform pg_temp.t587_check('words after the lock: refused', 'locked',
    (select outcome from public.capture_feed_append(s2, 'rec1', jsonb_build_array(pg_temp.sg('k6', m_b::text, 'Too late.', 100, 200)))));

  -- ── A meeting: its host owns the notes, whoever started the call; a guest says go first ──
  ch_meet := pg_temp.t587_as(u_b, format('select channel_id::text from public.meeting_create(%L, %L, %L, %L, %L, null, null)',
    gen_random_uuid(), w1, 't587 sync', repeat('a', 64), repeat('b', 24)))::uuid;
  select id into mt from public.meeting where channel_id = ch_meet;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch_meet, m_a, w1);
  call_m := pg_temp.t587_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_meet))::uuid;
  select room into room_m from public.team_call where id = call_m;
  insert into public.meeting_guest (meeting_id, workspace_id, channel_id, name, state, call_id) values (mt, w1, ch_meet, 'Dana', 'admitted', call_m) returning id into g1;
  perform pg_temp.t587_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call_m));
  select capture_id, session_id into cap_m, s_m from public.capture_feed_start('team_call', call_m, 'livekit_recorder', 'rec1', 't587 sync');
  perform pg_temp.t587_check('a meeting''s notes are its host''s, though someone else started the call', u_b::text, (select user_id::text from public.captures where id = cap_m));
  v := (select outcome from public.capture_feed_roster(s_m, 'rec1', jsonb_build_array(pg_temp.ev('g', 'guest-' || g1::text, 'joined', 10, jsonb_build_object('guest_id', g1)))));
  perform pg_temp.t587_check('a guest of this meeting is in, labelled a guest; their row attests nothing', 'applied/Dana (guest)/none/false',
    v || '/' || (select speaker_label || '/' || self_binding || '/' || is_self::text from public.capture_participant where capture_id = cap_m and member_id is null));
  perform pg_temp.t587_check('a guest who has not said go to this round''s notes: dropped', '0/1',
    (select accepted || '/' || dropped from public.capture_feed_append(s_m, 'rec1', jsonb_build_array(pg_temp.sg('gk1', 'guest-' || g1::text, 'Hello all.', 100, 900)))));
  update public.meeting_guest set notes_ack_round = 1 where id = g1;
  perform pg_temp.t587_check('… once they have: taken', '1/0',
    (select accepted || '/' || dropped from public.capture_feed_append(s_m, 'rec1', jsonb_build_array(pg_temp.sg('gk2', 'guest-' || g1::text, 'Hello all.', 1000, 1900)))));
  perform pg_temp.t587_run('the meeting''s member who started the call reads its notes', 'rows=1', u_a, array[format('select 1 from public.captures where id = %L', cap_m)]);

  -- ── A call where nothing was said leaves no capture ───────────────────────
  call_s := pg_temp.t587_as(u_b, format('select call_id::text from public.team_call_start(%L)', ch_quiet))::uuid;
  perform pg_temp.t587_as(u_b, format('select notes::text from public.team_call_set_notes(%L, true)', call_s));
  select capture_id, session_id into cap_s, s_s from public.capture_feed_start('team_call', call_s, 'livekit_recorder', 'rec1', 'quiet');
  perform public.team_call_end(call_s, 'finished', now());
  v := (select outcome from public.team_call_capture_lock(call_s, null, '', 0));
  perform pg_temp.t587_check('nothing said: silent, the capture and its grant gone', 'silent/silent/<none>/0/0',
    v || '/' || (select notes_state || '/' || coalesce(capture_id::text, '<none>') from public.team_call where id = call_s)
      || '/' || (select count(*)::text from public.captures where id = cap_s)
      || '/' || (select count(*)::text from public.entity_access where entity_id = cap_s));

  -- ── The server's alone ────────────────────────────────────────────────────
  perform pg_temp.t587_run('a person cannot read the sessions', 'refused', u_a, array['select 1 from public.capture_feed_session']);
  perform pg_temp.t587_run('a person cannot read the segments', 'refused', u_a, array['select 1 from public.capture_feed_segment']);
  perform pg_temp.t587_run('a person cannot start a feed', 'refused', u_a, array[format('select * from public.capture_feed_start(%L, %L, %L, %L, %L)', 'team_call', call_m, 'livekit_recorder', 'me', 'x')]);
  perform pg_temp.t587_run('a person cannot append words', 'refused', u_a, array[format('select * from public.capture_feed_append(%L, %L, %L)', s_m, 'rec1', '[]')]);
  perform pg_temp.t587_run('a person cannot make a call''s capture', 'refused', u_a, array[format('select public.team_call_capture_ensure(%L, %L)', call_m, 'x')]);
  perform pg_temp.t587_run('a person cannot lock one', 'refused', u_a, array[format('select * from public.team_call_capture_lock(%L, null, %L, -1)', call_m, '')]);
  perform pg_temp.t587_run('a person cannot read the recorder''s work', 'refused', u_a, array[format('select * from public.team_call_recorder_work(%L, %L, 5)', 'rec1', '{}')]);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t587_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '587 capture_feed: % of % check(s) failed: %', v_fail, (select count(*) from t587_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t587_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '587 capture_feed: all % checks passed', (select count(*) from t587_results) using detail = v_report;
  end if;
  raise notice '587 capture_feed: all checks passed';
end
$probe$;

rollback;
