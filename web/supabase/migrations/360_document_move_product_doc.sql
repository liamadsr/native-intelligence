-- ============================================================
-- 360: the workspace product doc can't be moved away by a plain member.
-- ============================================================
-- Security fix (review of 359, 2026-10-18). 359 says a document's creator may
-- delete it EXCEPT the workspace product doc
-- (workspace.settings.product_doc.document_id), which only an owner or admin
-- may change. The move engine (221) had no such exception:
--   * move_document's gate is "owner/admin, or the creator" (v_owns into
--     _wsmove_gate), so a plain member who created the page later named as the
--     product doc could move it into their own workspace. That empties the
--     pointer's target, and the live agent loses its product facts;
--   * move_project's gate is "owner/admin, or the project's creator or lead",
--     and by default it moves every document in the project, the product doc
--     included.
--
-- This re-creates both functions with EXACTLY 221's bodies (the only
-- definitions; no later migration replaced them) plus one check each, right
-- after _wsmove_gate (so a non-member still reads "not found") and before any
-- move work:
--   move_document  not owner/admin in the source AND is_product_doc(source,
--                  the document)                       -> 42501
--   move_project   documents move along (p_move_documents) AND not owner/admin
--                  in the source AND a document of the project in the source
--                  is the product doc                  -> 42501
--                  (with p_move_documents false the documents stay behind,
--                  unlinked, so the product doc never leaves)
-- Signatures, SECURITY DEFINER, search_path, return shapes and grants are
-- unchanged (the grants are re-stated as 221 has them). is_product_doc is
-- 359's helper, so 359 must be applied first.
--
-- Rollout: applied to DEV and then PROD BEFORE the app PR merges, after 359.
-- The app maps a 42501 from either RPC to a 403 already.
--
-- Idempotent: create or replace only. No backslash anywhere in this file (the
-- MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. move_document (221) plus the product-doc check.
-- ------------------------------------------------------------

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

  -- 360: the workspace product doc moves only for an owner or admin of the
  -- source workspace (359's rule: the creator, except the product doc).
  IF COALESCE((SELECT m.role FROM public.member m
                WHERE m.workspace_id = v_source AND m.user_id = v_user_id), '')
       NOT IN ('owner', 'admin')
     AND public.is_product_doc(v_source, p_document_id) THEN
    RAISE EXCEPTION 'only an owner or admin can move the workspace product doc'
      USING ERRCODE = '42501';
  END IF;

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

REVOKE ALL ON FUNCTION public.move_document(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_document(uuid, uuid, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 2. move_project (221) plus the product-doc check.
-- ------------------------------------------------------------

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

  -- 360: a project whose documents move along may not carry the workspace
  -- product doc away unless the caller is an owner or admin of the source
  -- workspace (359's rule: the creator, except the product doc).
  IF p_move_documents
     AND COALESCE((SELECT m.role FROM public.member m
                    WHERE m.workspace_id = v_source AND m.user_id = v_user_id), '')
           NOT IN ('owner', 'admin')
     AND EXISTS (
       SELECT 1 FROM public.document d
        WHERE d.project_id = p_project_id
          AND d.workspace_id = v_source
          AND public.is_product_doc(d.workspace_id, d.id)
     ) THEN
    RAISE EXCEPTION 'only an owner or admin can move a project holding the workspace product doc'
      USING ERRCODE = '42501';
  END IF;

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

REVOKE ALL ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) TO authenticated;
