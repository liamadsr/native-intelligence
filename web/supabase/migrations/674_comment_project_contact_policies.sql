-- ============================================================
-- 674: comments on a project and on a contact are allowed again.
-- (Written and applied to production as 673; renumbered when another 673
-- reached main first. The statements are unchanged.)
-- ============================================================
-- Why: the app comments on five kinds of record (lib/comments.ts
-- CommentableType: action, capture, document, project, contact), and the
-- comment table's type and its target check (validate_commentable_exists)
-- know all five. Its row policies know three. Migrations 055 and 057 gave
-- the member policies a project and a contact branch; 088 replaced the
-- insert and resolve policies and 493 the view policy, each with a CASE
-- over action, capture and document only. A CASE with no branch for a type
-- is null, so since then the database has refused every comment on a
-- project or a contact ("new row violates row-level security policy"), and
-- would show none. Production had no such comment when this was written.
--
-- What lands: three policies of their own for those two kinds, beside the
-- existing ones (permissive policies add up, so the three kinds that work
-- are not restated and cannot change):
--   - view:    a member of the record's workspace who can see the record;
--   - create:  the same, writing as their own member of THAT workspace;
--   - resolve: the same (088's "Members can resolve", for these two kinds).
-- "Can see the record" is the record's own row policy: the subquery on
-- projects / contact runs as the caller, so a contact a person may not see
-- has no comments for them either. Editing and deleting one's own comment
-- already work for every kind (088's author policies), and the view-only
-- grant fences (494 / 512: comment_*_not_by_grant) apply to these as to
-- the others.
--
-- No outside commenters here: a share link is for an action, a capture or
-- a document, and 088's own branch for them is untouched.
--
-- Safe to run twice. No table data changes. Policies are not in the data
-- API's schema cache, so no reload is needed.
-- ============================================================

drop policy if exists comment_project_contact_select on public.comment;
create policy comment_project_contact_select on public.comment
  for select to public
  using (
    case commentable_type
      when 'project'::public.commentable_type then exists (
        select 1 from public.projects p
         where p.id = comment.commentable_id
           and public.is_workspace_member(p.workspace_id)
      )
      when 'contact'::public.commentable_type then exists (
        select 1 from public.contact c
         where c.id = comment.commentable_id
           and public.is_workspace_member(c.workspace_id)
      )
      else false
    end
  );

drop policy if exists comment_project_contact_insert on public.comment;
create policy comment_project_contact_insert on public.comment
  for insert to public
  with check (
    author_id is not null
    and author_user_id is null
    and case commentable_type
      when 'project'::public.commentable_type then exists (
        select 1
          from public.projects p
          join public.member m on m.workspace_id = p.workspace_id
         where p.id = comment.commentable_id
           and m.id = comment.author_id
           and m.user_id = auth.uid()
           and public.is_workspace_member(p.workspace_id)
      )
      when 'contact'::public.commentable_type then exists (
        select 1
          from public.contact c
          join public.member m on m.workspace_id = c.workspace_id
         where c.id = comment.commentable_id
           and m.id = comment.author_id
           and m.user_id = auth.uid()
           and public.is_workspace_member(c.workspace_id)
      )
      else false
    end
  );

drop policy if exists comment_project_contact_resolve on public.comment;
create policy comment_project_contact_resolve on public.comment
  for update to public
  using (
    case commentable_type
      when 'project'::public.commentable_type then exists (
        select 1 from public.projects p
         where p.id = comment.commentable_id
           and public.is_workspace_member(p.workspace_id)
      )
      when 'contact'::public.commentable_type then exists (
        select 1 from public.contact c
         where c.id = comment.commentable_id
           and public.is_workspace_member(c.workspace_id)
      )
      else false
    end
  );
