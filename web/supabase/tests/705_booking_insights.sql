-- DB-level test for migration 705 (booking insights). A booking's attendance
-- is marked only on a confirmed booking that has started; its three columns
-- move together; a booking that leaves 'confirmed' drops its mark. A link's
-- form rule needs its form, goes when the form goes (deleted, or taken away),
-- names a field and a known op, and the form is the link's own workspace's;
-- a business's job link takes no form. A form row books once. Neither table is readable or
-- writable by anon or authenticated. The TS tests
-- (src/lib/booking-links/__tests__/migration-705.test.ts) pin the file's
-- text; this runs the SQL.
--
-- Run against a database with 705 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/705_booking_insights.sql
-- Everything runs in one transaction that is rolled back.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000705001';
  w1 uuid;
  t1 uuid;
  f1 uuid;
  l1 uuid;
  l_job uuid;
  b_past uuid := gen_random_uuid();
  b_future uuid := gen_random_uuid();
  v_got text;
  w2 uuid;
  t2 uuid;
  f_other uuid;
  row1 uuid := gen_random_uuid();
  v_report text;
  v_fail int;
begin
  create temp table t705_results (n serial, label text, expected text, got text, pass boolean) on commit drop;
  create function pg_temp.t705_check(p_label text, p_expect text, p_got text)
  returns void language plpgsql as $f$
  begin
    insert into t705_results (label, expected, got, pass) values (p_label, p_expect, coalesce(p_got, '<null>'), coalesce(p_got, '<null>') = p_expect);
  end $f$;

  insert into auth.users (id, email, raw_user_meta_data) values (u_a, 't705-ava@example.invalid', '{"full_name":"t705ava"}');
  select workspace_id into w1 from public.member where user_id = u_a limit 1;
  if w1 is null then
    insert into public.workspace (name) values ('t705 studio') returning id into w1;
    insert into public.member (user_id, workspace_id, role, display_name) values (u_a, w1, 'owner', 't705ava');
  end if;

  insert into public.data_table (workspace_id, name) values (w1, 't705 leads') returning id into t1;
  insert into public.data_form (workspace_id, table_id, name, key_hash, key_prefix) values (w1, t1, 't705 form', md5('t705-key'), 'fk_t705') returning id into f1;
  insert into public.booking_link (workspace_id, owner_user_id, slug, title) values (w1, u_a, 't705-intro', 'Intro') returning id into l1;

  insert into public.meeting_booking (id, workspace_id, host_user_id, host_name, source, link_id, guest_name, title, starts_at, ends_at, state, manage_token_hash)
  values
    (b_past, w1, u_a, 'Ava', 'link', l1, 'Dana', 'Intro', now() - interval '2 hours', now() - interval '90 minutes', 'confirmed', md5('t705-past')),
    (b_future, w1, u_a, 'Ava', 'link', l1, 'Eli', 'Intro', now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed', md5('t705-future'));

  -- 1. A started, confirmed booking takes a mark; clearing it clears its stamp.
  update public.meeting_booking set attendance = 'no_show', attendance_marked_at = now(), attendance_marked_by = u_a where id = b_past;
  select attendance into v_got from public.meeting_booking where id = b_past;
  perform pg_temp.t705_check('a started booking is marked', 'no_show', v_got);
  update public.meeting_booking set attendance = null where id = b_past;
  select coalesce(attendance, '') || '|' || coalesce(attendance_marked_at::text, '') || '|' || coalesce(attendance_marked_by::text, '') into v_got from public.meeting_booking where id = b_past;
  perform pg_temp.t705_check('clearing it clears its stamp', '||', v_got);

  -- 2. One not yet started is refused.
  begin
    update public.meeting_booking set attendance = 'attended', attendance_marked_at = now() where id = b_future;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('a booking not yet started is not marked', 'refused', v_got);

  -- 3. A mark without its stamp, or a word it doesn't know, is refused.
  begin
    update public.meeting_booking set attendance = 'attended', attendance_marked_at = null where id = b_past;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('a mark needs its stamp', 'refused', v_got);
  begin
    update public.meeting_booking set attendance = 'late', attendance_marked_at = now() where id = b_past;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('only attended or no_show', 'refused', v_got);

  -- 4. A marked booking that leaves confirmed drops its mark.
  update public.meeting_booking set attendance = 'attended', attendance_marked_at = now(), attendance_marked_by = u_a where id = b_past;
  update public.meeting_booking set state = 'cancelled' where id = b_past;
  select coalesce(attendance, '<none>') into v_got from public.meeting_booking where id = b_past;
  perform pg_temp.t705_check('leaving confirmed drops the mark', '<none>', v_got);

  -- 5. A rule needs its form; taking the form away takes its rule; deleting the form does too.
  begin
    update public.booking_link set form_rule = '{"all":[]}'::jsonb where id = l1;
    select coalesce(form_rule::text, '<null>') into v_got from public.booking_link where id = l1;
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('a rule without a form is dropped', '<null>', v_got);
  update public.booking_link set form_id = f1, form_rule = '{"all":[{"field":"budget","op":"gte","value":1000}]}'::jsonb, form_refusal = 'Teams only.' where id = l1;
  select jsonb_array_length(form_rule->'all')::text into v_got from public.booking_link where id = l1;
  perform pg_temp.t705_check('a form and its rule are kept', '1', v_got);
  delete from public.data_form where id = f1;
  select coalesce(form_id::text, '<null>') || '|' || coalesce(form_rule::text, '<null>') into v_got from public.booking_link where id = l1;
  perform pg_temp.t705_check('a deleted form takes its rule', '<null>|<null>', v_got);

  -- 6. Shapes: a rule of more than five, a refusal past 500, dated changes not an object, a job link with a form.
  insert into public.data_form (workspace_id, table_id, name, key_hash, key_prefix) values (w1, t1, 't705 form 2', md5('t705-key-2'), 'fk_t705b') returning id into f1;
  begin
    update public.booking_link set form_id = f1, form_rule = jsonb_build_object('all', jsonb_build_array(1, 2, 3, 4, 5, 6)) where id = l1;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('at most five conditions', 'refused', v_got);
  begin
    update public.booking_link set form_id = f1, form_refusal = repeat('x', 501) where id = l1;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('a refusal is at most 500', 'refused', v_got);
  begin
    update public.booking_link set date_overrides = '[]'::jsonb where id = l1;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('dated changes are an object', 'refused', v_got);
  update public.booking_link set date_overrides = '{"2031-01-07":[]}'::jsonb where id = l1;
  perform pg_temp.t705_check('dated changes are kept', '1', (select count(*)::text from jsonb_object_keys((select date_overrides from public.booking_link where id = l1))));
  begin
    insert into public.booking_link (workspace_id, owner_user_id, slug, title, purpose, form_id) values (w1, u_a, 't705-job', 'Pickup', 'job', f1) returning id into l_job;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('a job link takes no form', 'refused', v_got);

  -- 7. A link's form is its own workspace's; a rule names a field and a known op.
  insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-4000-8000-000000705002', 't705-ben@example.invalid', '{"full_name":"t705ben"}');
  select workspace_id into w2 from public.member where user_id = '00000000-0000-4000-8000-000000705002' limit 1;
  insert into public.data_table (workspace_id, name) values (w2, 't705 their leads') returning id into t2;
  insert into public.data_form (workspace_id, table_id, name, key_hash, key_prefix) values (w2, t2, 't705 their form', md5('t705-key-3'), 'fk_t705c') returning id into f_other;
  begin
    update public.booking_link set form_id = f_other, form_rule = null, form_refusal = null where id = l1;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('another workspace''s form is refused', 'refused', v_got);
  begin
    update public.booking_link set form_id = f1, form_rule = '{"all":[{"field":"budget","op":"regex","value":".*"}]}'::jsonb, form_refusal = null where id = l1;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('an unknown op is refused', 'refused', v_got);
  begin
    update public.booking_link set form_id = f1, form_rule = '{"all":[{"op":"equals","value":"x"}]}'::jsonb, form_refusal = null where id = l1;
    v_got := 'allowed';
  exception when check_violation then v_got := 'refused';
  end;
  perform pg_temp.t705_check('a condition names its field', 'refused', v_got);
  update public.booking_link set form_id = f1, form_rule = '{"all":[{"field":"budget","op":"gte","value":1000},{"field":"agree","op":"is_true"}]}'::jsonb, form_refusal = null where id = l1;
  perform pg_temp.t705_check('known ops are kept', '2', (select jsonb_array_length(form_rule->'all')::text from public.booking_link where id = l1));

  -- 8. A form row books once: the second booking on it is refused whole (book_meeting answers exists; nothing of it stays).
  v_got := public.book_meeting(
    jsonb_build_object('id', gen_random_uuid(), 'workspace_id', w1, 'host_user_id', u_a, 'host_name', 'Ava', 'source', 'link', 'link_id', l1, 'guest_name', 'Fay', 'title', 'Intro',
      'starts_at', now() + interval '3 days', 'ends_at', now() + interval '3 days 30 minutes', 'state', 'booking', 'manage_token_hash', md5('t705-pass-1'), 'form_row_id', row1),
    array[u_a], null)->>'status';
  perform pg_temp.t705_check('the first booking on a form row', 'booked', v_got);
  perform pg_temp.t705_check('it carries the row', '1', (select count(*)::text from public.meeting_booking where form_row_id = row1));
  v_got := public.book_meeting(
    jsonb_build_object('id', gen_random_uuid(), 'workspace_id', w1, 'host_user_id', u_a, 'host_name', 'Ava', 'source', 'link', 'link_id', l1, 'guest_name', 'Fay', 'title', 'Intro',
      'starts_at', now() + interval '4 days', 'ends_at', now() + interval '4 days 30 minutes', 'state', 'booking', 'manage_token_hash', md5('t705-pass-2'), 'form_row_id', row1),
    array[u_a], null)->>'status';
  perform pg_temp.t705_check('a second booking on the same row is refused', 'exists', v_got);
  perform pg_temp.t705_check('and nothing of it stays', '1|1', (select count(*)::text from public.meeting_booking where form_row_id = row1) || '|' || (select count(*)::text from public.host_time_claim c join public.meeting_booking b on b.id = c.booking_id where b.form_row_id = row1));
  perform pg_temp.t705_check('write_meeting_booking is the service role''s alone', 'false|false|true',
    has_function_privilege('anon', 'public.write_meeting_booking(jsonb, uuid[], timestamptz)', 'execute')::text || '|' ||
    has_function_privilege('authenticated', 'public.write_meeting_booking(jsonb, uuid[], timestamptz)', 'execute')::text || '|' ||
    has_function_privilege('service_role', 'public.write_meeting_booking(jsonb, uuid[], timestamptz)', 'execute')::text);

  -- 9. Neither table is the client's: no right for anon or authenticated.
  perform pg_temp.t705_check('authenticated may not read bookings', 'false', has_table_privilege('authenticated', 'public.meeting_booking', 'select')::text);
  perform pg_temp.t705_check('authenticated may not change bookings', 'false', has_table_privilege('authenticated', 'public.meeting_booking', 'update')::text);
  perform pg_temp.t705_check('anon may not read links', 'false', has_table_privilege('anon', 'public.booking_link', 'select')::text);
  perform pg_temp.t705_check('authenticated may not change links', 'false', has_table_privilege('authenticated', 'public.booking_link', 'update')::text);
  perform pg_temp.t705_check('row security stays on (bookings)', 'true', (select relrowsecurity::text from pg_class where oid = 'public.meeting_booking'::regclass));
  perform pg_temp.t705_check('row security stays on (links)', 'true', (select relrowsecurity::text from pg_class where oid = 'public.booking_link'::regclass));

  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'ok  ' else 'FAIL' end, label, expected, got), E'\n' order by n), count(*) filter (where not pass)
    into v_report, v_fail from t705_results;
  raise notice E'705 booking insights\n%', v_report;
  if v_fail > 0 then
    raise exception '705: % check(s) failed', v_fail;
  end if;
end
$probe$;

rollback;
