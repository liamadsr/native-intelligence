-- ============================================================
-- 493: grants (492) open the private kinds' existing read rules.
-- ============================================================
-- Each policy below is re-created EXACTLY as it stood on DEV before this
-- file (pg_policies, 2026-11-10), with one more OR arm, written last: a
-- grant on the row (or, for a child row, on its parent) that reaches the
-- reader. Nothing is removed or narrowed; the PR lists every before/after.
--
-- The grant arm, for a row r of kind K:
--     (r.id = any ((select public.my_entity_grant_ids('K'))::uuid[])
--      and public.has_entity_grant('K', r.id, r.workspace_id))
-- The first half is an InitPlan (one array per query: every id of kind K a
-- grant reaches the reader for), so a list of n rows pays one lookup, not n
-- function calls; the second is the exact rule (the grant lives in the
-- row's own workspace and still reaches the reader), asked only for the
-- ids in the array. (The bare per-row has_entity_grant was measured too: a
-- member's full contact read went from 77 ms to 124 ms. With the array it
-- is unchanged.)
--
-- Measured on DEV, a member's full read before → after, no grants: document
-- 0.9 → 1.3 ms, captures 12 → 13, contact 80 → 78, company 26 → 27,
-- capture_participant for one capture 0.7 → 0.5. Two child tables whose
-- view policy and ALL ("manage") policy were word for word the same, and so
-- were folded by the planner into one probe of the parent, now probe it
-- twice, because the view policy gained the arm and the manage policy must
-- not (a grant is view-only): a full read of capture_participant 22 → 44 ms,
-- document_chunks 1.7 → 3.7 ms. A read by capture or document id is
-- unchanged.
--
-- SELECT only. Grants are view-only in this phase (492), so no UPDATE,
-- INSERT or DELETE policy changes; a child table's ALL policy (capture
-- references, document chunk writes, sequence enrolments, capture
-- participants' and decisions' management) is left exactly as it is.
--
--   parents   document.document_select, captures.captures_select,
--             contact.contact_select_visibility,
--             company.company_select_with_visible_contacts (a company stays
--             visible to anyone who can see one of its contacts, and a
--             granted contact counts as one, as a contact_share does; or
--             its own grant)
--   children  document_revision, document_chunks (read), capture_chunks
--             (read), capture_participant (view), decision (view),
--             attachments (a capture's), comment (the capture and document
--             arms of its view policy), contact_interaction (read)
--   twins     contact_visible_to(contact, user) and company_visible_to(…),
--             the explicit-user forms the service-role tools call
--             (src/lib/crm/contact-visibility.ts), gain the same grant arm
--             through entity_grant_reaches (492): each keeps its body and
--             gains one check before its last answer. company_visible_to's
--             contact arm reads contact_visible_to, so a granted contact
--             counts there too, as it does in the company policy.
--
-- After 492. Idempotent (drop policy if exists, create or replace). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── document ─────────────────────────────────────────────────────────────────
drop policy if exists document_select on public.document;
create policy document_select on public.document
  for select to public
  using (
    is_workspace_member(workspace_id)
    and (
      (visibility = 'workspace'::text)
      or (created_by = current_member_id(workspace_id))
      or (id = any ((select public.my_entity_grant_ids('document'))::uuid[]) and public.has_entity_grant('document', id, workspace_id))
    )
  );

-- ── captures ─────────────────────────────────────────────────────────────────
drop policy if exists captures_select on public.captures;
create policy captures_select on public.captures
  for select to public
  using (
    is_workspace_member(workspace_id)
    and (
      (visibility = 'workspace'::text)
      or (user_id = auth.uid())
      or (id = any ((select public.my_entity_grant_ids('capture'))::uuid[]) and public.has_entity_grant('capture', id, workspace_id))
    )
  );

-- ── contact ──────────────────────────────────────────────────────────────────
drop policy if exists contact_select_visibility on public.contact;
create policy contact_select_visibility on public.contact
  for select to public
  using (
    can_view_contact(id, workspace_id, visibility, created_by_member_id)
    or (id = any ((select public.my_entity_grant_ids('contact'))::uuid[]) and public.has_entity_grant('contact', id, workspace_id))
  );

-- ── company ──────────────────────────────────────────────────────────────────
drop policy if exists company_select_with_visible_contacts on public.company;
create policy company_select_with_visible_contacts on public.company
  for select to public
  using (
    is_workspace_member(workspace_id)
    and (
      (get_member_role(workspace_id) = any (array['owner'::text, 'admin'::text]))
      or (exists (
        select 1
          from contact ct
         where ct.company_id = company.id
           and (
             can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id)
             or (ct.id = any ((select public.my_entity_grant_ids('contact'))::uuid[]) and public.has_entity_grant('contact', ct.id, ct.workspace_id))
           )
      ))
      or (id = any ((select public.my_entity_grant_ids('company'))::uuid[]) and public.has_entity_grant('company', id, workspace_id))
    )
  );

-- ── document_revision ────────────────────────────────────────────────────────
drop policy if exists document_revision_select on public.document_revision;
create policy document_revision_select on public.document_revision
  for select to public
  using (
    is_workspace_member(workspace_id)
    and (exists (
      select 1
        from document d
       where d.id = document_revision.document_id
         and (
           (d.visibility = 'workspace'::text)
           or (d.created_by = current_member_id(d.workspace_id))
           or (d.id = any ((select public.my_entity_grant_ids('document'))::uuid[]) and public.has_entity_grant('document', d.id, d.workspace_id))
         )
    ))
  );

-- ── document_chunks ──────────────────────────────────────────────────────────
drop policy if exists document_chunks_select on public.document_chunks;
create policy document_chunks_select on public.document_chunks
  for select to public
  using (
    is_workspace_member(workspace_id)
    and (exists (
      select 1
        from document d
       where d.id = document_chunks.document_id
         and d.workspace_id = document_chunks.workspace_id
         and (
           (d.visibility = 'workspace'::text)
           or (d.created_by = current_member_id(d.workspace_id))
           or (d.id = any ((select public.my_entity_grant_ids('document'))::uuid[]) and public.has_entity_grant('document', d.id, d.workspace_id))
         )
    ))
  );

-- ── capture_chunks ───────────────────────────────────────────────────────────
drop policy if exists capture_chunks_select on public.capture_chunks;
create policy capture_chunks_select on public.capture_chunks
  for select to public
  using (
    exists (
      select 1
        from captures c
       where c.id = capture_chunks.capture_id
         and is_workspace_member(c.workspace_id)
         and (
           (c.visibility = 'workspace'::text)
           or (c.user_id = auth.uid())
           or (c.id = any ((select public.my_entity_grant_ids('capture'))::uuid[]) and public.has_entity_grant('capture', c.id, c.workspace_id))
         )
    )
  );

-- ── capture_participant (view) ───────────────────────────────────────────────
-- Its ALL policy ("… can manage …") stays as it is: a grant is view-only.
drop policy if exists "Workspace members can view capture participants" on public.capture_participant;
create policy "Workspace members can view capture participants" on public.capture_participant
  for select to public
  using (
    exists (
      select 1
        from captures c
       where c.id = capture_participant.capture_id
         and is_workspace_member(c.workspace_id)
         and (
           (c.visibility = 'workspace'::text)
           or (c.user_id = auth.uid())
           or (c.id = any ((select public.my_entity_grant_ids('capture'))::uuid[]) and public.has_entity_grant('capture', c.id, c.workspace_id))
         )
    )
  );

-- ── decision (view) ──────────────────────────────────────────────────────────
-- Its ALL policy stays as it is, likewise.
drop policy if exists "Workspace members can view decisions" on public.decision;
create policy "Workspace members can view decisions" on public.decision
  for select to public
  using (
    exists (
      select 1
        from captures c
       where c.id = decision.capture_id
         and is_workspace_member(c.workspace_id)
         and (
           (c.visibility = 'workspace'::text)
           or (c.user_id = auth.uid())
           or (decision.confirmation = 'confirmed'::text)
           or (c.id = any ((select public.my_entity_grant_ids('capture'))::uuid[]) and public.has_entity_grant('capture', c.id, c.workspace_id))
         )
    )
  );

-- ── attachments ──────────────────────────────────────────────────────────────
drop policy if exists attachments_workspace_select on public.attachments;
create policy attachments_workspace_select on public.attachments
  for select to public
  using (
    is_workspace_member(workspace_id)
    and (
      (note_id is null)
      or (exists (
        select 1
          from captures c
         where c.id = attachments.note_id
           and (
             (c.visibility = 'workspace'::text)
             or (c.user_id = auth.uid())
             or (c.id = any ((select public.my_entity_grant_ids('capture'))::uuid[]) and public.has_entity_grant('capture', c.id, c.workspace_id))
           )
      ))
    )
  );

-- ── comment (view) ───────────────────────────────────────────────────────────
drop policy if exists "View comments: members + own external" on public.comment;
create policy "View comments: members + own external" on public.comment
  for select to public
  using (
    ((author_user_id is not null) and (author_user_id = auth.uid()))
    or case commentable_type
      when 'action'::commentable_type then (exists (
        select 1
          from (actions a join team t on ((t.id = a.team_id)))
         where a.id = comment.commentable_id
           and is_workspace_member(t.workspace_id)
      ))
      when 'capture'::commentable_type then (exists (
        select 1
          from captures c
         where c.id = comment.commentable_id
           and is_workspace_member(c.workspace_id)
           and (
             (c.visibility = 'workspace'::text)
             or (c.user_id = auth.uid())
             or (c.id = any ((select public.my_entity_grant_ids('capture'))::uuid[]) and public.has_entity_grant('capture', c.id, c.workspace_id))
           )
      ))
      when 'document'::commentable_type then (exists (
        select 1
          from document d
         where d.id = comment.commentable_id
           and is_workspace_member(d.workspace_id)
           and (
             (d.visibility = 'workspace'::text)
             or (d.created_by = current_member_id(d.workspace_id))
             or (d.id = any ((select public.my_entity_grant_ids('document'))::uuid[]) and public.has_entity_grant('document', d.id, d.workspace_id))
           )
      ))
      else null::boolean
    end
  );

-- ── contact_interaction (read) ───────────────────────────────────────────────
drop policy if exists interaction_select_via_contact on public.contact_interaction;
create policy interaction_select_via_contact on public.contact_interaction
  for select to public
  using (
    exists (
      select 1
        from contact c
       where c.id = contact_interaction.contact_id
         and (
           can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
           or (c.id = any ((select public.my_entity_grant_ids('contact'))::uuid[]) and public.has_entity_grant('contact', c.id, c.workspace_id))
         )
    )
  );

-- ── contact_visible_to: the explicit-user twin, plus the grant arm ───────────
-- 234's body, unchanged but for the last check before FALSE.
create or replace function public.contact_visible_to(p_contact_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_c         public.contact%ROWTYPE;
  v_member_id uuid;
  v_role      text;
BEGIN
  SELECT * INTO v_c FROM public.contact WHERE id = p_contact_id;
  IF v_c.id IS NULL THEN RETURN FALSE; END IF;

  IF p_user_id IS NULL THEN RETURN v_c.visibility = 'workspace'; END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_c.workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_c.visibility = 'workspace' THEN RETURN TRUE; END IF;
  IF v_member_id = v_c.created_by_member_id THEN RETURN TRUE; END IF;
  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  IF v_c.visibility = 'team' AND v_c.created_by_member_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM public.team_member tm1
         JOIN public.team_member tm2 ON tm2.team_id = tm1.team_id
        WHERE tm1.member_id = v_member_id
          AND tm2.member_id = v_c.created_by_member_id
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1 FROM public.contact_share cs
        WHERE cs.contact_id = p_contact_id AND cs.shared_with_member_id = v_member_id
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1
         FROM public.contact_share cs
         JOIN public.team_member tm ON tm.team_id = cs.shared_with_team_id
        WHERE cs.contact_id = p_contact_id AND tm.member_id = v_member_id
  ) THEN RETURN TRUE; END IF;

  -- 493: a grant (492) on the contact that reaches this user.
  IF public.entity_grant_reaches('contact', p_contact_id, v_c.workspace_id, p_user_id) THEN RETURN TRUE; END IF;

  RETURN FALSE;
END
$function$;

-- ── company_visible_to: 235's body plus its own grant arm ────────────────────
-- (Its contact check already follows contact_visible_to above.)
create or replace function public.company_visible_to(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_workspace_id uuid;
  v_member_id    uuid;
  v_role         text;
BEGIN
  SELECT c.workspace_id INTO v_workspace_id
    FROM public.company c
   WHERE c.id = p_company_id;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;

  IF p_user_id IS NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.contact ct
       WHERE ct.company_id = p_company_id
         AND ct.merged_into_contact_id IS NULL
         AND ct.visibility = 'workspace'
    );
  END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  -- 493: a grant (492) on the company that reaches this user.
  IF public.entity_grant_reaches('company', p_company_id, v_workspace_id, p_user_id) THEN RETURN TRUE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.contact ct
     WHERE ct.company_id = p_company_id
       AND ct.merged_into_contact_id IS NULL
       AND public.contact_visible_to(ct.id, p_user_id)
  );
END
$function$;
