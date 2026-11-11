-- DB-level test for migration 576 (a meeting link as a booked meeting's
-- place): the call_here choice beside availability's video and location, off
-- by default; one meeting per booking (meeting.booking_id); a moved booking
-- moves its meeting's window; a cancelled one revokes its link (a waiting
-- guest let go), once; a booking with no meeting changes nothing; a deleted
-- booking leaves its meeting; only the service role runs the function. The
-- TS tests (src/lib/meeting-links/__tests__/migration-572.test.ts) pin the
-- file's text; this runs the SQL.
--
-- Run against a database with availability's migrations (554, 581, 583) and
-- 572-576 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/576_meeting_links_for_bookings.sql
-- Everything runs in one transaction that is rolled back.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000576001';
  w1 uuid;
  m_a uuid;
  mt uuid := gen_random_uuid();
  mt2 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid();
  b2 uuid := gen_random_uuid();
  d1 text := md5('t576-one') || md5('t576-one-b');
  d2 text := md5('t576-two') || md5('t576-two-b');
  nn text := 't576-nonce-aaaaaaaaaaaa';
  g1 uuid;
  v_report text;
  v_fail int;
begin
  create temp table t576_results (n serial, label text, expected text, got text, pass boolean) on commit drop;
  create function pg_temp.t576_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t576_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  insert into auth.users (id, email, raw_user_meta_data) values (u_a, 't576-ana@example.invalid', '{"full_name":"t576ana"}');
  select workspace_id, id into w1, m_a from public.member where user_id = u_a;

  -- ── The choice ────────────────────────────────────────────────────────────
  perform pg_temp.t576_check('booking links and time offers have call_here, off by default', 'false/false',
    (select string_agg(column_default, '/' order by table_name) from information_schema.columns
      where table_schema = 'public' and column_name = 'call_here' and table_name in ('booking_link', 'time_offer')));

  -- ── One meeting per booking ───────────────────────────────────────────────
  insert into public.meeting_booking (id, workspace_id, host_user_id, host_name, source, guest_name, guest_email, title, starts_at, ends_at, state, manage_token_hash)
  values (b1, w1, u_a, 't576ana', 'offer', 'Dana Lee', 'dana@example.invalid', 'Intro call', now() + interval '1 day', now() + interval '1 day 45 minutes', 'confirmed', md5('t576-manage-1')),
         (b2, w1, u_a, 't576ana', 'offer', 'Lee Ray', 'lee@example.invalid', 'Second call', now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed', md5('t576-manage-2'));
  perform public.meeting_create_for(m_a, mt, w1, 'Intro call', d1, nn, now() + interval '1 day', 45);
  update public.meeting set booking_id = b1 where id = mt;
  perform public.meeting_create_for(m_a, mt2, w1, 'Another', d2, nn, now() + interval '1 day', 45);
  begin
    update public.meeting set booking_id = b1 where id = mt2;
    perform pg_temp.t576_check('a second meeting for the same booking is refused', 'refused', 'made');
  exception when unique_violation then
    perform pg_temp.t576_check('a second meeting for the same booking is refused', 'refused', 'refused');
  end;

  -- ── Moved ─────────────────────────────────────────────────────────────────
  perform pg_temp.t576_check('moved: the booking''s meeting answers', mt::text,
    (select meeting_id::text from public.meeting_booking_changed(b1, now() + interval '3 days', 30, false)));
  perform pg_temp.t576_check('… its window follows (15 minutes before, 2 hours after)', 'true',
    (select (starts_at = now() + interval '3 days' and ends_at = now() + interval '3 days 30 minutes'
             and opens_at = now() + interval '3 days' - interval '15 minutes' and closes_at = now() + interval '3 days 30 minutes' + interval '2 hours')::text
       from public.meeting where id = mt));
  begin
    perform public.meeting_booking_changed(b1, now() + interval '3 days', 900, false);
    perform pg_temp.t576_check('a length a meeting can''t have is refused', 'refused', 'moved');
  exception when others then
    perform pg_temp.t576_check('a length a meeting can''t have is refused', 'refused', 'refused');
  end;
  perform pg_temp.t576_check('a booking with no meeting changes nothing', '0',
    (select count(*)::text from public.meeting_booking_changed(b2, now() + interval '4 days', 30, false)));

  -- ── Cancelled ─────────────────────────────────────────────────────────────
  perform public.meeting_booking_changed(b1, now(), 30, false);
  perform pg_temp.t576_check('moved to now: a guest may ask', 'waiting',
    (select outcome from public.meeting_guest_request(mt, 'Dana Lee', 't576-key-one-xxxxxxx', 10)));
  select id into g1 from public.meeting_guest where meeting_id = mt and name = 'Dana Lee';
  perform pg_temp.t576_check('cancelled: the meeting answers', mt::text,
    (select meeting_id::text from public.meeting_booking_changed(b1, null, null, true)));
  perform pg_temp.t576_check('… its link revoked by its host, the waiting guest let go', 'true/true/left',
    (select (revoked_at is not null)::text || '/' || (revoked_by = m_a)::text from public.meeting where id = mt) || '/' || (select state from public.meeting_guest where id = g1));
  perform pg_temp.t576_check('… a new guest is told it no longer works', 'inactive',
    (select outcome from public.meeting_guest_request(mt, 'Late', 't576-key-two-xxxxxxx', 10)));
  perform pg_temp.t576_check('… cancelling again changes nothing', mt::text,
    (select meeting_id::text from public.meeting_booking_changed(b1, null, null, true)));

  -- ── The booking deleted; who may run it ───────────────────────────────────
  delete from public.meeting_booking where id = b1;
  perform pg_temp.t576_check('a deleted booking leaves its meeting, untied', 'null',
    (select coalesce(booking_id::text, 'null') from public.meeting where id = mt));
  perform pg_temp.t576_check('only the service role runs it', 'false/false/true',
    has_function_privilege('anon', 'public.meeting_booking_changed(uuid, timestamptz, integer, boolean)', 'execute')::text || '/' ||
    has_function_privilege('authenticated', 'public.meeting_booking_changed(uuid, timestamptz, integer, boolean)', 'execute')::text || '/' ||
    has_function_privilege('service_role', 'public.meeting_booking_changed(uuid, timestamptz, integer, boolean)', 'execute')::text);
  perform pg_temp.t576_check('a definer with a pinned search_path', 'true',
    (select (p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public, pg_temp%')::text from pg_proc p where p.proname = 'meeting_booking_changed'));
  perform pg_temp.t576_check('members never read booking_id', 'false', has_column_privilege('authenticated', 'public.meeting', 'booking_id', 'select')::text);

  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t576_results;
  if v_fail > 0 then
    raise exception '576 meeting_links_for_bookings: % of % check(s) failed: %', v_fail, (select count(*) from t576_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t576_results where not pass)
      using detail = v_report;
  end if;
  raise exception '576 meeting_links_for_bookings: all % checks passed', (select count(*) from t576_results) using detail = v_report;
end
$probe$;

rollback;
