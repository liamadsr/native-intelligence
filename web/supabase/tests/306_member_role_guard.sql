-- DB-level test for migration 306 (member_role_guard): who may write
-- public.member, as the real policies and trigger decide it. The TS tests pin
-- the file's text; this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/306_member_role_guard.sql
-- Prints one PASS/FAIL line per probe and "306 member_role_guard: all checks
-- passed". Everything runs in one transaction that is rolled back: six
-- throwaway auth users (the signup trigger gives each a workspace), their
-- memberships and every probe's writes. A failed check raises and aborts.
--
-- Each probe runs as a caller (an authenticated user's JWT claims, anon, the
-- service role, or no request at all) inside its own block that always rolls
-- back, so one probe never sees another's writes.

begin;

do $probe$
declare
  -- Throwaway users. handle_new_user (092) names each one's workspace from
  -- full_name, and workspace.slug must be unique, so the names differ.
  u_o constant uuid := '00000000-0000-4000-8000-000000306001'; -- owner of W1
  u_a constant uuid := '00000000-0000-4000-8000-000000306002'; -- admin in W1
  u_m constant uuid := '00000000-0000-4000-8000-000000306003'; -- member in W1
  u_g constant uuid := '00000000-0000-4000-8000-000000306004'; -- guest in W1
  u_x constant uuid := '00000000-0000-4000-8000-000000306005'; -- outsider, owner of W2
  u_j constant uuid := '00000000-0000-4000-8000-000000306006'; -- joins W1 by invite
  w1 uuid; w2 uuid; w3 uuid;
  m_o uuid; m_a uuid; m_m uuid; m_g uuid;
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP); false: raise only when a check fails.
  v_raise_report constant boolean := false;
begin
  -- @@MIGRATION@@

  create temp table t306_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller, then p_check as postgres, inside a block that
  -- always rolls back. Returns 'rows=N[ | check=...]' or 'refused [SQLSTATE] message'.
  create function pg_temp.t306_probe(p_role text, p_uid uuid, p_sqls text[], p_check text)
  returns text language plpgsql as $f$
  declare
    n bigint := 0;
    s text;
    v_check text;
  begin
    begin
      perform set_config('request.jwt.claims', case p_role
        when 'none' then ''
        when 'service_role' then json_build_object('role', 'service_role')::text
        else json_build_object('sub', p_uid, 'role', p_role)::text
      end, true);
      if p_role <> 'none' then
        perform set_config('role', p_role, true);
      end if;
      foreach s in array p_sqls loop
        execute s;
        get diagnostics n = row_count;
      end loop;
      if p_check is not null then
        perform set_config('role', 'postgres', true);
        perform set_config('request.jwt.claims', '', true);
        execute p_check into v_check;
      end if;
      raise exception using errcode = 'ZP306', message = 'rows=' || n || coalesce(' | check=' || v_check, '');
    exception
      when sqlstate 'ZP306' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t306_run(p_label text, p_expect text, p_role text, p_uid uuid, p_sqls text[], p_check text default null)
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t306_probe(p_role, p_uid, p_sqls, p_check);
  begin
    insert into t306_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_o, 't306-owner@example.invalid',    '{"full_name":"t306owner"}'),
    (u_a, 't306-admin@example.invalid',    '{"full_name":"t306admin"}'),
    (u_m, 't306-member@example.invalid',   '{"full_name":"t306member"}'),
    (u_g, 't306-guest@example.invalid',    '{"full_name":"t306guest"}'),
    (u_x, 't306-outsider@example.invalid', '{"full_name":"t306outsider"}'),
    (u_j, 't306-joiner@example.invalid',   '{"full_name":"t306joiner"}');

  select workspace_id, id into w1, m_o from public.member where user_id = u_o;
  select workspace_id into w2 from public.member where user_id = u_x;

  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_a, w1, 'admin', 't306admin'),
    (u_m, w1, 'member', 't306member'),
    (u_g, w1, 'guest', 't306guest');
  select id into m_a from public.member where user_id = u_a and workspace_id = w1;
  select id into m_m from public.member where user_id = u_m and workspace_id = w1;
  select id into m_g from public.member where user_id = u_g and workspace_id = w1;

  -- W3: a second workspace the owner of W1 also owns.
  insert into public.workspace (name, slug) values ('t306 second', 't306-second-306') returning id into w3;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_o, w3, 'owner', 't306owner');

  -- ── The signup trigger still makes each new user an owner ─────────────────
  perform pg_temp.t306_run('signup trigger: owner row, default-team lead, contact', 'rows=0 | check=owner lead contact',
    'none', null, '{}'::text[],
    format($c$select concat_ws(' ',
      (select 'owner' from public.member where id = %1$L and role = 'owner'),
      (select 'lead' from public.team_member where member_id = %1$L and team_role = 'lead'),
      (select 'contact' from public.contact where member_id = %1$L limit 1))$c$, m_o));

  -- ── Must be refused ───────────────────────────────────────────────────────
  perform pg_temp.t306_run('member raises own role to owner', 'refused', 'authenticated', u_m,
    array[format('update public.member set role = %L where id = %L', 'owner', m_m)]);
  perform pg_temp.t306_run('member raises own role to admin', 'refused', 'authenticated', u_m,
    array[format('update public.member set role = %L where id = %L', 'admin', m_m)]);
  perform pg_temp.t306_run('admin raises own role to owner', 'refused', 'authenticated', u_a,
    array[format('update public.member set role = %L where id = %L', 'owner', m_a)]);
  perform pg_temp.t306_run('guest raises own role to member', 'refused', 'authenticated', u_g,
    array[format('update public.member set role = %L where id = %L', 'member', m_g)]);
  perform pg_temp.t306_run('admin lowers own role (the app never does)', 'refused', 'authenticated', u_a,
    array[format('update public.member set role = %L where id = %L', 'member', m_a)]);
  perform pg_temp.t306_run('outsider adds self to W1 as owner', 'refused', 'authenticated', u_x,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_x, w1, 'owner', 'x')]);
  perform pg_temp.t306_run('outsider adds self to W1 as admin', 'refused', 'authenticated', u_x,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_x, w1, 'admin', 'x')]);
  perform pg_temp.t306_run('outsider adds self to W1 as member', 'refused', 'authenticated', u_x,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_x, w1, 'member', 'x')]);
  perform pg_temp.t306_run('outsider adds self to W1 as guest', 'refused', 'authenticated', u_x,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_x, w1, 'guest', 'x')]);
  perform pg_temp.t306_run('member moves own row to another workspace', 'refused', 'authenticated', u_m,
    array[format('update public.member set workspace_id = %L where id = %L', w2, m_m)]);
  perform pg_temp.t306_run('member changes own user_id', 'refused', 'authenticated', u_m,
    array[format('update public.member set user_id = %L where id = %L', u_x, m_m)]);
  perform pg_temp.t306_run('admin gives a member row another user_id', 'refused', 'authenticated', u_a,
    array[format('update public.member set user_id = %L where id = %L', u_x, m_m)]);
  perform pg_temp.t306_run('admin makes a member owner', 'refused', 'authenticated', u_a,
    array[format('update public.member set role = %L where id = %L', 'owner', m_m)]);
  perform pg_temp.t306_run('admin changes the owner''s role', 'refused', 'authenticated', u_a,
    array[format('update public.member set role = %L where id = %L', 'member', m_o)]);
  perform pg_temp.t306_run('admin inserts an owner row', 'refused', 'authenticated', u_a,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_j, w1, 'owner', 'j')]);
  perform pg_temp.t306_run('owner inserts a member row (client)', 'refused', 'authenticated', u_o,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_j, w1, 'member', 'j')]);
  perform pg_temp.t306_run('owner moves a member to another workspace it owns', 'refused', 'authenticated', u_o,
    array[format('update public.member set workspace_id = %L where id = %L', w3, m_m)]);
  perform pg_temp.t306_run('last owner steps down', 'refused', 'authenticated', u_o,
    array[format('update public.member set role = %L where id = %L', 'admin', m_o)]);
  perform pg_temp.t306_run('member changes another member''s role (no row)', 'rows=0', 'authenticated', u_m,
    array[format('update public.member set role = %L where id = %L', 'guest', m_g)]);
  perform pg_temp.t306_run('anon changes a role (no row)', 'rows=0', 'anon', null,
    array[format('update public.member set role = %L where workspace_id = %L', 'owner', w1)]);
  perform pg_temp.t306_run('anon inserts a member row', 'refused', 'anon', null,
    array[format('insert into public.member (user_id, workspace_id, role, display_name) values (%L, %L, %L, %L)', u_j, w1, 'member', 'j')]);

  -- ── Must still work ───────────────────────────────────────────────────────
  perform pg_temp.t306_run('owner sets a member to admin, guest, member', 'rows=1 | check=member', 'authenticated', u_o,
    array[format('update public.member set role = %L where id = %L', 'admin', m_m),
          format('update public.member set role = %L where id = %L', 'guest', m_m),
          format('update public.member set role = %L where id = %L', 'member', m_m)],
    format('select role from public.member where id = %L', m_m));
  perform pg_temp.t306_run('admin moves a member to guest', 'rows=1', 'authenticated', u_a,
    array[format('update public.member set role = %L where id = %L', 'guest', m_m)]);
  perform pg_temp.t306_run('admin promotes a guest to admin', 'rows=1', 'authenticated', u_a,
    array[format('update public.member set role = %L where id = %L', 'admin', m_g)]);
  perform pg_temp.t306_run('transfer-owner: promote target, then step down', 'rows=1 | check=admin/owner', 'authenticated', u_o,
    array[format('update public.member set role = %L where id = %L and workspace_id = %L', 'owner', m_m, w1),
          format('update public.member set role = %L where id = %L and workspace_id = %L', 'admin', m_o, w1)],
    format('select (select role from public.member where id = %L) || %L || (select role from public.member where id = %L)', m_o, '/', m_m));
  perform pg_temp.t306_run('member stamps onboarding_completed_at', 'rows=1', 'authenticated', u_m,
    array[format('update public.member set onboarding_completed_at = now() where user_id = %L and workspace_id = %L', u_m, w1)]);
  perform pg_temp.t306_run('member writes onboarding_progress (home pointer)', 'rows=1 | check=t306', 'authenticated', u_m,
    array[format($s$update public.member set onboarding_progress = onboarding_progress || '{"conversation":{"homeConversationId":"t306"}}' where user_id = %L and workspace_id = %L$s$, u_m, w1)],
    format($s$select onboarding_progress -> 'conversation' ->> 'homeConversationId' from public.member where id = %L$s$, m_m));
  perform pg_temp.t306_run('member merge_onboarding_progress RPC', 'rows=1 | check=true', 'authenticated', u_m,
    array[format($s$select public.merge_onboarding_progress(%L, '{"tutorial":{"t306":true}}'::jsonb, %L)$s$, w1, u_m)],
    format($s$select onboarding_progress -> 'tutorial' ->> 't306' from public.member where id = %L$s$, m_m));
  perform pg_temp.t306_run('member onboarding reset (dev route shape)', 'rows=1', 'authenticated', u_m,
    array[format($s$update public.member set onboarding_completed_at = null, onboarding_progress = '{"tutorial":{"detection_suppressed_at":"2026-10-07T00:00:00Z"}}' where user_id = %L and workspace_id = %L$s$, u_m, w1)]);
  perform pg_temp.t306_run('member edits own display_name and avatar_url', 'rows=1', 'authenticated', u_m,
    array[format('update public.member set display_name = %L, avatar_url = %L where id = %L', 't306 renamed', 'https://example.invalid/a.png', m_m)]);
  perform pg_temp.t306_run('member re-saves own row with the same role', 'rows=1', 'authenticated', u_m,
    array[format('update public.member set role = %L, display_name = %L where id = %L', 'member', 't306member', m_m)]);
  perform pg_temp.t306_run('owner edits own display_name', 'rows=1', 'authenticated', u_o,
    array[format('update public.member set display_name = %L where id = %L', 't306 owner renamed', m_o)]);
  perform pg_temp.t306_run('admin edits own display_name', 'rows=1', 'authenticated', u_a,
    array[format('update public.member set display_name = %L where id = %L', 't306 admin renamed', m_a)]);
  perform pg_temp.t306_run('service role: create workspace + owner row (AFTER INSERT triggers)', 'rows=1 | check=lead=1 prefs=yes', 'service_role', null,
    array[$s$insert into public.workspace (name, slug) values ('t306 created', 't306-created-306')$s$,
          format($s$insert into public.member (user_id, workspace_id, role, display_name, onboarding_completed_at) select %L, id, 'owner', 't306owner', now() from public.workspace where slug = 't306-created-306'$s$, u_o)],
    $s$select format('lead=%s prefs=%s',
      (select count(*) from public.team_member tm join public.member m on m.id = tm.member_id join public.workspace w on w.id = m.workspace_id where w.slug = 't306-created-306' and tm.team_role = 'lead'),
      (select case when count(*) > 0 then 'yes' else 'no' end from public.notification_preference np join public.member m on m.id = np.member_id join public.workspace w on w.id = m.workspace_id where w.slug = 't306-created-306'))$s$);
  perform pg_temp.t306_run('service role: invite accept (admin row, AFTER INSERT triggers)', 'rows=1 | check=lead=0 prefs=yes', 'service_role', null,
    array[format($s$insert into public.member (user_id, workspace_id, role, display_name, onboarding_completed_at) values (%L, %L, 'admin', 't306joiner', now())$s$, u_j, w1)],
    format($s$select format('lead=%%s prefs=%%s',
      (select count(*) from public.team_member tm join public.member m on m.id = tm.member_id where m.user_id = %1$L and m.workspace_id = %2$L),
      (select case when count(*) > 0 then 'yes' else 'no' end from public.notification_preference np join public.member m on m.id = np.member_id where m.user_id = %1$L and m.workspace_id = %2$L))$s$, u_j, w1));
  perform pg_temp.t306_run('service role changes a role', 'rows=1', 'service_role', null,
    array[format('update public.member set role = %L where id = %L', 'admin', m_m)]);
  perform pg_temp.t306_run('service role renames a user on every row (profile)', 'rows=2', 'service_role', null,
    array[format('update public.member set display_name = %L where user_id = %L', 't306 renamed', u_m)]);
  perform pg_temp.t306_run('no request context changes a role', 'rows=1', 'none', null,
    array[format('update public.member set role = %L where id = %L', 'guest', m_m)]);

  -- ── Deletes, unchanged ────────────────────────────────────────────────────
  perform pg_temp.t306_run('owner removes a member', 'rows=1', 'authenticated', u_o,
    array[format('delete from public.member where id = %L', m_g)]);
  perform pg_temp.t306_run('admin removes a member (owner-only policy)', 'rows=0', 'authenticated', u_a,
    array[format('delete from public.member where id = %L', m_g)]);
  perform pg_temp.t306_run('member deletes own row (owner-only policy)', 'rows=0', 'authenticated', u_m,
    array[format('delete from public.member where id = %L', m_m)]);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s  %s | expect %s | got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), E'\n' order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
  from t306_results;

  if v_raise_report then
    raise exception using errcode = 'ZP399', message = format(E'306 member_role_guard: %s failed\n%s', v_fail, v_report);
  end if;
  if v_fail > 0 then
    raise exception E'306 member_role_guard: % check(s) failed\n%', v_fail, v_report;
  end if;
  raise notice E'%\n306 member_role_guard: all checks passed', v_report;
end
$probe$;

rollback;
