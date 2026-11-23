-- DB-level test for migration 708 (attachment_search_fence): semantic search
-- over a file's text answers only with files the searcher may read, by the
-- attachments table's own read rule, for every kind of parent a file has.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/708_attachment_search_fence.sql
-- Prints "708 attachment_search_fence: all checks passed". Everything runs in
-- one transaction that is rolled back. Made-up people only (example.test). A
-- failed check raises and aborts. Before 708 is applied the "does not get"
-- checks fail: that is the leak.
--
-- People: Alice owns the private things; Bob is a member who may read none of
-- them; Gina is a member Alice's private capture is shared with (entity_access).
--
-- Files, one per parent kind (attachments_has_parent, 663):
--   f_cap_private   on Alice's private capture            Alice, Gina
--   f_cap_open      on a workspace capture                 everyone
--   f_action        on an action in a private team         everyone (the
--                   actions and attachments read rules are workspace-wide)
--   f_project       on a project                           everyone (projects
--                   have no private setting)
--   f_row_private   a form's file on a private table's row Alice
--   f_row_bob       Bob's own upload on that private row   Alice (the
--                   restrictive attachments_row_select beats the uploader's own)
--   f_row_open      on a workspace table's row             everyone
-- Each file has one chunk, with the same embedding, so every search ranks
-- them all; attachment_rag_search's chunks are keyed to Bob (as if he had
-- indexed them), to show the keying is not a fence.

begin;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $f$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    execute 'set local role service_role';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
end $f$;

create or replace function pg_temp.expect(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL: % (got %, want %)', p_label, p_got, p_want;
  end if;
end $f$;

-- The file names a search returns, sorted, comma-joined.
create table pg_temp.got (fn text, title text);
grant all on pg_temp.got to authenticated, service_role;

do $probe$
declare
  u_alice constant uuid := '00000000-0000-4000-8000-000000708001';
  u_bob   constant uuid := '00000000-0000-4000-8000-000000708002';
  u_gina  constant uuid := '00000000-0000-4000-8000-000000708003';
  ws uuid; m_alice uuid; m_bob uuid; m_gina uuid;
  t_private uuid; st uuid; act uuid; proj uuid;
  tbl_private uuid; tbl_open uuid; r_private uuid; r_open uuid;
  c_private uuid; c_open uuid;
  emb text := '[' || array_to_string(array_fill(0.1::real, array[3072]), ',') || ']';
  everyone constant text := 'f_action,f_cap_open,f_project,f_row_open';
  -- No requester: what every member reads, but no table row's file at all.
  no_one constant text := 'f_action,f_cap_open,f_project';
  got text;
  f record;
begin
  insert into auth.users (id, email) values
    (u_alice, 'alice@t708.example.test'), (u_bob, 'bob@t708.example.test'), (u_gina, 'gina@t708.example.test');
  insert into public.workspace (name, slug) values ('t708 team', 't708-team-708') returning id into ws;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'member', 'Alice T708') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob T708') returning id into m_bob;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_gina, ws, 'member', 'Gina T708') returning id into m_gina;

  insert into public.team (workspace_id, name, slug, issue_prefix, is_private) values (ws, 't708 private team', 't708-private', 'TSF', true) returning id into t_private;
  insert into public.team_member (team_id, member_id) values (t_private, m_alice) on conflict do nothing;
  select id into st from public.workflow_state where team_id = t_private order by id limit 1;
  insert into public.actions (user_id, title, workspace_id, team_id, status_id, identifier)
    values (u_alice, 't708 private-team action', ws, t_private, st, 'TSF-1') returning id into act;
  insert into public.projects (user_id, name, workspace_id) values (u_alice, 't708 project', ws) returning id into proj;

  insert into public.data_table (workspace_id, name, visibility, owner_member_id) values (ws, 't708 private table', 'private', m_alice) returning id into tbl_private;
  insert into public.data_table (workspace_id, name, visibility, owner_member_id) values (ws, 't708 open table', 'workspace', m_alice) returning id into tbl_open;
  insert into public.data_row (workspace_id, table_id, position) values (ws, tbl_private, 1) returning id into r_private;
  insert into public.data_row (workspace_id, table_id, position) values (ws, tbl_open, 1) returning id into r_open;

  insert into public.captures (user_id, title, workspace_id, visibility) values (u_alice, 't708 private capture', ws, 'private') returning id into c_private;
  insert into public.captures (user_id, title, workspace_id, visibility) values (u_alice, 't708 open capture', ws, 'workspace') returning id into c_open;
  insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by)
    values (ws, 'capture', c_private, 'member', m_gina, 'view', m_alice);

  for f in
    select * from (values
      ('f_cap_private', u_alice, c_private, null::uuid, null::uuid, null::uuid, false),
      ('f_cap_open',    u_alice, c_open,    null, null, null, false),
      ('f_action',      u_alice, null, act,  null, null, false),
      ('f_project',     u_alice, null, null, proj, null, false),
      ('f_row_private', null,    null, null, null, r_private, true),
      ('f_row_bob',     u_bob,   null, null, null, r_private, false),
      ('f_row_open',    u_alice, null, null, null, r_open, false)
    ) v(fn, uploader, note, action, project, data_row, from_form)
  loop
    with a as (
      insert into public.attachments (user_id, workspace_id, note_id, action_id, project_id, data_row_id, from_form,
                                      file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path)
      values (f.uploader, ws, f.note, f.action, f.project, f.data_row, f.from_form,
              f.fn, 1, 'text/plain', 'txt', 'document', 't708/' || f.fn)
      returning id
    )
    insert into public.attachment_chunks (attachment_id, user_id, workspace_id, project_id, chunk_text, embedding)
      select a.id, u_bob, ws, f.project, 'text of ' || f.fn, emb::vector from a;
  end loop;

  -- ── The table's own rule, as each person reads it directly ──
  perform pg_temp.as_user(u_bob);
  select string_agg(file_name, ',' order by file_name) into got from public.attachments where workspace_id = ws;
  perform pg_temp.expect('Bob reads, by the table''s own rule', got, everyone);
  perform pg_temp.as_user(u_alice);
  select string_agg(file_name, ',' order by file_name) into got from public.attachments where workspace_id = ws;
  perform pg_temp.expect('Alice reads, by the table''s own rule', got, 'f_action,f_cap_open,f_cap_private,f_project,f_row_bob,f_row_open,f_row_private');
  perform pg_temp.as_user(u_gina);
  select string_agg(file_name, ',' order by file_name) into got from public.attachments where workspace_id = ws;
  perform pg_temp.expect('Gina reads, by the table''s own rule', got, 'f_action,f_cap_open,f_cap_private,f_project,f_row_open');
  reset role;

  -- ── hybrid_search_attachments (find) ──
  perform pg_temp.as_user(u_bob);
  select string_agg(title, ',' order by title) into got from public.hybrid_search_attachments(ws, emb, null, null, 50, 50);
  perform pg_temp.expect('Bob does not get a private table''s files from hybrid_search_attachments', got, everyone);
  perform pg_temp.as_user(u_alice);
  select string_agg(title, ',' order by title) into got from public.hybrid_search_attachments(ws, emb, null, null, 50, 50);
  perform pg_temp.expect('Alice gets all her files from hybrid_search_attachments', got, 'f_action,f_cap_open,f_cap_private,f_project,f_row_bob,f_row_open,f_row_private');
  perform pg_temp.as_user(u_gina);
  select string_agg(title, ',' order by title) into got from public.hybrid_search_attachments(ws, emb, null, null, 50, 50);
  perform pg_temp.expect('Gina gets the capture shared with her from hybrid_search_attachments', got, 'f_action,f_cap_open,f_cap_private,f_project,f_row_open');
  -- No requester (an unattended run on the service role): workspace-visible files only.
  perform pg_temp.as_user(null);
  select string_agg(title, ',' order by title) into got from public.hybrid_search_attachments(ws, emb, null, null, 50, 50, 1.0, 0.5, null);
  perform pg_temp.expect('no requester gets the workspace''s files, and no row''s, from hybrid_search_attachments', got, no_one);
  select string_agg(title, ',' order by title) into got from public.hybrid_search_attachments(ws, emb, null, null, 50, 50, 1.0, 0.5, u_bob);
  perform pg_temp.expect('the service role naming Bob gets Bob''s files from hybrid_search_attachments', got, everyone);
  reset role;

  -- ── attachment_rag_search (deep_search) ──
  perform pg_temp.as_user(u_bob);
  select string_agg(file_name, ',' order by file_name) into got from public.attachment_rag_search(u_bob::text, emb, ws::text, '{}', 50, 0.0);
  perform pg_temp.expect('Bob does not get a private table''s files from attachment_rag_search', got, everyone);
  perform pg_temp.as_user(null);
  select string_agg(file_name, ',' order by file_name) into got from public.attachment_rag_search(u_bob::text, emb, ws::text, '{}', 50, 0.0);
  perform pg_temp.expect('the service role searching as Bob does not get them either', got, everyone);
  -- A project filter keeps working.
  select string_agg(file_name, ',' order by file_name) into got from public.attachment_rag_search(u_bob::text, emb, ws::text, array[proj::text], 50, 0.0);
  perform pg_temp.expect('attachment_rag_search with a project filter', got, 'f_project');
  reset role;

  -- ── The helper answers the table's rule for each file, and refuses to be an oracle ──
  for f in select a.id, a.file_name from public.attachments a where a.workspace_id = ws loop
    perform pg_temp.expect('helper for Bob on ' || f.file_name,
      public.attachment_readable_by(f.id, u_bob)::text, (f.file_name = any (string_to_array(everyone, ',')))::text);
    perform pg_temp.expect('helper for no one on ' || f.file_name,
      public.attachment_readable_by(f.id, null)::text, (f.file_name = any (string_to_array(no_one, ',')))::text);
    perform pg_temp.expect('helper for Alice on ' || f.file_name, public.attachment_readable_by(f.id, u_alice)::text, 'true');
  end loop;
  perform pg_temp.as_user(u_bob);
  perform pg_temp.expect('Bob cannot ask the helper about Alice',
    (select public.attachment_readable_by(a.id, u_alice) from public.attachments a where a.file_name = 'f_cap_open' and a.workspace_id = ws)::text, 'false');
  reset role;

  raise notice '708 attachment_search_fence: all checks passed';
end
$probe$;

rollback;
