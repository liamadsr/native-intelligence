-- ============================================================
-- 494: a view grant (492, 493) stays view-only for every write path.
-- ============================================================
-- 493 opened the private kinds' SELECT policies to grantees and left every
-- UPDATE, INSERT and DELETE policy as it was. But several of those write
-- policies never restated the record's read rule: they relied on the row (or
-- its parent, read in a subquery) being hidden by SELECT RLS. Once a grant
-- shows the row, they let the grantee write. Proven on DEV (rolled back), a
-- member with a view grant could:
--   comment         add a comment to the private doc or capture, rewrite or
--                   resolve its owner's comments ("Create comments", "Members
--                   can resolve comments": exists (… from captures/document …
--                   is_workspace_member …), 088 and 223's note: "a comment you
--                   cannot read is a comment you cannot address");
--   capture_label   add and remove the capture's labels (ALL policy: exists
--                   (… from captures … is_workspace_member));
--   attachments     delete the capture's attachment rows (attachments_
--                   workspace_delete: is_workspace_member);
--   company         rename or delete the company (company_update and
--                   company_delete: is_workspace_member);
--   proposed_change edit a suggestion on the private doc (its document arm);
--   document, captures, comment (admins)  an owner or admin who is a grantee
--                   could delete the private doc or capture, and any comment
--                   on it (their delete policies key on the role and relied
--                   on SELECT to hide the row).
--
-- The fix leaves every existing policy as it is and adds RESTRICTIVE ones
-- (ANDed with the permissive policies) that refuse exactly the rows a caller
-- can see ONLY through a grant:
--
--   entity_grant_only(type, id)  the record exists, its own read rule (the one
--        493 kept verbatim, before its grant arm) does not show it to
--        auth.uid(), and a grant does. So policy AND NOT grant_only equals
--        the policy as it behaved before 493, row for row:
--        (own rule OR grant) AND NOT (NOT own rule AND grant) = own rule.
--
-- A grantee still reads everything 493 opened. No permissive policy changes;
-- a member with no grants is unaffected (grant_only is false). SELECT is
-- never restricted here. Writes from the service role bypass RLS as before.
--
-- After 493. Idempotent (create or replace, drop policy if exists). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── Can the caller see this record only through a grant? ─────────────────────
-- Each kind's own read rule is 493's policy without its grant arm (document
-- 369, captures 223, contact 058, company 059), null-safe: a rule that comes
-- out NULL hid the row, so it counts as not visible.
create or replace function public.entity_grant_only(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_id is not null and coalesce(case p_type
    when 'document' then exists (
      select 1 from public.document d
       where d.id = p_id
         and not coalesce(public.is_workspace_member(d.workspace_id)
               and (d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id)), false)
         and public.has_entity_grant('document', d.id, d.workspace_id))
    when 'capture' then exists (
      select 1 from public.captures c
       where c.id = p_id
         and not coalesce(public.is_workspace_member(c.workspace_id)
               and (c.visibility = 'workspace' or c.user_id = auth.uid()), false)
         and public.has_entity_grant('capture', c.id, c.workspace_id))
    when 'contact' then exists (
      select 1 from public.contact ct
       where ct.id = p_id
         and not coalesce(public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id), false)
         and public.has_entity_grant('contact', ct.id, ct.workspace_id))
    when 'company' then exists (
      select 1 from public.company co
       where co.id = p_id
         and not coalesce(public.is_workspace_member(co.workspace_id)
               and (public.get_member_role(co.workspace_id) in ('owner', 'admin')
                    or exists (
                      select 1 from public.contact ct
                       where ct.company_id = co.id
                         and public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id))), false)
         and (public.has_entity_grant('company', co.id, co.workspace_id)
              or exists (
                select 1 from public.contact ct
                 where ct.company_id = co.id
                   and public.has_entity_grant('contact', ct.id, ct.workspace_id))))
    else false
  end, false);
$$;

revoke all on function public.entity_grant_only(text, uuid) from public, anon;
grant execute on function public.entity_grant_only(text, uuid) to authenticated, service_role;

-- ── The parents ──────────────────────────────────────────────────────────────
-- document and captures: update policies already restate the read rule; the
-- delete ones (owner/admin or creator) did not.
drop policy if exists document_delete_not_by_grant on public.document;
create policy document_delete_not_by_grant on public.document
  as restrictive for delete to public
  using (not public.entity_grant_only('document', id));

drop policy if exists captures_delete_not_by_grant on public.captures;
create policy captures_delete_not_by_grant on public.captures
  as restrictive for delete to public
  using (not public.entity_grant_only('capture', id));

-- company: update and delete were any member's who could see it.
drop policy if exists company_update_not_by_grant on public.company;
create policy company_update_not_by_grant on public.company
  as restrictive for update to public
  using (not public.entity_grant_only('company', id));

drop policy if exists company_delete_not_by_grant on public.company;
create policy company_delete_not_by_grant on public.company
  as restrictive for delete to public
  using (not public.entity_grant_only('company', id));

-- (contact: contact_update keys on can_edit_contact and contact_delete on the
-- creator or an admin, both explicit; nothing to add.)

-- ── comment: no new comment, edit, resolve or delete on a grant-only record ──
-- An external commenter's own arm (author_user_id, a share link) is not a
-- workspace grant, so grant_only is false for them.
drop policy if exists comment_insert_not_by_grant on public.comment;
create policy comment_insert_not_by_grant on public.comment
  as restrictive for insert to public
  with check (not public.entity_grant_only(commentable_type::text, commentable_id));

drop policy if exists comment_update_not_by_grant on public.comment;
create policy comment_update_not_by_grant on public.comment
  as restrictive for update to public
  using (not public.entity_grant_only(commentable_type::text, commentable_id));

drop policy if exists comment_delete_not_by_grant on public.comment;
create policy comment_delete_not_by_grant on public.comment
  as restrictive for delete to public
  using (not public.entity_grant_only(commentable_type::text, commentable_id));

-- ── capture_label: its ALL policy is "a member who can see the capture" ──────
drop policy if exists capture_label_insert_not_by_grant on public.capture_label;
create policy capture_label_insert_not_by_grant on public.capture_label
  as restrictive for insert to public
  with check (not public.entity_grant_only('capture', capture_id));

drop policy if exists capture_label_update_not_by_grant on public.capture_label;
create policy capture_label_update_not_by_grant on public.capture_label
  as restrictive for update to public
  using (not public.entity_grant_only('capture', capture_id));

drop policy if exists capture_label_delete_not_by_grant on public.capture_label;
create policy capture_label_delete_not_by_grant on public.capture_label
  as restrictive for delete to public
  using (not public.entity_grant_only('capture', capture_id));

-- ── attachments: the workspace delete policy is any member's ─────────────────
-- The uploader keeps their own (attachments_user_select showed it to them
-- before any grant).
drop policy if exists attachments_delete_not_by_grant on public.attachments;
create policy attachments_delete_not_by_grant on public.attachments
  as restrictive for delete to public
  using (user_id = auth.uid() or note_id is null or not public.entity_grant_only('capture', note_id));

-- (The files themselves are safe: storage's "attachments workspace delete"
-- needs the object visible under storage's own read policy, which keeps a
-- capture's files to the capture's own readers, and has no grant arm. Proven
-- on DEV: a grantee's delete through the Storage API's path removes nothing.)

-- ── proposed_change: the document arm of its update policy ───────────────────
-- (A row has one home, proposed_change_one_home: a document's has no capture
-- or conversation arm to pass instead.)
drop policy if exists proposed_change_update_not_by_grant on public.proposed_change;
create policy proposed_change_update_not_by_grant on public.proposed_change
  as restrictive for update to public
  using (document_id is null or not public.entity_grant_only('document', document_id));
