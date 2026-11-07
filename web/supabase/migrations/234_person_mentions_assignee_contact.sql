-- 234: Repair actions.assignee_contact_id and add contact_visible_to().
--
-- Background: actions.assignee_contact_id has existed on DEV and PROD as
-- undocumented drift (no migration created it — 103/155/221/223 only ever
-- null it out). Its FK pointed at the DEAD legacy plural `contacts` table,
-- not the live `contact` table. On PROD `contacts` has 0 rows against 1,132
-- live contacts, so the constraint could never be satisfied by any real
-- contact. That, plus apply-engine writing the value into context_data jsonb
-- instead of the column, is why "what am I waiting on from <person>" had
-- nothing to find.
--
-- This migration is idempotent and safe to re-run on both environments.

-- 1. Column (exists on DEV+PROD already; created on fresh envs).
ALTER TABLE public.actions ADD COLUMN IF NOT EXISTS assignee_contact_id uuid;

-- 2. Drop any value that isn't a live contact (FK pointed at dead `contacts`;
--    expect 0 rows on both envs).
UPDATE public.actions a SET assignee_contact_id = NULL
 WHERE a.assignee_contact_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.contact c WHERE c.id = a.assignee_contact_id);

-- 3. Repoint the FK at the live table.
ALTER TABLE public.actions DROP CONSTRAINT IF EXISTS actions_assignee_contact_id_fkey;
ALTER TABLE public.actions
  ADD CONSTRAINT actions_assignee_contact_id_fkey
  FOREIGN KEY (assignee_contact_id) REFERENCES public.contact(id) ON DELETE SET NULL;

-- 4. Index — same NAME as the one already on DEV+PROD, so no-op there.
CREATE INDEX IF NOT EXISTS idx_actions_assignee_contact
  ON public.actions (assignee_contact_id) WHERE assignee_contact_id IS NOT NULL;

-- 5. Backfill from applied proposals. Join on result_entity_id — entity_id is
--    the UPDATE target and is NULL for creates. Only fill actions that have
--    no assignee of any kind, so we never overwrite a human/agent assignment.
UPDATE public.actions a
   SET assignee_contact_id = pc.assignee_contact_id
  FROM public.proposed_change pc
  JOIN public.contact c ON c.id = pc.assignee_contact_id AND c.merged_into_contact_id IS NULL
 WHERE pc.status = 'applied'
   AND pc.entity_type = 'action'
   AND pc.change_type IN ('create','update','assign')
   AND pc.result_entity_id = a.id
   AND pc.assignee_contact_id IS NOT NULL
   AND a.workspace_id = c.workspace_id
   AND a.assignee_contact_id IS NULL
   AND a.assignee_id IS NULL
   AND a.assignee_ai_member_id IS NULL;

-- 6. Defensive: the old jsonb shadow apply-engine wrote until this change.
UPDATE public.actions a
   SET assignee_contact_id = (a.context_data->>'assignee_contact_id')::uuid
  FROM public.contact c
 WHERE a.assignee_contact_id IS NULL
   AND a.assignee_id IS NULL AND a.assignee_ai_member_id IS NULL
   AND (a.context_data->>'assignee_contact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND c.id = (a.context_data->>'assignee_contact_id')::uuid
   AND c.workspace_id = a.workspace_id AND c.merged_into_contact_id IS NULL;

-- 7. contact_visible_to(contact_id, user_id): explicit-user twin of
--    can_view_contact (058). can_view_contact keys off auth.uid(), which is
--    NULL under a service-role client — and the chat's eve/MCP/device-token
--    paths all run service-role. A client-controlled attachedContactIds list
--    must therefore be fenced with an explicit requester.
--    NULL requester degrades to "workspace-visible only" (never FALSE-for-all),
--    matching the posture of capture_visible_to / applyCaptureVisibility.
CREATE OR REPLACE FUNCTION public.contact_visible_to(p_contact_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
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
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;  -- not a member of that workspace

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

  RETURN FALSE;
END
$$;

REVOKE EXECUTE ON FUNCTION public.contact_visible_to(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.contact_visible_to(uuid, uuid) TO authenticated, service_role;
