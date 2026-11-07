-- 155: move_capture v2 — derived artifacts follow the capture
--
-- v1 (migration 103) moved the capture, its transcript/embeddings,
-- attachments, participants, decisions, and pending AI suggestions. Derived
-- artifacts stayed behind: confirmed actions were unlinked in the source
-- workspace, knowledge claims kept their source workspace, and auto-created
-- participant contacts never appeared in the destination. In practice that
-- stranded work (e.g. confirmed extracted actions left to be cancelled by
-- hand in the origin workspace).
--
-- v2 replaces public.move_capture with three additions:
--
--   1. Confirmed extracted actions — caller passes the EXPLICIT list of
--      confirmed-action ids to move (p_confirmed_action_ids). The choice is
--      surfaced in the UI (preflight flags hand-edited actions); anything
--      not listed keeps v1 behaviour: it stays behind with
--      source_capture_id nulled. Moved actions keep their identifier and
--      confirmation, get the destination's first team, and their workflow
--      state is matched by name, then by category, then falls back to the
--      destination default. Workspace-scoped joins (assignees, labels, PR
--      links) are wiped; relations and parent links that would cross the
--      workspace boundary are severed.
--
--   2. Knowledge claims — claims whose evidence (claim_source) points ONLY
--      at this capture or its attachments move with it (claim + claim_chunks
--      re-stamped, created_by translated by user). Claims with evidence from
--      other sources are ambiguous and stay behind; their claim_source rows
--      pointing at the capture remain as cross-workspace audit pointers
--      (same accepted class as proposed_change.result_entity_id).
--      superseded_by pointers that would cross the boundary are nulled.
--      entity_link edges are re-stamped when BOTH endpoints move with the
--      capture, and deleted when only one endpoint moves.
--
--   3. Participant contacts — contacts that were auto-created from the
--      capture's participants (contact.source IN ('capture_participant',
--      'calendar_sync')) are COPIED into the destination when no contact
--      with the same email exists there. Copy, not move: the source contact
--      may be referenced by other captures/interactions. The existing
--      participant translation step then links participants to the copies.
--      Company links are matched by domain/name in the destination but never
--      auto-created; interaction history stays with the source contact.
--
-- Also fixed in passing: capture_label rows are deleted on move (labels are
-- workspace-scoped and postdate the v1 RPC — leaving them leaked source-
-- workspace label names to destination members), suggested actions now get
-- cycle_id cleared and cross-workspace parent/relation links severed, and
-- the participant contact translation also matches secondary emails.
--
-- All v1 semantics, error codes, and known limitations otherwise carry over.
-- New errcode: P0004 — p_confirmed_action_ids contains an id that is not a
-- confirmed action extracted from this capture.

-- Signature changes (2 args → 5), so drop the old function first.
DROP FUNCTION IF EXISTS public.move_capture(UUID, UUID);

CREATE OR REPLACE FUNCTION public.move_capture(
  p_capture_id UUID,
  p_destination_workspace_id UUID,
  p_confirmed_action_ids UUID[] DEFAULT '{}',
  p_move_claims BOOLEAN DEFAULT TRUE,
  p_move_contacts BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_workspace_id UUID;
  v_user_id UUID := auth.uid();
  v_confirmed_ids UUID[] := COALESCE(p_confirmed_action_ids, '{}');
  v_suggested_action_ids UUID[] := '{}';
  v_moved_action_ids UUID[] := '{}';
  v_attachment_ids UUID[] := '{}';
  v_linked_claim_ids UUID[] := '{}';
  v_moving_claim_ids UUID[] := '{}';
  v_unlinked_actions INT := 0;
  v_moved_suggested_actions INT := 0;
  v_moved_confirmed_actions INT := 0;
  v_moved_decisions INT := 0;
  v_moved_proposed_changes INT := 0;
  v_moved_claims INT := 0;
  v_shared_claims_left INT := 0;
  v_copied_contacts INT := 0;
  v_dest_team_id UUID;
  v_dest_default_status_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Lock the capture row and read its source workspace
  SELECT workspace_id INTO v_source_workspace_id
  FROM public.captures
  WHERE id = p_capture_id
  FOR UPDATE;

  IF v_source_workspace_id IS NULL THEN
    RAISE EXCEPTION 'capture not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_source_workspace_id = p_destination_workspace_id THEN
    RAISE EXCEPTION 'destination is the same workspace' USING ERRCODE = '22023';
  END IF;

  -- Membership check (both workspaces). SECURITY DEFINER means RLS is bypassed
  -- in this function, so we MUST check membership explicitly.
  IF NOT EXISTS (
    SELECT 1 FROM public.member
    WHERE workspace_id = v_source_workspace_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'not a member of source workspace' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.member
    WHERE workspace_id = p_destination_workspace_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'not a member of destination workspace' USING ERRCODE = '42501';
  END IF;

  -- Every requested confirmed-action id must be a confirmed action extracted
  -- from THIS capture, still living in the source workspace. Anything else
  -- (typo, action from another capture, suggestion, already-moved id) is a
  -- caller bug — refuse the whole move rather than partially apply.
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

  -- ───────────────────────────────────────────────────────────────
  -- Pick a destination team + its default workflow state for moved actions.
  -- actions.team_id and actions.status_id are both NOT NULL, so we can't just
  -- null them like other workspace-scoped FKs. The trigger
  -- `handle_new_team_workflow_states` (migration 020) guarantees every team
  -- has a default state.
  -- ───────────────────────────────────────────────────────────────

  SELECT t.id, ws.id
  INTO v_dest_team_id, v_dest_default_status_id
  FROM public.team t
  JOIN public.workflow_state ws
    ON ws.team_id = t.id AND ws.is_default = true
  WHERE t.workspace_id = p_destination_workspace_id
  ORDER BY t.created_at ASC, t.id ASC   -- id tiebreaker for deterministic pick
  LIMIT 1;

  IF v_dest_team_id IS NULL THEN
    RAISE EXCEPTION 'destination workspace has no team with a default workflow state'
      USING ERRCODE = 'P0003';
  END IF;

  -- Collect the id sets everything below works from.
  SELECT COALESCE(array_agg(id), '{}') INTO v_suggested_action_ids
  FROM public.actions
  WHERE source_capture_id = p_capture_id AND confirmation = 'suggested';

  v_moved_action_ids := v_suggested_action_ids || v_confirmed_ids;
  v_moved_confirmed_actions := cardinality(v_confirmed_ids);
  v_moved_suggested_actions := cardinality(v_suggested_action_ids);

  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
  FROM public.attachments
  WHERE note_id = p_capture_id;

  -- ───────────────────────────────────────────────────────────────
  -- Unlink confirmed actions the caller chose to LEAVE BEHIND (v1 behaviour
  -- for all of them). They keep workspace, team, identifier, assignee,
  -- status, project, labels, comments, PR links — only the capture link is
  -- severed.
  -- ───────────────────────────────────────────────────────────────

  UPDATE public.actions
  SET source_capture_id = NULL
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'confirmed'
    AND NOT (id = ANY(v_confirmed_ids));

  GET DIAGNOSTICS v_unlinked_actions = ROW_COUNT;

  -- ───────────────────────────────────────────────────────────────
  -- Re-stamp workspace_id across the capture's subtree
  -- ───────────────────────────────────────────────────────────────

  -- Capture row: clear project/team links (destination doesn't have them)
  UPDATE public.captures
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL,
      team_id = NULL
  WHERE id = p_capture_id;

  -- RAG embeddings (capture_chunks)
  UPDATE public.capture_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE capture_id = p_capture_id;

  -- Capture labels: labels are workspace-scoped (migration 108) and don't
  -- translate; leaving the join rows would surface source-workspace label
  -- names to destination members. (v1 predates capture labels — this also
  -- fixes that gap.)
  DELETE FROM public.capture_label
  WHERE capture_id = p_capture_id;

  -- Attachments (file metadata; storage objects copied by caller)
  UPDATE public.attachments
  SET workspace_id = p_destination_workspace_id
  WHERE note_id = p_capture_id;

  -- Attachment embeddings
  UPDATE public.attachment_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE attachment_id = ANY(v_attachment_ids);

  -- Proposed_change rows (all statuses): re-stamp workspace and null the
  -- workspace-scoped FK fields on pending rows so the user re-decides them
  -- in the destination. Applied/dismissed rows are audit history and follow
  -- the capture too (their FK fields are still nulled here for consistency;
  -- they're no longer actionable so the staleness doesn't matter).
  UPDATE public.proposed_change
  SET workspace_id = p_destination_workspace_id,
      assignee_member_id = NULL,
      assignee_contact_id = NULL,
      team_id = NULL,
      project_id = NULL,
      labels = ARRAY[]::text[]
  WHERE capture_id = p_capture_id;

  GET DIAGNOSTICS v_moved_proposed_changes = ROW_COUNT;

  -- ───────────────────────────────────────────────────────────────
  -- Move extracted actions: all suggestions + the confirmed ids the caller
  -- selected. Identifier and confirmation are preserved (identifier is NOT
  -- NULL, UNIQUE per workspace; a destination-side collision raises errcode
  -- 23505 and rolls back the whole move). Workflow state is matched by name
  -- first (Done stays Done), then by category, then the destination default.
  -- ───────────────────────────────────────────────────────────────

  -- Sever parent links that would cross the workspace boundary — both a
  -- moved action whose parent stays, and a staying action whose parent moves.
  UPDATE public.actions
  SET parent_id = NULL
  WHERE id = ANY(v_moved_action_ids)
    AND parent_id IS NOT NULL
    AND NOT (parent_id = ANY(v_moved_action_ids));

  UPDATE public.actions
  SET parent_id = NULL
  WHERE workspace_id = v_source_workspace_id
    AND parent_id = ANY(v_moved_action_ids)
    AND NOT (id = ANY(v_moved_action_ids));

  UPDATE public.actions a
  SET workspace_id = p_destination_workspace_id,
      team_id = v_dest_team_id,
      status_id = COALESCE(
        (SELECT ws2.id
         FROM public.workflow_state ws2
         JOIN public.workflow_state ws1 ON ws1.id = a.status_id
         WHERE ws2.team_id = v_dest_team_id
           AND lower(ws2.name) = lower(ws1.name)
         LIMIT 1),
        (SELECT ws2.id
         FROM public.workflow_state ws2
         JOIN public.workflow_state ws1 ON ws1.id = a.status_id
         WHERE ws2.team_id = v_dest_team_id
           AND ws2.category = ws1.category
         ORDER BY ws2.sort_order ASC, ws2.id ASC
         LIMIT 1),
        v_dest_default_status_id),
      project_id = NULL,
      milestone_id = NULL,
      cycle_id = NULL,
      assignee_id = NULL
  WHERE a.id = ANY(v_moved_action_ids);

  -- Wipe workspace-scoped join rows for every moved action.
  DELETE FROM public.action_assignee
  WHERE action_id = ANY(v_moved_action_ids);

  -- Labels are workspace-scoped (UNIQUE name per workspace) and we don't
  -- auto-create matching labels in the destination.
  DELETE FROM public.action_label
  WHERE action_id = ANY(v_moved_action_ids);

  -- PRs carry their own workspace_id and are inherently source-workspace-
  -- scoped (repo config, webhook routing).
  DELETE FROM public.action_github_pr
  WHERE action_id = ANY(v_moved_action_ids);

  -- Relations (blocks/related/duplicate) survive only when both actions move.
  DELETE FROM public.action_relation
  WHERE (action_id = ANY(v_moved_action_ids)) <> (related_action_id = ANY(v_moved_action_ids));

  -- Decisions (all statuses) linked to this capture. decision has no
  -- workspace_id of its own; it inherits via the capture and is FK-bound by
  -- a NOT NULL capture_id, so decisions follow the capture by construction.
  -- We only clear project_id on SUGGESTED decisions (project_id is workspace-
  -- scoped and the suggestion's project doesn't exist in the destination).
  -- For CONFIRMED decisions the project_id was set deliberately by the user
  -- and would silently destroy user attribution if we nulled it. Confirmed
  -- decisions with a project_id end up with a cross-workspace project
  -- reference — same shape as comment.author_id, surfaced in the UI layer.
  UPDATE public.decision
  SET project_id = NULL
  WHERE capture_id = p_capture_id
    AND confirmation = 'suggested';

  -- Count of ALL decisions that move with the capture (for the response).
  SELECT count(*) INTO v_moved_decisions
  FROM public.decision
  WHERE capture_id = p_capture_id;

  -- Share rows pointing at this capture: re-stamp workspace_id so workspace-
  -- scoped management UI in the destination shows them. The share_token
  -- continues to work either way (it's globally unique).
  UPDATE public.share
  SET workspace_id = p_destination_workspace_id
  WHERE shareable_type = 'capture'
    AND shareable_id = p_capture_id;

  -- ───────────────────────────────────────────────────────────────
  -- Knowledge claims. A claim moves when ALL of its evidence points at this
  -- capture or its attachments — anything with outside evidence (another
  -- capture, a document, an email, a manual source) is ambiguous and stays.
  -- ───────────────────────────────────────────────────────────────

  SELECT COALESCE(array_agg(DISTINCT cs.claim_id), '{}') INTO v_linked_claim_ids
  FROM public.claim_source cs
  JOIN public.claim c ON c.id = cs.claim_id
  WHERE c.workspace_id = v_source_workspace_id
    AND (
      (cs.source_type = 'capture' AND cs.source_id = p_capture_id)
      OR (cs.source_type = 'attachment' AND cs.source_id = ANY(v_attachment_ids))
    );

  IF p_move_claims THEN
    SELECT COALESCE(array_agg(claim_id), '{}') INTO v_moving_claim_ids
    FROM (
      SELECT cs.claim_id
      FROM public.claim_source cs
      WHERE cs.claim_id = ANY(v_linked_claim_ids)
      GROUP BY cs.claim_id
      HAVING bool_and(
        (cs.source_type = 'capture' AND cs.source_id = p_capture_id)
        OR (cs.source_type = 'attachment' AND cs.source_id = ANY(v_attachment_ids))
      )
    ) sole;
  END IF;

  v_moved_claims := cardinality(v_moving_claim_ids);
  v_shared_claims_left := cardinality(v_linked_claim_ids) - v_moved_claims;

  IF v_moved_claims > 0 THEN
    -- Null supersede pointers that would cross the boundary — staying claims
    -- pointing at movers, and movers pointing at staying claims.
    UPDATE public.claim
    SET superseded_by = NULL
    WHERE workspace_id = v_source_workspace_id
      AND superseded_by = ANY(v_moving_claim_ids)
      AND NOT (id = ANY(v_moving_claim_ids));

    UPDATE public.claim c
    SET workspace_id = p_destination_workspace_id,
        created_by = (
          SELECT dm.id
          FROM public.member dm
          JOIN public.member sm ON sm.id = c.created_by
          WHERE dm.workspace_id = p_destination_workspace_id
            AND dm.user_id = sm.user_id
          LIMIT 1
        ),
        superseded_by = CASE
          WHEN c.superseded_by = ANY(v_moving_claim_ids) THEN c.superseded_by
          ELSE NULL
        END
    WHERE c.id = ANY(v_moving_claim_ids);

    UPDATE public.claim_chunks
    SET workspace_id = p_destination_workspace_id
    WHERE claim_id = ANY(v_moving_claim_ids);
  END IF;

  -- ───────────────────────────────────────────────────────────────
  -- entity_link edges: re-stamp edges where BOTH endpoints move with the
  -- capture (the capture itself, its attachments, moved claims, moved
  -- actions); delete edges where only one endpoint moves — a cross-workspace
  -- edge is invisible to both sides under RLS and can be re-woven later.
  -- ───────────────────────────────────────────────────────────────

  UPDATE public.entity_link el
  SET workspace_id = p_destination_workspace_id
  WHERE el.workspace_id = v_source_workspace_id
    AND (
      (el.source_type = 'capture' AND el.source_id = p_capture_id)
      OR (el.source_type = 'attachment' AND el.source_id = ANY(v_attachment_ids))
      OR (el.source_type = 'claim' AND el.source_id = ANY(v_moving_claim_ids))
      OR (el.source_type = 'action' AND el.source_id = ANY(v_moved_action_ids))
    )
    AND (
      (el.target_type = 'capture' AND el.target_id = p_capture_id)
      OR (el.target_type = 'attachment' AND el.target_id = ANY(v_attachment_ids))
      OR (el.target_type = 'claim' AND el.target_id = ANY(v_moving_claim_ids))
      OR (el.target_type = 'action' AND el.target_id = ANY(v_moved_action_ids))
    );

  -- After the both-endpoint re-stamp, any source-workspace edge still
  -- touching a moving entity has exactly one moving endpoint. Delete those.
  DELETE FROM public.entity_link el
  WHERE el.workspace_id = v_source_workspace_id
    AND (
      (el.source_type = 'capture' AND el.source_id = p_capture_id)
      OR (el.source_type = 'attachment' AND el.source_id = ANY(v_attachment_ids))
      OR (el.source_type = 'claim' AND el.source_id = ANY(v_moving_claim_ids))
      OR (el.source_type = 'action' AND el.source_id = ANY(v_moved_action_ids))
      OR (el.target_type = 'capture' AND el.target_id = p_capture_id)
      OR (el.target_type = 'attachment' AND el.target_id = ANY(v_attachment_ids))
      OR (el.target_type = 'claim' AND el.target_id = ANY(v_moving_claim_ids))
      OR (el.target_type = 'action' AND el.target_id = ANY(v_moved_action_ids))
    );

  -- ───────────────────────────────────────────────────────────────
  -- Copy auto-created participant contacts into the destination BEFORE the
  -- participant translation below, so translation finds them by email.
  -- Copy, not move: the source contact may be referenced by other captures,
  -- interactions, or email threads. Companies are matched (domain first,
  -- then name) but never auto-created; interaction history stays behind.
  -- ───────────────────────────────────────────────────────────────

  IF p_move_contacts THEN
    WITH src_contacts AS (
      SELECT c.*
      FROM public.contact c
      WHERE c.workspace_id = v_source_workspace_id
        AND c.email IS NOT NULL
        AND c.source IN ('capture_participant', 'calendar_sync')
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
        (SELECT dm.id
         FROM public.member dm
         JOIN public.member sm ON sm.id = sc.member_id
         WHERE dm.workspace_id = p_destination_workspace_id
           AND dm.user_id = sm.user_id
         LIMIT 1),
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
        -- Attribute the copy to the mover so 'private' contacts stay visible
        -- to the person who triggered the move.
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
      -- A destination contact "already exists" when it holds the address as
      -- its primary OR one of its secondary emails (merged contacts keep
      -- absorbed addresses in secondary_emails — see migration 132).
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

  -- ───────────────────────────────────────────────────────────────
  -- Translate per-workspace member/contact references on participants
  -- ───────────────────────────────────────────────────────────────

  -- Translate member_id by user_id; null if the user isn't a member of the
  -- destination workspace.
  UPDATE public.capture_participant cp
  SET member_id = (
    SELECT dm.id
    FROM public.member dm
    JOIN public.member sm ON sm.id = cp.member_id
    WHERE dm.workspace_id = p_destination_workspace_id
      AND dm.user_id = sm.user_id
    LIMIT 1
  )
  WHERE cp.capture_id = p_capture_id
    AND cp.member_id IS NOT NULL;

  -- Translate contact_id by email (this now also finds the copies made
  -- above, and destination contacts holding the address as a secondary
  -- email after a merge); null if no contact in destination matches.
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

  -- ───────────────────────────────────────────────────────────────
  -- Return the move summary + attachment paths for storage copy
  -- ───────────────────────────────────────────────────────────────

  RETURN jsonb_build_object(
    'capture_id', p_capture_id,
    'source_workspace_id', v_source_workspace_id,
    'destination_workspace_id', p_destination_workspace_id,
    'counts', jsonb_build_object(
      'unlinked_actions', v_unlinked_actions,
      'moved_suggested_actions', v_moved_suggested_actions,
      'moved_confirmed_actions', v_moved_confirmed_actions,
      'moved_decisions', v_moved_decisions,
      'moved_proposed_changes', v_moved_proposed_changes,
      'moved_claims', v_moved_claims,
      'shared_claims_left', v_shared_claims_left,
      'copied_contacts', v_copied_contacts
    ),
    'attachments', (
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object(
          'id', a.id,
          'storage_path', a.storage_path,
          'storage_bucket', a.storage_bucket
        )),
        '[]'::jsonb
      )
      FROM public.attachments a
      WHERE a.note_id = p_capture_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_capture(UUID, UUID, UUID[], BOOLEAN, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.move_capture(UUID, UUID, UUID[], BOOLEAN, BOOLEAN) IS
  'Move a capture (transcript, attachments, embeddings, participants, '
  'decisions, pending AI suggestions) plus its derived artifacts from one '
  'workspace to another. Confirmed extracted actions move only when listed '
  'in p_confirmed_action_ids (others stay, unlinked); claims whose evidence '
  'points solely at this capture move when p_move_claims; auto-created '
  'participant contacts are copied to the destination when p_move_contacts. '
  'Returns a counts object so the caller can disclose what happened. The '
  'caller must copy attachment storage objects after the RPC returns.';
