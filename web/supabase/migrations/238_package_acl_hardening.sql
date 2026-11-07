-- ============================================================================
-- 238: Package ACL hardening — one visibility predicate, everywhere.
--
-- Prep for context packages powering live agents. Before packages gate
-- anything an agent says on a call, the visibility rules must live in ONE
-- place. Today they are implemented three times (RLS policies from migs
-- 124/127, canSee/canMutate in src/lib/ai/tools/packages.ts for the
-- service-role MCP path, and a narrower fence in src/lib/flows/context-pack.ts)
-- and the copies disagree:
--
--   * knowledge_brief_select (mig 123) is bare workspace membership, so the
--     nightly compiled brief of a personal/team package leaks to the whole
--     workspace — in-app and over the MCP brief resource.
--   * knowledge_package_item_select (mig 193 rewrite) checks only workspace
--     membership on the parent, so any member can enumerate a team/personal
--     package's pins (titles, competitor names) by id.
--   * canMutate in packages.ts lets ANY member mutate ANY non-personal
--     package over service-role MCP, while RLS (mig 127) refuses the same
--     user on the REST path. The RLS item INSERT/DELETE policies have the
--     same any-member looseness for non-personal packages.
--
-- Structure: the rules live in COLUMN-BASED core predicates
-- (package_row_visible_to / package_row_editable_by) that take the package
-- row's fields directly — policies on knowledge_package itself call these
-- with their own columns, which avoids the self-lookup that breaks
-- INSERT … RETURNING (a STABLE function's snapshot cannot see the row being
-- inserted, so a by-id lookup inside the SELECT policy makes every INSERT
-- fail its RETURNING check with 42501 — found the hard way in review).
-- ID-BASED wrappers (package_visible_to / package_editable_by) serve child
-- tables and code callers, following the explicit-requester convention from
-- mig 237 (p_user_id DEFAULT NULL → session callers resolve via auth.uid();
-- sessionless service-role callers assert the user; a live session may not
-- assert a DIFFERENT user).
--
-- Membership is a precondition in BOTH predicates — a creator or share
-- grantee who has left the workspace has no access, matching RLS on every
-- other surface.
--
-- SECURITY DEFINER sidesteps the RLS-recursion problem that shaped mig 127's
-- share policies (definer queries bypass RLS on the tables they read).
--
-- Policies are scoped TO authenticated (mig 193 style): anon holds default
-- table grants but no EXECUTE on these functions, and an un-scoped policy
-- calling a revoked function turns anon's silent empty result into a 42501.
--
-- Code counterpart (same PR): src/lib/knowledge/package-acl.ts wraps the
-- id-based functions via RPC for every service-role path; packages.ts
-- canMutate and the MCP brief resources route through it.
--
-- DEPLOY ORDER: apply this migration BEFORE merging the code that calls the
-- RPCs — the wrappers fail closed, so code-before-migration disables package
-- mutations and hides package briefs until the functions exist.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Column-based core predicates (used by policies on knowledge_package)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.package_row_visible_to(
  p_id           uuid,
  p_workspace_id uuid,
  p_visibility   text,
  p_team_id      uuid,
  p_created_by   uuid,
  p_user_id      uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session   uuid := auth.uid();
  v_uid       uuid := COALESCE(p_user_id, auth.uid());
  v_member_id uuid;
BEGIN
  -- Unlike _resolve_requester this returns false instead of raising: it runs
  -- inside RLS policies, where an exception would fail the whole query.
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF v_session IS NOT NULL AND p_user_id IS NOT NULL AND v_session <> p_user_id THEN
    RETURN false;
  END IF;

  -- Membership precondition: no member row in the package's workspace → no
  -- access, regardless of creatorship or shares.
  SELECT m.id INTO v_member_id
    FROM public.member m
   WHERE m.user_id = v_uid AND m.workspace_id = p_workspace_id;
  IF v_member_id IS NULL THEN RETURN false; END IF;

  IF p_visibility = 'workspace' THEN RETURN true; END IF;
  IF p_created_by = v_uid THEN RETURN true; END IF;
  IF p_visibility = 'team' AND p_team_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.team_member tm
        WHERE tm.team_id = p_team_id AND tm.member_id = v_member_id
     ) THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.knowledge_package_share s
     WHERE s.package_id = p_id
       AND (
         s.shared_with_member_id = v_member_id
         OR (s.shared_with_team_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.team_member tm
                WHERE tm.team_id = s.shared_with_team_id
                  AND tm.member_id = v_member_id))
       )
  );
END
$$;
REVOKE EXECUTE ON FUNCTION public.package_row_visible_to(uuid, uuid, text, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.package_row_visible_to(uuid, uuid, text, uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.package_row_editable_by(
  p_id           uuid,
  p_workspace_id uuid,
  p_visibility   text,
  p_created_by   uuid,
  p_user_id      uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session   uuid := auth.uid();
  v_uid       uuid := COALESCE(p_user_id, auth.uid());
  v_member_id uuid;
  v_role      text;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF v_session IS NOT NULL AND p_user_id IS NOT NULL AND v_session <> p_user_id THEN
    RETURN false;
  END IF;

  -- Membership precondition comes BEFORE the creator check: an ex-member
  -- creator has no edit rights.
  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = v_uid AND m.workspace_id = p_workspace_id;
  IF v_member_id IS NULL THEN RETURN false; END IF;

  IF p_created_by = v_uid THEN RETURN true; END IF;

  -- Admins/owners may edit any package except someone else's personal one.
  IF p_visibility <> 'personal' AND v_role IN ('admin', 'owner') THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.knowledge_package_share s
     WHERE s.package_id = p_id
       AND s.access_level = 'edit'
       AND (
         s.shared_with_member_id = v_member_id
         OR (s.shared_with_team_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.team_member tm
                WHERE tm.team_id = s.shared_with_team_id
                  AND tm.member_id = v_member_id))
       )
  );
END
$$;
REVOKE EXECUTE ON FUNCTION public.package_row_editable_by(uuid, uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.package_row_editable_by(uuid, uuid, text, uuid, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Id-based wrappers (child-table policies + code callers via RPC)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.package_visible_to(
  p_package_id uuid,
  p_user_id    uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT public.package_row_visible_to(p.id, p.workspace_id, p.visibility, p.team_id, p.created_by, p_user_id)
       FROM public.knowledge_package p
      WHERE p.id = p_package_id),
    false
  );
$$;
REVOKE EXECUTE ON FUNCTION public.package_visible_to(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.package_visible_to(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.package_editable_by(
  p_package_id uuid,
  p_user_id    uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT public.package_row_editable_by(p.id, p.workspace_id, p.visibility, p.created_by, p_user_id)
       FROM public.knowledge_package p
      WHERE p.id = p_package_id),
    false
  );
$$;
REVOKE EXECUTE ON FUNCTION public.package_editable_by(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.package_editable_by(uuid, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. knowledge_package — SELECT/UPDATE through the column predicates (no
--    self-lookup: INSERT … RETURNING works because the policy reads the new
--    row's own columns).
--    INSERT unchanged: member + created_by = auth.uid(). DELETE unchanged:
--    creator or workspace-visible admin/owner — deletion stays stricter than
--    editing on purpose.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS knowledge_package_select ON public.knowledge_package;
CREATE POLICY knowledge_package_select ON public.knowledge_package
  FOR SELECT TO authenticated
  USING (public.package_row_visible_to(id, workspace_id, visibility, team_id, created_by));

DROP POLICY IF EXISTS knowledge_package_update ON public.knowledge_package;
CREATE POLICY knowledge_package_update ON public.knowledge_package
  FOR UPDATE TO authenticated
  USING (public.package_row_editable_by(id, workspace_id, visibility, created_by));

-- ----------------------------------------------------------------------------
-- 4. knowledge_package_item — pins are as visible as their package, and as
--    editable as their package. This tightens BOTH directions: mig 193's
--    SELECT (any workspace member) narrows to package visibility, and mig
--    124's INSERT/DELETE (any member, for non-personal packages) narrows to
--    package editors.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS knowledge_package_item_select ON public.knowledge_package_item;
CREATE POLICY knowledge_package_item_select ON public.knowledge_package_item
  FOR SELECT TO authenticated
  USING (public.package_visible_to(package_id));

DROP POLICY IF EXISTS knowledge_package_item_insert ON public.knowledge_package_item;
CREATE POLICY knowledge_package_item_insert ON public.knowledge_package_item
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND public.package_editable_by(package_id)
  );

DROP POLICY IF EXISTS knowledge_package_item_delete ON public.knowledge_package_item;
CREATE POLICY knowledge_package_item_delete ON public.knowledge_package_item
  FOR DELETE TO authenticated
  USING (public.package_editable_by(package_id));

-- ----------------------------------------------------------------------------
-- 5. knowledge_brief — the leak fix. Package-scoped briefs (the nightly
--    ≤900-word compiled summary of a package's contents) now require package
--    visibility; workspace/project briefs keep bare workspace membership
--    (projects are workspace-flat).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS knowledge_brief_select ON public.knowledge_brief;
CREATE POLICY knowledge_brief_select ON public.knowledge_brief
  FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      scope_type <> 'package'
      OR (scope_id IS NOT NULL AND public.package_visible_to(scope_id))
    )
  );
