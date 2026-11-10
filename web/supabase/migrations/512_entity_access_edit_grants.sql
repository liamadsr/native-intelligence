-- ============================================================
-- 512: a grant can be view or edit (the shared entity layer, FU-E).
-- ============================================================
-- 492 made the grant store with a `level` column that took 'edit' but whose
-- insert policy refused it, and 494 kept every write path view-only. This
-- turns 'edit' on: an edit grant lets its grantee change what a record SAYS
-- through the same write paths its owner uses, and nothing more.
--
-- WHAT AN EDIT GRANT OPENS (each a permissive policy re-created EXACTLY as it
-- stood on DEV, pg_policies 2026-11-10, with one more OR arm written last;
-- or a 494 restrictive policy re-pointed at entity_view_grant_only):
--   document         its update (title, body, tags, fields) and its search
--                    chunks (document_update, document_chunks_write); its
--                    comments and suggestions (494's comment and
--                    proposed_change restrictives);
--   capture          its update (captures_update), chunks (capture_chunks),
--                    participants, references, decisions and suggestions
--                    (their ALL / write policies), labels, comments and
--                    attachment rows (494's restrictives);
--   contact          its update and its interactions (contact_update,
--                    interaction_manage_via_contact);
--   company          its update (494's company restrictive).
--
-- WHAT IT NEVER OPENS (an edit grant is about content, not ownership):
--   - deleting the record: 494's delete restrictives on document, captures
--     and company stay on entity_grant_only (ANY grant), and the contact
--     delete policy never had a grant arm;
--   - who owns it, who sees it, where it lives, whether it is archived: a
--     column guard (below) refuses a change to those columns from a caller
--     who may write the row ONLY through an edit grant, admins included (369
--     gives an admin no override on a private record);
--   - sharing it on: entity_access_can_share is unchanged (the creator, or
--     an admin for contacts and companies);
--   - deleting someone else's comment: an edit grantee deletes their own;
--   - a guest: has_entity_edit_grant never answers yes for a guest member
--     (can_edit_document never lets a guest edit either).
-- An edit grant also reads: has_entity_grant (492) ignores the level.
--
-- The helpers (pinned search_path, SECURITY DEFINER, as 492's):
--   has_entity_edit_grant(type, id, workspace)  an EDIT grant on the record,
--        in that workspace, reaches auth.uid() (as the member, a team, or a
--        channel they can read), and auth.uid() is not a guest there.
--   my_entity_edit_grant_ids(type)  every id of the kind an edit grant
--        reaches auth.uid() for (495's flat form, level 'edit'): the
--        policies' InitPlan pre-check, so a list costs one lookup per query.
--   entity_edit_grant_on(type, id)  has_entity_edit_grant in the record's
--        own workspace. For a company: a grant on the COMPANY only (a grant
--        on one of its contacts opens the company to reading, never to
--        editing).
--   entity_view_grant_only(type, id)  494's entity_grant_only, less an edit
--        grant: the caller sees the record only through grants and none of
--        them is an edit grant. The content restrictives use it.
--   entity_edit_grant_only(type, id)  the caller's OWN write rule refuses
--        the record and an edit grant lets them: the column guard's question.
--   entity_edit_grant_reaches(type, id, workspace, user)  has_entity_edit_
--        grant for an explicit user (service role; a signed-in caller about
--        themself only), for the agent's write gates below.
--   contact_editable_by (498)  gains the edit-grant arm: the agent's contact
--        writes (src/lib/crm/contact-visibility.ts isContactWritableTo).
--   company_editable_by(company, user)  new: 496's company_visible_to_
--        ungranted plus the edit-grant arm, for the agent's company writes
--        (isCompanyWritableTo). The ungranted twin stays as it was.
--
-- entity_access itself: the insert policy takes 'view' or 'edit'; a new
-- update policy lets whoever may share the record change a grant's LEVEL (a
-- column grant on `level` only; every other column stays fixed, as before).
--
-- Cost: a member with no edit grants pays one empty-array InitPlan per query
-- on the opened policies, and the column guard's trigger fires only when an
-- owner column changes (its WHEN clause). Measured on DEV, see the PR.
--
-- After 492-495 and 498. Idempotent (create or replace, drop … if exists).
-- No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── An edit grant on this record reaches the caller ──────────────────────────
create or replace function public.has_entity_edit_grant(p_type text, p_id uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and coalesce(public.get_member_role(p_workspace) in ('owner', 'admin', 'member'), false)
    and exists (
      select 1
        from public.entity_access g
       where g.workspace_id = p_workspace
         and g.entity_type = p_type
         and g.entity_id = p_id
         and g.level = 'edit'
         and (
           (g.grantee_kind = 'member'
              and g.grantee_member_id = public.current_member_id(p_workspace))
           or (g.grantee_kind = 'team'
              and exists (select 1 from public.team t where t.id = g.grantee_team_id and t.workspace_id = p_workspace)
              and public.is_team_member(g.grantee_team_id))
           or (g.grantee_kind = 'channel'
              and exists (select 1 from public.team_chat_channel c where c.id = g.grantee_channel_id and c.workspace_id = p_workspace)
              and public.team_chat_can_read(g.grantee_channel_id))
         )
    );
$$;

-- ── Every id of a kind an edit grant reaches the caller for (pre-check) ──────
-- 495's my_entity_grant_ids with level 'edit'. Only ever a pre-check:
-- has_entity_edit_grant decides each row, in its own workspace, guests out.
create or replace function public.my_entity_edit_grant_ids(p_type text)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id, m.workspace_id from public.member m where m.user_id = auth.uid()
  ),
  my_teams as (
    select tm.team_id from public.team_member tm where tm.member_id in (select id from me)
  ),
  my_channels as (
    select c.id
      from public.team_chat_channel c
      join me on me.workspace_id = c.workspace_id
     where (c.kind = 'channel' and (c.team_id is null or c.team_id in (select team_id from my_teams)))
        or (c.kind = 'dm' and exists (
              select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
  )
  select coalesce(array_agg(distinct g.entity_id), '{}'::uuid[])
    from public.entity_access g
   where g.entity_type = p_type
     and g.level = 'edit'
     and g.workspace_id in (select workspace_id from me)
     and (
       (g.grantee_kind = 'member' and g.grantee_member_id in (select id from me))
       or (g.grantee_kind = 'team' and g.grantee_team_id in (select team_id from my_teams))
       or (g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels))
     );
$$;

-- ── has_entity_edit_grant in the record's own workspace ──────────────────────
create or replace function public.entity_edit_grant_on(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_id is not null and coalesce(case p_type
    when 'document' then (select public.has_entity_edit_grant('document', d.id, d.workspace_id) from public.document d where d.id = p_id)
    when 'capture' then (select public.has_entity_edit_grant('capture', c.id, c.workspace_id) from public.captures c where c.id = p_id and not c.is_eval)
    when 'contact' then (select public.has_entity_edit_grant('contact', ct.id, ct.workspace_id) from public.contact ct where ct.id = p_id)
    when 'company' then (select public.has_entity_edit_grant('company', co.id, co.workspace_id) from public.company co where co.id = p_id)
    else false
  end, false);
$$;

-- ── Seen only through grants, none of them an edit grant ─────────────────────
create or replace function public.entity_view_grant_only(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.entity_grant_only(p_type, p_id) and not public.entity_edit_grant_on(p_type, p_id);
$$;

-- ── Writable ONLY through an edit grant (the column guard's question) ────────
-- Each kind's own write rule is its permissive policy's arm before this file:
-- document_update (359, 369), captures_update (223), contact_update (058),
-- and for a company its read rule (494: a grant-only reader). Null-safe.
create or replace function public.entity_edit_grant_only(p_type text, p_id uuid)
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
         and not coalesce(public.can_edit_document(d.id, d.workspace_id, d.created_by, d.type, d.slug, d.published_status, d.frontmatter, d.project_id)
               and (d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id)), false)
         and public.has_entity_edit_grant('document', d.id, d.workspace_id))
    when 'capture' then exists (
      select 1 from public.captures c
       where c.id = p_id
         and not coalesce(public.is_workspace_member(c.workspace_id)
               and (c.visibility = 'workspace' or c.user_id = auth.uid()), false)
         and public.has_entity_edit_grant('capture', c.id, c.workspace_id))
    when 'contact' then exists (
      select 1 from public.contact ct
       where ct.id = p_id
         and not coalesce(public.can_edit_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id), false)
         and public.has_entity_edit_grant('contact', ct.id, ct.workspace_id))
    when 'company' then public.entity_grant_only('company', p_id) and public.entity_edit_grant_on('company', p_id)
    else false
  end, false);
$$;

-- ── has_entity_edit_grant for an explicit user (the agent's write gates) ─────
-- 492's entity_grant_reaches with level 'edit' and no guest. Asked by the
-- service role, or by a signed-in user about themself only.
create or replace function public.entity_edit_grant_reaches(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user is not null
    and (auth.uid() is null or auth.uid() = p_user)
    and exists (
      select 1
        from public.member me
        join public.entity_access g
          on g.workspace_id = me.workspace_id
       where me.user_id = p_user
         and me.workspace_id = p_workspace
         and me.role in ('owner', 'admin', 'member')
         and g.entity_type = p_type
         and g.entity_id = p_id
         and g.level = 'edit'
         and (
           (g.grantee_kind = 'member' and g.grantee_member_id = me.id)
           or (g.grantee_kind = 'team' and exists (
                 select 1 from public.team t
                   join public.team_member tm on tm.team_id = t.id
                  where t.id = g.grantee_team_id and t.workspace_id = p_workspace and tm.member_id = me.id))
           or (g.grantee_kind = 'channel' and exists (
                 select 1 from public.team_chat_channel c
                  where c.id = g.grantee_channel_id
                    and c.workspace_id = p_workspace
                    and (
                      (c.kind = 'channel' and (c.team_id is null or exists (
                         select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = me.id)))
                      or (c.kind = 'dm' and exists (
                         select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
                    )))
         )
    );
$$;

revoke all on function public.has_entity_edit_grant(text, uuid, uuid) from public, anon;
revoke all on function public.my_entity_edit_grant_ids(text) from public, anon;
revoke all on function public.entity_edit_grant_on(text, uuid) from public, anon;
revoke all on function public.entity_view_grant_only(text, uuid) from public, anon;
revoke all on function public.entity_edit_grant_only(text, uuid) from public, anon;
revoke all on function public.entity_edit_grant_reaches(text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.has_entity_edit_grant(text, uuid, uuid) to authenticated, service_role;
grant execute on function public.my_entity_edit_grant_ids(text) to authenticated, service_role;
grant execute on function public.entity_edit_grant_on(text, uuid) to authenticated, service_role;
grant execute on function public.entity_view_grant_only(text, uuid) to authenticated, service_role;
grant execute on function public.entity_edit_grant_only(text, uuid) to authenticated, service_role;
grant execute on function public.entity_edit_grant_reaches(text, uuid, uuid, uuid) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 494's restrictives: content writes refuse a VIEW-only grantee now
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists company_update_not_by_grant on public.company;
create policy company_update_not_by_grant on public.company
  as restrictive for update to public
  using (not public.entity_view_grant_only('company', id));

drop policy if exists comment_insert_not_by_grant on public.comment;
create policy comment_insert_not_by_grant on public.comment
  as restrictive for insert to public
  with check (not public.entity_view_grant_only(commentable_type::text, commentable_id));

drop policy if exists comment_update_not_by_grant on public.comment;
create policy comment_update_not_by_grant on public.comment
  as restrictive for update to public
  using (not public.entity_view_grant_only(commentable_type::text, commentable_id));

-- An edit grantee deletes their own comments, never the owner's.
drop policy if exists comment_delete_not_by_grant on public.comment;
create policy comment_delete_not_by_grant on public.comment
  as restrictive for delete to public
  using (
    not public.entity_grant_only(commentable_type::text, commentable_id)
    or (public.entity_edit_grant_on(commentable_type::text, commentable_id)
        and author_id in (select m.id from public.member m where m.user_id = auth.uid()))
  );

drop policy if exists capture_label_insert_not_by_grant on public.capture_label;
create policy capture_label_insert_not_by_grant on public.capture_label
  as restrictive for insert to public
  with check (not public.entity_view_grant_only('capture', capture_id));

drop policy if exists capture_label_update_not_by_grant on public.capture_label;
create policy capture_label_update_not_by_grant on public.capture_label
  as restrictive for update to public
  using (not public.entity_view_grant_only('capture', capture_id));

drop policy if exists capture_label_delete_not_by_grant on public.capture_label;
create policy capture_label_delete_not_by_grant on public.capture_label
  as restrictive for delete to public
  using (not public.entity_view_grant_only('capture', capture_id));

drop policy if exists attachments_delete_not_by_grant on public.attachments;
create policy attachments_delete_not_by_grant on public.attachments
  as restrictive for delete to public
  using (user_id = auth.uid() or note_id is null or not public.entity_view_grant_only('capture', note_id));

drop policy if exists proposed_change_update_not_by_grant on public.proposed_change;
create policy proposed_change_update_not_by_grant on public.proposed_change
  as restrictive for update to public
  using (document_id is null or not public.entity_view_grant_only('document', document_id));

-- (Unchanged on purpose: document_delete_not_by_grant, captures_delete_not_by_
-- grant and company_delete_not_by_grant keep entity_grant_only: no grant, of
-- any level, deletes a record.)

-- ════════════════════════════════════════════════════════════════════════════
-- The permissive write policies: each as it stood, plus the edit-grant arm
-- ════════════════════════════════════════════════════════════════════════════
-- The arm, for a row r of kind K:
--     (r.id = any ((select public.my_entity_edit_grant_ids('K'))::uuid[])
--      and public.has_entity_edit_grant('K', r.id, r.workspace_id))

-- ── document ─────────────────────────────────────────────────────────────────
-- Never the product doc or a spec page (can_edit_document keeps those to an
-- owner or admin).
drop policy if exists document_update on public.document;
create policy document_update on public.document
  for update to authenticated
  using (
    (can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id)
      and ((visibility = 'workspace'::text) or (created_by = current_member_id(workspace_id))))
    or (id = any ((select public.my_entity_edit_grant_ids('document'))::uuid[])
        and public.has_entity_edit_grant('document', id, workspace_id)
        and not public.is_product_doc(workspace_id, id)
        and coalesce(type, 'note') <> 'spec')
  )
  with check (
    (can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id)
      and ((visibility = 'workspace'::text) or (created_by = current_member_id(workspace_id))))
    or (id = any ((select public.my_entity_edit_grant_ids('document'))::uuid[])
        and public.has_entity_edit_grant('document', id, workspace_id)
        and not public.is_product_doc(workspace_id, id)
        and coalesce(type, 'note') <> 'spec')
  );

drop policy if exists document_chunks_write on public.document_chunks;
create policy document_chunks_write on public.document_chunks
  for all to public
  using (
    is_workspace_member(workspace_id) and (exists (
      select 1 from document d
       where d.id = document_chunks.document_id
         and d.workspace_id = document_chunks.workspace_id
         and ((d.visibility = 'workspace'::text)
              or (d.created_by = current_member_id(d.workspace_id))
              or (d.id = any ((select public.my_entity_edit_grant_ids('document'))::uuid[])
                  and public.has_entity_edit_grant('document', d.id, d.workspace_id)))))
  )
  with check (
    is_workspace_member(workspace_id) and (exists (
      select 1 from document d
       where d.id = document_chunks.document_id
         and d.workspace_id = document_chunks.workspace_id
         and ((d.visibility = 'workspace'::text)
              or (d.created_by = current_member_id(d.workspace_id))
              or (d.id = any ((select public.my_entity_edit_grant_ids('document'))::uuid[])
                  and public.has_entity_edit_grant('document', d.id, d.workspace_id)))))
  );

-- ── captures ─────────────────────────────────────────────────────────────────
drop policy if exists captures_update on public.captures;
create policy captures_update on public.captures
  for update to public
  using (
    is_workspace_member(workspace_id)
    and ((visibility = 'workspace'::text)
         or (user_id = auth.uid())
         or (id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
             and public.has_entity_edit_grant('capture', id, workspace_id)))
  );

drop policy if exists capture_chunks_insert on public.capture_chunks;
create policy capture_chunks_insert on public.capture_chunks
  for insert to public
  with check (exists (
    select 1 from captures c
     where c.id = capture_chunks.capture_id
       and is_workspace_member(c.workspace_id)
       and ((c.visibility = 'workspace'::text)
            or (c.user_id = auth.uid())
            or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))));

drop policy if exists capture_chunks_delete on public.capture_chunks;
create policy capture_chunks_delete on public.capture_chunks
  for delete to public
  using (exists (
    select 1 from captures c
     where c.id = capture_chunks.capture_id
       and is_workspace_member(c.workspace_id)
       and ((c.visibility = 'workspace'::text)
            or (c.user_id = auth.uid())
            or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))));

drop policy if exists "Workspace members can manage capture participants" on public.capture_participant;
create policy "Workspace members can manage capture participants" on public.capture_participant
  for all to public
  using (exists (
    select 1 from captures c
     where c.id = capture_participant.capture_id
       and is_workspace_member(c.workspace_id)
       and ((c.visibility = 'workspace'::text)
            or (c.user_id = auth.uid())
            or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))));

drop policy if exists capture_references_all on public.capture_references;
create policy capture_references_all on public.capture_references
  for all to public
  using (exists (
    select 1 from captures c
     where c.id = capture_references.capture_id
       and is_workspace_member(c.workspace_id)
       and ((c.visibility = 'workspace'::text)
            or (c.user_id = auth.uid())
            or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))));

drop policy if exists "Workspace members can manage decisions" on public.decision;
create policy "Workspace members can manage decisions" on public.decision
  for all to public
  using (exists (
    select 1 from captures c
     where c.id = decision.capture_id
       and is_workspace_member(c.workspace_id)
       and ((c.visibility = 'workspace'::text)
            or (c.user_id = auth.uid())
            or (decision.confirmation = 'confirmed'::text)
            or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))));

-- ── proposed_change: its capture arms ────────────────────────────────────────
drop policy if exists "Members can insert proposed changes" on public.proposed_change;
create policy "Members can insert proposed changes" on public.proposed_change
  for insert to public
  with check (
    (workspace_id in (select member.workspace_id from member where member.user_id = auth.uid()))
    and (exists (
      select 1 from captures c
       where c.id = proposed_change.capture_id
         and ((c.visibility = 'workspace'::text)
              or (c.user_id = auth.uid())
              or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                  and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))))
  );

drop policy if exists "Members can delete proposed changes" on public.proposed_change;
create policy "Members can delete proposed changes" on public.proposed_change
  for delete to public
  using (
    (workspace_id in (select member.workspace_id from member where member.user_id = auth.uid()))
    and (exists (
      select 1 from captures c
       where c.id = proposed_change.capture_id
         and ((c.visibility = 'workspace'::text)
              or (c.user_id = auth.uid())
              or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                  and public.has_entity_edit_grant('capture', c.id, c.workspace_id)))))
  );

drop policy if exists "Members can update proposed changes" on public.proposed_change;
create policy "Members can update proposed changes" on public.proposed_change
  for update to public
  using (
    (workspace_id in (select member.workspace_id from member where member.user_id = auth.uid()))
    and (
      ((capture_id is not null) and (exists (
        select 1 from captures c
         where c.id = proposed_change.capture_id
           and ((c.visibility = 'workspace'::text)
                or (c.user_id = auth.uid())
                or (c.id = any ((select public.my_entity_edit_grant_ids('capture'))::uuid[])
                    and public.has_entity_edit_grant('capture', c.id, c.workspace_id))))))
      or ((document_id is not null) and (exists (
        select 1 from document d
         where d.id = proposed_change.document_id
           and (d.workspace_id in (select member.workspace_id from member where member.user_id = auth.uid())))))
      or ((conversation_id is not null) and (exists (
        select 1 from chat_conversations cc
         where cc.id = proposed_change.conversation_id and cc.user_id = auth.uid())))
    )
  );

-- ── contact ──────────────────────────────────────────────────────────────────
drop policy if exists contact_update on public.contact;
create policy contact_update on public.contact
  for update to public
  using (
    can_edit_contact(id, workspace_id, visibility, created_by_member_id)
    or (id = any ((select public.my_entity_edit_grant_ids('contact'))::uuid[])
        and public.has_entity_edit_grant('contact', id, workspace_id))
  );

drop policy if exists interaction_manage_via_contact on public.contact_interaction;
create policy interaction_manage_via_contact on public.contact_interaction
  for all to public
  using (exists (
    select 1 from contact c
     where c.id = contact_interaction.contact_id
       and (can_edit_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
            or (c.id = any ((select public.my_entity_edit_grant_ids('contact'))::uuid[])
                and public.has_entity_edit_grant('contact', c.id, c.workspace_id)))));

-- ════════════════════════════════════════════════════════════════════════════
-- The column guard: an edit grant never changes ownership, visibility,
-- workspace or archive state
-- ════════════════════════════════════════════════════════════════════════════
-- Fires only when one of those columns changes (each trigger's WHEN), and
-- only refuses a signed-in caller whose write rests on an edit grant alone.
-- The service role and server functions pass, as 359's guard lets them.
create or replace function public.entity_edit_grant_column_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') or auth.uid() is null then
    return new;
  end if;
  if public.entity_edit_grant_only(tg_argv[0], old.id) then
    raise exception 'an edit grant changes what this says, not who owns or sees it' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.entity_edit_grant_column_guard() from public, anon, authenticated;

drop trigger if exists entity_edit_grant_column_guard on public.document;
create trigger entity_edit_grant_column_guard
  before update on public.document
  for each row
  when (old.workspace_id is distinct from new.workspace_id
     or old.created_by is distinct from new.created_by
     or old.visibility is distinct from new.visibility
     or old.status is distinct from new.status
     or old.published_status is distinct from new.published_status
     or old.slug is distinct from new.slug
     or old.type is distinct from new.type
     or old.canon_key is distinct from new.canon_key
     or old.project_id is distinct from new.project_id)
  execute function public.entity_edit_grant_column_guard('document');

drop trigger if exists entity_edit_grant_column_guard on public.captures;
create trigger entity_edit_grant_column_guard
  before update on public.captures
  for each row
  when (old.workspace_id is distinct from new.workspace_id
     or old.user_id is distinct from new.user_id
     or old.visibility is distinct from new.visibility
     or old.is_eval is distinct from new.is_eval
     or (old.status = 'archived') is distinct from (new.status = 'archived'))
  execute function public.entity_edit_grant_column_guard('capture');

drop trigger if exists entity_edit_grant_column_guard on public.contact;
create trigger entity_edit_grant_column_guard
  before update on public.contact
  for each row
  when (old.workspace_id is distinct from new.workspace_id
     or old.created_by_member_id is distinct from new.created_by_member_id
     or old.visibility is distinct from new.visibility
     or old.merged_into_contact_id is distinct from new.merged_into_contact_id)
  execute function public.entity_edit_grant_column_guard('contact');

drop trigger if exists entity_edit_grant_column_guard on public.company;
create trigger entity_edit_grant_column_guard
  before update on public.company
  for each row
  when (old.workspace_id is distinct from new.workspace_id
     or old.is_workspace_company is distinct from new.is_workspace_company)
  execute function public.entity_edit_grant_column_guard('company');

-- ════════════════════════════════════════════════════════════════════════════
-- entity_access: grants of either level, and a grant's level can change
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists entity_access_insert on public.entity_access;
create policy entity_access_insert on public.entity_access
  for insert to authenticated
  with check (
    granted_by = public.current_member_id(workspace_id)
    and level in ('view', 'edit')
    and public.entity_access_can_share(entity_type, entity_id, workspace_id)
    and (grantee_kind <> 'team' or exists (
          select 1 from public.team t
           where t.id = grantee_team_id and t.workspace_id = entity_access.workspace_id
             and (not t.is_private or public.is_team_member(t.id))))
    and (grantee_kind <> 'channel' or public.team_chat_can_read(grantee_channel_id))
  );

-- Only the level: no other column is granted for update.
grant update (level) on table public.entity_access to authenticated;

drop policy if exists entity_access_update on public.entity_access;
create policy entity_access_update on public.entity_access
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.entity_access_can_share(entity_type, entity_id, workspace_id)
  )
  with check (
    level in ('view', 'edit')
    and public.is_workspace_member(workspace_id)
    and public.entity_access_can_share(entity_type, entity_id, workspace_id)
  );

-- ════════════════════════════════════════════════════════════════════════════
-- The explicit-user edit rules the agent's writes ask
-- ════════════════════════════════════════════════════════════════════════════
-- 498's body, plus an edit grant on the contact that reaches this user.
create or replace function public.contact_editable_by(p_contact_id uuid, p_user_id uuid)
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
  IF p_contact_id IS NULL OR p_user_id IS NULL THEN RETURN FALSE; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RETURN FALSE; END IF;

  SELECT * INTO v_c FROM public.contact WHERE id = p_contact_id;
  IF v_c.id IS NULL THEN RETURN FALSE; END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_c.workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_member_id = v_c.created_by_member_id THEN RETURN TRUE; END IF;
  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;
  IF v_c.visibility = 'workspace' THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1 FROM public.contact_share cs
        WHERE cs.contact_id = p_contact_id
          AND cs.shared_with_member_id = v_member_id
          AND cs.access_level = 'edit'
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1
         FROM public.contact_share cs
         JOIN public.team_member tm ON tm.team_id = cs.shared_with_team_id
        WHERE cs.contact_id = p_contact_id
          AND tm.member_id = v_member_id
          AND cs.access_level = 'edit'
  ) THEN RETURN TRUE; END IF;

  -- 512: an edit grant (any view grant never counts).
  IF public.entity_edit_grant_reaches('contact', p_contact_id, v_c.workspace_id, p_user_id) THEN RETURN TRUE; END IF;

  RETURN FALSE;
END
$function$;

revoke all on function public.contact_editable_by(uuid, uuid) from public, anon;
grant execute on function public.contact_editable_by(uuid, uuid) to authenticated, service_role;

-- 496's company_visible_to_ungranted (the company write rule), plus an edit
-- grant on the company itself. Asked by the service role, or by a signed-in
-- user about themself only.
create or replace function public.company_editable_by(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_workspace_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL THEN RETURN FALSE; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RETURN FALSE; END IF;
  SELECT c.workspace_id INTO v_workspace_id FROM public.company c WHERE c.id = p_company_id;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;
  IF public.company_visible_to_ungranted(p_company_id, p_user_id) THEN RETURN TRUE; END IF;
  RETURN public.entity_edit_grant_reaches('company', p_company_id, v_workspace_id, p_user_id);
END
$function$;

revoke all on function public.company_editable_by(uuid, uuid) from public, anon;
grant execute on function public.company_editable_by(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
