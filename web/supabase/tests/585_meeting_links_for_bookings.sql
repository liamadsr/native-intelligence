-- DB-level test for migration 585 (a meeting link as a booked meeting's
-- place) with 573's meeting.booking_id and 574's daily allowance: the
-- call_here choice beside availability's video and location, off by default;
-- a booking's meeting made and tied in one step, a retry finding it, never
-- one for a booking no longer live; booking meetings outside the host's own
-- daily allowance (51 of them, and the host still makes a link); and every
-- writer of a booking's time or state reaching its meeting through the
-- trigger: a plain update and 581's move_meeting_booking move its window; a
-- cancellation revokes its link (a waiting guest let go), a booking put back
-- gets it back, a failure or a deletion revokes it, and a change the meeting
-- can't follow never stops the booking's write. Only the service role runs
-- the functions. The TS tests (src/lib/meeting-links/__tests__/
-- migration-572.test.ts) pin the file's text; this runs the SQL.
--
-- Run against a database with availability's migrations (554, 581, 583) and
-- 572-575 and 585 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/585_meeting_links_for_bookings.sql
-- Everything runs in one transaction that is rolled back.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000585001';
  w1 uuid;
  m_a uuid;
  mt uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid();
  b_dead uuid := gen_random_uuid();
  nn text := 't585-nonce-aaaaaaaaaaaa';
  bk uuid;
  made_n integer := 0;
  r record;
  g1 uuid;
  v_report text;
  v_fail int;
begin
  create temp table t585_results (n serial, label text, expected text, got text, pass boolean) on commit drop;
  create function pg_temp.t585_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t585_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;
  create function pg_temp.t585_as(p_uid uuid, p_sql text)
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
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    return 'refused: ' || sqlerrm;
  end $f$;
  create function pg_temp.t585_booking(p_id uuid, p_ws uuid, p_user uuid, p_state text, p_starts timestamptz, p_minutes integer, p_source text default 'offer')
  returns void language sql as $f$
    insert into public.meeting_booking (id, workspace_id, host_user_id, host_name, source, guest_name, guest_email, title, starts_at, ends_at, state, manage_token_hash)
    values (p_id, p_ws, p_user, 't585ana', p_source, 'Dana Lee', 'dana@example.invalid', 'Intro call', p_starts, p_starts + make_interval(mins => p_minutes), p_state, md5(p_id::text));
  $f$;

  insert into auth.users (id, email, raw_user_meta_data) values (u_a, 't585-ana@example.invalid', '{"full_name":"t585ana"}');
  select workspace_id, id into w1, m_a from public.member where user_id = u_a;

  -- ── The choice ────────────────────────────────────────────────────────────
  perform pg_temp.t585_check('booking links and time offers have call_here, off by default', 'false/false',
    (select string_agg(column_default, '/' order by table_name) from information_schema.columns
      where table_schema = 'public' and column_name = 'call_here' and table_name in ('booking_link', 'time_offer')));

  -- ── Made and tied in one step; a retry finds it ───────────────────────────
  perform pg_temp.t585_booking(b1, w1, u_a, 'confirmed', now() + interval '1 day', 45);
  perform pg_temp.t585_check('the booking''s meeting: made', 'true',
    (select created::text from public.meeting_create_for_booking(b1, mt, md5('t585-one') || md5('t585-one-b'), nn)));
  perform pg_temp.t585_check('… tied to it in the same step, its host the booking''s, its start and length', 'true/true',
    (select (booking_id = b1 and host_member_id = m_a)::text from public.meeting where id = mt) || '/' ||
    (select (starts_at = now() + interval '1 day' and ends_at = now() + interval '1 day 45 minutes' and opens_at = starts_at - interval '15 minutes')::text from public.meeting where id = mt));
  perform pg_temp.t585_check('a retry (another ref, another hash) finds the same meeting, its own nonce, nothing new', mt::text || '/' || nn || '/false/1',
    (select made_id::text || '/' || made_nonce || '/' || created::text from public.meeting_create_for_booking(b1, gen_random_uuid(), md5('t585-x') || md5('t585-x-b'), 't585-nonce-bbbbbbbbbbbb')) || '/' ||
    (select count(*)::text from public.meeting where booking_id = b1));
  perform pg_temp.t585_booking(b_dead, w1, u_a, 'cancelled', now() + interval '1 day', 30);
  begin
    perform public.meeting_create_for_booking(b_dead, gen_random_uuid(), md5('t585-d') || md5('t585-d-b'), nn);
    perform pg_temp.t585_check('a booking no longer live gets none', 'refused', 'made');
  exception when others then
    perform pg_temp.t585_check('a booking no longer live gets none', 'refused', 'refused');
  end;
  -- Only a customer's job may run longer than 8 hours (581's meeting_booking_times).
  bk := gen_random_uuid();
  perform pg_temp.t585_booking(bk, w1, u_a, 'confirmed', now() + interval '1 day', 600, 'customer');
  perform pg_temp.t585_check('one longer than a meeting may be: nothing (the provider''s link stays)', '0',
    (select count(*)::text from public.meeting_create_for_booking(bk, gen_random_uuid(), md5('t585-l') || md5('t585-l-b'), nn)));
  -- A change the meeting can't follow never stops the booking's write.
  bk := gen_random_uuid();
  perform pg_temp.t585_booking(bk, w1, u_a, 'confirmed', now() + interval '1 day', 60, 'customer');
  perform public.meeting_create_for_booking(bk, gen_random_uuid(), md5('t585-c') || md5('t585-c-b'), nn);
  update public.meeting_booking set ends_at = starts_at + interval '9 hours' where id = bk;
  perform pg_temp.t585_check('a length the meeting can''t take: the booking''s write stands, the meeting stays', '540/60',
    (select (extract(epoch from ends_at - starts_at) / 60)::integer::text from public.meeting_booking where id = bk) || '/' ||
    (select (extract(epoch from ends_at - starts_at) / 60)::integer::text from public.meeting where booking_id = bk));

  -- ── Outside the host's own daily allowance ────────────────────────────────
  for i in 1..51 loop
    bk := gen_random_uuid();
    perform pg_temp.t585_booking(bk, w1, u_a, 'confirmed', now() + make_interval(days => 2, hours => i), 30);
    select * into r from public.meeting_create_for_booking(bk, gen_random_uuid(), md5('t585-cap-' || i) || md5('t585-cap-b-' || i), nn);
    if r.created then
      made_n := made_n + 1;
    end if;
  end loop;
  perform pg_temp.t585_check('51 booked meetings in a day all get their link', '51', made_n::text);
  perform pg_temp.t585_check('… and the host still makes a link of their own', 'made',
    case when pg_temp.t585_as(u_a, format('select channel_id::text from public.meeting_create(%L, %L, %L, %L, %L, null, null)', gen_random_uuid(), w1, 'My own', md5('t585-own') || md5('t585-own-b'), nn)) like 'refused%' then 'refused' else 'made' end);

  -- ── Every writer reaches the meeting (the trigger) ────────────────────────
  update public.meeting_booking set starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 30 minutes' where id = b1;
  perform pg_temp.t585_check('a plain update of the time moves the meeting''s window', 'true',
    (select (starts_at = now() + interval '3 days' and ends_at = now() + interval '3 days 30 minutes' and closes_at = ends_at + interval '2 hours')::text from public.meeting where id = mt));
  perform pg_temp.t585_check('581''s move_meeting_booking (the customers'' tools): moved', 'moved',
    (select public.move_meeting_booking(b1, now() + interval '3 days', now() + interval '4 days', now() + interval '4 days 30 minutes', null) ->> 'status'));
  perform pg_temp.t585_check('… and the meeting with it', 'true',
    (select (starts_at = now() + interval '4 days' and ends_at = now() + interval '4 days 30 minutes')::text from public.meeting where id = mt));
  update public.meeting_booking set starts_at = now() + interval '5 minutes', ends_at = now() + interval '35 minutes' where id = b1;
  perform pg_temp.t585_check('moved to now: a guest may ask', 'waiting',
    (select outcome from public.meeting_guest_request(mt, 'Dana Lee', 't585-key-one-xxxxxxx', 10)));
  select id into g1 from public.meeting_guest where meeting_id = mt and name = 'Dana Lee';
  update public.meeting_booking set state = 'cancelled', cancelled_at = now(), cancelled_by = 'host' where id = b1;
  perform pg_temp.t585_check('cancelled: its link revoked by its host, the waiting guest let go', 'true/true/left',
    (select (revoked_at is not null)::text || '/' || (revoked_by = m_a)::text from public.meeting where id = mt) || '/' || (select state from public.meeting_guest where id = g1));
  perform pg_temp.t585_check('… a new guest is told it no longer works', 'inactive',
    (select outcome from public.meeting_guest_request(mt, 'Late', 't585-key-two-xxxxxxx', 10)));
  update public.meeting_booking set state = 'confirmed', cancelled_at = null, cancelled_by = null where id = b1;
  perform pg_temp.t585_check('put back (a cancellation the calendar refused): the link works again', 'true/waiting',
    (select (revoked_at is null)::text from public.meeting where id = mt) || '/' ||
    (select outcome from public.meeting_guest_request(mt, 'Again', 't585-key-three-xxxxx', 10)));
  update public.meeting_booking set state = 'failed' where id = b1;
  perform pg_temp.t585_check('a failed booking revokes it too', 'true', (select (revoked_at is not null)::text from public.meeting where id = mt));
  update public.meeting_booking set state = 'confirmed' where id = b1;
  delete from public.meeting_booking where id = b1;
  perform pg_temp.t585_check('a deleted booking: its link revoked, its meeting untied', 'true/null',
    (select (revoked_at is not null)::text || '/' || coalesce(booking_id::text, 'null') from public.meeting where id = mt));

  -- ── Who may run them ──────────────────────────────────────────────────────
  perform pg_temp.t585_check('only the service role makes a booking''s meeting', 'false/false/true',
    has_function_privilege('anon', 'public.meeting_create_for_booking(uuid, uuid, text, text)', 'execute')::text || '/' ||
    has_function_privilege('authenticated', 'public.meeting_create_for_booking(uuid, uuid, text, text)', 'execute')::text || '/' ||
    has_function_privilege('service_role', 'public.meeting_create_for_booking(uuid, uuid, text, text)', 'execute')::text);
  perform pg_temp.t585_check('… and runs the worker', 'false/false/true',
    has_function_privilege('anon', 'public.meeting_booking_changed(uuid, timestamptz, integer, boolean)', 'execute')::text || '/' ||
    has_function_privilege('authenticated', 'public.meeting_booking_changed(uuid, timestamptz, integer, boolean)', 'execute')::text || '/' ||
    has_function_privilege('service_role', 'public.meeting_booking_changed(uuid, timestamptz, integer, boolean)', 'execute')::text);
  perform pg_temp.t585_check('each a definer with a pinned search_path', '3',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('meeting_create_for_booking', 'meeting_booking_changed', 'meeting_booking_follow')
        and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public, pg_temp%'));
  perform pg_temp.t585_check('members never read booking_id', 'false', has_column_privilege('authenticated', 'public.meeting', 'booking_id', 'select')::text);

  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t585_results;
  if v_fail > 0 then
    raise exception '585 meeting_links_for_bookings: % of % check(s) failed: %', v_fail, (select count(*) from t585_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t585_results where not pass)
      using detail = v_report;
  end if;
  raise exception '585 meeting_links_for_bookings: all % checks passed', (select count(*) from t585_results) using detail = v_report;
end
$probe$;

rollback;
