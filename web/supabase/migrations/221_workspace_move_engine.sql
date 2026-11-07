-- 221: workspace move engine — move actions, projects, documents, initiatives,
-- and captures (v3) cleanly across workspaces.
--
-- WHOLE-WORKSPACE MOVES ARE NOT A LOOP OVER THESE RPCs. merge_workspace
-- (migration 402) folds one workspace into another in one transaction and
-- SUPERSEDES the sever rules below for that case: nothing is severed except
-- for a provider both sides have (task links keep the URL, as here; CRM ids
-- are cleared) — PR links, agent runs, shares, external tasks when the
-- integration comes over, cross-call claims and links all re-stamp; teams
-- keep their shape by default (folding is the person's choice); labels
-- union by name and are created rather than dropped, and the move log's FKs
-- no longer cascade (402 dropped them). These RPCs stay the right tool for
-- moving ONE entity between two workspaces that both keep existing.
--
-- Prior art: move_capture v2 (migration 155) is the reference implementation.
-- This migration generalizes it into shared internal helpers plus one public
-- RPC per entity, and upgrades move_capture in place (same 5-arg signature,
-- so the shipped route keeps working). The design went through an
-- adversarial review; the decisions below each cite the failure they close.
--
--   * IDENTIFIERS: PRESERVED WHEN FREE, REISSUED ONLY ON COLLISION.
--     v2 preserved unconditionally and rolled the whole move back on a
--     (workspace_id, identifier) collision (23505) while never advancing the
--     destination team's counter — leaving a landmine where a future insert
--     re-mints an imported identifier. v3 keeps every identifier that is
--     free in the destination (they are the product's stable handles: PR
--     titles, Slack messages, muscle memory), renumbers just the colliding
--     subset from a WATERMARK (max of the team counter and the highest
--     existing numeric suffix for the prefix — the counter alone is not a
--     watermark: v2 imports and the app-side allocator both bypassed it),
--     records the old handle in the new actions.previous_identifier column
--     so search still finds it, and finally raises the counter over
--     everything it imported. generate_action_identifier() is also replaced
--     with a collision-skipping version, which retroactively defuses the
--     landmines v2 already planted.
--   * ROLE GATE (delete-parity). v2 allowed any member — even a guest — of
--     both workspaces to move data. A move is a superset of deletion
--     (irreversible source removal plus mover-controlled read), so the
--     source side now requires owner/admin, or entity ownership for plain
--     members; guests are refused outright on either side. A caller with NO
--     source membership gets P0002 ('not found'), not 42501 — the
--     42501/P0002 split was an existence oracle for foreign workspaces.
--   * AUDIT. Every move writes workspace_move_log rows.
--   * LABELS REMAP BY NAME (case-insensitive) where the destination has a
--     same-named label; unmatched junction rows are deleted; labels are
--     never auto-created.
--   * MEMBER REFS TRANSLATE BY user_id (assignees, leads, owners, claim
--     authors/subjects, document authors, decision deciders, and — new —
--     comment authors, whose ON DELETE CASCADE would otherwise let a later
--     source-workspace offboarding silently delete destination comments).
--     Untranslatable comment authors remain the one accepted dangle
--     (NOT NULL + polymorphic; documented since migration 103).
--   * EXTERNAL TASK LINKS ARE SEVERED, NOT RE-STAMPED. A re-stamped
--     action_external_task row makes the provider echo authenticate against
--     the destination's Jira/Linear/Asana account for a source-tenant issue
--     id (the exact cross-site hazard 216's external_scope exists for). The
--     remote URL is appended to actions.links so the reference survives,
--     and the severed links are disclosed in preflight + counts.
--   * PUBLIC SHARES: DEACTIVATED IN PLACE, NEVER RE-STAMPED. v2 re-stamped
--     share.workspace_id, which handed share_comment rows (external
--     commenters' names/emails/content — RLS resolves through the parent
--     share's workspace) to the destination. v3 leaves the share row in the
--     source with is_active = false: token dead, comments stay where they
--     were authorized.
--   * AGENT RUNS ARE DELETED. agent_run carries repo_full_name / branch /
--     pr_url / log_tail under workspace-wide SELECT; re-stamping would leak
--     a private repo's identity and stdout into the destination.
--   * THE CAPTURE'S AI THREAD IS UNLINKED, NOT MOVED. Re-stamping the
--     conversation would (a) strand it when the mover isn't its owner
--     (personal RLS + destination workspace filter = unreachable by
--     everyone) and (b) let the claim-extraction path re-read pre-move
--     source-workspace content into destination-visible claims. Severing
--     chat_conversations.capture_id frees the unique capture index so the
--     destination can mint a fresh thread.
--   * claim_source.workspace_id IS RE-STAMPED for moved claims (v2 bug:
--     moved claims rendered with zero evidence in the destination forever).
--   * PARTICIPANT-CONTACT COPIES ARE VISIBILITY-GATED. v2 copied private
--     contacts (notes, phone, LinkedIn) the mover could not see, and
--     re-attributed them to the mover. v3 copies only contacts the mover
--     can already view (can_view_contact).
--   * DOCUMENT DRAFTS TRANSLATE (author by user_id) instead of being
--     deleted; only drafts whose author has no destination membership are
--     dropped, and the count is disclosed.
--   * KNOWLEDGE BRIEFS: source_fingerprint is NULLED (both workspaces, plus
--     moved-project scopes) so the weaver recompiles on its next pass while
--     the stale-but-useful content keeps serving. Deleting them would blank
--     the AI's world model for up to a day per move.
--   * RESIDUE CLEANUP: source-workspace knowledge_package_item pins,
--     notifications targeting moved entities, email_thread_index.linked_*,
--     and attention_item cards for moved proposals are removed.
--   * ZERO STORAGE WORK. Since migration 128 the attachments bucket
--     authorizes via the attachments ROW (workspace membership), so
--     re-stamping attachments.workspace_id re-points storage access by
--     itself. The route-side object copy (which duplicated bytes and
--     orphaned originals) is removed with this change.
--
-- Known accepted limitations (unchanged from v2, documented on purpose):
--   * Row locks don't block concurrent INSERTs into child tables; a comment
--     or proposal landing mid-move can split (103's caveat carries over).
--   * In-flight Inngest jobs keyed on (entity_id, workspace_id) no-op with
--     a 'skipped' log if the entity moves mid-run.
--   * tracked_job.source / view.filters / agent_run.resources hold
--     free-form JSONB references that cannot be rewritten generically.
--   * Source-workspace tabs other than the mover's learn about the move
--     only on refetch (realtime UPDATE events don't match their workspace
--     filter).
--
-- New errcodes (on top of v2's P0002/P0003/P0004/22023/42501):
--   P0005 — the entity refuses to move (the '__default__' project).

-- ============================================================
-- 0. Schema additions
-- ============================================================

-- The audit trail. Deliberately NO foreign key on moved_by: the row must
-- survive account deletion.
CREATE TABLE IF NOT EXISTS public.workspace_move_log (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type               text NOT NULL,
  entity_id                 uuid NOT NULL,
  source_workspace_id       uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  destination_workspace_id  uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  moved_by                  uuid NOT NULL,
  counts                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_move_log_source_idx
  ON public.workspace_move_log (source_workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_move_log_dest_idx
  ON public.workspace_move_log (destination_workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_move_log_entity_idx
  ON public.workspace_move_log (entity_type, entity_id);

ALTER TABLE public.workspace_move_log ENABLE ROW LEVEL SECURITY;

-- Members of either side may read the trail. Writes happen only inside the
-- SECURITY DEFINER move RPCs (no INSERT/UPDATE/DELETE policies).
DROP POLICY IF EXISTS workspace_move_log_select ON public.workspace_move_log;
CREATE POLICY workspace_move_log_select ON public.workspace_move_log
  FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(source_workspace_id)
    OR public.is_workspace_member(destination_workspace_id)
  );

-- Where a move had to renumber (destination collision), the old handle is
-- kept so search can still resolve "ENG-42".
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS previous_identifier text;

CREATE INDEX IF NOT EXISTS actions_previous_identifier_idx
  ON public.actions (workspace_id, previous_identifier)
  WHERE previous_identifier IS NOT NULL;

-- Collision-skipping identifier allocation. The original (022) blindly took
-- counter+1; imported identifiers (v2 moves preserved them without touching
-- the counter) could collide with a future insert and fail action creation
-- forever at that number. Bounded loop: each iteration advances the counter,
-- so it terminates after at most (number of imported identifiers) skips.
CREATE OR REPLACE FUNCTION public.generate_action_identifier()
RETURNS trigger AS $$
DECLARE
  prefix text;
  counter integer;
BEGIN
  LOOP
    UPDATE public.team
    SET issue_counter = issue_counter + 1
    WHERE id = new.team_id
    RETURNING issue_prefix, issue_counter INTO prefix, counter;

    IF prefix IS NULL THEN
      RETURN new;  -- no team row; let the NOT NULL constraint speak
    END IF;

    new.identifier := prefix || '-' || counter;

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.actions a
      WHERE a.workspace_id = new.workspace_id
        AND a.identifier = new.identifier
    );
  END LOOP;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- 1. Internal helpers
--    All EXECUTE-revoked below (§7); reachable only through the public move
--    RPCs, the same posture as _cleanup_claim_provenance (migration 178).
-- ============================================================

-- Translate a member id into the destination workspace by user identity.
-- Returns NULL when the user behind p_member is not a destination member.
-- member is UNIQUE (user_id, workspace_id), so no ORDER BY is needed.
CREATE OR REPLACE FUNCTION public._wsmove_member_in(p_member uuid, p_dest uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT dm.id
  FROM public.member dm
  JOIN public.member sm ON sm.id = p_member
  WHERE dm.workspace_id = p_dest
    AND dm.user_id = sm.user_id
  LIMIT 1
$$;

-- The tenancy gate every move RPC runs after resolving its source workspace.
-- SECURITY DEFINER bypasses RLS, so this IS the authorization.
--   * no source membership       → P0002 'not found' (no existence oracle)
--   * same workspace             → 22023
--   * guest on either side       → 42501
--   * plain member on the source → allowed only when p_is_entity_owner
--     (delete-parity: RLS already refuses members deleting others' work)
--   * destination needs owner/admin/member
CREATE OR REPLACE FUNCTION public._wsmove_gate(
  p_user uuid,
  p_source uuid,
  p_dest uuid,
  p_is_entity_owner boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_role text;
  v_dest_role text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_source_role
  FROM public.member
  WHERE workspace_id = p_source AND user_id = p_user;

  IF v_source_role IS NULL THEN
    -- Not a member of the source: indistinguishable from "does not exist".
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_source = p_dest THEN
    RAISE EXCEPTION 'destination is the same workspace' USING ERRCODE = '22023';
  END IF;

  IF v_source_role NOT IN ('owner', 'admin')
     AND NOT (v_source_role = 'member' AND p_is_entity_owner) THEN
    RAISE EXCEPTION 'moving this requires workspace admin rights or ownership of the item'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_dest_role
  FROM public.member
  WHERE workspace_id = p_dest AND user_id = p_user;

  IF v_dest_role IS NULL OR v_dest_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'not authorized in destination workspace' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Resolve the destination team + its default workflow state. When p_team_id
-- is NULL, fall back to the v2 heuristic (oldest team WITH a default state).
-- An explicit team missing a default state raises P0003 rather than risking
-- a NULL status_id.
CREATE OR REPLACE FUNCTION public._wsmove_dest_team(
  p_dest uuid,
  p_team_id uuid,
  OUT team_id uuid,
  OUT default_status_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_team_id IS NOT NULL THEN
    SELECT t.id, ws.id
    INTO team_id, default_status_id
    FROM public.team t
    JOIN public.workflow_state ws
      ON ws.team_id = t.id AND ws.is_default = true
    WHERE t.id = p_team_id AND t.workspace_id = p_dest
    ORDER BY ws.sort_order ASC, ws.id ASC
    LIMIT 1;
  ELSE
    SELECT t.id, ws.id
    INTO team_id, default_status_id
    FROM public.team t
    JOIN public.workflow_state ws
      ON ws.team_id = t.id AND ws.is_default = true
    WHERE t.workspace_id = p_dest
    ORDER BY t.created_at ASC, t.id ASC, ws.sort_order ASC, ws.id ASC
    LIMIT 1;
  END IF;

  IF team_id IS NULL THEN
    RAISE EXCEPTION 'destination workspace has no team with a default workflow state'
      USING ERRCODE = 'P0003';
  END IF;
END;
$$;

-- Re-point label junction rows to same-named destination labels, delete the
-- rest. The four junctions share the (entity_id, label_id) composite-PK
-- shape, so one dynamic entry point covers them. DISTINCT ON collapses
-- case-variant source labels ("Bug"/"bug") mapping to one destination label,
-- and the NOT EXISTS guard skips a remap that would duplicate the PK.
CREATE OR REPLACE FUNCTION public._wsmove_remap_labels(
  p_junction text,
  p_entity_col text,
  p_entity_ids uuid[],
  p_source uuid,
  p_dest uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_remapped int := 0;
  v_deleted int := 0;
BEGIN
  IF p_junction NOT IN ('action_label', 'capture_label', 'project_label', 'initiative_label')
     OR p_entity_col NOT IN ('action_id', 'capture_id', 'project_id', 'initiative_id') THEN
    RAISE EXCEPTION 'invalid label junction' USING ERRCODE = '22023';
  END IF;
  IF p_entity_ids IS NULL OR cardinality(p_entity_ids) = 0 THEN
    RETURN jsonb_build_object('remapped', 0, 'deleted', 0);
  END IF;

  EXECUTE format($q$
    WITH map AS (
      SELECT DISTINCT ON (j.%2$I, dl.id)
        j.%2$I AS entity_id, j.label_id AS old_label, dl.id AS new_label
      FROM public.%1$I j
      JOIN public.label sl ON sl.id = j.label_id AND sl.workspace_id = $2
      JOIN public.label dl ON dl.workspace_id = $3 AND lower(dl.name) = lower(sl.name)
      WHERE j.%2$I = ANY($1)
      ORDER BY j.%2$I, dl.id, sl.name ASC
    ),
    updated AS (
      UPDATE public.%1$I j
      SET label_id = m.new_label
      FROM map m
      WHERE j.%2$I = m.entity_id AND j.label_id = m.old_label
        AND NOT EXISTS (
          SELECT 1 FROM public.%1$I x
          WHERE x.%2$I = m.entity_id AND x.label_id = m.new_label
        )
      RETURNING 1
    )
    SELECT count(*) FROM updated
  $q$, p_junction, p_entity_col)
  INTO v_remapped
  USING p_entity_ids, p_source, p_dest;

  EXECUTE format($q$
    WITH deleted AS (
      DELETE FROM public.%1$I j
      USING public.label sl
      WHERE j.%2$I = ANY($1)
        AND sl.id = j.label_id
        AND sl.workspace_id = $2
      RETURNING 1
    )
    SELECT count(*) FROM deleted
  $q$, p_junction, p_entity_col)
  INTO v_deleted
  USING p_entity_ids, p_source;

  RETURN jsonb_build_object('remapped', v_remapped, 'deleted', v_deleted);
END;
$$;

-- Translate comment authors for moved commentables. comment.author_id is
-- NOT NULL → member ON DELETE CASCADE: left untranslated, a later source-
-- workspace offboarding would cascade-delete destination comments. Authors
-- without a destination membership stay as the documented dangle.
CREATE OR REPLACE FUNCTION public._wsmove_comments(
  p_commentable_type text,
  p_ids uuid[],
  p_source uuid,
  p_dest uuid
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_translated int := 0;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;

  WITH translated AS (
    UPDATE public.comment c
    SET author_id = dm.id
    FROM public.member sm
    JOIN public.member dm
      ON dm.workspace_id = p_dest AND dm.user_id = sm.user_id
    WHERE c.commentable_type::text = p_commentable_type
      AND c.commentable_id = ANY(p_ids)
      AND sm.id = c.author_id
      AND sm.workspace_id = p_source
    RETURNING 1
  )
  SELECT count(*) INTO v_translated FROM translated;

  RETURN v_translated;
END;
$$;

-- entity_link surgery for a move. p_moving is a jsonb array of
-- {"t": "<entity type>", "i": "<uuid>"} covering EVERYTHING that moves in
-- this transaction (the polymorphic endpoints carry no FKs, so the moving
-- set is handed in explicitly).
--   1. Source edges whose BOTH endpoints move but which already exist in
--      the destination (same 6-col unique key) are deleted — an UPDATE
--      would 23505.
--   2. Remaining both-endpoint edges are re-stamped to the destination.
--   3. Any source edge still touching a mover has exactly one moving
--      endpoint — deleted (cross-workspace edges are invisible to both
--      sides under RLS; they can be re-woven later).
CREATE OR REPLACE FUNCTION public._wsmove_entity_links(
  p_source uuid,
  p_dest uuid,
  p_moving jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_moved int := 0;
  v_severed int := 0;
  v_deduped int := 0;
BEGIN
  IF p_moving IS NULL OR jsonb_array_length(p_moving) = 0 THEN
    RETURN jsonb_build_object('moved', 0, 'severed', 0, 'deduped', 0);
  END IF;

  -- pg_temp-qualified so no same-named object in `public` can ever shadow it
  DROP TABLE IF EXISTS pg_temp._wsmove_set;
  CREATE TABLE pg_temp._wsmove_set (t text, i uuid, PRIMARY KEY (t, i)) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmove_set (t, i)
  SELECT DISTINCT m->>'t', (m->>'i')::uuid
  FROM jsonb_array_elements(p_moving) m
  ON CONFLICT DO NOTHING;

  WITH gone AS (
    DELETE FROM public.entity_link el
    WHERE el.workspace_id = p_source
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = el.source_type AND s.i = el.source_id)
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = el.target_type AND s.i = el.target_id)
      AND EXISTS (
        SELECT 1 FROM public.entity_link d
        WHERE d.workspace_id = p_dest
          AND d.source_type = el.source_type AND d.source_id = el.source_id
          AND d.target_type = el.target_type AND d.target_id = el.target_id
          AND d.relation = el.relation
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_deduped FROM gone;

  WITH moved AS (
    UPDATE public.entity_link el
    SET workspace_id = p_dest,
        created_by = public._wsmove_member_in(el.created_by, p_dest)
    WHERE el.workspace_id = p_source
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = el.source_type AND s.i = el.source_id)
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = el.target_type AND s.i = el.target_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_moved FROM moved;

  WITH severed AS (
    DELETE FROM public.entity_link el
    WHERE el.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = el.source_type AND s.i = el.source_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = el.target_type AND s.i = el.target_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_severed FROM severed;

  RETURN jsonb_build_object('moved', v_moved, 'severed', v_severed, 'deduped', v_deduped);
END;
$$;

-- Move knowledge claims whose evidence points SOLELY at the given source
-- pairs (same bool_and partition as v2 / _cleanup_claim_provenance).
-- Fixes two v2 gaps: claim_source.workspace_id is re-stamped, and
-- subject_member_id is translated alongside created_by.
-- Returns {moved, left, moved_ids: [uuid…]} — moved_ids feed the caller's
-- entity_link moving set.
CREATE OR REPLACE FUNCTION public._wsmove_claims(
  p_source uuid,
  p_dest uuid,
  p_pairs jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_linked uuid[] := '{}';
  v_moving uuid[] := '{}';
BEGIN
  IF p_pairs IS NULL OR jsonb_array_length(p_pairs) = 0 THEN
    RETURN jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT cs.claim_id), '{}')
  INTO v_linked
  FROM public.claim_source cs
  JOIN public.claim c ON c.id = cs.claim_id
  WHERE c.workspace_id = p_source
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_pairs) m
      WHERE m->>'t' = cs.source_type AND (m->>'i')::uuid = cs.source_id
    );

  SELECT COALESCE(array_agg(claim_id), '{}')
  INTO v_moving
  FROM (
    SELECT cs.claim_id
    FROM public.claim_source cs
    WHERE cs.claim_id = ANY(v_linked)
    GROUP BY cs.claim_id
    HAVING bool_and(
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_pairs) m
        WHERE m->>'t' = cs.source_type AND (m->>'i')::uuid = cs.source_id
      )
    )
  ) sole;

  IF cardinality(v_moving) > 0 THEN
    UPDATE public.claim
    SET superseded_by = NULL
    WHERE workspace_id = p_source
      AND superseded_by = ANY(v_moving)
      AND NOT (id = ANY(v_moving));

    UPDATE public.claim c
    SET workspace_id = p_dest,
        created_by = public._wsmove_member_in(c.created_by, p_dest),
        subject_member_id = public._wsmove_member_in(c.subject_member_id, p_dest),
        superseded_by = CASE
          WHEN c.superseded_by = ANY(v_moving) THEN c.superseded_by
          ELSE NULL
        END
    WHERE c.id = ANY(v_moving);

    UPDATE public.claim_chunks
    SET workspace_id = p_dest
    WHERE claim_id = ANY(v_moving);

    -- v2 bug fix: evidence rows carry their own workspace_id (117) and the
    -- destination knowledge view filters on it.
    UPDATE public.claim_source
    SET workspace_id = p_dest
    WHERE claim_id = ANY(v_moving);
  END IF;

  RETURN jsonb_build_object(
    'moved', cardinality(v_moving),
    'left', cardinality(v_linked) - cardinality(v_moving),
    'moved_ids', COALESCE((SELECT jsonb_agg(x) FROM unnest(v_moving) x), '[]'::jsonb)
  );
END;
$$;

-- Source-workspace residue that would otherwise keep pointing at moved
-- entities, plus knowledge-brief invalidation on BOTH sides.
CREATE OR REPLACE FUNCTION public._wsmove_residue(
  p_source uuid,
  p_dest uuid,
  p_moving jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pins int := 0;
  v_notifications int := 0;
  v_threads int := 0;
BEGIN
  -- pg_temp-qualified so no same-named object in `public` can ever shadow it
  DROP TABLE IF EXISTS pg_temp._wsmove_set;
  CREATE TABLE pg_temp._wsmove_set (t text, i uuid, PRIMARY KEY (t, i)) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmove_set (t, i)
  SELECT DISTINCT m->>'t', (m->>'i')::uuid
  FROM jsonb_array_elements(COALESCE(p_moving, '[]'::jsonb)) m
  ON CONFLICT DO NOTHING;

  WITH gone AS (
    DELETE FROM public.knowledge_package_item i
    WHERE i.workspace_id = p_source
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = i.entity_type AND s.i = i.entity_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_pins FROM gone;

  WITH gone AS (
    DELETE FROM public.notification n
    WHERE n.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = n.target_type AND s.i = n.target_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = n.context_type AND s.i = n.context_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_notifications FROM gone;

  WITH cleared AS (
    UPDATE public.email_thread_index e
    SET linked_action_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'action' AND s.i = e.linked_action_id)
          THEN NULL ELSE e.linked_action_id END,
        linked_capture_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'capture' AND s.i = e.linked_capture_id)
          THEN NULL ELSE e.linked_capture_id END,
        linked_project_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = e.linked_project_id)
          THEN NULL ELSE e.linked_project_id END
    WHERE e.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'action' AND s.i = e.linked_action_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'capture' AND s.i = e.linked_capture_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = e.linked_project_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_threads FROM cleared;

  -- Workspace briefs: invalidate, don't delete — the stale brief keeps
  -- serving until the weaver's next pass recompiles it (a deleted brief
  -- blanks the AI's world model for up to a day).
  UPDATE public.knowledge_brief b
  SET source_fingerprint = NULL
  WHERE b.workspace_id IN (p_source, p_dest)
    AND b.scope_type = 'workspace';

  -- Project briefs for MOVED projects: delete outright. The project no
  -- longer exists in the source workspace, so a fingerprint-nulled row would
  -- just make the weaver try to recompile a brief for a foreign project.
  DELETE FROM public.knowledge_brief b
  WHERE b.workspace_id = p_source
    AND b.scope_type = 'project'
    AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = b.scope_id);

  RETURN jsonb_build_object(
    'package_pins_removed', v_pins,
    'notifications_removed', v_notifications,
    'email_threads_unlinked', v_threads
  );
END;
$$;

-- The action closure. Everything required to move a set of actions from
-- p_source to p_dest; move_actions, move_project, and move_capture all call
-- it. The CALLER must have validated that every id exists in p_source (this
-- function re-derives the working set with a workspace predicate as defence
-- in depth).
--
--   p_keep_project    — TRUE only when the actions' project moves in the
--                       same transaction (project move).
--   p_sever_capture   — TRUE when the source capture is NOT moving along.
--   p_moving_doc_ids  — documents moving in the same transaction;
--                       action_document rows to those documents survive.
CREATE OR REPLACE FUNCTION public._wsmove_actions_core(
  p_action_ids uuid[],
  p_source uuid,
  p_dest uuid,
  p_dest_team uuid,
  p_dest_default_status uuid,
  p_keep_project boolean,
  p_sever_capture boolean,
  p_moving_doc_ids uuid[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_count int;
  v_prefix text;
  v_counter int;
  v_base int;
  v_renumbered int := 0;
  v_attachment_ids uuid[] := '{}';
  v_identifier_map jsonb := '{}'::jsonb;
  v_assignees_translated int := 0;
  v_assignees_dropped int := 0;
  v_external_severed int := 0;
  v_agent_runs_removed int := 0;
  v_comments_translated int := 0;
  v_labels jsonb := jsonb_build_object('remapped', 0, 'deleted', 0);
BEGIN
  -- Defence in depth: never operate on an id outside the declared source.
  SELECT COALESCE(array_agg(id), '{}') INTO v_ids
  FROM public.actions
  WHERE id = ANY(COALESCE(p_action_ids, '{}'))
    AND workspace_id = p_source;

  v_count := cardinality(v_ids);
  IF v_count = 0 THEN
    RETURN jsonb_build_object(
      'moved', 0,
      'identifier_map', '{}'::jsonb,
      'renumbered', 0,
      'assignees_translated', 0,
      'assignees_dropped', 0,
      'labels', v_labels,
      'external_tasks_severed', 0,
      'agent_runs_removed', 0,
      'comments_translated', 0,
      'attachment_ids', '[]'::jsonb
    );
  END IF;

  -- ── parent links that would cross the boundary, both directions ──
  UPDATE public.actions
  SET parent_id = NULL
  WHERE id = ANY(v_ids)
    AND parent_id IS NOT NULL
    AND NOT (parent_id = ANY(v_ids));

  UPDATE public.actions
  SET parent_id = NULL
  WHERE workspace_id = p_source
    AND parent_id = ANY(v_ids)
    AND NOT (id = ANY(v_ids));

  -- ── identifiers: preserve when free, renumber only collisions ──
  -- Lock the destination team's counter row first (also serializes against
  -- the BEFORE INSERT trigger, which UPDATEs the same row). The renumber
  -- base is a WATERMARK: the counter is not authoritative (v2 imports and
  -- the app-side allocator both bypassed it).
  SELECT t.issue_prefix, t.issue_counter
  INTO v_prefix, v_counter
  FROM public.team t
  WHERE t.id = p_dest_team
  FOR UPDATE;

  SELECT GREATEST(
    v_counter,
    COALESCE((
      SELECT MAX(substring(a.identifier FROM length(v_prefix) + 2)::bigint)
      FROM public.actions a
      WHERE a.workspace_id = p_dest
        AND left(a.identifier, length(v_prefix) + 1) = v_prefix || '-'
        AND substring(a.identifier FROM length(v_prefix) + 2) ~ '^[0-9]{1,9}$'
    ), 0),
    -- Incoming PRESERVED identifiers with the destination prefix also raise
    -- the base — otherwise a renumbered action could be assigned the same
    -- number a preserved sibling is bringing along in this very statement.
    COALESCE((
      SELECT MAX(substring(a.identifier FROM length(v_prefix) + 2)::bigint)
      FROM public.actions a
      WHERE a.id = ANY(v_ids)
        AND left(a.identifier, length(v_prefix) + 1) = v_prefix || '-'
        AND substring(a.identifier FROM length(v_prefix) + 2) ~ '^[0-9]{1,9}$'
    ), 0)
  )::int INTO v_base;

  -- One statement: (workspace_id, identifier) flips atomically per row, so
  -- the unique index never sees a colliding transient state. Only actions
  -- whose identifier is already taken in the destination are renumbered.
  WITH colliding AS (
    SELECT a.id,
           a.identifier AS old_identifier,
           row_number() OVER (ORDER BY a.created_at ASC, a.id ASC) AS rn
    FROM public.actions a
    WHERE a.id = ANY(v_ids)
      AND EXISTS (
        SELECT 1 FROM public.actions d
        WHERE d.workspace_id = p_dest AND d.identifier = a.identifier
      )
  ),
  moved AS (
    UPDATE public.actions a
    SET workspace_id = p_dest,
        team_id = p_dest_team,
        identifier = CASE
          WHEN c.id IS NOT NULL THEN v_prefix || '-' || (v_base + c.rn)
          ELSE a.identifier
        END,
        previous_identifier = CASE
          WHEN c.id IS NOT NULL THEN a.identifier
          ELSE a.previous_identifier
        END,
        status_id = COALESCE(
          (SELECT ws2.id
           FROM public.workflow_state ws2
           JOIN public.workflow_state ws1 ON ws1.id = a.status_id
           WHERE ws2.team_id = p_dest_team
             AND lower(ws2.name) = lower(ws1.name)
           ORDER BY ws2.sort_order ASC, ws2.id ASC
           LIMIT 1),
          (SELECT ws2.id
           FROM public.workflow_state ws2
           JOIN public.workflow_state ws1 ON ws1.id = a.status_id
           WHERE ws2.team_id = p_dest_team
             AND ws2.category = ws1.category
           ORDER BY ws2.sort_order ASC, ws2.id ASC
           LIMIT 1),
          p_dest_default_status),
        project_id = CASE WHEN p_keep_project THEN a.project_id ELSE NULL END,
        milestone_id = CASE WHEN p_keep_project THEN a.milestone_id ELSE NULL END,
        cycle_id = NULL,
        assignee_id = public._wsmove_member_in(a.assignee_id, p_dest),
        assignee_ai_member_id = NULL,
        agent_run_status = 'idle',
        assignee_contact_id = NULL,
        context_data = CASE
          WHEN a.context_data IS NULL THEN NULL
          ELSE a.context_data - 'assignee_contact_id'
        END,
        source_capture_id = CASE
          WHEN p_sever_capture THEN NULL
          ELSE a.source_capture_id
        END
    FROM (SELECT id FROM public.actions WHERE id = ANY(v_ids)) pick
    LEFT JOIN colliding c ON c.id = pick.id
    WHERE a.id = pick.id
    RETURNING c.old_identifier, a.identifier AS new_identifier
  )
  SELECT
    COALESCE(jsonb_object_agg(m.old_identifier, m.new_identifier)
             FILTER (WHERE m.old_identifier IS NOT NULL), '{}'::jsonb),
    count(*) FILTER (WHERE m.old_identifier IS NOT NULL)
  INTO v_identifier_map, v_renumbered
  FROM moved m;

  -- Raise the counter over everything now present for this prefix so future
  -- trigger allocations start clear of imports (the trigger also skips
  -- collisions on its own now, so this is an optimization, not a guard).
  UPDATE public.team t
  SET issue_counter = GREATEST(
    t.issue_counter,
    COALESCE((
      SELECT MAX(substring(a.identifier FROM length(v_prefix) + 2)::bigint)
      FROM public.actions a
      WHERE a.workspace_id = p_dest
        AND left(a.identifier, length(v_prefix) + 1) = v_prefix || '-'
        AND substring(a.identifier FROM length(v_prefix) + 2) ~ '^[0-9]{1,9}$'
    ), 0)::int
  )
  WHERE t.id = p_dest_team;

  -- ── multi-assignee join: translate by user identity, drop the rest ──
  WITH translated AS (
    UPDATE public.action_assignee aa
    SET member_id = dm.id
    FROM public.member sm
    JOIN public.member dm
      ON dm.workspace_id = p_dest AND dm.user_id = sm.user_id
    WHERE aa.action_id = ANY(v_ids)
      AND sm.id = aa.member_id
      AND sm.workspace_id = p_source
    RETURNING 1
  )
  SELECT count(*) INTO v_assignees_translated FROM translated;

  WITH dropped AS (
    DELETE FROM public.action_assignee aa
    USING public.member sm
    WHERE aa.action_id = ANY(v_ids)
      AND sm.id = aa.member_id
      AND sm.workspace_id = p_source
    RETURNING 1
  )
  SELECT count(*) INTO v_assignees_dropped FROM dropped;

  -- ── labels: remap by name, delete the rest ──
  v_labels := public._wsmove_remap_labels('action_label', 'action_id', v_ids, p_source, p_dest);

  -- ── comment authors: translate so the source ON DELETE CASCADE can't
  --    reach into the destination later ──
  v_comments_translated := public._wsmove_comments('action', v_ids, p_source, p_dest);

  -- ── workspace-bound joins that never translate ──
  DELETE FROM public.action_github_pr
  WHERE action_id = ANY(v_ids);

  -- External task links are severed (a re-stamped row routes the provider
  -- echo through the wrong tenant's credentials) — but the remote URL is
  -- preserved on the action so the reference survives.
  WITH severed AS (
    DELETE FROM public.action_external_task t
    WHERE t.action_id = ANY(v_ids)
    RETURNING t.action_id, t.provider, t.external_url, t.external_title
  ),
  link_rows AS (
    SELECT action_id,
           jsonb_agg(jsonb_build_object(
             'url', external_url,
             'title', COALESCE(external_title, initcap(provider) || ' task')
           )) FILTER (WHERE external_url IS NOT NULL) AS new_links,
           count(*) AS n
    FROM severed
    GROUP BY action_id
  ),
  appended AS (
    UPDATE public.actions a
    SET links = CASE
      WHEN lr.new_links IS NULL THEN a.links
      WHEN a.links IS NULL OR jsonb_typeof(a.links) <> 'array'
        THEN lr.new_links
      ELSE a.links || lr.new_links
    END
    FROM link_rows lr
    WHERE a.id = lr.action_id
    RETURNING lr.n
  )
  SELECT COALESCE(sum(n), 0)::int INTO v_external_severed FROM appended;

  -- relations survive only when both endpoints move
  DELETE FROM public.action_relation
  WHERE (action_id = ANY(v_ids)) <> (related_action_id = ANY(v_ids));

  -- document links survive only when the document moves too
  DELETE FROM public.action_document ad
  WHERE ad.action_id = ANY(v_ids)
    AND NOT (ad.document_id = ANY(COALESCE(p_moving_doc_ids, '{}')));

  -- ── action-parented attachments follow (storage authz rides on the row) ──
  SELECT COALESCE(array_agg(id), '{}')
  INTO v_attachment_ids
  FROM public.attachments
  WHERE action_id = ANY(v_ids) AND workspace_id = p_source;

  UPDATE public.attachments
  SET workspace_id = p_dest,
      project_id = CASE WHEN p_keep_project THEN project_id ELSE NULL END
  WHERE id = ANY(v_attachment_ids);

  UPDATE public.attachment_chunks
  SET workspace_id = p_dest,
      project_id = CASE WHEN p_keep_project THEN project_id ELSE NULL END
  WHERE attachment_id = ANY(v_attachment_ids);

  -- ── agent runs are deleted: repo_full_name / branch / pr_url / log_tail
  --    are workspace-wide readable and describe a source-tenant repo ──
  WITH gone AS (
    DELETE FROM public.agent_run
    WHERE action_id = ANY(v_ids)
      AND workspace_id = p_source
    RETURNING 1
  )
  SELECT count(*) INTO v_agent_runs_removed FROM gone;

  RETURN jsonb_build_object(
    'moved', v_count,
    'identifier_map', v_identifier_map,
    'renumbered', v_renumbered,
    'assignees_translated', v_assignees_translated,
    'assignees_dropped', v_assignees_dropped,
    'labels', v_labels,
    'external_tasks_severed', v_external_severed,
    'agent_runs_removed', v_agent_runs_removed,
    'comments_translated', v_comments_translated,
    'attachment_ids', COALESCE((SELECT jsonb_agg(x) FROM unnest(v_attachment_ids) x), '[]'::jsonb)
  );
END;
$$;

-- The document closure, shared by move_document and move_project.
CREATE OR REPLACE FUNCTION public._wsmove_documents_core(
  p_document_ids uuid[],
  p_source uuid,
  p_dest uuid,
  p_keep_project boolean,
  p_moving_action_ids uuid[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_slug_cleared int := 0;
  v_shares_deactivated int := 0;
  v_drafts_translated int := 0;
  v_drafts_discarded int := 0;
  v_comments_translated int := 0;
BEGIN
  SELECT COALESCE(array_agg(id), '{}') INTO v_ids
  FROM public.document
  WHERE id = ANY(COALESCE(p_document_ids, '{}'))
    AND workspace_id = p_source;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object(
      'moved', 0,
      'slugs_cleared', 0,
      'shares_deactivated', 0,
      'drafts_translated', 0,
      'drafts_discarded', 0,
      'comments_translated', 0
    );
  END IF;

  -- wiki slugs are unique per workspace; clear colliding ones rather than
  -- fail the move (the document stays reachable by id)
  WITH cleared AS (
    UPDATE public.document d
    SET slug = NULL
    WHERE d.id = ANY(v_ids)
      AND d.slug IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.document x
        WHERE x.workspace_id = p_dest AND x.slug = d.slug AND x.id <> d.id
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_slug_cleared FROM cleared;

  UPDATE public.document d
  SET workspace_id = p_dest,
      project_id = CASE WHEN p_keep_project THEN d.project_id ELSE NULL END,
      team_id = NULL,
      created_by = public._wsmove_member_in(d.created_by, p_dest),
      last_edited_by = public._wsmove_member_in(d.last_edited_by, p_dest)
  WHERE d.id = ANY(v_ids);

  UPDATE public.document_chunks
  SET workspace_id = p_dest,
      project_id = CASE WHEN p_keep_project THEN project_id ELSE NULL END
  WHERE document_id = ANY(v_ids);

  -- revisions carry an author member pointer; translate it like every other
  -- member ref (nullable FK — untranslatable authors go NULL, not dangling)
  UPDATE public.document_revision dr
  SET workspace_id = p_dest,
      author_id = public._wsmove_member_in(dr.author_id, p_dest)
  WHERE dr.document_id = ANY(v_ids);

  -- Drafts are other people's unpublished work: translate the author when a
  -- destination membership exists, drop (and count) only when it doesn't.
  WITH translated AS (
    UPDATE public.document_draft dd
    SET author_id = dm.id,
        workspace_id = p_dest
    FROM public.member sm
    JOIN public.member dm
      ON dm.workspace_id = p_dest AND dm.user_id = sm.user_id
    WHERE dd.document_id = ANY(v_ids)
      AND sm.id = dd.author_id
      AND sm.workspace_id = p_source
    RETURNING 1
  )
  SELECT count(*) INTO v_drafts_translated FROM translated;

  WITH discarded AS (
    DELETE FROM public.document_draft dd
    USING public.member sm
    WHERE dd.document_id = ANY(v_ids)
      AND sm.id = dd.author_id
      AND sm.workspace_id = p_source
    RETURNING 1
  )
  SELECT count(*) INTO v_drafts_discarded FROM discarded;

  v_comments_translated := public._wsmove_comments('document', v_ids, p_source, p_dest);

  -- action links survive only when the action moves in the same transaction
  DELETE FROM public.action_document ad
  WHERE ad.document_id = ANY(v_ids)
    AND NOT (ad.action_id = ANY(COALESCE(p_moving_action_ids, '{}')));

  -- Public links die in place: the share row (and its share_comment rows,
  -- whose RLS resolves through it) stays in the SOURCE workspace,
  -- deactivated. Re-stamping would hand external commenters' identities to
  -- the destination.
  WITH deactivated AS (
    UPDATE public.share
    SET is_active = false
    WHERE shareable_type = 'document'
      AND shareable_id = ANY(v_ids)
      AND workspace_id = p_source
      AND is_active
    RETURNING 1
  )
  SELECT count(*) INTO v_shares_deactivated FROM deactivated;

  RETURN jsonb_build_object(
    'moved', cardinality(v_ids),
    'slugs_cleared', v_slug_cleared,
    'shares_deactivated', v_shares_deactivated,
    'drafts_translated', v_drafts_translated,
    'drafts_discarded', v_drafts_discarded,
    'comments_translated', v_comments_translated
  );
END;
$$;

-- ============================================================
-- 2. move_actions — standalone single/bulk action move
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_actions(
  p_action_ids uuid[],
  p_destination_workspace_id uuid,
  p_destination_team_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_ids uuid[];
  v_source uuid;
  v_found int;
  v_owns_all boolean;
  v_dest_team uuid;
  v_dest_default_status uuid;
  v_core jsonb;
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_ids
  FROM unnest(COALESCE(p_action_ids, '{}')) x;

  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no action ids supplied' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION 'too many action ids' USING ERRCODE = '22023';
  END IF;

  -- Lock the rows and pin the single source workspace. Every id must exist
  -- and share it — SECURITY DEFINER + a raw id array would otherwise let a
  -- member of workspaces A and B drag workspace C's rows along.
  SELECT min(workspace_id::text)::uuid, count(*)
  INTO v_source, v_found
  FROM (
    SELECT workspace_id
    FROM public.actions
    WHERE id = ANY(v_ids)
    FOR UPDATE
  ) locked;

  IF v_found = 0 THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_found <> cardinality(v_ids)
     OR EXISTS (
       SELECT 1 FROM public.actions
       WHERE id = ANY(v_ids) AND workspace_id <> v_source
     ) THEN
    RAISE EXCEPTION 'action ids must all exist in one workspace'
      USING ERRCODE = 'P0004';
  END IF;

  -- Plain members may move only actions they created. IS NOT DISTINCT FROM:
  -- bool_and skips NULL inputs, so a NULL user_id row would otherwise slip
  -- past the ownership gate instead of failing it closed.
  SELECT bool_and(user_id IS NOT DISTINCT FROM v_user_id) INTO v_owns_all
  FROM public.actions
  WHERE id = ANY(v_ids);

  PERFORM public._wsmove_gate(
    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns_all, false));

  SELECT team_id, default_status_id
  INTO v_dest_team, v_dest_default_status
  FROM public._wsmove_dest_team(p_destination_workspace_id, p_destination_team_id);

  v_core := public._wsmove_actions_core(
    v_ids, v_source, p_destination_workspace_id,
    v_dest_team, v_dest_default_status,
    false,  -- standalone moves leave the project behind
    true    -- the capture is not moving
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object('t', 'action', 'i', x)), '[]'::jsonb)
  INTO v_moving
  FROM unnest(v_ids) x;
  v_moving := v_moving || COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a))
     FROM jsonb_array_elements_text(v_core->'attachment_ids') a),
    '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source, p_destination_workspace_id, v_moving);
  v_residue := public._wsmove_residue(v_source, p_destination_workspace_id, v_moving);

  v_counts := jsonb_build_object(
    'moved_actions', v_core->'moved',
    'identifier_map', v_core->'identifier_map',
    'renumbered', v_core->'renumbered',
    'assignees_translated', v_core->'assignees_translated',
    'assignees_dropped', v_core->'assignees_dropped',
    'labels_remapped', v_core->'labels'->'remapped',
    'labels_removed', v_core->'labels'->'deleted',
    'external_tasks_severed', v_core->'external_tasks_severed',
    'agent_runs_removed', v_core->'agent_runs_removed',
    'comments_translated', v_core->'comments_translated',
    'attachments_moved', jsonb_array_length(v_core->'attachment_ids'),
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  SELECT 'action', x, v_source, p_destination_workspace_id, v_user_id, v_counts
  FROM unnest(v_ids) x;

  RETURN jsonb_build_object(
    'action_ids', (SELECT jsonb_agg(x) FROM unnest(v_ids) x),
    'source_workspace_id', v_source,
    'destination_workspace_id', p_destination_workspace_id,
    'destination_team_id', v_dest_team,
    'counts', v_counts
  );
END;
$$;

-- ============================================================
-- 3. move_document — standalone document move
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_document(
  p_document_id uuid,
  p_destination_workspace_id uuid,
  p_move_claims boolean DEFAULT TRUE
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source uuid;
  v_owns boolean;
  v_core jsonb;
  v_claims jsonb := jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT d.workspace_id,
         EXISTS (
           SELECT 1 FROM public.member m
           WHERE m.id = d.created_by AND m.user_id = v_user_id
         )
  INTO v_source, v_owns
  FROM public.document d
  WHERE d.id = p_document_id
  FOR UPDATE OF d;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wsmove_gate(
    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns, false));

  v_core := public._wsmove_documents_core(
    ARRAY[p_document_id], v_source, p_destination_workspace_id,
    false  -- the project (if any) stays behind
  );

  IF p_move_claims THEN
    v_claims := public._wsmove_claims(
      v_source, p_destination_workspace_id,
      jsonb_build_array(jsonb_build_object('t', 'document', 'i', p_document_id))
    );
  END IF;

  v_moving := jsonb_build_array(jsonb_build_object('t', 'document', 'i', p_document_id))
    || COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('t', 'claim', 'i', c))
       FROM jsonb_array_elements_text(v_claims->'moved_ids') c),
      '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source, p_destination_workspace_id, v_moving);
  v_residue := public._wsmove_residue(v_source, p_destination_workspace_id, v_moving);

  v_counts := jsonb_build_object(
    'slugs_cleared', v_core->'slugs_cleared',
    'shares_deactivated', v_core->'shares_deactivated',
    'drafts_translated', v_core->'drafts_translated',
    'drafts_discarded', v_core->'drafts_discarded',
    'comments_translated', v_core->'comments_translated',
    'moved_claims', v_claims->'moved',
    'shared_claims_left', v_claims->'left',
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('document', p_document_id, v_source, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'document_id', p_document_id,
    'source_workspace_id', v_source,
    'destination_workspace_id', p_destination_workspace_id,
    'counts', v_counts
  );
END;
$$;

-- ============================================================
-- 4. move_project — deep move: project + milestones + all its actions
--    (+ documents by default). Captures linked to the project are UNLINKED,
--    not moved — a capture has its own move flow.
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_project(
  p_project_id uuid,
  p_destination_workspace_id uuid,
  p_destination_team_id uuid DEFAULT NULL,
  p_move_documents boolean DEFAULT TRUE
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source uuid;
  v_name text;
  v_owns boolean;
  v_dest_team uuid;
  v_dest_default_status uuid;
  v_action_ids uuid[] := '{}';
  v_doc_ids uuid[] := '{}';
  v_milestone_ids uuid[] := '{}';
  v_attachment_ids uuid[] := '{}';
  v_captures_unlinked int := 0;
  v_docs_unlinked int := 0;
  v_views_deleted int := 0;
  v_core jsonb;
  v_doc_core jsonb := jsonb_build_object(
    'moved', 0, 'slugs_cleared', 0, 'shares_deactivated', 0,
    'drafts_translated', 0, 'drafts_discarded', 0, 'comments_translated', 0);
  v_claims jsonb := jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  v_labels jsonb;
  v_comments_translated int := 0;
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT p.workspace_id, p.name,
         (p.user_id = v_user_id) OR EXISTS (
           SELECT 1 FROM public.member m
           WHERE m.id = p.lead_id AND m.user_id = v_user_id
         )
  INTO v_source, v_name, v_owns
  FROM public.projects p
  WHERE p.id = p_project_id
  FOR UPDATE OF p;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wsmove_gate(
    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns, false));

  -- After the gate: a P0005 before it would tell a non-member whether a
  -- guessed project id is a workspace's default bucket (existence oracle).
  IF v_name = '__default__' THEN
    RAISE EXCEPTION 'the default project cannot be moved' USING ERRCODE = 'P0005';
  END IF;

  SELECT team_id, default_status_id
  INTO v_dest_team, v_dest_default_status
  FROM public._wsmove_dest_team(p_destination_workspace_id, p_destination_team_id);

  -- ── the closure sets ──
  SELECT COALESCE(array_agg(id), '{}') INTO v_action_ids
  FROM public.actions
  WHERE project_id = p_project_id AND workspace_id = v_source;

  SELECT COALESCE(array_agg(id), '{}') INTO v_milestone_ids
  FROM public.milestone
  WHERE project_id = p_project_id;

  IF p_move_documents THEN
    SELECT COALESCE(array_agg(id), '{}') INTO v_doc_ids
    FROM public.document
    WHERE project_id = p_project_id AND workspace_id = v_source;
  END IF;

  -- ── captures stay; unlink them ──
  WITH unlinked AS (
    UPDATE public.captures
    SET project_id = NULL
    WHERE project_id = p_project_id AND workspace_id = v_source
    RETURNING id
  ),
  chunks AS (
    UPDATE public.capture_chunks cc
    SET project_id = NULL
    FROM unlinked u
    WHERE cc.capture_id = u.id
    RETURNING 1
  )
  SELECT count(*) INTO v_captures_unlinked FROM unlinked;

  -- ── documents: move or unlink ──
  IF p_move_documents THEN
    v_doc_core := public._wsmove_documents_core(
      v_doc_ids, v_source, p_destination_workspace_id,
      true,          -- the project moves with them
      v_action_ids   -- action_document rows to moved actions survive
    );
    IF cardinality(v_doc_ids) > 0 THEN
      v_claims := public._wsmove_claims(
        v_source, p_destination_workspace_id,
        (SELECT jsonb_agg(jsonb_build_object('t', 'document', 'i', d))
         FROM unnest(v_doc_ids) d)
      );
    END IF;
  ELSE
    WITH unlinked AS (
      UPDATE public.document
      SET project_id = NULL
      WHERE project_id = p_project_id AND workspace_id = v_source
      RETURNING id
    ),
    chunks AS (
      UPDATE public.document_chunks dc
      SET project_id = NULL
      FROM unlinked u
      WHERE dc.document_id = u.id
      RETURNING 1
    )
    SELECT count(*) INTO v_docs_unlinked FROM unlinked;
  END IF;

  -- ── all the project's actions move with it ──
  v_core := public._wsmove_actions_core(
    v_action_ids, v_source, p_destination_workspace_id,
    v_dest_team, v_dest_default_status,
    true,   -- keep project/milestone links: they move in this transaction
    true,   -- source captures stay behind
    v_doc_ids
  );

  -- ── the project row itself ──
  UPDATE public.projects p
  SET workspace_id = p_destination_workspace_id,
      initiative_id = NULL,
      lead_id = public._wsmove_member_in(p.lead_id, p_destination_workspace_id),
      cloud_env_id = NULL,
      parent_project_id = NULL
  WHERE p.id = p_project_id;

  -- sub-projects that stay lose their parent pointer
  UPDATE public.projects
  SET parent_project_id = NULL
  WHERE workspace_id = v_source AND parent_project_id = p_project_id;

  -- milestones travel by construction (project_id NOT NULL, no workspace
  -- column); actions in OTHER projects that pointed at them must let go
  UPDATE public.actions
  SET milestone_id = NULL
  WHERE workspace_id = v_source
    AND milestone_id = ANY(v_milestone_ids)
    AND NOT (id = ANY(v_action_ids));

  v_labels := public._wsmove_remap_labels(
    'project_label', 'project_id', ARRAY[p_project_id], v_source, p_destination_workspace_id);

  v_comments_translated := public._wsmove_comments(
    'project', ARRAY[p_project_id], v_source, p_destination_workspace_id);

  UPDATE public.project_embedding
  SET workspace_id = p_destination_workspace_id
  WHERE project_id = p_project_id;

  -- decisions never move (capture-owned): suggested ones let go of the
  -- project, confirmed ones keep the user-set attribution (v2 precedent)
  UPDATE public.decision
  SET project_id = NULL
  WHERE project_id = p_project_id
    AND confirmation = 'suggested';

  -- project-parented attachments follow
  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
  FROM public.attachments
  WHERE project_id = p_project_id AND workspace_id = v_source;

  UPDATE public.attachments
  SET workspace_id = p_destination_workspace_id
  WHERE id = ANY(v_attachment_ids);

  UPDATE public.attachment_chunks
  SET workspace_id = p_destination_workspace_id
  WHERE attachment_id = ANY(v_attachment_ids);

  -- project-scoped saved views reference workspace-scoped filter ids that
  -- don't translate; deleted (counted, disclosed in preflight)
  WITH gone AS (
    DELETE FROM public.view
    WHERE workspace_id = v_source
      AND scope_type = 'project'
      AND scope_id = p_project_id
    RETURNING 1
  )
  SELECT count(*) INTO v_views_deleted FROM gone;

  -- packages that curated by this project stop doing so
  UPDATE public.knowledge_package kp
  SET rules = jsonb_set(
    kp.rules, '{projects}',
    COALESCE((
      SELECT jsonb_agg(x)
      FROM jsonb_array_elements(kp.rules->'projects') x
      WHERE x <> to_jsonb(p_project_id::text)
    ), '[]'::jsonb))
  WHERE kp.workspace_id = v_source
    AND jsonb_typeof(kp.rules->'projects') = 'array'
    AND kp.rules->'projects' @> to_jsonb(p_project_id::text);

  -- ── graph + residue ──
  v_moving := jsonb_build_array(jsonb_build_object('t', 'project', 'i', p_project_id))
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'action', 'i', x)) FROM unnest(v_action_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'document', 'i', x)) FROM unnest(v_doc_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'milestone', 'i', x)) FROM unnest(v_milestone_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', x)) FROM unnest(v_attachment_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a)) FROM jsonb_array_elements_text(v_core->'attachment_ids') a), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'claim', 'i', c)) FROM jsonb_array_elements_text(v_claims->'moved_ids') c), '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source, p_destination_workspace_id, v_moving);
  v_residue := public._wsmove_residue(v_source, p_destination_workspace_id, v_moving);

  v_counts := jsonb_build_object(
    'moved_actions', v_core->'moved',
    'identifier_map', v_core->'identifier_map',
    'renumbered', v_core->'renumbered',
    'moved_documents', v_doc_core->'moved',
    'documents_unlinked', v_docs_unlinked,
    'moved_milestones', cardinality(v_milestone_ids),
    'captures_unlinked', v_captures_unlinked,
    'moved_claims', v_claims->'moved',
    'shared_claims_left', v_claims->'left',
    'labels_remapped', v_labels->'remapped',
    'labels_removed', v_labels->'deleted',
    'action_labels_remapped', v_core->'labels'->'remapped',
    'action_labels_removed', v_core->'labels'->'deleted',
    'assignees_translated', v_core->'assignees_translated',
    'assignees_dropped', v_core->'assignees_dropped',
    'external_tasks_severed', v_core->'external_tasks_severed',
    'agent_runs_removed', v_core->'agent_runs_removed',
    'comments_translated',
      (v_core->>'comments_translated')::int
      + (v_doc_core->>'comments_translated')::int
      + v_comments_translated,
    'drafts_translated', v_doc_core->'drafts_translated',
    'drafts_discarded', v_doc_core->'drafts_discarded',
    'attachments_moved',
      cardinality(v_attachment_ids) + jsonb_array_length(v_core->'attachment_ids'),
    'slugs_cleared', v_doc_core->'slugs_cleared',
    'shares_deactivated', v_doc_core->'shares_deactivated',
    'views_deleted', v_views_deleted,
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('project', p_project_id, v_source, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'project_id', p_project_id,
    'source_workspace_id', v_source,
    'destination_workspace_id', p_destination_workspace_id,
    'destination_team_id', v_dest_team,
    'counts', v_counts
  );
END;
$$;

-- ============================================================
-- 5. move_initiative — the initiative row; its projects stay behind
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_initiative(
  p_initiative_id uuid,
  p_destination_workspace_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source uuid;
  v_owns boolean;
  v_projects_unlinked int := 0;
  v_views_deleted int := 0;
  v_labels jsonb;
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT i.workspace_id,
         EXISTS (
           SELECT 1 FROM public.member m
           WHERE m.id = i.owner_id AND m.user_id = v_user_id
         )
  INTO v_source, v_owns
  FROM public.initiative i
  WHERE i.id = p_initiative_id
  FOR UPDATE OF i;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wsmove_gate(
    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns, false));

  UPDATE public.initiative i
  SET workspace_id = p_destination_workspace_id,
      owner_id = public._wsmove_member_in(i.owner_id, p_destination_workspace_id)
  WHERE i.id = p_initiative_id;

  WITH unlinked AS (
    UPDATE public.projects
    SET initiative_id = NULL
    WHERE workspace_id = v_source AND initiative_id = p_initiative_id
    RETURNING 1
  )
  SELECT count(*) INTO v_projects_unlinked FROM unlinked;

  v_labels := public._wsmove_remap_labels(
    'initiative_label', 'initiative_id', ARRAY[p_initiative_id],
    v_source, p_destination_workspace_id);

  WITH gone AS (
    DELETE FROM public.view
    WHERE workspace_id = v_source
      AND scope_type = 'initiative'
      AND scope_id = p_initiative_id
    RETURNING 1
  )
  SELECT count(*) INTO v_views_deleted FROM gone;

  v_moving := jsonb_build_array(jsonb_build_object('t', 'initiative', 'i', p_initiative_id));
  v_links := public._wsmove_entity_links(v_source, p_destination_workspace_id, v_moving);
  v_residue := public._wsmove_residue(v_source, p_destination_workspace_id, v_moving);

  v_counts := jsonb_build_object(
    'projects_unlinked', v_projects_unlinked,
    'labels_remapped', v_labels->'remapped',
    'labels_removed', v_labels->'deleted',
    'views_deleted', v_views_deleted,
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('initiative', p_initiative_id, v_source, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'initiative_id', p_initiative_id,
    'source_workspace_id', v_source,
    'destination_workspace_id', p_destination_workspace_id,
    'counts', v_counts
  );
END;
$$;

-- ============================================================
-- 6. move_capture v3 — same signature as v2 (the shipped route keeps
--    working); body rebuilt on the shared helpers with the gap fixes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_capture(
  p_capture_id UUID,
  p_destination_workspace_id UUID,
  p_confirmed_action_ids UUID[] DEFAULT '{}',
  p_move_claims BOOLEAN DEFAULT TRUE,
  p_move_contacts BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_workspace_id UUID;
  v_user_id UUID := auth.uid();
  v_owns boolean;
  v_confirmed_ids UUID[] := COALESCE(p_confirmed_action_ids, '{}');
  v_suggested_action_ids UUID[] := '{}';
  v_moved_action_ids UUID[] := '{}';
  v_attachment_ids UUID[] := '{}';
  v_unlinked_actions INT := 0;
  v_moved_decisions INT := 0;
  v_moved_proposed_changes INT := 0;
  v_copied_contacts INT := 0;
  v_shares_deactivated INT := 0;
  v_threads_unlinked INT := 0;
  v_comments_translated INT := 0;
  v_dest_team_id UUID;
  v_dest_default_status_id UUID;
  v_core jsonb;
  v_claims jsonb := jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  v_labels jsonb;
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Lock the capture row and read its source workspace + ownership
  SELECT workspace_id, (user_id = v_user_id)
  INTO v_source_workspace_id, v_owns
  FROM public.captures
  WHERE id = p_capture_id
  FOR UPDATE;

  IF v_source_workspace_id IS NULL THEN
    RAISE EXCEPTION 'capture not found' USING ERRCODE = 'P0002';
  END IF;

  -- v3 adds the role gate: plain members may move only their own captures;
  -- guests and non-members are refused (non-members as 'not found').
  PERFORM public._wsmove_gate(
    v_user_id, v_source_workspace_id, p_destination_workspace_id, COALESCE(v_owns, false));

  -- Every requested confirmed-action id must be a confirmed action extracted
  -- from THIS capture, still living in the source workspace (v2 contract).
  IF EXISTS (
    SELECT 1 FROM unnest(v_confirmed_ids) AS req(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.actions a
      WHERE a.id = req.id
        AND a.source_capture_id = p_capture_id
        AND a.confirmation = 'confirmed'
        AND a.workspace_id = v_source_workspace_id
    )
  ) THEN
    RAISE EXCEPTION 'confirmed_action_ids contains an id that is not a confirmed action of this capture'
      USING ERRCODE = 'P0004';
  END IF;

  SELECT team_id, default_status_id
  INTO v_dest_team_id, v_dest_default_status_id
  FROM public._wsmove_dest_team(p_destination_workspace_id, NULL);

  -- Collect the id sets everything below works from.
  SELECT COALESCE(array_agg(id), '{}') INTO v_suggested_action_ids
  FROM public.actions
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'suggested'
    AND workspace_id = v_source_workspace_id;

  v_moved_action_ids := v_suggested_action_ids || v_confirmed_ids;

  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
  FROM public.attachments
  WHERE note_id = p_capture_id;

  -- ── confirmed actions the caller chose to LEAVE BEHIND: unlink only ──
  UPDATE public.actions
  SET source_capture_id = NULL
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'confirmed'
    AND NOT (id = ANY(v_confirmed_ids));

  GET DIAGNOSTICS v_unlinked_actions = ROW_COUNT;

  -- ── attention cards for this capture's proposals die with the source
  --    context (member-scoped rows can't follow) ──
  DELETE FROM public.attention_item ai
  USING public.proposed_change pc
  WHERE ai.proposal_id = pc.id
    AND pc.capture_id = p_capture_id
    AND ai.workspace_id = v_source_workspace_id;

  -- ── the capture subtree ──
  UPDATE public.captures
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL,
      team_id = NULL
  WHERE id = p_capture_id;

  UPDATE public.capture_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE capture_id = p_capture_id;

  -- v3: reference rows + the extraction ledger carry workspace ids too
  UPDATE public.capture_references
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE capture_id = p_capture_id;

  UPDATE public.extraction_pass
  SET workspace_id = p_destination_workspace_id
  WHERE capture_id = p_capture_id;

  -- v3: the capture's AI thread is UNLINKED, not moved. Re-stamping would
  -- strand threads the mover doesn't own (personal RLS + foreign workspace
  -- filter) and let claim extraction replay pre-move source content into
  -- destination-visible claims. Severing frees the unique capture index so
  -- the destination can mint a fresh thread.
  WITH unlinked AS (
    UPDATE public.chat_conversations
    SET capture_id = NULL
    WHERE capture_id = p_capture_id
    RETURNING 1
  )
  SELECT count(*) INTO v_threads_unlinked FROM unlinked;

  -- v3: labels remap by name instead of vanishing
  v_labels := public._wsmove_remap_labels(
    'capture_label', 'capture_id', ARRAY[p_capture_id],
    v_source_workspace_id, p_destination_workspace_id);

  -- v3: comment authors translate (see _wsmove_comments)
  v_comments_translated := public._wsmove_comments(
    'capture', ARRAY[p_capture_id], v_source_workspace_id, p_destination_workspace_id);

  -- capture-parented attachments (storage authz follows the row); the
  -- capture's project stays behind, so the attachments' project link does too
  UPDATE public.attachments
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE note_id = p_capture_id;

  UPDATE public.attachment_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE attachment_id = ANY(v_attachment_ids);

  -- staged proposals follow; their workspace-scoped fields reset
  UPDATE public.proposed_change
  SET workspace_id = p_destination_workspace_id,
      assignee_member_id = NULL,
      assignee_contact_id = NULL,
      team_id = NULL,
      project_id = NULL,
      labels = ARRAY[]::text[]
  WHERE capture_id = p_capture_id;

  GET DIAGNOSTICS v_moved_proposed_changes = ROW_COUNT;

  -- ── extracted actions: all suggestions + the selected confirmed ids ──
  v_core := public._wsmove_actions_core(
    v_moved_action_ids, v_source_workspace_id, p_destination_workspace_id,
    v_dest_team_id, v_dest_default_status_id,
    false,  -- their project stays behind
    false   -- the capture moves WITH them: keep source_capture_id
  );

  -- ── decisions follow by construction; suggested ones let go of the
  --    project, and v3 translates the decider ──
  UPDATE public.decision
  SET project_id = NULL
  WHERE capture_id = p_capture_id
    AND confirmation = 'suggested';

  UPDATE public.decision d
  SET decided_by = public._wsmove_member_in(d.decided_by, p_destination_workspace_id)
  WHERE d.capture_id = p_capture_id
    AND d.decided_by IS NOT NULL;

  SELECT count(*) INTO v_moved_decisions
  FROM public.decision
  WHERE capture_id = p_capture_id;

  -- ── public links die in place (v3): share + share_comment stay in the
  --    SOURCE workspace, deactivated ──
  WITH deactivated AS (
    UPDATE public.share
    SET is_active = false
    WHERE shareable_type = 'capture'
      AND shareable_id = p_capture_id
      AND workspace_id = v_source_workspace_id
      AND is_active
    RETURNING 1
  )
  SELECT count(*) INTO v_shares_deactivated FROM deactivated;

  -- ── knowledge claims (sole-sourced by this capture/its attachments) ──
  IF p_move_claims THEN
    v_claims := public._wsmove_claims(
      v_source_workspace_id, p_destination_workspace_id,
      jsonb_build_array(jsonb_build_object('t', 'capture', 'i', p_capture_id))
        || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a))
                     FROM unnest(v_attachment_ids) a), '[]'::jsonb)
    );
  END IF;

  -- ── graph edges ──
  v_moving := jsonb_build_array(jsonb_build_object('t', 'capture', 'i', p_capture_id))
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a)) FROM unnest(v_attachment_ids) a), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a)) FROM jsonb_array_elements_text(v_core->'attachment_ids') a), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'action', 'i', x)) FROM unnest(v_moved_action_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'claim', 'i', c)) FROM jsonb_array_elements_text(v_claims->'moved_ids') c), '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source_workspace_id, p_destination_workspace_id, v_moving);

  -- ── participant contacts: copy auto-created ones the mover CAN SEE
  --    (v3 adds the can_view_contact gate — v2 copied private contacts the
  --    mover had no right to read) ──
  IF p_move_contacts THEN
    WITH src_contacts AS (
      SELECT c.*
      FROM public.contact c
      WHERE c.workspace_id = v_source_workspace_id
        AND c.email IS NOT NULL
        AND c.source IN ('capture_participant', 'calendar_sync')
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
        AND c.id IN (
          SELECT cp.contact_id
          FROM public.capture_participant cp
          WHERE cp.capture_id = p_capture_id
            AND cp.contact_id IS NOT NULL
        )
    ), inserted AS (
      INSERT INTO public.contact (
        workspace_id, member_id, company_id, created_by_member_id,
        first_name, last_name, full_name, email, secondary_emails, phone,
        avatar_url, job_title, department, linkedin_url,
        relationship_type, relationship_strength, visibility,
        source, source_provider, notes, tags, metadata
      )
      SELECT
        p_destination_workspace_id,
        public._wsmove_member_in(sc.member_id, p_destination_workspace_id),
        (SELECT dco.id
         FROM public.company dco
         JOIN public.company sco ON sco.id = sc.company_id
         WHERE dco.workspace_id = p_destination_workspace_id
           AND (
             (sco.domain IS NOT NULL AND dco.domain = sco.domain)
             OR lower(dco.name) = lower(sco.name)
           )
         ORDER BY (dco.domain IS NOT DISTINCT FROM sco.domain) DESC, dco.created_at ASC
         LIMIT 1),
        -- Attribute the copy to the mover: the visibility gate above means
        -- they could already read everything being copied.
        (SELECT dm.id FROM public.member dm
         WHERE dm.workspace_id = p_destination_workspace_id
           AND dm.user_id = v_user_id
         LIMIT 1),
        sc.first_name, sc.last_name, sc.full_name, sc.email,
        sc.secondary_emails, sc.phone, sc.avatar_url, sc.job_title,
        sc.department, sc.linkedin_url, sc.relationship_type,
        sc.relationship_strength, sc.visibility, sc.source,
        sc.source_provider, sc.notes, sc.tags, sc.metadata
      FROM src_contacts sc
      WHERE NOT EXISTS (
        SELECT 1 FROM public.contact dc
        WHERE dc.workspace_id = p_destination_workspace_id
          AND (
            dc.email = sc.email
            OR sc.email = ANY(COALESCE(dc.secondary_emails, '{}'))
          )
      )
      RETURNING 1
    )
    SELECT count(*) INTO v_copied_contacts FROM inserted;
  END IF;

  -- ── translate participant member/contact refs (v2 logic) ──
  UPDATE public.capture_participant cp
  SET member_id = public._wsmove_member_in(cp.member_id, p_destination_workspace_id)
  WHERE cp.capture_id = p_capture_id
    AND cp.member_id IS NOT NULL;

  UPDATE public.capture_participant cp
  SET contact_id = (
    SELECT dc.id
    FROM public.contact dc
    JOIN public.contact sc ON sc.id = cp.contact_id
    WHERE dc.workspace_id = p_destination_workspace_id
      AND sc.email IS NOT NULL
      AND (
        dc.email = sc.email
        OR sc.email = ANY(COALESCE(dc.secondary_emails, '{}'))
      )
    ORDER BY (dc.email = sc.email) DESC NULLS LAST, dc.created_at ASC
    LIMIT 1
  )
  WHERE cp.capture_id = p_capture_id
    AND cp.contact_id IS NOT NULL;

  -- ── residue on both sides (decisions included in the moving set so their
  --    notifications/pins clean up) ──
  v_residue := public._wsmove_residue(
    v_source_workspace_id, p_destination_workspace_id,
    v_moving || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'decision', 'i', d.id))
                          FROM public.decision d
                          WHERE d.capture_id = p_capture_id), '[]'::jsonb)
  );

  v_counts := jsonb_build_object(
    -- v2 keys the shipped client reads
    'unlinked_actions', v_unlinked_actions,
    'moved_suggested_actions', cardinality(v_suggested_action_ids),
    'moved_confirmed_actions', cardinality(v_confirmed_ids),
    'moved_decisions', v_moved_decisions,
    'moved_proposed_changes', v_moved_proposed_changes,
    'moved_claims', v_claims->'moved',
    'shared_claims_left', v_claims->'left',
    'copied_contacts', v_copied_contacts,
    -- v3 additions
    'identifier_map', v_core->'identifier_map',
    'renumbered', v_core->'renumbered',
    'external_tasks_severed', v_core->'external_tasks_severed',
    'agent_runs_removed', v_core->'agent_runs_removed',
    'comments_translated', v_comments_translated + (v_core->>'comments_translated')::int,
    'labels_remapped', v_labels->'remapped',
    'labels_removed', v_labels->'deleted',
    'shares_deactivated', v_shares_deactivated,
    'ai_threads_unlinked', v_threads_unlinked,
    'attachments', cardinality(v_attachment_ids),
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('capture', p_capture_id, v_source_workspace_id, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'capture_id', p_capture_id,
    'source_workspace_id', v_source_workspace_id,
    'destination_workspace_id', p_destination_workspace_id,
    'counts', v_counts
  );
END;
$$;

-- ============================================================
-- 7. Grants. Migration 193 revokes EXECUTE on new functions from anon +
--    authenticated by default; the public RPCs get explicit grants, the
--    internal helpers stay locked to the definer.
-- ============================================================

REVOKE ALL ON FUNCTION public._wsmove_member_in(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_gate(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_dest_team(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_remap_labels(text, text, uuid[], uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_comments(text, uuid[], uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_entity_links(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_claims(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_residue(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_actions_core(uuid[], uuid, uuid, uuid, uuid, boolean, boolean, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wsmove_documents_core(uuid[], uuid, uuid, boolean, uuid[]) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.move_actions(uuid[], uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_actions(uuid[], uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.move_document(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_document(uuid, uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.move_initiative(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_initiative(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.move_capture(UUID, UUID, UUID[], BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_capture(UUID, UUID, UUID[], BOOLEAN, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.move_actions(uuid[], uuid, uuid) IS
  'Move up to 500 actions (one source workspace) to another workspace. '
  'Identifiers are preserved when free in the destination and reissued from '
  'a watermark only on collision (old handle kept in previous_identifier); '
  'workflow state matches name -> category -> default; assignees translate '
  'by user identity; labels remap by name; Jira/Linear/Asana links and PR '
  'links are severed (remote URLs appended to actions.links); agent runs '
  'are deleted; action-parented attachments follow.';

COMMENT ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) IS
  'Deep-move a project: the project row, its milestones, ALL its actions '
  '(full action closure), and by default its documents. Captures linked to '
  'the project are unlinked, not moved. The ''__default__'' project refuses '
  'to move (errcode P0005).';

COMMENT ON FUNCTION public.move_document(uuid, uuid, boolean) IS
  'Move a document (chunks, revisions; drafts translate by user identity, '
  'discarded only for non-members; slug cleared on destination collision; '
  'shares deactivated in place) plus claims solely evidenced by it when '
  'p_move_claims.';

COMMENT ON FUNCTION public.move_initiative(uuid, uuid) IS
  'Move an initiative row to another workspace; its projects stay behind '
  'with initiative_id cleared.';

COMMENT ON FUNCTION public.move_capture(UUID, UUID, UUID[], BOOLEAN, BOOLEAN) IS
  'Move a capture (v3): v2 semantics plus — delete-parity role gate, '
  'identifier preserve-or-renumber, external task links severed, '
  'claim_source evidence re-stamped, contact copies visibility-gated, AI '
  'thread unlinked, extraction ledger follows, labels remap by name, shares '
  'deactivate in place, residue cleaned. The caller no longer needs to copy '
  'storage objects.';
