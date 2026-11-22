-- ============================================================
-- 681: a comment is its author's to change; anyone who can see it resolves it.
-- ============================================================
-- Why: public.comment has four permissive UPDATE policies, and three of them
-- check only that the caller can see the record the comment is on:
--   "Members can resolve comments on their entities" (088): action, capture,
--                                                           document;
--   comment_project_contact_resolve (674):                  project, contact;
--   comment_company_resolve (679):                          company.
-- They are meant for is_resolved, but a policy cannot name columns, so any
-- member who can see the record could rewrite ANY column of anyone's comment
-- on it with their own token through the data API: the words and mentions,
-- the author (author_id, author_user_id, author_name, author_avatar_url), the
-- record and thread it sits in, its time. The author policy (088, "Authors
-- can update own comments") has no WITH CHECK either, so an author could move
-- their comment to another record or sign it as another of their members.
-- 512's entity_edit_grant_comment_guard stops only grant-only callers.
--
-- What lands: one BEFORE UPDATE trigger beside the others (no policy and no
-- existing function changes). For a client (current_user authenticated or
-- anon) it refuses, with 42501:
--   - any change to commentable_type, commentable_id, parent_id, author_id,
--     author_user_id or created_at, whoever asks (the author too);
--   - any change to any other column but is_resolved (body, mentions,
--     record_mentions, author_name, author_avatar_url, edited_at, the anchor_*
--     columns, and any column added later) unless the caller is the comment's
--     author: author_id is the caller's own member in the workspace of the
--     record the comment is on, or author_user_id = auth.uid() (an outside
--     commenter, 088). A former member's comment (both null) has no author.
-- is_resolved stays open to whoever the policies let update the row. The
-- table has no resolved_by / resolved_at columns, so there is no "who
-- resolved" to check.
--
-- Anchors are author-only: the app never re-anchors a comment (the inline
-- comment UI matches anchor_text against the content when it draws; no route
-- or job writes anchor_* after the insert).
--
-- Deletes are not changed: the delete policies (088 "Authors can delete own
-- comments", the baseline's comment_delete: the author, or an owner or admin
-- of an action's, capture's or document's workspace; 512's restrictive for
-- grantees) already let no member delete another member's comment.
--
-- Server code is not touched: the service role, the database owner and
-- SECURITY DEFINER functions (merges, moves, member departure, the share
-- page's resolve route) run as another current_user and pass straight
-- through, as with 512's guard and 675's spreadsheet_comment_guard.
--
-- Its own transaction. Safe to run twice. No table data changes. No
-- backslashes anywhere in this file.
-- ============================================================

begin;

set local lock_timeout = '5s';

-- Is the caller this comment's author? A member author counts only as the
-- caller's own member row in the workspace of the record the comment is on.
-- SECURITY DEFINER so a record the caller cannot see still has a workspace;
-- it answers only about the caller (auth.uid()), never about anyone else.
create or replace function public.comment_written_by_me(
  p_author_id uuid,
  p_author_user_id uuid,
  p_commentable_type text,
  p_commentable_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    return false;
  end if;
  if p_author_user_id is not null then
    return p_author_user_id = auth.uid();
  end if;
  if p_author_id is null then
    return false;
  end if;
  v_ws := case p_commentable_type
    when 'action' then (select t.workspace_id from public.actions a join public.team t on t.id = a.team_id where a.id = p_commentable_id)
    when 'capture' then (select c.workspace_id from public.captures c where c.id = p_commentable_id)
    when 'document' then (select d.workspace_id from public.document d where d.id = p_commentable_id)
    when 'project' then (select p.workspace_id from public.projects p where p.id = p_commentable_id)
    when 'contact' then (select c.workspace_id from public.contact c where c.id = p_commentable_id)
    when 'company' then (select c.workspace_id from public.company c where c.id = p_commentable_id)
    else null
  end;
  if v_ws is null then
    return false;
  end if;
  return exists (
    select 1 from public.member m
     where m.id = p_author_id
       and m.user_id = auth.uid()
       and m.workspace_id = v_ws
  );
end;
$$;

revoke all on function public.comment_written_by_me(uuid, uuid, text, uuid) from public;
grant execute on function public.comment_written_by_me(uuid, uuid, text, uuid) to authenticated, anon, service_role;

-- Not SECURITY DEFINER: current_user must stay the caller's role.
create or replace function public.comment_author_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.commentable_type is distinct from old.commentable_type
     or new.commentable_id is distinct from old.commentable_id
     or new.parent_id is distinct from old.parent_id
     or new.author_id is distinct from old.author_id
     or new.author_user_id is distinct from old.author_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'A comment keeps its record, its thread, its author and its time.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'is_resolved') is distinct from (to_jsonb(old) - 'is_resolved')
     and not public.comment_written_by_me(old.author_id, old.author_user_id, old.commentable_type::text, old.commentable_id) then
    raise exception 'Only its author changes a comment; anyone who can see it may resolve it.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.comment_author_guard() from public, anon, authenticated;

drop trigger if exists comment_author_guard on public.comment;
create trigger comment_author_guard
  before update on public.comment
  for each row execute function public.comment_author_guard();

commit;
