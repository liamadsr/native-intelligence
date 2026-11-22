-- DB-level test for migration 681 (comment_author_guard): a comment is its
-- author's to change; anyone who can see it resolves it. The TS test pins
-- the file's text; this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/681_comment_guard.sql
-- Prints "681 comment_guard: all checks passed". Everything runs in one
-- transaction that is rolled back, and every attempt below runs in its own
-- subtransaction that is rolled back too, so each starts from the same rows.
-- Made-up people only (example.test). A failed check raises and aborts.
--
-- People: Alice writes the comments; Bob is a member, Dana an admin of the
-- same workspace; Carol is an outside commenter (author_user_id, 088); Eve
-- belongs to another workspace. A company is seen by its workspace's owners
-- and admins (679), so the company cases ask Dana.

begin;

-- Runs p_sql as p_user ('authenticated'), or as the service role when p_user
-- is null, inside a subtransaction that is always rolled back. Returns
-- 'rows=<n>' or 'refused:<sqlstate>'.
create or replace function pg_temp.attempt(p_user uuid, p_sql text) returns text language plpgsql as $f$
declare
  n int;
begin
  begin
    if p_user is null then
      perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
      execute 'set local role service_role';
    else
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
    end if;
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'P0681', message = 'rows=' || n;
  exception when others then
    if sqlstate = 'P0681' then
      return sqlerrm;
    end if;
    return 'refused:' || sqlstate;
  end;
end $f$;

create or replace function pg_temp.expect(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL: % (got %, want %)', p_label, p_got, p_want;
  end if;
end $f$;

do $probe$
declare
  u_alice constant uuid := '00000000-0000-4000-8000-000000681001';
  u_bob   constant uuid := '00000000-0000-4000-8000-000000681002';
  u_carol constant uuid := '00000000-0000-4000-8000-000000681003';
  u_dana  constant uuid := '00000000-0000-4000-8000-000000681004';
  u_eve   constant uuid := '00000000-0000-4000-8000-000000681005';
  ws uuid; ws2 uuid;
  m_alice uuid; m_bob uuid; m_dana uuid; m_eve uuid; m_alice2 uuid;
  rec uuid; rec2 uuid; c uuid; c_ext uuid; c_gone uuid; c_cross uuid;
  kind text; other uuid; v_rec uuid;
  got text;
begin
  insert into auth.users (id, email) values
    (u_alice, 'alice@team.example.test'), (u_bob, 'bob@team.example.test'),
    (u_carol, 'carol@outside.example.test'), (u_dana, 'dana@team.example.test'),
    (u_eve, 'eve@elsewhere.example.test');

  insert into public.workspace (name, slug) values ('t681 team', 't681-team-681') returning id into ws;
  insert into public.workspace (name, slug) values ('t681 elsewhere', 't681-elsewhere-681') returning id into ws2;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'member', 'Alice T681') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob T681') returning id into m_bob;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_dana, ws, 'admin', 'Dana T681') returning id into m_dana;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_eve, ws2, 'owner', 'Eve T681') returning id into m_eve;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws2, 'member', 'Alice T681') returning id into m_alice2;

  foreach kind in array array['document', 'capture', 'project', 'contact', 'company'] loop
    -- Two records of this kind in the team's workspace.
    for i in 1..2 loop
      case kind
        when 'document' then insert into public.document (workspace_id, title, visibility) values (ws, 't681 doc', 'workspace') returning id into v_rec;
        when 'capture' then insert into public.captures (workspace_id, user_id, title, visibility) values (ws, u_alice, 't681 capture', 'workspace') returning id into v_rec;
        when 'project' then insert into public.projects (workspace_id, user_id, name) values (ws, u_alice, 't681 project') returning id into v_rec;
        when 'contact' then insert into public.contact (workspace_id, full_name, visibility) values (ws, 'Pat Example', 'workspace') returning id into v_rec;
        when 'company' then insert into public.company (workspace_id, name) values (ws, 'Example Widgets') returning id into v_rec;
      end case;
      if i = 1 then rec := v_rec; else rec2 := v_rec; end if;
    end loop;
    if kind = 'company' then other := u_dana; else other := u_bob; end if;

    insert into public.comment (body, author_id, commentable_type, commentable_id)
    values ('alice wrote this', m_alice, kind::public.commentable_type, rec) returning id into c;

    -- ── Refused: someone else rewrites, re-signs or moves Alice's comment ──
    perform pg_temp.expect(kind || ': other rewrites the body',
      pg_temp.attempt(other, format('update public.comment set body = %L where id = %L', 'not what alice said', c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other re-signs it as themself',
      pg_temp.attempt(other, format('update public.comment set author_id = (select id from public.member where user_id = auth.uid() and workspace_id = %L) where id = %L', ws, c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other renames the author',
      pg_temp.attempt(other, format('update public.comment set author_name = %L, author_avatar_url = %L where id = %L', 'Someone Else', 'https://example.test/x.png', c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other changes the mentions',
      pg_temp.attempt(other, format('update public.comment set mentions = array[%L]::uuid[] where id = %L', m_bob, c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other moves the anchor',
      pg_temp.attempt(other, format('update public.comment set anchor_text = %L where id = %L', 'elsewhere', c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other moves it to another record',
      pg_temp.attempt(other, format('update public.comment set commentable_id = %L where id = %L', rec2, c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other rewrites it while resolving',
      pg_temp.attempt(other, format('update public.comment set is_resolved = true, body = %L where id = %L', 'gotcha', c)), 'refused:42501');
    perform pg_temp.expect(kind || ': other backdates it',
      pg_temp.attempt(other, format('update public.comment set created_at = %L where id = %L', '2020-01-01', c)), 'refused:42501');

    -- ── Refused even for the author: the fixed columns ──
    perform pg_temp.expect(kind || ': author moves it to another record',
      pg_temp.attempt(u_alice, format('update public.comment set commentable_id = %L where id = %L', rec2, c)), 'refused:42501');
    perform pg_temp.expect(kind || ': author signs it as another member',
      pg_temp.attempt(u_alice, format('update public.comment set author_id = %L where id = %L', m_bob, c)), 'refused:42501');
    perform pg_temp.expect(kind || ': author signs it with their other workspace''s member',
      pg_temp.attempt(u_alice, format('update public.comment set author_id = %L where id = %L', m_alice2, c)), 'refused:42501');
    perform pg_temp.expect(kind || ': author backdates it',
      pg_temp.attempt(u_alice, format('update public.comment set created_at = %L where id = %L', '2020-01-01', c)), 'refused:42501');

    -- ── Allowed ──
    perform pg_temp.expect(kind || ': other resolves it',
      pg_temp.attempt(other, format('update public.comment set is_resolved = true where id = %L', c)), 'rows=1');
    perform pg_temp.expect(kind || ': author edits words and mentions (as the edit route does)',
      pg_temp.attempt(u_alice, format('update public.comment set body = %L, mentions = array[%L]::uuid[], record_mentions = %L::jsonb where id = %L and author_id = %L', 'alice, edited', m_bob, '[]', c, m_alice)), 'rows=1');
    perform pg_temp.expect(kind || ': author resolves it',
      pg_temp.attempt(u_alice, format('update public.comment set is_resolved = true where id = %L', c)), 'rows=1');
    perform pg_temp.expect(kind || ': the service role rewrites it (server code)',
      pg_temp.attempt(null, format('update public.comment set body = %L where id = %L', 'server rewrite', c)), 'rows=1');
    perform pg_temp.expect(kind || ': someone in another workspace sees nothing to resolve',
      pg_temp.attempt(u_eve, format('update public.comment set is_resolved = true where id = %L', c)), 'rows=0');

    -- ── Deletes (unchanged by 681): never another member's ──
    perform pg_temp.expect(kind || ': other member deletes it',
      pg_temp.attempt(u_bob, format('delete from public.comment where id = %L', c)), 'rows=0');
    perform pg_temp.expect(kind || ': author deletes it',
      pg_temp.attempt(u_alice, format('delete from public.comment where id = %L', c)), 'rows=1');
  end loop;

  -- The edit stamps edited_at (026's trigger still runs after the guard).
  insert into public.document (workspace_id, title, visibility) values (ws, 't681 doc', 'workspace') returning id into rec;
  insert into public.comment (body, author_id, commentable_type, commentable_id)
  values ('alice wrote this', m_alice, 'document', rec) returning id into c;
  perform pg_temp.expect('document: other sets edited_at',
    pg_temp.attempt(u_bob, format('update public.comment set edited_at = now() where id = %L', c)), 'refused:42501');
  perform pg_temp.expect('document: author edit stamps edited_at',
    pg_temp.attempt(u_alice, format($s$update public.comment set body = 'edited' where id = %L and edited_at is null; update public.comment set is_resolved = is_resolved where id = %L and edited_at is not null$s$, c, c)), 'rows=1');
  -- An admin may delete a document comment (the baseline's comment_delete), as before.
  perform pg_temp.expect('document: admin deletes it',
    pg_temp.attempt(u_dana, format('delete from public.comment where id = %L', c)), 'rows=1');

  -- An outside commenter's comment (088) is theirs to edit; members resolve it.
  insert into public.comment (body, author_user_id, author_name, commentable_type, commentable_id)
  values ('carol from outside', u_carol, 'Carol Outside', 'document', rec) returning id into c_ext;
  perform pg_temp.expect('outside comment: member rewrites it',
    pg_temp.attempt(u_bob, format('update public.comment set body = %L where id = %L', 'rewritten', c_ext)), 'refused:42501');
  perform pg_temp.expect('outside comment: member resolves it',
    pg_temp.attempt(u_bob, format('update public.comment set is_resolved = true where id = %L', c_ext)), 'rows=1');
  perform pg_temp.expect('outside comment: its author edits it',
    pg_temp.attempt(u_carol, format('update public.comment set body = %L where id = %L', 'carol, edited', c_ext)), 'rows=1');
  perform pg_temp.expect('outside comment: its author cannot hand it to a member',
    pg_temp.attempt(u_carol, format('update public.comment set author_user_id = null, author_id = %L where id = %L', m_bob, c_ext)), 'refused:42501');

  -- A former member's comment (no author left) is only resolved.
  insert into public.comment (body, author_name, commentable_type, commentable_id)
  values ('from someone who left', 'Former Person', 'document', rec) returning id into c_gone;
  perform pg_temp.expect('former member''s comment: member rewrites it',
    pg_temp.attempt(u_bob, format('update public.comment set body = %L where id = %L', 'rewritten', c_gone)), 'refused:42501');
  perform pg_temp.expect('former member''s comment: member claims it',
    pg_temp.attempt(u_bob, format('update public.comment set author_id = %L, author_name = null where id = %L', m_bob, c_gone)), 'refused:42501');
  perform pg_temp.expect('former member''s comment: member resolves it',
    pg_temp.attempt(u_bob, format('update public.comment set is_resolved = true where id = %L', c_gone)), 'rows=1');

  -- Signed with Alice's member in ANOTHER workspace: not the author here.
  insert into public.comment (body, author_id, commentable_type, commentable_id)
  values ('signed from elsewhere', m_alice2, 'document', rec) returning id into c_cross;
  perform pg_temp.expect('author member from another workspace edits it',
    pg_temp.attempt(u_alice, format('update public.comment set body = %L where id = %L', 'edited', c_cross)), 'refused:42501');
  perform pg_temp.expect('author member from another workspace resolves it',
    pg_temp.attempt(u_alice, format('update public.comment set is_resolved = true where id = %L', c_cross)), 'rows=1');

  raise notice '681 comment_guard: all checks passed';
end
$probe$;

rollback;
