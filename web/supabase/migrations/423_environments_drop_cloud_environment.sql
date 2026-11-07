-- ============================================================
-- 423: Environments E5, the old cloud_environment table goes
-- (docs/plans/environments.md §4 "The drop is separate", §8 E5).
--
-- Apply AFTER the deploy that stops reading and writing them: the code that
-- shipped with 420 still cleared projects.cloud_env_id on a project PATCH, so
-- this drop waits for the deploy of this PR. Migration 420 copied every
-- cloud_environment row into public.environment (same ids) and every
-- projects.cloud_env_id into projects.environment_id; the table holds 0 rows
-- on DEV and PROD (checked 2026-10-23).
--
-- Two functions still named the old column, and are redefined first, exactly
-- as they are live (pg_get_functiondef on PROD, 2026-10-23) minus that one
-- assignment:
--   move_project            no longer clears projects.cloud_env_id (moving a
--                           project already drops its environment_id through
--                           420's projects_environment_check)
--   _wsmerge_environments   no longer clears projects.cloud_env_id when it pins
--                           a source project to the source's default
-- export_workspace_rows keeps its string 'cloud_environment' in a column
-- filter: harmless once the table is gone (every env_vars column is excluded
-- by name anyway).
--
-- Dropping the column drops projects_cloud_env_id_fkey; dropping the table
-- drops its updated_at trigger and policies. No backfill, no data loss.
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_project(p_project_id uuid, p_destination_workspace_id uuid, p_destination_team_id uuid DEFAULT NULL::uuid, p_move_documents boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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

  -- 369: documents moving along may not carry someone else's private
  -- document (the caller can't read it, so can't carry it somewhere they can).
  IF p_move_documents AND EXISTS (
       SELECT 1 FROM public.document d
        WHERE d.project_id = p_project_id
          AND d.workspace_id = v_source
          AND d.visibility = 'private'
          AND NOT EXISTS (
            SELECT 1 FROM public.member m
             WHERE m.id = d.created_by AND m.user_id = v_user_id
          )
     ) THEN
    RAISE EXCEPTION 'the project holds someone else''s private document'
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
$$
;

CREATE OR REPLACE FUNCTION public._wsmerge_environments(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare
  v_src_name text;
  v_renamed int := 0;
  v_moved int := 0;
  v_adopted int := 0;
  v_dropped int := 0;
  v_defaults int := 0;
  v_pinned int := 0;
begin
  select name into v_src_name from public.workspace where id = p_source;

  update public.projects p
  set environment_id = s.default_cloud_environment_id
  from public.workspace s
  where s.id = p_source and p.workspace_id = p_source
    and p.environment_id is null and s.default_cloud_environment_id is not null;
  get diagnostics v_pinned = row_count;

  update public.environment s
  set name = left(s.name || ' (' || coalesce(v_src_name, 'merged') || ')', 80)
  where s.workspace_id = p_source and s.kind = 'cloud'
    and exists (
      select 1 from public.environment d
      where d.workspace_id = p_dest and d.kind = 'cloud' and lower(d.name) = lower(s.name)
    );
  get diagnostics v_renamed = row_count;

  update public.environment set workspace_id = p_dest where workspace_id = p_source;
  get diagnostics v_moved = row_count;

  update public.workspace d
  set default_cloud_environment_id = s.default_cloud_environment_id
  from public.workspace s
  where d.id = p_dest and s.id = p_source
    and d.default_cloud_environment_id is null
    and s.default_cloud_environment_id is not null;
  get diagnostics v_adopted = row_count;

  delete from public.environment_default s
  where s.workspace_id = p_source
    and exists (
      select 1 from public.environment_default d
      where d.workspace_id = p_dest and d.user_id = s.user_id
        and d.project_id is not distinct from coalesce(
          (select m.dst from pg_temp._wsmerge_projects m where m.src = s.project_id), s.project_id)
    );
  get diagnostics v_dropped = row_count;

  update public.environment_default s
  set workspace_id = p_dest,
      project_id = coalesce((select m.dst from pg_temp._wsmerge_projects m where m.src = s.project_id), s.project_id)
  where s.workspace_id = p_source;
  get diagnostics v_defaults = row_count;

  return jsonb_build_object(
    'projects_pinned_to_source_default', v_pinned,
    'cloud_environments_moved', v_moved,
    'cloud_environments_renamed', v_renamed,
    'default_cloud_environment_adopted', v_adopted > 0,
    'environment_defaults_moved', v_defaults,
    'environment_defaults_dropped', v_dropped
  );
end;
$$
;


alter table public.projects drop column if exists cloud_env_id;

drop table if exists public.cloud_environment;
