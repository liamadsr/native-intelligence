-- DB-level test for migrations 572-575 (meeting links): a meeting's private
-- conversation and who may read it, the link's window and its revoke, a
-- member joining by the link's hash, guests asking, waiting (the cap),
-- being let in or declined by someone in the call, their LiveKit events
-- (an admitted guest counts and stays; one not let in, or removed, is
-- ejected), removal sticking for the guest (not for their address), the
-- members' fence leaving an admitted guest alone, a guest's go to notes and
-- recording (per notes round; no notes file of theirs before it), a call
-- left to guests, a call's end letting its guests go, the notes' capture
-- readable by the meeting's members and no one else, a new link replacing
-- the old, the rate limit, and anon having nothing. The TS tests
-- (src/lib/meeting-links/__tests__/migration-572.test.ts) pin the files'
-- text; this runs the SQL.
--
-- Run against a database with 564-567 and 572-575 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/572_meeting_links.sql
-- Everything runs in one transaction that is rolled back. A probe runs as one
-- caller (role authenticated, or anon) inside its own block that always rolls
-- back; t572_as runs as a caller and keeps what it did.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000572001'; -- Ana, hosts the meeting
  u_b constant uuid := '00000000-0000-4000-8000-000000572002'; -- Ben, in the workspace, opens the link
  u_c constant uuid := '00000000-0000-4000-8000-000000572003'; -- Cy, in the workspace, never opens it
  u_x constant uuid := '00000000-0000-4000-8000-000000572004'; -- outsider: their own workspace only
  w1 uuid; wx uuid;
  m_a uuid; m_b uuid; m_c uuid; m_x uuid;
  mt1 uuid := gen_random_uuid(); mt2 uuid := gen_random_uuid(); mt3 uuid := gen_random_uuid();
  d1 text := md5('t572-one') || md5('t572-one-b');
  d2 text := md5('t572-two') || md5('t572-two-b');
  d3 text := md5('t572-three') || md5('t572-three-b');
  d4 text := md5('t572-four') || md5('t572-four-b');
  d5 text := md5('t572-five') || md5('t572-five-b');
  nn text := 't572-nonce-aaaaaaaaaaaa';
  key1 text := 't572-key-one-xxxxxxxx';
  key2 text := 't572-key-two-xxxxxxxx';
  ch1 uuid; ch2 uuid; ch_open uuid;
  call1 uuid; room1 text; call2 uuid; room2 text;
  g1 uuid; g2 uuid; g3 uuid; g4 uuid; g5 uuid; g6 uuid;
  eg uuid;
  cap uuid;
  v_report text;
  v_fail int;
  v_raise_report constant boolean := true;
begin
  create temp table t572_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  create function pg_temp.t572_probe(p_uid uuid, p_sqls text[])
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
      raise exception using errcode = 'ZP572', message = 'rows=' || n;
    exception
      when sqlstate 'ZP572' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t572_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t572_probe(p_uid, p_sqls);
  begin
    insert into t572_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  create function pg_temp.t572_as(p_uid uuid, p_sql text)
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

  create function pg_temp.t572_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t572_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't572-ana@example.invalid', '{"full_name":"t572ana"}'),
    (u_b, 't572-ben@example.invalid', '{"full_name":"t572ben"}'),
    (u_c, 't572-cy@example.invalid',  '{"full_name":"t572cy"}'),
    (u_x, 't572-out@example.invalid', '{"full_name":"t572outsider"}');
  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  select workspace_id, id into wx, m_x from public.member where user_id = u_x;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't572ben'),
    (u_c, w1, 'member', 't572cy');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't572-open', m_a) returning id into ch_open;

  -- ── Making a meeting ──────────────────────────────────────────────────────
  perform pg_temp.t572_run('an outsider cannot make a meeting in the workspace', 'refused', u_x,
    array[format('select * from public.meeting_create(%L, %L, %L, %L, %L, null, null)', gen_random_uuid(), w1, 'Nope', d3, nn)]);
  perform pg_temp.t572_run('a meeting needs a title', 'refused', u_a,
    array[format('select * from public.meeting_create(%L, %L, %L, %L, %L, null, null)', gen_random_uuid(), w1, '   ', d3, nn)]);
  perform pg_temp.t572_run('a meeting is 5 minutes or more', 'refused', u_a,
    array[format('select * from public.meeting_create(%L, %L, %L, %L, %L, now() + interval ''1 day'', 3)', gen_random_uuid(), w1, 'Short', d3, nn)]);
  perform pg_temp.t572_run('a time that has passed (its window closed) is refused', 'refused', u_a,
    array[format('select * from public.meeting_create(%L, %L, %L, %L, %L, now() - interval ''1 day'', 30)', gen_random_uuid(), w1, 'Gone', d3, nn)]);
  perform pg_temp.t572_run('a token hash too short is refused', 'refused', u_a,
    array[format('select * from public.meeting_create(%L, %L, %L, %L, %L, null, null)', gen_random_uuid(), w1, 'Short hash', 'abc', nn)]);
  perform pg_temp.t572_run('a link''s nonce too short is refused', 'refused', u_a,
    array[format('select * from public.meeting_create(%L, %L, %L, %L, %L, null, null)', gen_random_uuid(), w1, 'Short nonce', d3, 'abc')]);
  ch1 := pg_temp.t572_as(u_a, format('select channel_id::text from public.meeting_create(%L, %L, %L, %L, %L, null, null)', mt1, w1, '  Design   review ', d1, nn))::uuid;
  perform pg_temp.t572_check('made: a conversation of its own kind, named for the title, its host its member',
    'meeting/Design review/1', (select c.kind || '/' || c.name || '/' || (select count(*) from public.team_chat_member tm where tm.channel_id = c.id and tm.member_id = m_a)::text from public.team_chat_channel c where c.id = ch1));
  perform pg_temp.t572_check('an unscheduled link works for 30 days from now', 'true',
    (select (closes_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 minute' and opens_at <= now())::text from public.meeting where id = mt1));
  ch2 := pg_temp.t572_as(u_a, format('select channel_id::text from public.meeting_create(%L, %L, %L, %L, %L, now() + interval ''1 day'', 45)', mt2, w1, 'Later', d2, nn))::uuid;
  perform pg_temp.t572_check('a scheduled one opens 15 minutes before its start, closes 2 hours after its planned end', 'true',
    (select (ends_at - starts_at = interval '45 minutes' and starts_at - opens_at = interval '15 minutes' and closes_at - ends_at = interval '2 hours')::text from public.meeting where id = mt2));
  perform pg_temp.t572_run('a person cannot make one for someone else (the service role''s)', 'refused', u_a,
    array[format('select * from public.meeting_create_for(%L, %L, %L, %L, %L, %L, null, null)', m_b, gen_random_uuid(), w1, 'For Ben', d3, nn)]);
  perform pg_temp.t572_check('the service role makes one for a member it knows', 'true',
    (select (count(*) = 1)::text from public.meeting_create_for(m_b, mt3, w1, 'Ben''s', d3, nn, null, null)));
  begin
    perform public.meeting_create_for(m_x, gen_random_uuid(), w1, 'Not theirs', md5('t572-x') || md5('t572-x2'), nn, null, null);
    perform pg_temp.t572_check('… but never for a member of another workspace', 'refused', 'made');
  exception when others then
    perform pg_temp.t572_check('… but never for a member of another workspace', 'refused', 'refused');
  end;

  -- ── Who may read it ───────────────────────────────────────────────────────
  perform pg_temp.t572_run('its host reads the meeting', 'rows=1', u_a, array[format('select 1 from public.meeting where id = %L', mt1)]);
  perform pg_temp.t572_run('… never its token''s hash', 'refused', u_a, array[format('select token_hash from public.meeting where id = %L', mt1)]);
  perform pg_temp.t572_run('… nor its link''s nonce', 'refused', u_a, array[format('select token_nonce from public.meeting where id = %L', mt1)]);
  perform pg_temp.t572_run('a member of the workspace who never opened the link does not see it', 'rows=0', u_c, array[format('select 1 from public.meeting where id = %L', mt1)]);
  perform pg_temp.t572_run('… nor its conversation', 'rows=0', u_c, array[format('select 1 from public.team_chat_channel where id = %L', ch1)]);
  perform pg_temp.t572_run('… and cannot post in it', 'refused', u_c,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body) values (%L, %L, %L, %L, %L)', ch1, w1, 'member', m_c, 'hi')]);
  perform pg_temp.t572_run('the workspace''s open channel reads as ever', 'rows=1', u_c, array[format('select 1 from public.team_chat_channel where id = %L', ch_open)]);
  perform pg_temp.t572_run('an outsider joining by the hash: refused', 'refused', u_x, array[format('select * from public.meeting_join(%L)', d1)]);
  perform pg_temp.t572_run('a wrong hash: refused', 'refused', u_b, array[format('select * from public.meeting_join(%L)', md5('nope') || md5('nope2'))]);
  perform pg_temp.t572_as(u_b, format('select channel_id::text from public.meeting_join(%L)', d1));
  perform pg_temp.t572_run('a member who opened the link reads the conversation', 'rows=1', u_b, array[format('select 1 from public.team_chat_channel where id = %L', ch1)]);
  perform pg_temp.t572_run('… and joining twice changes nothing', 'rows=1', u_b, array[format('select 1 from public.meeting_join(%L)', d1)]);

  -- ── Its call, and guests ──────────────────────────────────────────────────
  call1 := pg_temp.t572_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch1))::uuid;
  select room into room1 from public.team_call where id = call1;
  perform public.team_call_participant_event(room1, m_a, 'PA_a', true, now(), now());
  perform pg_temp.t572_check('a guest asks: waiting, the host named, one member in the call', 'waiting/' || m_a::text || '/1',
    (select outcome || '/' || host_member_id::text || '/' || members_in_call::text from public.meeting_guest_request(mt1, '  Dana   Lee ', key1, 3)));
  select id into g1 from public.meeting_guest where meeting_id = mt1 and name = 'Dana Lee';
  perform pg_temp.t572_check('… their name tidied, their key kept apart', 'Dana Lee/1', (select g.name || '/' || (select count(*) from public.meeting_guest_key k where k.guest_id = g.id)::text from public.meeting_guest g where g.id = g1));
  perform pg_temp.t572_check('a scheduled link before its window: early', 'early', (select outcome from public.meeting_guest_request(mt2, 'Early', key1, 3)));
  perform pg_temp.t572_check('a second guest waits', 'waiting', (select outcome from public.meeting_guest_request(mt1, 'Lee', key2, 3)));
  select id into g2 from public.meeting_guest where meeting_id = mt1 and name = 'Lee';
  perform pg_temp.t572_check('a third', 'waiting', (select outcome from public.meeting_guest_request(mt1, 'Kai', key2, 3)));
  select id into g3 from public.meeting_guest where meeting_id = mt1 and name = 'Kai';
  perform pg_temp.t572_check('the lobby is full at the cap', 'full', (select outcome from public.meeting_guest_request(mt1, 'Mo', key2, 3)));
  perform pg_temp.t572_run('a member of the conversation sees who waits', 'rows=3', u_b, array[format('select 1 from public.meeting_guest where meeting_id = %L', mt1)]);
  perform pg_temp.t572_run('… one who isn''t, nobody', 'rows=0', u_c, array[format('select 1 from public.meeting_guest where meeting_id = %L', mt1)]);
  perform pg_temp.t572_run('nobody reads the guests'' keys', 'refused', u_a, array['select 1 from public.meeting_guest_key']);
  perform pg_temp.t572_run('… nor the limits', 'refused', u_a, array['select 1 from public.meeting_rate']);
  perform pg_temp.t572_run('a person cannot ask as a guest (the service role''s)', 'refused', u_a,
    array[format('select * from public.meeting_guest_request(%L, %L, %L, 3)', mt1, 'X', key1)]);

  perform pg_temp.t572_run('a member not in the call cannot let a guest in', 'refused', u_b,
    array[format('select * from public.meeting_guest_decide(%L, true)', g1)]);
  perform pg_temp.t572_run('a member outside the conversation cannot either', 'refused', u_c,
    array[format('select * from public.meeting_guest_decide(%L, true)', g1)]);
  perform pg_temp.t572_check('someone in the call admits them into it', 'admitted/' || call1::text,
    pg_temp.t572_as(u_a, format('select state || ''/'' || call_id::text from public.meeting_guest_decide(%L, true)', g1)));
  perform pg_temp.t572_check('a second answer changes nothing', 'admitted',
    pg_temp.t572_as(u_a, format('select state from public.meeting_guest_decide(%L, false)', g1)));
  perform pg_temp.t572_check('another declined', 'declined',
    pg_temp.t572_as(u_a, format('select state from public.meeting_guest_decide(%L, false)', g3)));

  -- ── LiveKit's word on guests ──────────────────────────────────────────────
  perform pg_temp.t572_check('the admitted guest joins', 'joined', public.meeting_guest_event(room1, g1, 'PG_1', true, now(), now()));
  perform pg_temp.t572_check('… counted with the members, now and at the peak', '2/2',
    (select participant_count::text || '/' || peak_participants::text from public.team_call where id = call1));
  perform pg_temp.t572_check('a guest still waiting who reaches the room: ejected', 'ejected', public.meeting_guest_event(room1, g2, 'PG_2', true, now(), now()));
  perform pg_temp.t572_check('… on the eject outbox as their guest identity', '1',
    (select count(*)::text from public.team_call_eject where room = room1 and identity = 'guest-' || g2::text and done_at is null));
  perform pg_temp.t572_check('a declined guest too', 'ejected',
    public.meeting_guest_event(room1, g3, 'PG_3', true, now(), now()));
  perform pg_temp.t572_check('an identity no guest has: ejected', 'ejected',
    public.meeting_guest_event(room1, gen_random_uuid(), 'PG_x', true, now(), now()));
  perform pg_temp.t572_check('a repeat of the join: same', 'same', public.meeting_guest_event(room1, g1, 'PG_1', true, now(), now()));
  perform public.team_call_participant_event(room1, m_b, 'PA_b', true, now(), now());
  perform pg_temp.t572_check('a member joining counts the guest too (575)', '3', (select participant_count::text from public.team_call where id = call1));
  perform public.team_call_fence(null, null);
  perform pg_temp.t572_check('the members'' fence leaves an admitted guest alone', 'true/0',
    (select in_call::text || '/' || (select count(*) from public.team_call_eject where identity = 'guest-' || g1::text)::text from public.meeting_guest where id = g1));
  perform pg_temp.t572_check('… and so does the guests'' fence', '0', (select count(*)::text from public.meeting_guest_fence()));
  perform pg_temp.t572_check('the count still includes them', '3', (select participant_count::text from public.team_call where id = call1));
  perform pg_temp.t572_check('the lobby''s poll by the link''s hash: admitted, the call''s room, no notice, two members in it', 'admitted/' || room1 || '/true/false/2',
    (select state || '/' || room || '/' || open::text || '/' || needs_notice::text || '/' || members_in_call::text from public.meeting_guest_poll(g1, d1)));
  perform pg_temp.t572_check('… another link''s hash: nothing', '0', (select count(*)::text from public.meeting_guest_poll(g1, d2)));

  -- ── A guest's notes file ──────────────────────────────────────────────────
  perform pg_temp.t572_check('notes off: no file for a guest', '0', (select count(*)::text from public.meeting_guest_egress_claim(call1, g1, 'TR_g1')));
  perform pg_temp.t572_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call1));
  perform pg_temp.t572_check('notes on mid-call: the guest must see the notice (the poll)', 'true',
    (select needs_notice::text from public.meeting_guest_poll(g1, d1)));
  perform pg_temp.t572_check('… and before their go, no notes file of theirs', '0', (select count(*)::text from public.meeting_guest_egress_claim(call1, g1, 'TR_g1')));
  perform pg_temp.t572_check('a declined guest''s go: nothing', '0', (select count(*)::text from public.meeting_guest_ack(g3, d1)));
  perform pg_temp.t572_check('… another link''s hash: nothing', '0', (select count(*)::text from public.meeting_guest_ack(g1, d2)));
  perform pg_temp.t572_run('a person cannot say go for a guest (the service role''s)', 'refused', u_a,
    array[format('select * from public.meeting_guest_ack(%L, %L)', g1, d1)]);
  perform pg_temp.t572_check('the guest says go: this call''s room', room1, (select room from public.meeting_guest_ack(g1, d1)));
  perform pg_temp.t572_check('… recorded for this notes round, the notice gone', '1/false',
    (select notes_ack_round::text from public.meeting_guest where id = g1) || '/' || (select needs_notice::text from public.meeting_guest_poll(g1, d1)));
  select egress_row into eg from public.meeting_guest_egress_claim(call1, g1, 'TR_g1');
  perform pg_temp.t572_check('notes on: the guest''s microphone gets its file, theirs, no member''s', 'notes/' || g1::text || '/true',
    (select kind || '/' || guest_id::text || '/' || (member_id is null)::text from public.team_call_egress where id = eg));
  perform pg_temp.t572_check('a declined guest gets none', '0', (select count(*)::text from public.meeting_guest_egress_claim(call1, g3, 'TR_g3')));
  perform pg_temp.t572_as(u_a, format('select notes::text from public.team_call_set_notes(%L, false)', call1));
  perform pg_temp.t572_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call1));
  perform pg_temp.t572_check('notes off and on again (a new round): the notice again, no file before the go', 'true/0',
    (select needs_notice::text from public.meeting_guest_poll(g1, d1)) || '/' || (select count(*)::text from public.meeting_guest_egress_claim(call1, g1, 'TR_g1b')));
  perform public.meeting_guest_ack(g1, d1);
  perform pg_temp.t572_check('… their go for that round: the file', '1', (select count(*)::text from public.meeting_guest_egress_claim(call1, g1, 'TR_g1b')));
  -- A recording: its own go.
  update public.team_call set recording = 'on', recording_by = m_a, recording_started_at = now() where id = call1;
  perform pg_temp.t572_check('a recording started: the notice for a guest who said go to notes only', 'true',
    (select needs_notice::text from public.meeting_guest_poll(g1, d1)));
  perform public.meeting_guest_ack(g1, d1);
  perform pg_temp.t572_check('… their go to it: no notice', 'false', (select needs_notice::text from public.meeting_guest_poll(g1, d1)));
  update public.team_call set recording_started_at = now() + interval '1 second' where id = call1;
  perform pg_temp.t572_check('… a recording started after their go: the notice again', 'true', (select needs_notice::text from public.meeting_guest_poll(g1, d1)));
  update public.team_call set recording = 'off' where id = call1;

  -- ── Removed, for good ─────────────────────────────────────────────────────
  perform pg_temp.t572_run('an outsider cannot remove a guest', 'refused', u_x, array[format('select * from public.meeting_guest_remove(%L)', g1)]);
  perform pg_temp.t572_check('a member of the conversation removes them: out of the room', 'removed/true',
    pg_temp.t572_as(u_b, format('select state || ''/'' || ejected::text from public.meeting_guest_remove(%L)', g1)));
  perform pg_temp.t572_check('… out of the count, on the eject outbox', 'false/2/1',
    (select g.in_call::text || '/' || t.participant_count::text || '/' || (select count(*) from public.team_call_eject where identity = 'guest-' || g1::text and done_at is null)::text
       from public.meeting_guest g join public.team_call t on t.id = call1 where g.id = g1));
  perform pg_temp.t572_check('rejoining on their old token: ejected', 'ejected', public.meeting_guest_event(room1, g1, 'PG_1b', true, now(), now()));
  perform pg_temp.t572_check('asking again from the same address: a new request, waiting (no refusal by address)', 'waiting', (select outcome from public.meeting_guest_request(mt1, 'Dana again', key1, 10)));
  perform pg_temp.t572_check('the lobby''s poll says removed', 'removed', (select state from public.meeting_guest_poll(g1, d1)));

  -- ── Leaving, and a call's end ─────────────────────────────────────────────
  perform pg_temp.t572_check('a waiting guest who cancels has left', 'left', public.meeting_guest_leave(g2, d1));
  perform pg_temp.t572_check('another address may ask', 'waiting', (select outcome from public.meeting_guest_request(mt1, 'Noor', key2 || 'z', 10)));
  select id into g4 from public.meeting_guest where meeting_id = mt1 and name = 'Noor';
  perform pg_temp.t572_as(u_a, format('select state from public.meeting_guest_decide(%L, true)', g4));
  -- Let in, their join not landed yet: leaving through the route still takes them out of the room.
  perform pg_temp.t572_check('five from one address wait', 'waiting/waiting/waiting/waiting/waiting',
    (select outcome from public.meeting_guest_request(mt1, 'Pat', 't572-key-three-xxxxx', 10)) || '/' || (select outcome from public.meeting_guest_request(mt1, 'Sam', 't572-key-three-xxxxx', 10))
      || '/' || (select outcome from public.meeting_guest_request(mt1, 'Tia', 't572-key-three-xxxxx', 10)) || '/' || (select outcome from public.meeting_guest_request(mt1, 'Vic', 't572-key-three-xxxxx', 10))
      || '/' || (select outcome from public.meeting_guest_request(mt1, 'Wes', 't572-key-three-xxxxx', 10)));
  perform pg_temp.t572_check('… a sixth from the same address: full (one address can''t fill the lobby)', 'full',
    (select outcome from public.meeting_guest_request(mt1, 'Lou', 't572-key-three-xxxxx', 10)));
  select id into g5 from public.meeting_guest where meeting_id = mt1 and name = 'Pat';
  perform pg_temp.t572_as(u_a, format('select state from public.meeting_guest_decide(%L, true)', g5));
  perform pg_temp.t572_check('a guest let in who leaves through the route (their join not seen): left', 'left', public.meeting_guest_leave(g5, d1));
  perform pg_temp.t572_check('… and out of the room (on the eject outbox)', '1',
    (select count(*)::text from public.team_call_eject where identity = 'guest-' || g5::text and done_at is null));
  select id into g5 from public.meeting_guest where meeting_id = mt1 and name = 'Sam';
  perform pg_temp.t572_as(u_a, format('select state from public.meeting_guest_decide(%L, true)', g5));
  perform pg_temp.t572_check('a guest let in and removed before their join landed: removed, ejected', 'removed/true',
    pg_temp.t572_as(u_b, format('select state || ''/'' || ejected::text from public.meeting_guest_remove(%L)', g5)));
  perform pg_temp.t572_check('… on the eject outbox too', '1',
    (select count(*)::text from public.team_call_eject where identity = 'guest-' || g5::text and done_at is null));
  perform public.meeting_guest_event(room1, g4, 'PG_4', true, now(), now());
  perform pg_temp.t572_check('a guest in the call with members: not a call left to guests', '0', (select count(*)::text from public.meeting_guest_only_calls(0)));
  perform public.team_call_participant_event(room1, m_a, 'PA_a', false, now(), now());
  perform public.team_call_participant_event(room1, m_b, 'PA_b', false, now(), now());
  perform pg_temp.t572_check('the members left just now: within the grace, not yet', '0', (select count(*)::text from public.meeting_guest_only_calls(180)));
  perform pg_temp.t572_check('… and the poll tells the guest no member is in it', '0', (select members_in_call::text from public.meeting_guest_poll(g4, d1)));
  update public.team_call_participant set first_joined_at = now() - interval '20 minutes', joined_at = now() - interval '20 minutes', left_at = now() - interval '10 minutes' where call_id = call1;
  perform pg_temp.t572_check('… left past the grace: the call is one to end', call1::text, (select string_agg(call_id::text, ',') from public.meeting_guest_only_calls(180)));
  perform pg_temp.t572_run('a person cannot list them (the service role''s)', 'refused', u_a, array['select * from public.meeting_guest_only_calls(180)']);
  perform public.team_call_end(call1, 'finished', now());
  perform pg_temp.t572_check('… ended: nothing left to end', '0', (select count(*)::text from public.meeting_guest_only_calls(0)));
  perform pg_temp.t572_check('the call ended: its admitted guest has left, out of it', 'left/false',
    (select state || '/' || in_call::text from public.meeting_guest where id = g4));
  perform pg_temp.t572_check('… and the ended call counted the guests at its peak', 'true',
    (select (peak_participants >= 3)::text from public.team_call where id = call1));

  -- ── The notes' capture: the meeting's members, no one else ────────────────
  update public.team_call set notes_state = 'transcribing' where id = call1 and notes_state <> 'ready';
  cap := public.team_call_attach_notes(call1, u_a, 'Design review', '[Ana] hello' || chr(10) || '[Dana Lee (guest)] hi', '', jsonb_build_array(jsonb_build_object('member_id', m_a, 'name', 't572ana')), '{}');
  perform pg_temp.t572_run('a member of the meeting reads its notes (the channel grant, 572''s readers)', 'rows=1', u_b, array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t572_run('a member of the workspace outside it does not', 'rows=0', u_c, array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t572_check('… the grant reaches Ben, not Cy (entity_grant_reaches)', 'true/false',
    public.entity_grant_reaches('capture', cap, w1, u_b)::text || '/' || public.entity_grant_reaches('capture', cap, w1, u_c)::text);

  -- ── Revoked ───────────────────────────────────────────────────────────────
  perform pg_temp.t572_check('one more guest waits', 'waiting', (select outcome from public.meeting_guest_request(mt1, 'Ola', key2 || 'y', 10)));
  select id into g5 from public.meeting_guest where meeting_id = mt1 and name = 'Ola';
  perform pg_temp.t572_run('only the host revokes the link', 'refused', u_b, array[format('select * from public.meeting_revoke(%L)', mt1)]);
  perform pg_temp.t572_check('the host does', 'true', pg_temp.t572_as(u_a, format('select revoked::text from public.meeting_revoke(%L)', mt1)));
  perform pg_temp.t572_check('… the guest waiting is let go', 'left', (select state from public.meeting_guest where id = g5));
  perform pg_temp.t572_check('… a new guest is told it no longer works', 'inactive', (select outcome from public.meeting_guest_request(mt1, 'Late', key2 || 'x', 10)));
  perform pg_temp.t572_run('… a member opening it is refused', 'refused', u_c, array[format('select * from public.meeting_join(%L)', d1)]);
  perform pg_temp.t572_check('… its poll says the link is closed', 'false', (select open::text from public.meeting_guest_poll(g5, d1)));
  perform pg_temp.t572_run('… and the conversation stays its members''', 'rows=1', u_b, array[format('select 1 from public.team_chat_channel where id = %L', ch1)]);

  -- ── A new link: the old one stops, the meeting and its conversation stay ──
  perform pg_temp.t572_run('only the host makes a new link', 'refused', u_b, array[format('select public.meeting_new_link(%L, %L, %L)', mt1, d4, nn)]);
  perform pg_temp.t572_run('… with a hash and a nonce of the right size', 'refused', u_a, array[format('select public.meeting_new_link(%L, %L, %L)', mt1, d4, 'abc')]);
  perform pg_temp.t572_check('the host makes one for a turned-off link', 'true',
    pg_temp.t572_as(u_a, format('select public.meeting_new_link(%L, %L, %L)::text', mt1, d4, 't572-nonce-bbbbbbbbbbbb')));
  perform pg_temp.t572_check('… it works again, on the new hash and nonce', 'true',
    (select (revoked_at is null and token_hash = d4 and token_nonce = 't572-nonce-bbbbbbbbbbbb')::text from public.meeting where id = mt1));
  perform pg_temp.t572_check('a guest asks on the new link', 'waiting', (select outcome from public.meeting_guest_request(mt1, 'Uma', 't572-key-five-xxxxxx', 10)));
  select id into g6 from public.meeting_guest where meeting_id = mt1 and name = 'Uma';
  perform pg_temp.t572_as(u_a, format('select public.meeting_new_link(%L, %L, %L)::text', mt1, d5, 't572-nonce-cccccccccccc'));
  perform pg_temp.t572_check('another new link: the guest waiting on the old one is let go', 'left', (select state from public.meeting_guest where id = g6));
  perform pg_temp.t572_run('… the old link opens nothing for a member', 'refused', u_c, array[format('select * from public.meeting_join(%L)', d4)]);
  perform pg_temp.t572_check('… its lobby answers nothing', '0', (select count(*)::text from public.meeting_guest_poll(g6, d4)));
  perform pg_temp.t572_run('… the new one does, into the same conversation', 'rows=1', u_c, array[format('select 1 from public.meeting_join(%L) where channel_id = %L', d5, ch1)]);

  -- ── Limits, notices, and nothing for anon ─────────────────────────────────
  perform pg_temp.t572_check('a limit: two hits pass, the third does not', 'true/true/false',
    public.meeting_rate_hit('t572', 'k', 2, 60)::text || '/' || public.meeting_rate_hit('t572', 'k', 2, 60)::text || '/' || public.meeting_rate_hit('t572', 'k', 2, 60)::text);
  insert into public.notification (workspace_id, recipient_id, type, title, target_type, target_id, context_type, context_id)
  values (w1, m_a, 'meeting_waiting', 'Dana is waiting to join Design review', 'team_chat_channel', ch1, 'team_chat_channel', ch1);
  perform pg_temp.t572_check('the host''s notice: a meeting_waiting notification on the conversation', '1',
    (select count(*)::text from public.notification where type = 'meeting_waiting' and recipient_id = m_a and target_id = ch1));
  perform pg_temp.t572_check('anon has no table here', 'false',
    (has_table_privilege('anon', 'public.meeting', 'select') or has_table_privilege('anon', 'public.meeting_guest', 'select')
      or has_table_privilege('anon', 'public.meeting_guest_key', 'select') or has_table_privilege('anon', 'public.meeting_rate', 'select')
      or has_table_privilege('anon', 'public.meeting_guest', 'insert'))::text);
  perform pg_temp.t572_check('anon may run none of the functions', '0',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'meeting%' or p.proname = 'team_call_people_now')
        and has_function_privilege('anon', p.oid, 'execute')));
  perform pg_temp.t572_check('a person may run only the six person functions', 'meeting_create,meeting_guest_decide,meeting_guest_remove,meeting_join,meeting_new_link,meeting_revoke',
    (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'meeting%' or p.proname = 'team_call_people_now')
        and has_function_privilege('authenticated', p.oid, 'execute')));
  perform pg_temp.t572_run('anon reads no guest', 'refused', null, array['select 1 from public.meeting_guest']);
  perform pg_temp.t572_run('anon asks no lobby', 'refused', null, array[format('select * from public.meeting_guest_poll(%L, %L)', g5, d1)]);
  perform pg_temp.t572_check('every new function is a definer with a pinned search_path', '0',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'meeting%' or p.proname = 'team_call_people_now')
        and not (p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public, pg_temp%')));

  -- ── A meeting's conversation deleted mid-call, a guest let in: everything goes ──
  select channel_id into ch2 from public.meeting where id = mt3;
  call2 := pg_temp.t572_as(u_b, format('select call_id::text from public.team_call_start(%L)', ch2))::uuid;
  select room into room2 from public.team_call where id = call2;
  perform public.team_call_participant_event(room2, m_b, 'PB_3', true, now(), now());
  perform public.meeting_guest_request(mt3, 'Rae', 't572-key-four-xxxxxx', 10);
  select id into g5 from public.meeting_guest where meeting_id = mt3 and name = 'Rae';
  perform pg_temp.t572_as(u_b, format('select state from public.meeting_guest_decide(%L, true)', g5));
  delete from public.team_chat_channel where id = ch2;
  perform pg_temp.t572_check('the conversation deleted with an admitted guest: the call, the meeting and the guest go with it', '0/0/0',
    (select count(*)::text from public.team_call where id = call2) || '/' || (select count(*)::text from public.meeting where id = mt3) || '/' || (select count(*)::text from public.meeting_guest where id = g5));

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t572_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '572 meeting_links: % of % check(s) failed: %', v_fail, (select count(*) from t572_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t572_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '572 meeting_links: all % checks passed', (select count(*) from t572_results) using detail = v_report;
  end if;
  raise notice '572 meeting_links: all checks passed';
end
$probe$;

rollback;
