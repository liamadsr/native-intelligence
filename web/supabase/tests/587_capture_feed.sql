-- DB-level test for migrations 587-588 (the capture feed: one recorder per
-- call). A call's one capture, made when notes go on (private, its
-- conversation's, shared with it and no one else; a meeting's is its host's
-- whoever started the call); a producer's session per round of notes, made
-- once, taken up again after a restart and not by a second producer while
-- the first heartbeats; who joined and left, refused for anyone who may not
-- read the conversation, one label per person; segments taken once each and
-- appended in the order said, none said after notes went off, none of a
-- guest who has not said go to this round (and the producer told which
-- guests it may hear); a quiet producer lost and back; every way a session
-- ends or goes quiet puts its producer on the eject outbox; a producer's
-- `end` (delivered); a closed capture wanted by no producer; who said a
-- quote; the recorder's work; the end (every segment, well over a page of
-- them, written in the order said, in the database; or no capture when
-- nothing was said); a speaker's label kept when its row goes; a roster's
-- row the server's alone; the service role's functions refused to a person. The TS tests (src/lib/capture-feed/__tests__/migration-587-588
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
  call_t uuid; room_t text; call_m uuid; room_m text; call_s uuid; call_d uuid;
  cap uuid; cap_m uuid; cap_s uuid; cap_d uuid; cap_d2 uuid;
  s1 uuid; s2 uuid; s_m uuid; s_s uuid; s_d uuid;
  g1 uuid;
  v text;
  v2 text;
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
  perform pg_temp.t587_check('… and the call keeps a record of it, not finished', '1/false',
    (select count(*)::text || '/' || bool_or(finished_at is not null)::text from public.team_call_capture where call_id = call_t and capture_id = cap));
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
  perform pg_temp.t587_check('each speaker keeps its own label (the transcript''s, whatever becomes of the row)',
    't587ana,t587ana (2),t587ben',
    (select string_agg(label, ',' order by label) from public.capture_feed_speaker where capture_id = cap));
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
  perform pg_temp.t587_check('notes off: the producer is put out of the room (the eject outbox, its own identity)', '1',
    (select count(*)::text from public.team_call_eject where room = room_t and identity = 'notes-recorder-rec1' and done_at is null));
  perform pg_temp.t587_check('another producer cannot say it is done with the session', 'false', public.capture_feed_end(s1, 'rec2', 'told')::text);
  v := public.capture_feed_end(s1, 'rec1', 'told')::text;
  perform pg_temp.t587_check('its own producer says it delivered everything: the finish stops waiting for it', 'true/true/ended',
    v || '/' || (select (delivered_at is not null)::text || '/' || status from public.capture_feed_session where id = s1));
  perform pg_temp.t587_check('… the eject names the session it is for', s1::text,
    (select feed_session::text from public.team_call_eject where room = room_t and identity = 'notes-recorder-rec1' and done_at is null));
  perform pg_temp.t587_check('… the drain''s settle leaves it while the call does not want the producer', '0/1',
    public.capture_feed_settle_ejects()::text || '/' || (select count(*)::text from public.team_call_eject where room = room_t and done_at is null));

  -- ── Round 2, a producer gone quiet and back ───────────────────────────────
  perform pg_temp.t587_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call_t));
  select session_id into s2 from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec1', 'x') where outcome = 'started';
  perform pg_temp.t587_check('notes on again: a new round, the same capture', '2/' || cap::text,
    (select round::text || '/' || capture_id::text from public.capture_feed_session where id = s2));
  -- Notes off, then on before the drain ran: the eject queued for round 1 must not put round 2's recorder out.
  v := public.capture_feed_settle_ejects()::text;
  perform pg_temp.t587_check('the drain''s settle: the round-1 eject is done, nobody removed (the producer has round 2''s live session)', '1/0',
    v || '/' || (select count(*)::text from public.team_call_eject where room = room_t and done_at is null));
  perform pg_temp.t587_check('a heartbeat keeps it; no meeting guest to hear here', 'true/{}', (select keep::text || '/' || guests::text from public.capture_feed_heartbeat('rec1', array[s2])));
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
  perform pg_temp.t587_check('… and it is put out of the room (the settle keeps the entry: its session is lost)', '1/0',
    (select count(*)::text from public.team_call_eject where room = room_t and identity = 'notes-recorder-rec1' and done_at is null)
      || '/' || public.capture_feed_settle_ejects()::text);
  update public.team_call_eject set done_at = now() where room = room_t and done_at is null;
  perform pg_temp.t587_check('… then any producer may take it', '1',
    (select count(*)::text from public.team_call_recorder_work('rec2', '{}', 20) w where w.call_id = call_t));
  v := (select keep::text from public.capture_feed_heartbeat('rec1', array[s2]));
  perform pg_temp.t587_check('back: live, the gap closed, the capture live again', 'true/live/true/live',
    v || '/' || (select status || '/' || ((gaps -> 0) ? 'to')::text from public.capture_feed_session where id = s2)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap));
  perform public.capture_feed_fence_producers();
  perform pg_temp.t587_check('the sweeper''s fence leaves a producer whose session the call wants', '0',
    (select count(*)::text from public.team_call_eject where room = room_t and done_at is null));
  v := public.capture_feed_end(s2, 'rec1', 'alone')::text;
  perform pg_temp.t587_check('left an empty room while the call wants it: handed back as it is, no gap, the capture still live', 'true/live/1/live',
    v || '/' || (select status || '/' || jsonb_array_length(gaps)::text from public.capture_feed_session where id = s2)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap));
  v := public.capture_feed_end(s2, 'rec1', 'failed')::text;
  perform pg_temp.t587_check('… and after a join that failed: the same', 'true/live/1',
    v || '/' || (select status || '/' || jsonb_array_length(gaps)::text from public.capture_feed_session where id = s2));
  v := public.capture_feed_end(s2, 'rec1', 'disconnected')::text;
  perform pg_temp.t587_check('a producer that lost the room hands the session back: lost, a gap open, the capture says so, offered again',
    'true/lost/true/2/false/lost/1',
    v || '/' || (select status || '/' || (delivered_at is not null)::text || '/' || jsonb_array_length(gaps)::text || '/' || ((gaps -> -1) ? 'to')::text from public.capture_feed_session where id = s2)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap)
      || '/' || (select count(*)::text from public.team_call_recorder_work('rec1', '{}', 20) w where w.call_id = call_t));
  v := (select outcome from public.capture_feed_start('team_call', call_t, 'livekit_recorder', 'rec1', 'x'));
  perform pg_temp.t587_check('… taken up again: waited on once more, the gap closed, the capture live', 'resumed/false/true/live',
    v || '/' || (select (delivered_at is not null)::text || '/' || ((gaps -> -1) ? 'to')::text from public.capture_feed_session where id = s2)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap));

  -- ── Who said a quote (the live agent's auto-apply gate) ───────────────────
  perform pg_temp.t587_check('two lines about the contract', 'applied/2',
    (select outcome || '/' || accepted from public.capture_feed_append(s2, 'rec1', jsonb_build_array(
      pg_temp.sg('q1', m_a::text, 'Ben, can you send the contract?', 30000, 31500),
      pg_temp.sg('q2', m_b::text, 'Sure. I will send the contract today.', 33000, 35000)))));
  perform pg_temp.t587_check('the ask: said by Ana''s own roster row, not Ben''s', m_a::text || '/call_roster/1',
    (select min(member_id::text) || '/' || min(source) || '/' || count(*)::text from public.capture_feed_quote_speakers(cap, 'Ben, can you send the contract?')));
  perform pg_temp.t587_check('the promise: said by Ben''s', m_b::text || '/call_roster/1',
    (select min(member_id::text) || '/' || min(source) || '/' || count(*)::text from public.capture_feed_quote_speakers(cap, 'I will send the contract today')));
  perform pg_temp.t587_check('a short quote names no one; one nobody said, no one', '0/0',
    (select count(*)::text from public.capture_feed_quote_speakers(cap, 'the contract')) || '/'
      || (select count(*)::text from public.capture_feed_quote_speakers(cap, 'we will never ship this')));

  -- ── Far more than a page of segments (PostgREST answers 1000 rows at most) ─
  insert into public.capture_feed_segment (session_id, capture_id, key, speaker_key, start_ms, end_ms, said_at, text)
  select s2, cap, 'bulk-' || i, case when i % 2 = 0 then m_a::text else m_b::text end, 100000 + i * 2000, 100000 + i * 2000 + 800,
         (select started_at from public.capture_feed_session where id = s2) + make_interval(secs => 100 + i * 2), 'Point number ' || i || '.'
    from generate_series(1, 1500) as i;

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
  perform pg_temp.t587_check('locked: the owner''s, something said', 'ready/' || u_a::text || '/true',
    (select outcome || '/' || owner_user::text || '/' || spoke::text from public.team_call_capture_lock(call_t, 'Notes were on for 1 min of the 2 min call.', true)));
  perform pg_temp.t587_check('… every segment, in the order said, written in the database: 1505 lines, the first and the last where they belong',
    '1505/[t587ben] Good morning./[t587ana] Point number 1500./' || chr(10) || '[t587ana] Ben, can you send the contract?' || chr(10) || '[t587ben] Sure. I will send the contract today.' || chr(10) || '[t587ben] Point number 1.' || chr(10),
    (select (length(transcript) - length(replace(transcript, chr(10), '')) + 1)::text || '/' || split_part(transcript, chr(10), 1) || '/'
            || split_part(transcript, chr(10), 1505) || '/'
            || substr(transcript, position(chr(10) || '[t587ana] Ben, can' in transcript), length(chr(10) || '[t587ana] Ben, can you send the contract?' || chr(10) || '[t587ben] Sure. I will send the contract today.' || chr(10) || '[t587ben] Point number 1.' || chr(10)))
       from public.captures where id = cap));
  perform pg_temp.t587_check('… the preamble, ended, locked, done, the notes ready', 'Notes were on for 1 min of the 2 min call./true/true/done/ready',
    (select user_notes || '/' || (ended_at is not null)::text || '/' || is_transcript_locked::text || '/' || (metadata ->> 'notes_recorder') from public.captures where id = cap)
      || '/' || (select notes_state from public.team_call where id = call_t));
  perform pg_temp.t587_check('… everyone still in it has left at the end', '0',
    (select count(*)::text from public.capture_participant where capture_id = cap and joined_at is not null and left_at is null));
  update public.team_call set notes_state = 'transcribing' where id = call_t;
  v := (select outcome from public.team_call_capture_lock(call_t, 'other', true));
  perform pg_temp.t587_check('locking again changes nothing, the notes are ready, and no second pass is asked for (done)', 'done/ready/Notes were on for 1 min of the 2 min call.',
    v || '/' || (select notes_state from public.team_call where id = call_t) || '/' || (select user_notes from public.captures where id = cap));
  perform pg_temp.t587_check('words after the lock: refused', 'locked',
    (select outcome from public.capture_feed_append(s2, 'rec1', jsonb_build_array(pg_temp.sg('k6', m_b::text, 'Too late.', 100, 200)))));
  v := (select count(*)::text from public.capture_feed_lines(cap));
  delete from public.capture_participant where capture_id = cap and member_id = m_b;
  perform pg_temp.t587_check('a participant row deleted: its lines stay, with their label', v || '/' || v || '/t587ben',
    v || '/' || (select count(*)::text from public.capture_feed_lines(cap)) || '/'
      || (select min(label) from public.capture_feed_lines(cap) l where l.label = 't587ben'));

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
  perform pg_temp.t587_check('the producer is told it may hear no guest yet', '{}',
    (select guests::text from public.capture_feed_heartbeat('rec1', array[s_m])));
  perform pg_temp.t587_check('a guest who has not said go to this round''s notes: dropped', '0/1',
    (select accepted || '/' || dropped from public.capture_feed_append(s_m, 'rec1', jsonb_build_array(pg_temp.sg('gk1', 'guest-' || g1::text, 'Hello all.', 100, 900)))));
  update public.meeting_guest set notes_ack_round = 1 where id = g1;
  perform pg_temp.t587_check('… once they have: taken', '1/0',
    (select accepted || '/' || dropped from public.capture_feed_append(s_m, 'rec1', jsonb_build_array(pg_temp.sg('gk2', 'guest-' || g1::text, 'Hello all, everyone, good to be here.', 1000, 1900)))));
  perform pg_temp.t587_check('… and the producer is told it may hear them now', '{' || g1::text || '}',
    (select guests::text from public.capture_feed_heartbeat('rec1', array[s_m])));
  perform pg_temp.t587_check('the guest''s line names a row that is no member', '<null>/call_roster',
    (select coalesce(min(member_id::text), '<null>') || '/' || min(source) from public.capture_feed_quote_speakers(cap_m, 'Hello all everyone good to be here') q) );

  -- ── The quote matcher: whole words, a long enough quote, one line, one speaker ──
  perform pg_temp.t587_check('two members in the meeting''s roster', 'qa:applied,qb:applied',
    (select string_agg(key || ':' || outcome, ',' order by key) from public.capture_feed_roster(s_m, 'rec1', jsonb_build_array(
      pg_temp.ev('qa', m_a::text, 'joined', 20, jsonb_build_object('member_id', m_a)),
      pg_temp.ev('qb', m_b::text, 'joined', 30, jsonb_build_object('member_id', m_b))))));
  perform pg_temp.t587_check('their lines, seconds apart', 'applied/7',
    (select outcome || '/' || accepted from public.capture_feed_append(s_m, 'rec1', jsonb_build_array(
      pg_temp.sg('m1', m_a::text, 'We will resend the contracts tomorrow morning.', 10000, 12000),
      pg_temp.sg('m2', m_b::text, 'Okay. I''ll do it.', 15000, 16000),
      pg_temp.sg('m3', m_b::text, 'Sure, I' || chr(8217) || 'll send the deck tonight.', 20000, 22000),
      pg_temp.sg('m4', m_a::text, 'Let us ship the release on Friday.', 25000, 27000),
      pg_temp.sg('m5', m_b::text, 'Let us ship the release on Friday.', 30000, 32000),
      pg_temp.sg('m6', m_a::text, 'Then can you take the', 35000, 36000),
      pg_temp.sg('m7', m_b::text, 'budget review next week please', 36500, 38000)))));
  perform pg_temp.t587_check('a contraction is one word', 'ill send the deck tonight', public.capture_feed_norm('I' || chr(8217) || 'll send the deck tonight!'));
  perform pg_temp.t587_check('inside a longer word: no one ("send" is not "resend")', '0',
    (select count(*)::text from public.capture_feed_quote_speakers(cap_m, 'send the contracts tomorrow morning')));
  perform pg_temp.t587_check('a three-word common phrase names no one, though one member said it', '0',
    (select count(*)::text from public.capture_feed_quote_speakers(cap_m, 'I''ll do it')));
  perform pg_temp.t587_check('a contraction in a long enough quote: the one who said it', m_b::text || '/1',
    (select min(member_id::text) || '/' || count(*)::text from public.capture_feed_quote_speakers(cap_m, 'I''ll send the deck tonight')));
  perform pg_temp.t587_check('said by two speakers: both rows (the gate stages it: one row only is anyone''s)', '2',
    (select count(*)::text from public.capture_feed_quote_speakers(cap_m, 'let us ship the release on friday')));
  perform pg_temp.t587_check('spanning two speakers'' lines: no one', '0',
    (select count(*)::text from public.capture_feed_quote_speakers(cap_m, 'take the budget review next week')));
  perform pg_temp.t587_check('the happy path: a whole quote from one line, its speaker', m_a::text || '/call_roster/1',
    (select min(member_id::text) || '/' || min(source) || '/' || count(*)::text from public.capture_feed_quote_speakers(cap_m, 'we will resend the contracts tomorrow')));
  perform pg_temp.t587_run('the meeting''s member who started the call reads its notes', 'rows=1', u_a, array[format('select 1 from public.captures where id = %L', cap_m)]);
  -- Its owner ends the capture by hand while the call goes on: no producer may feed it.
  v2 := (select transcript from public.captures where id = cap_m);
  update public.captures set is_transcript_locked = true where id = cap_m;
  perform public.capture_feed_recorder_state(cap_m, 'lost');
  perform pg_temp.t587_check('nothing writes the recorder''s state onto a locked capture', 'live',
    (select metadata ->> 'notes_recorder' from public.captures where id = cap_m));
  v := (select keep::text || '/' || reason from public.capture_feed_heartbeat('rec1', array[s_m]));
  perform pg_temp.t587_check('a closed capture: the heartbeat stops the producer and puts it out of the room', 'false/capture_closed/1',
    v || '/' || (select count(*)::text from public.team_call_eject where room = room_m and identity = 'notes-recorder-rec1' and done_at is null));
  perform pg_temp.t587_check('… not offered to any producer, and not started again', '0/not_wanted',
    (select count(*)::text from public.team_call_recorder_work('rec2', '{}', 20) w where w.call_id = call_m) || '/'
      || (select outcome from public.capture_feed_start('team_call', call_m, 'livekit_recorder', 'rec2', 't587 sync')));
  perform public.team_call_end(call_m, 'finished', now());
  v := (select outcome from public.team_call_capture_lock(call_m, '', true));
  perform pg_temp.t587_check('at the end, a transcript its owner locked is kept as they left it; the capture ends, the notes ready', 'ready/true/true/ready',
    v || '/' || (select ((transcript is not distinct from v2))::text || '/' || (ended_at is not null)::text from public.captures where id = cap_m)
      || '/' || (select notes_state from public.team_call where id = call_m));
  perform pg_temp.t587_check('… a closed-capture finish after the lock: done, nothing run twice', 'done',
    (select outcome from public.team_call_capture_finish(cap_m)));

  -- ── A capture ended by hand mid-round: the producer's end ends the session; notes on again, a new capture ──
  call_d := pg_temp.t587_as(u_b, format('select call_id::text from public.team_call_start(%L)', ch_quiet))::uuid;
  perform pg_temp.t587_as(u_b, format('select notes::text from public.team_call_set_notes(%L, true)', call_d));
  select capture_id, session_id into cap_d, s_d from public.capture_feed_start('team_call', call_d, 'livekit_recorder', 'rec1', 'd');
  perform public.capture_feed_roster(s_d, 'rec1', jsonb_build_array(pg_temp.ev('d1', m_b::text, 'joined', 10, jsonb_build_object('member_id', m_b))));
  perform public.capture_feed_append(s_d, 'rec1', jsonb_build_array(pg_temp.sg('dk1', m_b::text, 'First round words, kept.', 1000, 2000)));
  perform pg_temp.t587_check('a capture still open is not finished by hand', 'open',
    (select outcome from public.team_call_capture_finish(cap_d)));
  -- Its owner locks it (without ending it) while the call goes on.
  update public.captures set is_transcript_locked = true where id = cap_d;
  v := public.capture_feed_end(s_d, 'rec1', 'refused')::text;
  perform pg_temp.t587_check('the producer leaves a closed capture: its session ended, nothing written on the capture', 'true/ended/refused/live',
    v || '/' || (select status || '/' || end_reason from public.capture_feed_session where id = s_d)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap_d));
  perform pg_temp.t587_check('the sweeper sees it: closed by hand, not finished', '1',
    (select count(*)::text from public.team_call_closed_captures(50) x where x.capture_id = cap_d));
  v := (select outcome || '/' || spoke::text || '/' || owner_user::text from public.team_call_capture_finish(cap_d));
  perform pg_temp.t587_check('finished then: ended with a duration, its people left, the recorder''s no more (editable once unlocked), its record finished; the pass is the caller''s',
    'ready/true/' || u_b::text || '/true/true/0/done/true/0',
    v || '/' || (select (ended_at is not null)::text || '/' || (duration_seconds is not null)::text from public.captures where id = cap_d)
      || '/' || (select count(*)::text from public.capture_participant where capture_id = cap_d and joined_at is not null and left_at is null)
      || '/' || (select metadata ->> 'notes_recorder' from public.captures where id = cap_d)
      || '/' || (select (finished_at is not null)::text from public.team_call_capture where capture_id = cap_d)
      || '/' || (select count(*)::text from public.team_call_closed_captures(50) x where x.capture_id = cap_d));
  perform pg_temp.t587_check('… a second finish runs nothing', 'done', (select outcome from public.team_call_capture_finish(cap_d)));
  perform pg_temp.t587_as(u_b, format('select notes::text from public.team_call_set_notes(%L, false)', call_d));
  perform pg_temp.t587_as(u_b, format('select notes::text from public.team_call_set_notes(%L, true)', call_d));
  select capture_id into cap_d2 from public.capture_feed_start('team_call', call_d, 'livekit_recorder', 'rec1', 'd') where outcome = 'started';
  perform pg_temp.t587_check('notes on again: a new round into a new capture, the call linked to it, both on record', 'true/true/2',
    (cap_d2 is not null and cap_d2 <> cap_d)::text || '/' || (select (capture_id = cap_d2)::text from public.team_call where id = call_d)
      || '/' || (select count(*)::text from public.team_call_capture where call_id = call_d));
  perform public.team_call_end(call_d, 'finished', now());
  v := (select outcome || '/' || coalesce(capture_id::text, '<none>') from public.team_call_capture_lock(call_d, '', true));
  perform pg_temp.t587_check('the new round said nothing: its capture goes, and the call links back to the earlier one that holds words (ready, not silent)',
    'silent/' || cap_d::text || '/' || cap_d::text || '/ready/0',
    v || '/' || (select coalesce(capture_id::text, '<none>') || '/' || notes_state from public.team_call where id = call_d)
      || '/' || (select count(*)::text from public.captures where id = cap_d2));

  -- ── A call where nothing was said leaves no capture ───────────────────────
  call_s := pg_temp.t587_as(u_b, format('select call_id::text from public.team_call_start(%L)', ch_quiet))::uuid;
  perform pg_temp.t587_as(u_b, format('select notes::text from public.team_call_set_notes(%L, true)', call_s));
  select capture_id, session_id into cap_s, s_s from public.capture_feed_start('team_call', call_s, 'livekit_recorder', 'rec1', 'quiet');
  perform public.team_call_end(call_s, 'finished', now());
  v := (select outcome from public.team_call_capture_lock(call_s, '', true));
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
  perform pg_temp.t587_run('a person cannot lock one', 'refused', u_a, array[format('select * from public.team_call_capture_lock(%L, %L, true)', call_m, '')]);
  perform pg_temp.t587_run('a person cannot read who said a quote', 'refused', u_a, array[format('select * from public.capture_feed_quote_speakers(%L, %L)', cap, 'can you send')]);
  perform pg_temp.t587_run('a person cannot read the lines', 'refused', u_a, array[format('select * from public.capture_feed_lines(%L)', cap)]);
  perform pg_temp.t587_run('a person cannot fence the producers', 'refused', u_a, array['select public.capture_feed_fence_producers()']);
  perform pg_temp.t587_run('a person cannot settle the eject outbox', 'refused', u_a, array['select public.capture_feed_settle_ejects()']);
  perform pg_temp.t587_run('a person cannot finish a call''s capture', 'refused', u_a, array[format('select * from public.team_call_capture_finish(%L)', cap)]);
  perform pg_temp.t587_run('a person cannot read a call''s captures', 'refused', u_a, array['select 1 from public.team_call_capture']);
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
