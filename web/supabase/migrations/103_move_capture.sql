-- 103: move_capture
--
-- Moves a single capture from one workspace to another. Always succeeds for any
-- capture the user has access to in both workspaces — accepted (confirmed)
-- actions get unlinked and stay behind in the source workspace, suggested
-- (pending) actions follow the capture, and decisions follow the capture.
--
-- What moves with the capture:
--   * captures row (workspace_id re-stamp; project_id/team_id nulled — destination
--     has no matching project/team and the user can re-link)
--   * capture_chunks (RAG embeddings)
--   * attachments + attachment_chunks
--   * proposed_change rows — all of them (pending, applied, dismissed). Audit
--     trail follows the capture. Workspace-scoped FK fields on pending rows
--     are nulled (assignee, team, project, labels); applied rows keep their
--     result_entity_id pointer, which becomes a cross-workspace dangle for
--     applied-into-action cases (those actions stay behind) — that's
--     acceptable: result_entity_id is audit metadata, not a hot link.
--   * actions where confirmation='suggested' AND source_capture_id matches
--     (team_id and status_id reassigned to destination's first team and its
--     default workflow state; project/milestone/assignee nulled; identifier
--     preserved — see note below)
--   * decision rows (confirmation='suggested' OR 'confirmed' — both follow the
--     capture; decision has no workspace_id of its own and capture_id is
--     NOT NULL, so confirmed decisions are structurally bound to their capture)
--   * capture_participant member_id/contact_id translated by user_id/email
--   * share rows with shareable_type='capture' (workspace_id re-stamped)
--   * action_label / action_github_pr rows for moved suggested actions
--     (deleted — labels and PRs are source-workspace-scoped and don't translate)
--
-- What stays behind in the source workspace:
--   * actions where confirmation='confirmed' AND source_capture_id matches
--     The action keeps its workspace, team, identifier, assignee, status, project,
--     labels, comments, GitHub PR links, etc. — everything stays intact. Only
--     `source_capture_id` is nulled, severing the link to the moved capture.
--     The user can re-record what the capture came from in the action description.
--
-- Storage objects (attachment files) are NOT touched here. The caller does that
-- after the RPC returns the list of attachments to copy.
--
-- Notes / known limitations:
--   * actions.identifier is NOT NULL and UNIQUE per workspace. We preserve the
--     existing identifier on move; the UNIQUE constraint is checked against
--     the destination workspace, so a collision (rare) raises errcode 23505
--     and the whole transaction rolls back. This is the right behaviour —
--     better to refuse than to silently reissue.
--   * Cross-workspace member dangles. The following references are NOT
--     translated and will point to source-workspace member rows after the
--     move; cross-workspace resolution is a UI concern handled at render:
--       - comment.author_id (polymorphic comments on the capture)
--       - share.created_by (workspace_id is re-stamped, but created_by is not)
--       - decision.decided_by (confirmed decisions that move with the capture)
--   * Confirmed decisions with a project_id move with the capture but keep
--     their source-workspace project reference. UI must handle a project_id
--     that doesn't resolve in the current workspace.
--   * notification rows targeting this capture are intentionally left in the
--     source workspace — they are historical "your capture was processed"
--     events tied to the recipient's inbox, not the capture itself.
--   * Narrow concurrency race: the captures row is locked FOR UPDATE, but
--     PostgreSQL row locks don't prevent concurrent INSERTs into child
--     tables. A suggested action, decision, or proposed_change inserted
--     against this capture mid-move (after the capture's workspace_id has
--     been re-stamped but before that table's UPDATE runs) could end up in
--     a split state. The window is microseconds in practice; full
--     prevention would require ACCESS EXCLUSIVE table locks on every child
--     table — too heavy for v1. Accept and revisit if it manifests.

CREATE OR REPLACE FUNCTION public.move_capture(
  p_capture_id UUID,
  p_destination_workspace_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_workspace_id UUID;
  v_user_id UUID := auth.uid();
  v_unlinked_actions INT := 0;
  v_moved_suggested_actions INT := 0;
  v_moved_decisions INT := 0;
  v_moved_proposed_changes INT := 0;
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

  -- ───────────────────────────────────────────────────────────────
  -- Pick a destination team + its default workflow state for moved suggested
  -- actions. actions.team_id and actions.status_id are both NOT NULL, so we
  -- can't just null them like other workspace-scoped FKs — the user has to
  -- re-categorise the suggestion in the destination later. The trigger
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

  -- ───────────────────────────────────────────────────────────────
  -- Unlink confirmed actions FIRST (before the capture moves workspace).
  -- These actions stay in the source workspace with everything intact —
  -- team, identifier, assignee, status, project, labels, comments, PR links.
  -- Only source_capture_id is nulled so the action no longer references a
  -- capture in another workspace.
  -- ───────────────────────────────────────────────────────────────

  UPDATE public.actions
  SET source_capture_id = NULL
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'confirmed';

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

  -- Attachments (file metadata; storage objects copied by caller)
  UPDATE public.attachments
  SET workspace_id = p_destination_workspace_id
  WHERE note_id = p_capture_id;

  -- Attachment embeddings
  UPDATE public.attachment_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE attachment_id IN (
    SELECT id FROM public.attachments WHERE note_id = p_capture_id
  );

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

  -- Suggested actions linked to this capture: re-stamp workspace + assign to
  -- the destination's first team and its default workflow state (both NOT
  -- NULL columns). Project/milestone/assignee are nullable and get cleared —
  -- the user will re-categorise on accept. Identifier is preserved (NOT NULL,
  -- UNIQUE per workspace); a destination-side collision raises errcode 23505
  -- and rolls back the whole move.
  UPDATE public.actions
  SET workspace_id = p_destination_workspace_id,
      team_id = v_dest_team_id,
      status_id = v_dest_default_status_id,
      project_id = NULL,
      milestone_id = NULL,
      assignee_id = NULL
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'suggested';

  GET DIAGNOSTICS v_moved_suggested_actions = ROW_COUNT;

  -- Wipe action_assignee join rows for those suggested actions (legacy
  -- assignee_id has already been cleared above).
  DELETE FROM public.action_assignee
  WHERE action_id IN (
    SELECT id FROM public.actions
    WHERE source_capture_id = p_capture_id
      AND confirmation = 'suggested'
  );

  -- Wipe action_label rows: labels are workspace-scoped (UNIQUE name per
  -- workspace) and we don't auto-create matching labels in the destination.
  -- User can re-label after accepting the suggestion.
  DELETE FROM public.action_label
  WHERE action_id IN (
    SELECT id FROM public.actions
    WHERE source_capture_id = p_capture_id
      AND confirmation = 'suggested'
  );

  -- Wipe action_github_pr rows: PRs carry their own workspace_id and are
  -- inherently source-workspace-scoped (repo config, webhook routing).
  DELETE FROM public.action_github_pr
  WHERE action_id IN (
    SELECT id FROM public.actions
    WHERE source_capture_id = p_capture_id
      AND confirmation = 'suggested'
  );

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

  -- Translate contact_id by email; null if no contact in destination matches.
  UPDATE public.capture_participant cp
  SET contact_id = (
    SELECT dc.id
    FROM public.contact dc
    JOIN public.contact sc ON sc.id = cp.contact_id
    WHERE dc.workspace_id = p_destination_workspace_id
      AND dc.email IS NOT NULL
      AND dc.email = sc.email
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
      'moved_decisions', v_moved_decisions,
      'moved_proposed_changes', v_moved_proposed_changes
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

GRANT EXECUTE ON FUNCTION public.move_capture(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.move_capture(UUID, UUID) IS
  'Move a capture (transcript, attachments, embeddings, participants, '
  'decisions, and pending AI suggestions) from one workspace to another. '
  'Confirmed actions linked to the capture stay in the source workspace '
  'with their source_capture_id nulled. Returns a counts object so the '
  'caller can disclose what happened. The caller must copy attachment '
  'storage objects after the RPC returns.';
