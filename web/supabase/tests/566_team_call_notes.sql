-- DB-level test for migrations 566-569 (call notes and recordings): who may
-- turn a call's notes on or off, a microphone's file claimed once per track
-- and round, LiveKit's egress events applied in order whatever order they
-- arrive in, the recording's cap across the server, a call's end settling
-- its notes, the notes' capture (private, shared with the conversation and
-- no one else, read only while the conversation is), the recordings bucket
-- read by the conversation's readers and written by no client, and the
-- service role's functions refused to a person. The TS tests
-- (src/lib/team-calls/__tests__/migration-566.test.ts) pin the files' text;
-- this runs the SQL.
--
-- Run against a database with 564-569 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/566_team_call_notes.sql
-- Everything runs in one transaction that is rolled back. A probe runs as one
-- caller (role authenticated with that user's JWT claims) inside its own
-- block that always rolls back; t566_as runs as a caller and keeps what it did.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000566001'; -- Ana, in the team, starts the call
  u_b constant uuid := '00000000-0000-4000-8000-000000566002'; -- Ben, in the team, joins
  u_c constant uuid := '00000000-0000-4000-8000-000000566003'; -- Cy, in the workspace, not in the team
  u_x constant uuid := '00000000-0000-4000-8000-000000566004'; -- outsider: their own workspace only
  w1 uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid;
  ch_team uuid; ch_open uuid;
  call_t uuid; room_t text; call_o uuid; room_o text;
  row_a uuid; row_a2 uuid; row_a3 uuid; rec_t uuid; rec_t2 uuid; rec_o uuid;
  now_ns bigint;
  cap uuid;
  clm uuid;
  v_report text;
  v_fail int;
  v_raise_report constant boolean := true;
begin
  create temp table t566_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  create function pg_temp.t566_probe(p_uid uuid, p_sqls text[])
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
      raise exception using errcode = 'ZP566', message = 'rows=' || n;
    exception
      when sqlstate 'ZP566' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t566_run(p_label text, p_expect text, p_uid uuid, p_sqls text[])
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t566_probe(p_uid, p_sqls);
  begin
    insert into t566_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  create function pg_temp.t566_as(p_uid uuid, p_sql text)
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

  -- Run a statement as postgres (the server) and say whether it was refused; always rolled back.
  create function pg_temp.t566_try(p_sql text)
  returns text language plpgsql as $f$
  begin
    begin
      execute p_sql;
      raise exception using errcode = 'ZP566', message = 'done';
    exception
      when sqlstate 'ZP566' then return 'done';
      when others then return 'refused';
    end;
  end $f$;

  create function pg_temp.t566_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t566_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't566-ana@example.invalid', '{"full_name":"t566ana"}'),
    (u_b, 't566-ben@example.invalid', '{"full_name":"t566ben"}'),
    (u_c, 't566-cy@example.invalid',  '{"full_name":"t566cy"}'),
    (u_x, 't566-out@example.invalid', '{"full_name":"t566outsider"}');
  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't566ben'),
    (u_c, w1, 'member', 't566cy');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  update public.member set display_name = 't566ana' where id = m_a;
  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't566 team', 't566-team', 'TQZ') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a), (t1, m_b);
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't566-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't566-open', m_a) returning id into ch_open;

  call_t := pg_temp.t566_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_team))::uuid;
  select room into room_t from public.team_call where id = call_t;
  update public.team_call set started_at = now() - interval '20 minutes' where id = call_t;

  -- ── Who turns notes on or off ─────────────────────────────────────────────
  perform pg_temp.t566_run('someone outside the team cannot turn the call''s notes on', 'refused', u_c,
    array[format('select * from public.team_call_set_notes(%L, true)', call_t)]);
  perform pg_temp.t566_run('NON-MEMBER cannot turn the call''s notes on', 'refused', u_x,
    array[format('select * from public.team_call_set_notes(%L, true)', call_t)]);
  perform pg_temp.t566_run('a teammate not in the call (yet) cannot either', 'refused', u_b,
    array[format('select * from public.team_call_set_notes(%L, true)', call_t)]);
  perform pg_temp.t566_run('its starter can, before LiveKit says they joined (Auto-record at start)', 'rows=1', u_a,
    array[format('select 1 from public.team_call_set_notes(%L, true) where notes and changed and notes_round = 1', call_t)]);
  perform pg_temp.t566_as(u_a, format('select notes::text from public.team_call_set_notes(%L, true)', call_t));
  perform pg_temp.t566_check('notes on: on the call''s row for everyone, by its starter, capturing', 'true/' || m_a::text || '/capturing/1',
    (select notes::text || '/' || notes_by::text || '/' || notes_state || '/' || notes_round::text from public.team_call where id = call_t));
  perform pg_temp.t566_run('a second press changes nothing', 'rows=1', u_a,
    array[format('select 1 from public.team_call_set_notes(%L, true) where not changed', call_t)]);
  perform public.team_call_participant_event(room_t, m_b, 'PA_b', true, now(), now());
  perform pg_temp.t566_run('once in the call, anyone in it may turn them off', 'rows=1', u_b,
    array[format('select 1 from public.team_call_set_notes(%L, false) where not notes and changed', call_t)]);
  perform pg_temp.t566_as(u_b, format('select notes::text from public.team_call_set_notes(%L, false)', call_t));
  perform pg_temp.t566_check('notes off: by Ben, still capturing (what was written is kept)', 'false/' || m_b::text || '/capturing',
    (select notes::text || '/' || notes_by::text || '/' || notes_state from public.team_call where id = call_t));
  perform pg_temp.t566_run('a teammate reads the notes state on the call (Realtime''s row)', 'rows=1', u_b,
    array[format('select 1 from public.team_call where id = %L and notes_state = %L', call_t, 'capturing')]);

  -- ── A microphone's file ───────────────────────────────────────────────────
  perform pg_temp.t566_check('notes off: a published microphone claims no file', '0',
    (select count(*)::text from public.team_call_egress_claim(call_t, m_b, 'TR_b')));
  perform pg_temp.t566_as(u_b, format('select notes::text from public.team_call_set_notes(%L, true)', call_t));
  select egress_row into row_a from public.team_call_egress_claim(call_t, m_b, 'TR_b');
  perform pg_temp.t566_check('notes on again (round 2): its file claimed, named for its row', ch_team::text || '/' || call_t::text || '/notes/' || row_a::text || '.ogg',
    (select file_path from public.team_call_egress where id = row_a));
  perform pg_temp.t566_check('the same track again (a repeated webhook): nothing', '0',
    (select count(*)::text from public.team_call_egress_claim(call_t, m_b, 'TR_b')));
  perform pg_temp.t566_check('a file not yet cut off while notes are on', 'true', (select (cutoff_at is null)::text from public.team_call_egress where id = row_a));
  perform pg_temp.t566_check('a member of another workspace: nothing',
    '0', (select count(*)::text from public.team_call_egress_claim(call_t, (select id from public.member where user_id = u_x), 'TR_x')));

  -- ── Egress events, in LiveKit's order ─────────────────────────────────────
  perform pg_temp.t566_check('started: the egress id bound, active', 'applied/active',
    (select outcome || '/' || status from public.team_call_egress_event(row_a, 'EG_t566_a', 'active', 1000, now() - interval '5 minutes', null, null, null, null)));
  perform pg_temp.t566_check('an older event after it: stale', 'stale',
    (select outcome from public.team_call_egress_event(null, 'EG_t566_a', 'starting', 500, null, null, null, null, null)));
  perform pg_temp.t566_check('the file a webhook names, from another egress: unknown', 'unknown',
    (select outcome from public.team_call_egress_event(row_a, 'EG_t566_other', 'active', 1500, null, null, null, null, null)));
  perform pg_temp.t566_check('ended with a file: complete, its words still to come', 'applied/complete/pending',
    (select r.outcome || '/' || r.status || '/' || e.transcript_status from public.team_call_egress_event(null, 'EG_t566_a', 'complete', 3000, null, now(), 290000, 1200000, null) r join public.team_call_egress e on e.id = r.egress_row));
  perform pg_temp.t566_check('a late "active" after it ended: stale, a finished egress never starts again', 'stale/complete',
    (select outcome || '/' || status from public.team_call_egress_event(row_a, 'EG_t566_a', 'active', 4000, null, null, null, null, null)));
  perform pg_temp.t566_check('… its file''s start and size kept', '1200000/true',
    (select size_bytes::text || '/' || (started_at is not null)::text from public.team_call_egress where id = row_a) );
  select egress_row into row_a2 from public.team_call_egress_claim(call_t, m_a, 'TR_a');
  perform public.team_call_egress_event(row_a2, 'EG_t566_a2', 'complete', 10, null, now(), 0, 0, null);
  perform pg_temp.t566_check('a file with nothing in it: empty, no words to wait for', 'empty',
    (select transcript_status from public.team_call_egress where id = row_a2));
  select egress_row into row_a3 from public.team_call_egress_claim(call_t, m_a, 'TR_a3');
  perform public.team_call_egress_event(row_a3, 'EG_t566_a3', 'active', 1762850000000000000, null, null, null, null, null);
  now_ns := (extract(epoch from clock_timestamp()) * 1000000000)::bigint;
  perform pg_temp.t566_check('the app''s own word that it failed (stamped now) lands after LiveKit''s events', 'applied/failed',
    (select outcome || '/' || status from public.team_call_egress_event(row_a3, null, 'failed', now_ns, null, null, null, null, 'lost: never finished')));
  perform pg_temp.t566_check('… and LiveKit''s newer finish with a file after all still lands', 'applied/complete',
    (select outcome || '/' || status from public.team_call_egress_event(row_a3, 'EG_t566_a3', 'complete', now_ns + 1000000000, null, now(), 1000, 5000, null)));
  perform pg_temp.t566_check('… its words wanted again', 'pending', (select transcript_status from public.team_call_egress where id = row_a3));

  -- ── The recording and its cap ─────────────────────────────────────────────
  call_o := pg_temp.t566_as(u_a, format('select call_id::text from public.team_call_start(%L)', ch_open))::uuid;
  select room into room_o from public.team_call where id = call_o;
  perform public.team_call_participant_event(room_o, m_c, 'PA_c', true, now(), now());
  perform pg_temp.t566_run('the starter who never joined may turn notes on', 'rows=1', u_a,
    array[format('select 1 from public.team_call_set_notes(%L, true) where changed', call_o)]);
  perform public.team_call_participant_event(room_o, m_a, 'PA_ao', true, now() - interval '2 minutes', now() - interval '2 minutes');
  perform public.team_call_participant_event(room_o, m_a, 'PA_ao', false, now() - interval '1 minute', now() - interval '2 minutes');
  perform pg_temp.t566_run('… not once they have left the call', 'refused', u_a,
    array[format('select * from public.team_call_set_notes(%L, true)', call_o)]);
  perform public.team_call_participant_event(room_t, m_a, 'PA_a', true, now(), now());
  perform pg_temp.t566_check('someone not in the call cannot record it', 'not_in_call',
    (select outcome from public.team_call_recording_begin(call_t, m_c, 1)));
  -- Recordings running elsewhere on this database are left as they are; the cap counts them too.
  perform pg_temp.t566_check('the first recording: claimed', 'claimed',
    (select outcome from public.team_call_recording_begin(call_t, m_a, 1 + (select count(*)::integer from public.team_call where recording in ('starting', 'on')))));
  select id into rec_t from public.team_call_egress where call_id = call_t and kind = 'recording';
  perform pg_temp.t566_check('a second, at the cap: busy ("another recording is running")', 'busy',
    (select outcome from public.team_call_recording_begin(call_o, m_c, (select count(*)::integer from public.team_call where recording in ('starting', 'on')))));
  perform pg_temp.t566_check('the same call again: already', 'already',
    (select outcome from public.team_call_recording_begin(call_t, m_a, 99)));
  perform public.team_call_egress_event(rec_t, 'EG_t566_rec', 'active', 100, null, null, null, null, null);
  perform pg_temp.t566_check('its egress active: the call is recording, for everyone', 'on',
    (select recording from public.team_call where id = call_t));
  perform public.team_call_egress_event(rec_t, 'EG_t566_rec', 'complete', 150, null, now(), 0, 0, null);
  perform pg_temp.t566_check('it ended with no file: the recording failed', 'failed', (select recording from public.team_call where id = call_t));
  perform pg_temp.t566_check('… and another may be started in the same call', 'claimed',
    (select outcome from public.team_call_recording_begin(call_t, m_a, 1 + (select count(*)::integer from public.team_call where recording in ('starting', 'on')))));
  select id into rec_t2 from public.team_call_egress where call_id = call_t and kind = 'recording' and status = 'starting';
  perform public.team_call_egress_event(rec_t2, 'EG_t566_rec2', 'active', 160, null, null, null, null, null);

  -- ── The end ───────────────────────────────────────────────────────────────
  perform public.team_call_egress_event(rec_t2, 'EG_t566_rec2', 'complete', 200, null, now(), 600000, 50000000, null);
  perform pg_temp.t566_check('its file saved', 'saved', (select recording from public.team_call where id = call_t));
  perform pg_temp.t566_check('a saved recording is the call''s: no second', 'saved',
    (select outcome from public.team_call_recording_begin(call_t, m_a, 99)));
  -- Notes on for the last five minutes of it (the clock stands still inside one transaction).
  update public.team_call set notes_on_since = now() - interval '5 minutes' where id = call_t;
  perform public.team_call_end(call_t, 'finished', now());
  perform pg_temp.t566_check('the call''s end cuts the open round''s files off at its end (no word after it reaches the notes)', '0',
    (select count(*)::text from public.team_call_egress where call_id = call_t and kind = 'notes' and round = 2 and cutoff_at is null));
  perform pg_temp.t566_check('the call ends (565''s end, unchanged): notes off, their time counted, transcribing', 'false/transcribing/true',
    (select notes::text || '/' || notes_state || '/' || (notes_seconds > 0)::text from public.team_call where id = call_t));
  perform pg_temp.t566_run('notes can''t be turned on after the end', 'refused', u_a,
    array[format('select * from public.team_call_set_notes(%L, true)', call_t)]);

  -- ── The notes: one capture, as wide as the conversation ───────────────────
  cap := public.team_call_attach_notes(call_t, u_a, 'Call in #t566-team', '[t566ana] Shall we?' || chr(10) || '[t566ben] Yes.', '',
    jsonb_build_array(
      jsonb_build_object('member_id', m_a, 'name', 't566ana', 'label', 't566ana'),
      jsonb_build_object('member_id', m_b, 'name', 't566ben', 'label', 't566ben')
    ), '{}'::jsonb);
  perform pg_temp.t566_check('a capture: private to its owner, the starter, with its transcript', 'private/true/true',
    (select visibility || '/' || (user_id = u_a)::text || '/' || (transcript like '[t566ana]%')::text from public.captures where id = cap));
  perform pg_temp.t566_check('… linked to the call, notes ready', 'ready',
    (select notes_state from public.team_call where id = call_t and capture_id = cap));
  perform pg_temp.t566_check('… a participant row each, the owner''s confirmed as theirs', '2/1',
    (select count(*)::text || '/' || count(*) filter (where is_self and self_binding = 'confirmed')::text from public.capture_participant where capture_id = cap));
  perform pg_temp.t566_check('… shared with the conversation by one grant', '1',
    (select count(*)::text from public.entity_access where entity_type = 'capture' and entity_id = cap and grantee_kind = 'channel' and grantee_channel_id = ch_team and source = 'team_call'));
  perform pg_temp.t566_check('written again: the same capture, no second', cap::text,
    public.team_call_attach_notes(call_t, u_a, 'x', 'x', '', '[]'::jsonb, '{}'::jsonb)::text);
  perform pg_temp.t566_run('a teammate in the conversation reads the notes', 'rows=1', u_b,
    array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t566_run('someone outside the conversation does not', 'rows=0', u_c,
    array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t566_run('NON-MEMBER does not', 'rows=0', u_x,
    array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t566_run('its owner cannot make the notes the whole workspace''s', 'refused', u_a,
    array[format('update public.captures set visibility = %L where id = %L', 'workspace', cap)]);
  perform pg_temp.t566_run('its owner cannot share them with someone outside the conversation', 'refused', u_a,
    array[format('insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, granted_by) values (%L, %L, %L, %L, %L, %L)', w1, 'capture', cap, 'member', m_c, m_a)]);
  perform pg_temp.t566_run('… nor to edit, even with its own conversation', 'refused', u_a,
    array[format('update public.entity_access set level = %L where entity_type = %L and entity_id = %L', 'edit', 'capture', cap)]);
  perform pg_temp.t566_check('… nor by the server (the guard holds for every writer)', 'refused', (
    select case when exists (select 1) then pg_temp.t566_try(format('update public.entity_access set level = %L where entity_type = %L and entity_id = %L', 'edit', 'capture', cap)) end));
  perform pg_temp.t566_run('… nor with another channel', 'refused', u_a,
    array[format('insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_channel_id, granted_by) values (%L, %L, %L, %L, %L, %L)', w1, 'capture', cap, 'channel', ch_open, m_a)]);
  perform pg_temp.t566_check('the notes carry their conversation', ch_team::text, (select notes_channel_id::text from public.captures where id = cap));

  -- ── The owner's reads through the definer functions (568) ──────────────────
  update public.captures set title = 't566 quokka notes' where id = cap;
  insert into public.claim (workspace_id, text, type) values (w1, 't566 quokka claim', 'fact') returning id into clm;
  insert into public.claim_source (claim_id, source_type, source_id) values (clm, 'capture', cap);
  perform pg_temp.t566_check('in the conversation, the owner reads their notes: capture_visible_to', 'true', public.capture_visible_to(cap, u_a)::text);
  perform pg_temp.t566_check('… claim_visible_to', 'true', public.claim_visible_to(clm, u_a)::text);
  perform pg_temp.t566_check('… unified_search', '1', (select count(*)::text from public.unified_search(w1, 'quokka', array['capture'], 10, u_a) x where x.result_id = cap));
  perform pg_temp.t566_check('… hybrid_search', '1', (select count(*)::text from public.hybrid_search(p_workspace_id => w1, p_query => 'quokka', p_types => array['capture'], p_requesting_user_id => u_a) x where x.result_id = cap));
  perform pg_temp.t566_check('… and the agent''s flag says they are in', 'false', (select notes_owner_out::text from public.captures where id = cap));
  delete from public.team_member where team_id = t1 and member_id = m_a;
  perform pg_temp.t566_check('the owner taken off the team: the agent''s flag follows at once', 'true', (select notes_owner_out::text from public.captures where id = cap));
  perform pg_temp.t566_check('… capture_visible_to says no', 'false', public.capture_visible_to(cap, u_a)::text);
  perform pg_temp.t566_check('… the claim from the notes is hidden', 'false', public.claim_visible_to(clm, u_a)::text);
  perform pg_temp.t566_check('… unified_search finds nothing', '0', (select count(*)::text from public.unified_search(w1, 'quokka', array['capture'], 10, u_a) x where x.result_id = cap));
  perform pg_temp.t566_check('… hybrid_search finds nothing', '0', (select count(*)::text from public.hybrid_search(p_workspace_id => w1, p_query => 'quokka', p_types => array['capture'], p_requesting_user_id => u_a) x where x.result_id = cap));
  perform pg_temp.t566_run('… and RLS hides it from them', 'rows=0', u_a, array[format('select 1 from public.captures where id = %L', cap)]);
  insert into public.team_member (team_id, member_id) values (t1, m_a);
  perform pg_temp.t566_check('back on the team: back in', 'false/true', (select notes_owner_out::text || '/' || public.capture_visible_to(cap, u_a)::text from public.captures where id = cap));
  insert into public.captures (user_id, workspace_id, title) values (u_a, w1, 't566 plain capture');
  delete from public.team_member where team_id = t1 and member_id = m_a;
  perform pg_temp.t566_check('a capture of no call is untouched by any of this', 'false/1',
    (select bool_or(notes_owner_out)::text || '/' || count(*)::text from public.captures where user_id = u_a and notes_channel_id is null));
  insert into public.team_member (team_id, member_id) values (t1, m_a);
  perform pg_temp.t566_run('its owner cannot take the conversation off the notes', 'refused', u_a,
    array[format('update public.captures set notes_channel_id = null where id = %L', cap)]);
  perform pg_temp.t566_run('nobody makes a capture that claims to be a call''s notes', 'refused', u_a,
    array[format('insert into public.captures (user_id, workspace_id, title, notes_channel_id) values (%L, %L, %L, %L)', u_a, w1, 't566 fake', ch_open)]);
  perform pg_temp.t566_run('its owner taken off the team: they lose the notes with the conversation', 'rows=0', u_a,
    array[format('delete from public.team_member where team_id = %L and member_id = %L', t1, m_a), format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t566_run('… a capture of no call is untouched by that fence', 'rows=1', u_a,
    array[format('insert into public.captures (user_id, workspace_id, title) values (%L, %L, %L)', u_a, w1, 't566 plain'), 'select 1 from public.captures where title = ''t566 plain'''] );

  -- ── The recordings bucket ─────────────────────────────────────────────────
  insert into storage.objects (bucket_id, name) values
    ('team-call-recordings', ch_team::text || '/' || call_t::text || '/recording/' || rec_t2::text || '.mp4'),
    ('team-call-recordings', ch_team::text || '/' || call_t::text || '/notes/' || row_a::text || '.ogg');
  perform pg_temp.t566_run('the conversation''s reader may read a recording''s object (to be signed for them)', 'rows=1', u_b,
    array[format('select 1 from storage.objects where bucket_id = %L and name like %L', 'team-call-recordings', ch_team::text || '/%/recording/%')]);
  perform pg_temp.t566_run('… never a microphone''s raw notes audio (the server''s alone)', 'rows=0', u_b,
    array[format('select 1 from storage.objects where bucket_id = %L and name like %L', 'team-call-recordings', ch_team::text || '/%/notes/%')]);
  perform pg_temp.t566_run('someone outside the conversation may not', 'rows=0', u_c,
    array[format('select 1 from storage.objects where bucket_id = %L and name like %L', 'team-call-recordings', ch_team::text || '/%')]);
  perform pg_temp.t566_run('no client writes to the bucket', 'refused', u_b,
    array[format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'team-call-recordings', ch_team::text || '/' || call_t::text || '/notes/fake.ogg')]);
  perform pg_temp.t566_run('… nor deletes from it', 'refused', u_b,
    array[format('delete from storage.objects where bucket_id = %L', 'team-call-recordings')]);
  perform pg_temp.t566_check('the bucket is private', 'false', (select public::text from storage.buckets where id = 'team-call-recordings'));

  -- ── A silent call, and the service role's functions ───────────────────────
  perform public.team_call_end(call_o, 'finished', now());
  perform pg_temp.t566_check('a call whose notes were never on: nothing to write', 'none', (select notes_state from public.team_call where id = call_o));
  update public.team_call set notes_state = 'transcribing' where id = call_o;
  perform pg_temp.t566_check('nothing said: settled', 'true', public.team_call_notes_settle(call_o, 'silent')::text);
  perform pg_temp.t566_check('… silent, no capture', 'silent/true',
    (select notes_state || '/' || (capture_id is null)::text from public.team_call where id = call_o));
  perform pg_temp.t566_run('a person cannot read the egresses', 'refused', u_a, array['select 1 from public.team_call_egress']);
  perform pg_temp.t566_run('a person cannot claim a file', 'refused', u_a, array[format('select * from public.team_call_egress_claim(%L, %L, %L)', call_t, m_a, 'TR_z')]);
  perform pg_temp.t566_run('a person cannot write an egress''s state', 'refused', u_a, array[format('select * from public.team_call_egress_event(%L, null, %L, 9, null, null, null, null, null)', row_a, 'failed')]);
  perform pg_temp.t566_run('a person cannot claim a recording past the cap', 'refused', u_a, array[format('select * from public.team_call_recording_begin(%L, %L, 1000)', call_t, m_a)]);
  perform pg_temp.t566_run('a person cannot write notes', 'refused', u_a, array[format('select public.team_call_attach_notes(%L, %L, %L, %L, %L, %L, %L)', call_o, u_a, 'x', 'x', '', '[]', '{}')]);
  perform pg_temp.t566_run('a person cannot settle notes', 'refused', u_a, array[format('select public.team_call_notes_settle(%L, %L)', call_o, 'failed')]);
  perform pg_temp.t566_run('a person cannot stop notes as the server', 'refused', u_a, array[format('select public.team_call_notes_stop(%L)', call_o)]);

  -- A channel deleted: its notes are read by no one, their owner included (the call row goes with
  -- the channel; the capture keeps its conversation's id, which reads as no one's).
  delete from public.team_chat_channel where id = ch_team;
  perform pg_temp.t566_check('a channel deleted: its notes stay, with its id', ch_team::text, (select notes_channel_id::text from public.captures where id = cap));
  perform pg_temp.t566_run('… read by no one, their owner included', 'rows=0', u_a, array[format('select 1 from public.captures where id = %L', cap)]);
  perform pg_temp.t566_check('… not through the definer functions either', 'true/false/false',
    (select notes_owner_out::text || '/' || public.capture_visible_to(cap, u_a)::text || '/' || public.claim_visible_to(clm, u_a)::text from public.captures where id = cap));
  perform pg_temp.t566_check('… and the call''s files are orphans for the retention to remove', 'true',
    (select (count(*) >= 1)::text from public.team_call_recordings_orphans(1000) o where o.name like ch_team::text || '/%'));
  perform pg_temp.t566_run('… nor changed by them (they no longer see it)', 'rows=0', u_a,
    array[format('update public.captures set visibility = %L where id = %L', 'workspace', cap)]);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t566_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '566 team_call_notes: % of % check(s) failed: %', v_fail, (select count(*) from t566_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t566_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '566 team_call_notes: all % checks passed', (select count(*) from t566_results) using detail = v_report;
  end if;
  raise notice '566 team_call_notes: all checks passed';
end
$probe$;

rollback;
