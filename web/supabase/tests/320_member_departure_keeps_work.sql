-- DB-level test for migration 320 (member_departure_keeps_work): removing a
-- member, or leaving, keeps what they wrote. The TS test pins the file's text;
-- this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/320_member_departure_keeps_work.sql
-- Prints "320 member_departure_keeps_work: all checks passed". Everything runs
-- in one transaction that is rolled back: a throwaway member (an existing user
-- joining a workspace with a document), their comments, a draft and an applied
-- suggestion. A failed check raises and aborts.
--
-- Before 320 the DELETE below failed (proposed_change.applied_by refused it),
-- and without the applied suggestion it deleted the comments and the draft.

begin;

do $probe$
declare
  ws uuid; doc uuid; u uuid; m uuid; m2 uuid; c1 uuid; c2 uuid; pc uuid;
  u1 constant uuid := '00000000-0000-4000-8000-000000320001';
  u2 constant uuid := '00000000-0000-4000-8000-000000320002';
  u3 constant uuid := '00000000-0000-4000-8000-000000320003';
  w1 uuid; m1 uuid; mu2 uuid; cw uuid; cu uuid; w3 uuid; m3own uuid; m3 uuid;
begin
  select d.workspace_id, d.id into ws, doc from public.document d limit 1;
  select id into u from auth.users
   where id not in (select user_id from public.member where workspace_id = ws) limit 1;
  if ws is null or u is null then raise exception 'FAIL: needs a document and a user outside its workspace'; end if;

  insert into public.member (user_id, workspace_id, role, display_name, avatar_url)
  values (u, ws, 'member', 'Probe Person', 'https://example.com/a.png') returning id into m;
  insert into public.comment (body, author_id, commentable_type, commentable_id)
  values ('probe', m, 'document', doc) returning id into c1;
  -- A comment whose action is gone: comments are polymorphic and stay behind.
  alter table public.comment disable trigger comment_validate_target;
  insert into public.comment (body, author_id, commentable_type, commentable_id)
  values ('orphan probe', m, 'action', gen_random_uuid()) returning id into c2;
  alter table public.comment enable trigger comment_validate_target;
  insert into public.document_draft (document_id, workspace_id, author_id, title)
  values (doc, ws, m, 'probe draft');
  if not exists (select 1 from public.document_draft where document_id = doc and author_user_id = u) then
    raise exception 'FAIL: a draft written by member id gets its user';
  end if;
  select id into pc from public.proposed_change limit 1;
  if pc is not null then update public.proposed_change set applied_by = m where id = pc; end if;

  delete from public.member where id = m;

  if not exists (select 1 from public.comment where id = c1 and author_id is null
                 and author_name = 'Probe Person' and author_avatar_url = 'https://example.com/a.png'
                 and edited_at is null) then
    raise exception 'FAIL: the comment stays under its author''s name, not marked edited';
  end if;
  if not exists (select 1 from public.comment where id = c2 and author_name = 'Probe Person') then
    raise exception 'FAIL: a comment on a deleted action stays too';
  end if;
  if not exists (select 1 from public.document_draft where document_id = doc and author_user_id = u and author_id is null) then
    raise exception 'FAIL: the draft stays with its user';
  end if;
  if pc is not null and exists (select 1 from public.proposed_change where id = pc and applied_by is not null) then
    raise exception 'FAIL: who applied the suggestion is cleared';
  end if;

  insert into public.member (user_id, workspace_id, role, display_name)
  values (u, ws, 'member', 'Probe Person') returning id into m2;
  if not exists (select 1 from public.document_draft where document_id = doc and author_id = m2) then
    raise exception 'FAIL: rejoining gives the draft back';
  end if;
  insert into public.document_draft (document_id, workspace_id, author_id, title)
  values (doc, ws, m2, 'again')
  on conflict (document_id, author_id) do update set title = excluded.title;
  if not exists (select 1 from public.document_draft where document_id = doc and author_id = m2 and title = 'again') then
    raise exception 'FAIL: the app''s upsert on (document_id, author_id) still lands';
  end if;

  begin
    insert into public.comment (body, commentable_type, commentable_id) values ('nobody', 'document', doc);
    raise exception 'FAIL: a comment with no author and no name is refused';
  exception when check_violation then null;
  end;

  -- Throwaway users: the signup trigger gives each a workspace they own.
  insert into auth.users (id, email, raw_user_meta_data) values
    (u1, 't320-one@example.invalid', '{"full_name":"t320one"}'),
    (u2, 't320-two@example.invalid', '{"full_name":"t320two"}'),
    (u3, 't320-three@example.invalid', '{"full_name":"t320three"}');

  -- Deleting a whole workspace still deletes its members' comments.
  select workspace_id, id into w1, m1 from public.member where user_id = u1;
  alter table public.comment disable trigger comment_validate_target;
  insert into public.comment (body, author_id, commentable_type, commentable_id)
  values ('in w1', m1, 'action', gen_random_uuid()) returning id into cw;
  alter table public.comment enable trigger comment_validate_target;
  delete from public.workspace where id = w1;
  if exists (select 1 from public.comment where id = cw) then
    raise exception 'FAIL: deleting the workspace deletes its comments';
  end if;

  -- Deleting an account still deletes their comments, in a workspace that stays.
  insert into public.member (user_id, workspace_id, role, display_name) values (u2, ws, 'member', 'Two') returning id into mu2;
  insert into public.comment (body, author_id, commentable_type, commentable_id) values ('by two', mu2, 'document', doc) returning id into cu;
  delete from auth.users where id = u2;
  if exists (select 1 from public.comment where id = cu) then
    raise exception 'FAIL: deleting the account deletes their comments';
  end if;

  -- A kept draft (the document then moved to another workspace of theirs) never
  -- blocks a new draft by the same person: the new one replaces it.
  select workspace_id, id into w3, m3own from public.member where user_id = u3;
  insert into public.member (user_id, workspace_id, role, display_name) values (u3, ws, 'member', 'Three') returning id into m3;
  insert into public.document_draft (document_id, workspace_id, author_id, title) values (doc, ws, m3, 'old');
  delete from public.member where id = m3;
  insert into public.document_draft (document_id, workspace_id, author_id, title) values (doc, w3, m3own, 'new')
  on conflict (document_id, author_id) do update set title = excluded.title;
  if not exists (select 1 from public.document_draft where document_id = doc and author_id = m3own and title = 'new')
     or exists (select 1 from public.document_draft where document_id = doc and author_user_id = u3 and author_id is null) then
    raise exception 'FAIL: a new draft replaces the same person''s kept one';
  end if;

  raise notice '320 member_departure_keeps_work: all checks passed';
end
$probe$;

rollback;
