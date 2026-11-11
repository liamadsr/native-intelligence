-- DB-level test for migration 586: the event's kind takes only 'meeting' or
-- 'person'; meeting_revoke_as revokes as the meeting's host only (another
-- member refused), lets a waiting guest go, and a second revoke changes
-- nothing; only the service role runs it. The TS tests
-- (src/lib/meeting-links/__tests__/migration-586.test.ts) pin the file's
-- text; this runs the SQL.
--
-- Run against a database with 572-575 and 586 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/586_meeting_calendar_event.sql
-- Everything runs in one transaction that is rolled back.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000586001';
  u_b constant uuid := '00000000-0000-4000-8000-000000586002';
  w1 uuid;
  m_a uuid;
  mt uuid := gen_random_uuid();
  g1 uuid;
  v_report text;
  v_fail int;
begin
  create temp table t586_results (n serial, label text, expected text, got text, pass boolean) on commit drop;
  create function pg_temp.t586_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t586_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't586-ana@example.invalid', '{"full_name":"t586ana"}'),
    (u_b, 't586-ben@example.invalid', '{"full_name":"t586ben"}');
  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_b, w1, 'member', 't586ben');
  perform public.meeting_create_for(m_a, mt, w1, 'Client review', md5('t586-one') || md5('t586-one-b'), 't586-nonce-aaaaaaaaaaaa', null, null);

  begin
    update public.meeting set calendar_event_kind = 'other' where id = mt;
    perform pg_temp.t586_check('the event''s kind is the meeting''s own or the person''s, nothing else', 'refused', 'stored');
  exception when check_violation then
    perform pg_temp.t586_check('the event''s kind is the meeting''s own or the person''s, nothing else', 'refused', 'refused');
  end;
  update public.meeting set calendar_event_id = 'evt-1', calendar_event_kind = 'person' where id = mt;
  perform pg_temp.t586_check('… person and meeting are', 'person', (select calendar_event_kind from public.meeting where id = mt));

  perform pg_temp.t586_check('a guest waits', 'waiting', (select outcome from public.meeting_guest_request(mt, 'Dana Lee', 't586-key-one-xxxxxxx', 10)));
  select id into g1 from public.meeting_guest where meeting_id = mt;
  begin
    perform public.meeting_revoke_as(mt, u_b);
    perform pg_temp.t586_check('another member can''t revoke it', 'refused', 'revoked');
  exception when insufficient_privilege then
    perform pg_temp.t586_check('another member can''t revoke it', 'refused', 'refused');
  end;
  perform pg_temp.t586_check('its host revokes it (whoever signed in how)', 'true', (select revoked::text from public.meeting_revoke_as(mt, u_a)));
  perform pg_temp.t586_check('… the link off by its host, the waiting guest let go', 'true/true/left',
    (select (revoked_at is not null)::text || '/' || (revoked_by = m_a)::text from public.meeting where id = mt) || '/' || (select state from public.meeting_guest where id = g1));
  perform pg_temp.t586_check('… again: nothing changes', 'false', (select revoked::text from public.meeting_revoke_as(mt, u_a)));
  perform pg_temp.t586_check('only the service role runs it', 'false/false/true',
    has_function_privilege('anon', 'public.meeting_revoke_as(uuid, uuid)', 'execute')::text || '/' ||
    has_function_privilege('authenticated', 'public.meeting_revoke_as(uuid, uuid)', 'execute')::text || '/' ||
    has_function_privilege('service_role', 'public.meeting_revoke_as(uuid, uuid)', 'execute')::text);
  perform pg_temp.t586_check('members never read the event columns', 'false/false/false',
    has_column_privilege('authenticated', 'public.meeting', 'calendar_event_id', 'select')::text || '/' ||
    has_column_privilege('authenticated', 'public.meeting', 'calendar_account_id', 'select')::text || '/' ||
    has_column_privilege('authenticated', 'public.meeting', 'calendar_event_kind', 'select')::text);

  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t586_results;
  if v_fail > 0 then
    raise exception '586 meeting_calendar_event: % of % check(s) failed: %', v_fail, (select count(*) from t586_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t586_results where not pass)
      using detail = v_report;
  end if;
  raise exception '586 meeting_calendar_event: all % checks passed', (select count(*) from t586_results) using detail = v_report;
end
$probe$;

rollback;
