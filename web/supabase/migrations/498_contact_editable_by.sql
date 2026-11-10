-- ============================================================
-- 498: contact_editable_by, the contact EDIT rule for an explicit user (the
-- shared entity layer, phase 6 review).
-- ============================================================
-- The agent's contact writes run on a service-role client, where RLS and
-- auth.uid() are out of the picture, so they ask a function for the person
-- first. They asked contact_visible_to_ungranted (495), which is the READ
-- rule without the grant arm. But contact_update (058) keys on
-- can_edit_contact, which is narrower than reading:
--
--   can see the contact                     can edit it
--   ------------------------------------    ------------------------------
--   its creator                             its creator
--   an owner or admin                       an owner or admin
--   anyone, when visibility = 'workspace'   anyone, when 'workspace'
--   a teammate of the creator ('team')      no
--   a contact_share, at any access_level    only access_level = 'edit'
--
-- So a teammate, or a member the contact was shared to for viewing, could
-- have their agent set its custom fields (set_custom_fields, 496) or rewrite
-- it (update_contact, update_crm_contact, enrich_contact), while the same
-- write from the app was refused by RLS. Verified on DEV in a rolled-back
-- transaction: the member's own UPDATE changed 0 rows on both contacts, and
-- contact_visible_to_ungranted said true for both.
--
-- contact_editable_by(contact, user) is can_edit_contact for an explicit
-- user, read from the row itself. src/lib/crm/contact-visibility.ts
-- (isContactWritableTo) asks it instead. It takes no grant (492 grants only
-- ever VIEW). Asked by the service role, or by a signed-in user about
-- themself only (as 495 did for the grant arms): someone else's edit rights
-- are not theirs to probe.
--
-- After 058 and 495. Idempotent (create or replace). No backslashes anywhere
-- in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

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

  RETURN FALSE;
END
$function$;

revoke all on function public.contact_editable_by(uuid, uuid) from public, anon;
grant execute on function public.contact_editable_by(uuid, uuid) to authenticated, service_role;
