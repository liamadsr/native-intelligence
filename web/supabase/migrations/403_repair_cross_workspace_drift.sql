-- 403: repair cross-workspace drift — the rows the integrity sweep (402)
-- flags: a child stamped with a workspace other than its parent's, a member
-- reference from another workspace, a team pointer into another workspace, a
-- junction whose two ends sit in different workspaces. All of it predates the
-- merge feature (older moves, the pre-#571 home-only mail sync, same-user
-- cross-workspace assignment); the merge preflight refuses a workspace that
-- carries any of it (P0009), so this is the repair that lets Liam's own
-- workspaces merge, written once as a function so it can run again.
--
-- Rules, the same the merge engine applies, in this order:
--   1. A child row follows its parent's workspace (chunks, references,
--      extraction passes, proposals, revisions, drafts, evidence, external
--      links, PR links, agent runs, contact shares, embeddings). An
--      attachment's home is its capture's, else its action's, else its
--      project's workspace (the sweep's own order); a pointer of its that
--      lands outside that home is cleared (221's rule); its chunks follow it.
--   2. A member reference is translated BY USER into the row's own workspace
--      when that person is a member there. Otherwise a nullable column is
--      cleared; a per-member row (assignee, notification, card, job,
--      approval, finding) is dropped; a share's or invite's author becomes
--      the workspace owner (a share's public comments are never lost).
--   3. An action or teammate on another workspace's team moves to its own
--      workspace's first team (222's trigger remaps the status); a nullable
--      team pointer (capture, document, proposal, package, flow, view) is
--      cleared; a cycle from another team is cleared.
--   4. A pointer across workspaces that nothing can resolve is cut (project,
--      milestone, parent, source capture, initiative, AI assignee, a loop's
--      bot); a contact or company pointer re-points by email / domain where
--      the row's own workspace has one, else is cleared. A mail thread copy
--      linking another workspace's entity hands the link to the sibling copy
--      in that workspace (where it has none), re-points a contact link
--      locally by email where possible, and clears the rest.
--   5. A label junction re-points to the same-named label in the entity's
--      workspace, else goes; a share on another workspace's entity is
--      deactivated; an edge or pin with an end outside its workspace goes.
--
-- Every changed row lands in workspace_repair_log (run id, class, table,
-- key, before, after, including the old value of anything overwritten and the
-- rows a cascade touches), so nothing is silent and anything can be put back
-- by hand. Where two source rows would map to one target key, one is
-- translated and the other dropped, so no statement can collide with itself.
-- The function is idempotent: a second run changes nothing. The migration
-- creates it and runs it once for every workspace; the JSON it returns is the
-- report (counts per class, and whatever the sweep still flags, in every
-- workspace the run touched, under "remaining").

CREATE TABLE IF NOT EXISTS public.workspace_repair_log (
  id            bigserial PRIMARY KEY,
  run_id        uuid NOT NULL,
  class         text NOT NULL,
  table_name    text NOT NULL,
  row_key       jsonb NOT NULL,
  workspace_id  uuid,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_repair_log_run_idx ON public.workspace_repair_log (run_id);
CREATE INDEX IF NOT EXISTS workspace_repair_log_workspace_idx ON public.workspace_repair_log (workspace_id, created_at DESC);
ALTER TABLE public.workspace_repair_log ENABLE ROW LEVEL SECURITY;
-- No policies: the server reads it (service_role bypasses RLS); clients never do.

-- The workspace's first team: the oldest, the general-slug one among ties.
CREATE OR REPLACE FUNCTION public._wsrepair_first_team(p_workspace uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM public.team WHERE workspace_id = p_workspace ORDER BY created_at, (slug <> 'general'), id LIMIT 1;
$$;

-- The workspace's owner (oldest), else its oldest admin.
CREATE OR REPLACE FUNCTION public._wsrepair_owner(p_workspace uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM public.member WHERE workspace_id = p_workspace AND role IN ('owner', 'admin')
  ORDER BY (role <> 'owner'), created_at, id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.repair_cross_workspace_drift(p_workspace uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_run uuid := gen_random_uuid();
  v_out jsonb := '{}'::jsonb;
  n int;
  r record;
  v_remaining jsonb;
BEGIN
  -- ══ 1. children follow their parent's workspace ═════════════════════════════
  -- attachments: home = capture, else action, else project (the sweep's order)
  WITH fixed AS (
    UPDATE public.attachments x SET workspace_id = sub.home
    FROM (SELECT x2.id, x2.workspace_id AS old_ws, COALESCE(c.workspace_id, a.workspace_id, p.workspace_id) AS home
          FROM public.attachments x2
          LEFT JOIN public.captures c ON c.id = x2.note_id
          LEFT JOIN public.actions a ON a.id = x2.action_id
          LEFT JOIN public.projects p ON p.id = x2.project_id) sub
    WHERE x.id = sub.id AND sub.home IS NOT NULL AND sub.home <> sub.old_ws
      AND (p_workspace IS NULL OR sub.home = p_workspace OR sub.old_ws = p_workspace)
    RETURNING x.id, sub.old_ws, sub.home)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'child_follows_parent', 'attachments', jsonb_build_object('id', id), home, jsonb_build_object('workspace_id', old_ws), jsonb_build_object('workspace_id', home) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('attachments.restamped', n); END IF;
  -- an attachment's secondary pointers outside its home are cleared (a parent always remains: the home came from one)
  WITH fixed AS (
    UPDATE public.attachments x SET project_id = NULL
    FROM public.projects p
    WHERE p.id = x.project_id AND p.workspace_id <> x.workspace_id AND (x.note_id IS NOT NULL OR x.action_id IS NOT NULL)
      AND (p_workspace IS NULL OR x.workspace_id = p_workspace)
    RETURNING x.id, x.workspace_id, p.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'attachments', jsonb_build_object('id', id), workspace_id, jsonb_build_object('project_id', old_target), jsonb_build_object('project_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('attachments.project_id.cleared', n); END IF;
  WITH fixed AS (
    UPDATE public.attachments x SET action_id = NULL
    FROM public.actions a
    WHERE a.id = x.action_id AND a.workspace_id <> x.workspace_id AND x.note_id IS NOT NULL
      AND (p_workspace IS NULL OR x.workspace_id = p_workspace)
    RETURNING x.id, x.workspace_id, a.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'attachments', jsonb_build_object('id', id), workspace_id, jsonb_build_object('action_id', old_target), jsonb_build_object('action_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('attachments.action_id.cleared', n); END IF;

  -- (child, fk, parent); attachment_chunks after attachments
  FOR r IN SELECT * FROM (VALUES
      ('capture_chunks', 'capture_id', 'captures'),
      ('capture_references', 'capture_id', 'captures'),
      ('extraction_pass', 'capture_id', 'captures'),
      ('proposed_change', 'capture_id', 'captures'),
      ('document_chunks', 'document_id', 'document'),
      ('document_revision', 'document_id', 'document'),
      ('claim_source', 'claim_id', 'claim'),
      ('claim_chunks', 'claim_id', 'claim'),
      ('action_external_task', 'action_id', 'actions'),
      ('action_github_pr', 'action_id', 'actions'),
      ('agent_run', 'action_id', 'actions'),
      ('contact_share', 'contact_id', 'contact'),
      ('attachment_chunks', 'attachment_id', 'attachments')
    ) AS v(child, fk, parent)
  LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I c SET workspace_id = p.workspace_id
        FROM public.%3$I p
        WHERE p.id = c.%2$I AND c.workspace_id IS DISTINCT FROM p.workspace_id
          AND ($1 IS NULL OR p.workspace_id = $1 OR c.workspace_id = $1)
        RETURNING c.id, c.workspace_id AS new_ws)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'child_follows_parent', %4$L, jsonb_build_object('id', f.id), f.new_ws, NULL, jsonb_build_object('workspace_id', f.new_ws) FROM fixed f
    $q$, r.child, r.fk, r.parent, r.child) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.child || '.' || r.fk || '.restamped', n); END IF;
  END LOOP;
  -- document_draft has no id: keyed by (document_id, author_user_id)
  WITH fixed AS (
    UPDATE public.document_draft c SET workspace_id = d.workspace_id
    FROM public.document d
    WHERE d.id = c.document_id AND c.workspace_id IS DISTINCT FROM d.workspace_id
      AND (p_workspace IS NULL OR d.workspace_id = p_workspace OR c.workspace_id = p_workspace)
    RETURNING c.document_id, c.author_user_id, c.workspace_id AS new_ws)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'child_follows_parent', 'document_draft', jsonb_build_object('document_id', document_id, 'author_user_id', author_user_id), new_ws, NULL, jsonb_build_object('workspace_id', new_ws) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document_draft.restamped', n); END IF;
  -- anchor embeddings of projects: the key includes the workspace. Keep the newest out-of-place row
  -- per project (unless the project's workspace already has one), drop the rest, re-key the keeper.
  WITH ranked AS (
    SELECT e.workspace_id AS old_ws, e.entity_id, p.workspace_id AS home,
           row_number() OVER (PARTITION BY e.entity_id ORDER BY e.updated_at DESC, e.workspace_id) AS rn,
           EXISTS (SELECT 1 FROM public.anchor_embedding d WHERE d.workspace_id = p.workspace_id AND d.entity_type = 'project' AND d.entity_id = p.id) AS home_has_one
    FROM public.anchor_embedding e JOIN public.projects p ON p.id = e.entity_id
    WHERE e.entity_type = 'project' AND e.workspace_id <> p.workspace_id
      AND (p_workspace IS NULL OR p.workspace_id = p_workspace OR e.workspace_id = p_workspace)
  ),
  gone AS (
    DELETE FROM public.anchor_embedding e USING ranked k
    WHERE e.entity_type = 'project' AND e.entity_id = k.entity_id AND e.workspace_id = k.old_ws AND (k.rn > 1 OR k.home_has_one)
    RETURNING e.entity_id, e.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'duplicate_dropped', 'anchor_embedding', jsonb_build_object('entity_type', 'project', 'entity_id', entity_id, 'workspace_id', workspace_id), workspace_id, NULL, NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('anchor_embedding.duplicates_dropped', n); END IF;
  WITH fixed AS (
    UPDATE public.anchor_embedding e SET workspace_id = p.workspace_id
    FROM public.projects p
    WHERE e.entity_type = 'project' AND p.id = e.entity_id AND e.workspace_id <> p.workspace_id
      AND (p_workspace IS NULL OR p.workspace_id = p_workspace OR e.workspace_id = p_workspace)
    RETURNING e.entity_id, e.workspace_id AS new_ws)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'child_follows_parent', 'anchor_embedding', jsonb_build_object('entity_type', 'project', 'entity_id', entity_id), new_ws, NULL, jsonb_build_object('workspace_id', new_ws) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('anchor_embedding.restamped', n); END IF;

  -- ══ 2. member references ════════════════════════════════════════════════════
  -- jobs about to be dropped: the children that lose their parent pointer are logged first
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'cascade.parent_cleared', 'tracked_job', jsonb_build_object('id', c.id), c.workspace_id,
         jsonb_build_object('parent_id', c.parent_id, 'root_id', c.root_id), NULL
  FROM public.tracked_job c
  WHERE EXISTS (SELECT 1 FROM public.tracked_job t JOIN public.member m ON m.id = t.member_id
                WHERE m.workspace_id <> t.workspace_id AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
                  AND NOT EXISTS (SELECT 1 FROM public.member x WHERE x.workspace_id = t.workspace_id AND x.user_id = m.user_id)
                  AND t.id IN (c.parent_id, c.root_id));
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('tracked_job.children_orphaned', n); END IF;

  -- (table, column, what to do when the person is not in the row's workspace)
  FOR r IN SELECT * FROM (VALUES
      ('actions', 'assignee_id', 'null'),
      ('projects', 'lead_id', 'null'),
      ('initiative', 'owner_id', 'null'),
      ('document', 'last_edited_by', 'null'),
      ('document_revision', 'author_id', 'null'),
      ('claim', 'created_by', 'null'),
      ('claim', 'subject_member_id', 'null'),
      ('contact', 'member_id', 'null'),
      ('contact', 'created_by_member_id', 'null'),
      ('proposed_change', 'assignee_member_id', 'null'),
      ('proposed_change', 'applied_by', 'null'),
      ('campaign', 'owner_member_id', 'null'),
      ('notification', 'actor_id', 'null'),
      ('entity_link', 'created_by', 'null'),
      ('notification', 'recipient_id', 'delete'),
      ('attention_item', 'member_id', 'delete'),
      ('tracked_job', 'member_id', 'delete'),
      ('tool_approval', 'member_id', 'delete'),
      ('lens_finding', 'member_id', 'delete'),
      ('invite', 'invited_by', 'owner'),
      ('share', 'created_by', 'owner'),
      ('contact_share', 'shared_by_member_id', 'owner')
    ) AS v(tbl, col, on_miss)
  LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I t SET %2$I = x.id
        FROM public.member m, public.member x
        WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
          AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id
          AND ($1 IS NULL OR t.workspace_id = $1)
        RETURNING t.id, t.workspace_id, m.id AS old_member, x.id AS new_member)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'member_ref.translated', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
             jsonb_build_object(%4$L, f.old_member), jsonb_build_object(%4$L, f.new_member)
      FROM fixed f
    $q$, r.tbl, r.col, r.tbl, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col || '.translated', n); END IF;

    IF r.on_miss = 'null' THEN
      EXECUTE format($q$
        WITH fixed AS (
          UPDATE public.%1$I t SET %2$I = NULL
          FROM public.member m
          WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
            AND ($1 IS NULL OR t.workspace_id = $1)
          RETURNING t.id, t.workspace_id, m.id AS old_member)
        INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
        SELECT $2, 'member_ref.cleared', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
               jsonb_build_object(%4$L, f.old_member), jsonb_build_object(%4$L, NULL)
        FROM fixed f
      $q$, r.tbl, r.col, r.tbl, r.col) USING p_workspace, v_run;
    ELSIF r.on_miss = 'owner' THEN
      EXECUTE format($q$
        WITH fixed AS (
          UPDATE public.%1$I t SET %2$I = public._wsrepair_owner(t.workspace_id)
          FROM public.member m
          WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
            AND public._wsrepair_owner(t.workspace_id) IS NOT NULL
            AND ($1 IS NULL OR t.workspace_id = $1)
          RETURNING t.id, t.workspace_id, m.id AS old_member, t.%2$I AS new_member)
        INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
        SELECT $2, 'member_ref.reassigned_to_owner', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
               jsonb_build_object(%4$L, f.old_member), jsonb_build_object(%4$L, f.new_member)
        FROM fixed f
      $q$, r.tbl, r.col, r.tbl, r.col) USING p_workspace, v_run;
    ELSE
      EXECUTE format($q$
        WITH gone AS (
          DELETE FROM public.%1$I t
          USING public.member m
          WHERE m.id = t.%2$I AND m.workspace_id <> t.workspace_id
            AND ($1 IS NULL OR t.workspace_id = $1)
          RETURNING t.*)
        INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
        SELECT $2, 'member_ref.row_dropped', %3$L, jsonb_build_object('id', g.id), g.workspace_id, to_jsonb(g), NULL FROM gone g
      $q$, r.tbl, r.col, r.tbl) USING p_workspace, v_run;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col || '.' || CASE r.on_miss WHEN 'null' THEN 'cleared' WHEN 'owner' THEN 'to_owner' ELSE 'dropped' END, n); END IF;
  END LOOP;

  -- document.created_by: translate unless the person already holds the same personal canon key here;
  -- then that key goes (the twin keeps it) and the translation follows; the rest is cleared
  WITH fixed AS (
    UPDATE public.document t SET created_by = x.id
    FROM public.member m, public.member x
    WHERE m.id = t.created_by AND m.workspace_id <> t.workspace_id
      AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id
      AND NOT (t.canon_key ~ '^(person|content-brief):'
               AND EXISTS (SELECT 1 FROM public.document d2 WHERE d2.workspace_id = t.workspace_id AND d2.created_by = x.id AND d2.canon_key = t.canon_key AND d2.id <> t.id))
      AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING t.id, t.workspace_id, m.id AS old_member, x.id AS new_member)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated', 'document', jsonb_build_object('id', id), workspace_id, jsonb_build_object('created_by', old_member), jsonb_build_object('created_by', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document.created_by.translated', n); END IF;
  WITH fixed AS (
    UPDATE public.document t SET created_by = x.id, canon_key = NULL
    FROM public.member m, public.member x
    WHERE m.id = t.created_by AND m.workspace_id <> t.workspace_id
      AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id
      AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING t.id, t.workspace_id, m.id AS old_member, x.id AS new_member)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated_canon_released', 'document', jsonb_build_object('id', id), workspace_id, jsonb_build_object('created_by', old_member), jsonb_build_object('created_by', new_member, 'canon_key', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document.created_by.translated_canon_released', n); END IF;
  WITH fixed AS (
    UPDATE public.document t SET created_by = NULL
    FROM public.member m
    WHERE m.id = t.created_by AND m.workspace_id <> t.workspace_id AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING t.id, t.workspace_id, m.id AS old_member)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.cleared', 'document', jsonb_build_object('id', id), workspace_id, jsonb_build_object('created_by', old_member), jsonb_build_object('created_by', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('document.created_by.cleared', n); END IF;

  -- action_assignee (key action_id + member_id; workspace through the action); one row per target key
  WITH fixed AS (
    UPDATE public.action_assignee aa SET member_id = sub.new_member
    FROM (SELECT aa2.action_id, aa2.member_id AS old_member, x.id AS new_member, a.workspace_id,
                 row_number() OVER (PARTITION BY aa2.action_id, x.id ORDER BY aa2.created_at, aa2.member_id) AS rn
          FROM public.action_assignee aa2
          JOIN public.actions a ON a.id = aa2.action_id
          JOIN public.member m ON m.id = aa2.member_id
          JOIN public.member x ON x.workspace_id = a.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> a.workspace_id
            AND NOT EXISTS (SELECT 1 FROM public.action_assignee y WHERE y.action_id = aa2.action_id AND y.member_id = x.id)) sub
    WHERE aa.action_id = sub.action_id AND aa.member_id = sub.old_member AND sub.rn = 1
      AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING aa.action_id, sub.old_member, sub.new_member, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated', 'action_assignee', jsonb_build_object('action_id', action_id, 'member_id', new_member), workspace_id,
         jsonb_build_object('member_id', old_member), jsonb_build_object('member_id', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_assignee.translated', n); END IF;
  WITH gone AS (
    DELETE FROM public.action_assignee aa
    USING public.actions a, public.member m
    WHERE a.id = aa.action_id AND m.id = aa.member_id AND m.workspace_id <> a.workspace_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING aa.action_id, aa.member_id, a.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.row_dropped', 'action_assignee', jsonb_build_object('action_id', action_id, 'member_id', member_id), workspace_id,
         jsonb_build_object('member_id', member_id), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_assignee.dropped', n); END IF;

  -- team_member (workspace through the team); one row per target key
  WITH fixed AS (
    UPDATE public.team_member tm SET member_id = sub.new_member
    FROM (SELECT tm2.id, tm2.member_id AS old_member, x.id AS new_member, t.workspace_id,
                 row_number() OVER (PARTITION BY tm2.team_id, x.id ORDER BY tm2.joined_at, tm2.id) AS rn
          FROM public.team_member tm2
          JOIN public.team t ON t.id = tm2.team_id
          JOIN public.member m ON m.id = tm2.member_id
          JOIN public.member x ON x.workspace_id = t.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> t.workspace_id
            AND NOT EXISTS (SELECT 1 FROM public.team_member y WHERE y.team_id = tm2.team_id AND y.member_id = x.id)) sub
    WHERE tm.id = sub.id AND sub.rn = 1 AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING tm.id, sub.old_member, sub.new_member, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.translated', 'team_member', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('member_id', old_member), jsonb_build_object('member_id', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('team_member.translated', n); END IF;
  WITH gone AS (
    DELETE FROM public.team_member tm
    USING public.team t, public.member m
    WHERE t.id = tm.team_id AND m.id = tm.member_id AND m.workspace_id <> t.workspace_id
      AND (p_workspace IS NULL OR t.workspace_id = p_workspace)
    RETURNING tm.id, tm.team_id, tm.member_id, tm.team_role, t.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'member_ref.row_dropped', 'team_member', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('team_id', team_id, 'member_id', member_id, 'team_role', team_role), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('team_member.dropped', n); END IF;

  -- capture_participant.member_id (workspace through the capture); a participant keeps a name (CHECK: member or external_name)
  WITH fixed AS (
    UPDATE public.capture_participant cp
    SET member_id = sub.new_member,
        external_name = CASE WHEN sub.new_member IS NULL THEN COALESCE(cp.external_name, sub.display_name, 'Former member') ELSE cp.external_name END
    FROM (SELECT cp2.id, cp2.member_id AS old_member, x.id AS new_member, c.workspace_id, m.display_name
          FROM public.capture_participant cp2
          JOIN public.captures c ON c.id = cp2.capture_id
          JOIN public.member m ON m.id = cp2.member_id
          LEFT JOIN public.member x ON x.workspace_id = c.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> c.workspace_id) sub
    WHERE cp.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING cp.id, sub.old_member, cp.member_id AS new_member, cp.external_name, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_member IS NULL THEN 'member_ref.cleared' ELSE 'member_ref.translated' END, 'capture_participant',
         jsonb_build_object('id', id), workspace_id, jsonb_build_object('member_id', old_member), jsonb_build_object('member_id', new_member, 'external_name', external_name) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('capture_participant.member', n); END IF;

  -- decision.decided_by (workspace through the capture)
  WITH fixed AS (
    UPDATE public.decision d SET decided_by = sub.new_member
    FROM (SELECT d2.id, d2.decided_by AS old_member, x.id AS new_member, c.workspace_id
          FROM public.decision d2
          JOIN public.captures c ON c.id = d2.capture_id
          JOIN public.member m ON m.id = d2.decided_by
          LEFT JOIN public.member x ON x.workspace_id = c.workspace_id AND x.user_id = m.user_id
          WHERE m.workspace_id <> c.workspace_id) sub
    WHERE d.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING d.id, sub.old_member, d.decided_by AS new_member, sub.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_member IS NULL THEN 'member_ref.cleared' ELSE 'member_ref.translated' END, 'decision',
         jsonb_build_object('id', id), workspace_id, jsonb_build_object('decided_by', old_member), jsonb_build_object('decided_by', new_member) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('decision.decided_by', n); END IF;

  -- comment.author_id (workspace through the commentable); an untranslatable author keeps the name, as 320 does on departure
  WITH target AS (
    SELECT cm.id AS comment_id, cm.author_id, cm.author_name AS old_name, cm.author_avatar_url AS old_avatar,
           COALESCE(a.workspace_id, c.workspace_id, d.workspace_id, p.workspace_id, ct.workspace_id) AS ws
    FROM public.comment cm
    LEFT JOIN public.actions a ON cm.commentable_type = 'action' AND a.id = cm.commentable_id
    LEFT JOIN public.captures c ON cm.commentable_type = 'capture' AND c.id = cm.commentable_id
    LEFT JOIN public.document d ON cm.commentable_type = 'document' AND d.id = cm.commentable_id
    LEFT JOIN public.projects p ON cm.commentable_type = 'project' AND p.id = cm.commentable_id
    LEFT JOIN public.contact ct ON cm.commentable_type = 'contact' AND ct.id = cm.commentable_id
    WHERE cm.author_id IS NOT NULL
  ),
  fixed AS (
    UPDATE public.comment cm
    SET author_id = x.id,
        author_name = CASE WHEN x.id IS NULL THEN COALESCE(cm.author_name, m.display_name) ELSE cm.author_name END,
        author_avatar_url = CASE WHEN x.id IS NULL THEN COALESCE(cm.author_avatar_url, m.avatar_url) ELSE cm.author_avatar_url END
    FROM target tg
    JOIN public.member m ON m.id = tg.author_id
    LEFT JOIN public.member x ON x.user_id = m.user_id AND x.workspace_id = tg.ws
    WHERE cm.id = tg.comment_id AND tg.ws IS NOT NULL AND m.workspace_id <> tg.ws
      AND (p_workspace IS NULL OR tg.ws = p_workspace)
    RETURNING cm.id, m.id AS old_member, cm.author_id AS new_member, tg.old_name, tg.old_avatar, cm.author_name, cm.author_avatar_url, tg.ws)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_member IS NULL THEN 'member_ref.cleared' ELSE 'member_ref.translated' END, 'comment',
         jsonb_build_object('id', id), ws,
         jsonb_build_object('author_id', old_member, 'author_name', old_name, 'author_avatar_url', old_avatar),
         jsonb_build_object('author_id', new_member, 'author_name', author_name, 'author_avatar_url', author_avatar_url) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('comment.author', n); END IF;

  -- shares addressed to a member of another workspace (unique per contact / package): one row per target key, the rest dropped
  FOR r IN SELECT * FROM (VALUES ('contact_share', 'contact_id'), ('knowledge_package_share', 'package_id')) AS v(tbl, scope_col) LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I s SET shared_with_member_id = sub.new_member
        FROM (SELECT s2.id, s2.shared_with_member_id AS old_member, x.id AS new_member, s2.workspace_id,
                     row_number() OVER (PARTITION BY s2.%2$I, x.id ORDER BY s2.created_at, s2.id) AS rn
              FROM public.%1$I s2
              JOIN public.member m ON m.id = s2.shared_with_member_id
              JOIN public.member x ON x.workspace_id = s2.workspace_id AND x.user_id = m.user_id
              WHERE m.workspace_id <> s2.workspace_id
                AND NOT EXISTS (SELECT 1 FROM public.%1$I y WHERE y.%2$I = s2.%2$I AND y.shared_with_member_id = x.id)) sub
        WHERE s.id = sub.id AND sub.rn = 1 AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING s.id, sub.workspace_id, sub.old_member, sub.new_member)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'member_ref.translated', %3$L, jsonb_build_object('id', f.id), f.workspace_id,
             jsonb_build_object('shared_with_member_id', f.old_member), jsonb_build_object('shared_with_member_id', f.new_member) FROM fixed f
    $q$, r.tbl, r.scope_col, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.shared_with.translated', n); END IF;
    EXECUTE format($q$
      WITH gone AS (
        DELETE FROM public.%1$I s USING public.member m
        WHERE m.id = s.shared_with_member_id AND m.workspace_id <> s.workspace_id AND ($1 IS NULL OR s.workspace_id = $1)
        RETURNING s.*)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'member_ref.row_dropped', %2$L, jsonb_build_object('id', g.id), g.workspace_id, to_jsonb(g), NULL FROM gone g
    $q$, r.tbl, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.shared_with.dropped', n); END IF;
  END LOOP;

  -- ══ 3. team pointers ════════════════════════════════════════════════════════
  -- an action on another workspace's team: its own workspace's first team (222's trigger remaps the status; old status logged)
  WITH fixed AS (
    UPDATE public.actions a SET team_id = sub.new_team
    FROM (SELECT a2.id, a2.workspace_id, a2.team_id AS old_team, a2.status_id AS old_status, public._wsrepair_first_team(a2.workspace_id) AS new_team
          FROM public.actions a2 JOIN public.team t ON t.id = a2.team_id
          WHERE t.workspace_id <> a2.workspace_id) sub
    WHERE a.id = sub.id AND sub.new_team IS NOT NULL AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING a.id, sub.workspace_id, sub.old_team, sub.old_status, a.team_id AS new_team, a.status_id AS new_status)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'team_ref.refiled', 'actions', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('team_id', old_team, 'status_id', old_status), jsonb_build_object('team_id', new_team, 'status_id', new_status) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.team.refiled', n); END IF;
  -- a teammate on another workspace's team
  WITH fixed AS (
    UPDATE public.ai_team_member a SET team_id = public._wsrepair_first_team(a.workspace_id)
    FROM public.team t
    WHERE t.id = a.team_id AND t.workspace_id <> a.workspace_id
      AND public._wsrepair_first_team(a.workspace_id) IS NOT NULL
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING a.id, a.workspace_id, t.id AS old_team, a.team_id AS new_team)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'team_ref.refiled', 'ai_team_member', jsonb_build_object('id', id), workspace_id, jsonb_build_object('team_id', old_team), jsonb_build_object('team_id', new_team) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('ai_team_member.team.refiled', n); END IF;
  -- nullable team pointers into another workspace: cleared
  FOR r IN SELECT * FROM (VALUES ('captures'), ('document'), ('proposed_change'), ('knowledge_package'), ('flow'), ('view')) AS v(tbl) LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I x SET team_id = NULL
        FROM public.team t
        WHERE t.id = x.team_id AND t.workspace_id <> x.workspace_id
          AND ($1 IS NULL OR x.workspace_id = $1)
        RETURNING x.id, x.workspace_id, t.id AS old_team)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'team_ref.cleared', %2$L, jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object('team_id', f.old_team), jsonb_build_object('team_id', NULL) FROM fixed f
    $q$, r.tbl, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.team.cleared', n); END IF;
  END LOOP;
  -- a cycle from another team (after the refile above)
  WITH fixed AS (
    UPDATE public.actions a SET cycle_id = NULL
    FROM public.cycle cy
    WHERE cy.id = a.cycle_id AND cy.team_id <> a.team_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING a.id, a.workspace_id, cy.id AS old_cycle)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'actions', jsonb_build_object('id', id), workspace_id, jsonb_build_object('cycle_id', old_cycle), jsonb_build_object('cycle_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.cycle.cleared', n); END IF;
  -- team shares into another workspace's team
  FOR r IN SELECT * FROM (VALUES ('contact_share'), ('knowledge_package_share')) AS v(tbl) LOOP
    EXECUTE format($q$
      WITH gone AS (
        DELETE FROM public.%1$I s USING public.team t
        WHERE t.id = s.shared_with_team_id AND t.workspace_id <> s.workspace_id
          AND ($1 IS NULL OR s.workspace_id = $1)
        RETURNING s.*)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'team_ref.row_dropped', %2$L, jsonb_build_object('id', g.id), g.workspace_id, to_jsonb(g), NULL FROM gone g
    $q$, r.tbl, r.tbl) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.shared_with_team.dropped', n); END IF;
  END LOOP;

  -- ══ 4. pointers across workspaces ═══════════════════════════════════════════
  -- mail copies first: the sibling copy in the entity's workspace takes a link where it has none (logged), then the copy's own link is cleared
  FOR r IN SELECT * FROM (VALUES
      ('linked_action_id', 'actions'), ('linked_capture_id', 'captures'), ('linked_project_id', 'projects')
    ) AS v(col, target)
  LOOP
    EXECUTE format($q$
      WITH moved AS (
        UPDATE public.email_thread_index s SET %1$I = e.%1$I
        FROM public.email_thread_index e
        JOIN public.%2$I tg ON tg.id = e.%1$I
        WHERE tg.workspace_id <> e.workspace_id
          AND s.workspace_id = tg.workspace_id AND s.provider_thread_id = e.provider_thread_id
          AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND s.%1$I IS NULL
          AND ($1 IS NULL OR e.workspace_id = $1)
        RETURNING s.id, s.workspace_id, e.id AS from_copy, s.%1$I AS link)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'mail_link.sibling_took_link', 'email_thread_index', jsonb_build_object('id', mv.id), mv.workspace_id,
             jsonb_build_object(%3$L, NULL, 'from_copy', mv.from_copy), jsonb_build_object(%3$L, mv.link) FROM moved mv
    $q$, r.col, r.target, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.' || r.col || '.sibling_took_link', n); END IF;
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.email_thread_index e SET %1$I = NULL
        FROM (SELECT e2.id, tg.id AS old_target, e2.workspace_id,
                     EXISTS (SELECT 1 FROM public.email_thread_index s WHERE s.workspace_id = tg.workspace_id AND s.provider_thread_id = e2.provider_thread_id
                             AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e2.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
                             AND s.%1$I = tg.id) AS sibling_has
              FROM public.email_thread_index e2 JOIN public.%2$I tg ON tg.id = e2.%1$I
              WHERE tg.workspace_id <> e2.workspace_id) sub
        WHERE e.id = sub.id AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING e.id, sub.workspace_id, sub.old_target, sub.sibling_has)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, CASE WHEN f.sibling_has THEN 'mail_link.moved_to_sibling' ELSE 'mail_link.cleared' END, 'email_thread_index',
             jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object(%3$L, f.old_target), jsonb_build_object(%3$L, NULL) FROM fixed f
    $q$, r.col, r.target, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.' || r.col || '.cleared', n); END IF;
  END LOOP;
  -- a mail copy linking another workspace's contact: sibling takes it (logged), then re-point locally by email, else clear
  WITH moved AS (
    UPDATE public.email_thread_index s SET linked_contact_id = e.linked_contact_id
    FROM public.email_thread_index e JOIN public.contact ct ON ct.id = e.linked_contact_id
    WHERE ct.workspace_id <> e.workspace_id
      AND s.workspace_id = ct.workspace_id AND s.provider_thread_id = e.provider_thread_id
      AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND s.linked_contact_id IS NULL
      AND (p_workspace IS NULL OR e.workspace_id = p_workspace)
    RETURNING s.id, s.workspace_id, e.id AS from_copy, s.linked_contact_id AS link)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'mail_link.sibling_took_link', 'email_thread_index', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('linked_contact_id', NULL, 'from_copy', from_copy), jsonb_build_object('linked_contact_id', link) FROM moved;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.linked_contact_id.sibling_took_link', n); END IF;
  WITH fixed AS (
    UPDATE public.email_thread_index e SET linked_contact_id = sub.new_target
    FROM (SELECT e2.id, ct.id AS old_target, e2.workspace_id,
                 (SELECT c2.id FROM public.contact c2 WHERE c2.workspace_id = e2.workspace_id AND c2.email IS NOT NULL
                   AND lower(c2.email) = lower(ct.email) AND c2.merged_into_contact_id IS NULL ORDER BY c2.created_at LIMIT 1) AS new_target,
                 EXISTS (SELECT 1 FROM public.email_thread_index s WHERE s.workspace_id = ct.workspace_id AND s.provider_thread_id = e2.provider_thread_id
                         AND COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(e2.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
                         AND s.linked_contact_id = ct.id) AS sibling_has
          FROM public.email_thread_index e2 JOIN public.contact ct ON ct.id = e2.linked_contact_id
          WHERE ct.workspace_id <> e2.workspace_id) sub
    WHERE e.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING e.id, sub.workspace_id, sub.old_target, sub.new_target, sub.sibling_has)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NOT NULL THEN 'mail_link.relinked_by_email' WHEN sibling_has THEN 'mail_link.moved_to_sibling' ELSE 'mail_link.cleared' END,
         'email_thread_index', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('linked_contact_id', old_target), jsonb_build_object('linked_contact_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('email_thread_index.linked_contact_id', n); END IF;

  -- pointers nothing can resolve: cut
  FOR r IN SELECT * FROM (VALUES
      ('actions', 'project_id', 'projects'),
      ('actions', 'parent_id', 'actions'),
      ('actions', 'source_capture_id', 'captures'),
      ('actions', 'assignee_ai_member_id', 'ai_team_member'),
      ('projects', 'initiative_id', 'initiative'),
      ('projects', 'parent_project_id', 'projects'),
      ('captures', 'project_id', 'projects'),
      ('document', 'project_id', 'projects'),
      ('chat_conversations', 'capture_id', 'captures'),
      ('chat_conversations', 'ai_team_member_id', 'ai_team_member'),
      ('flow', 'ai_team_member_id', 'ai_team_member')
    ) AS v(tbl, col, target)
  LOOP
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I x SET %2$I = NULL
        FROM public.%3$I tg
        WHERE tg.id = x.%2$I AND tg.workspace_id <> x.workspace_id
          AND ($1 IS NULL OR x.workspace_id = $1)
        RETURNING x.id, x.workspace_id, tg.id AS old_target)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'pointer.cleared', %4$L, jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object(%5$L, f.old_target), jsonb_build_object(%5$L, NULL) FROM fixed f
    $q$, r.tbl, r.col, r.target, r.tbl, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col || '.cleared', n); END IF;
  END LOOP;
  -- actions.milestone_id (through the milestone's project)
  WITH fixed AS (
    UPDATE public.actions a SET milestone_id = NULL
    FROM public.milestone ms JOIN public.projects p ON p.id = ms.project_id
    WHERE ms.id = a.milestone_id AND p.workspace_id <> a.workspace_id AND (p_workspace IS NULL OR a.workspace_id = p_workspace)
    RETURNING a.id, a.workspace_id, ms.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'actions', jsonb_build_object('id', id), workspace_id, jsonb_build_object('milestone_id', old_target), jsonb_build_object('milestone_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.milestone_id.cleared', n); END IF;
  -- decision.project_id (workspace through the capture)
  WITH fixed AS (
    UPDATE public.decision d SET project_id = NULL
    FROM public.captures c, public.projects p
    WHERE c.id = d.capture_id AND p.id = d.project_id AND p.workspace_id <> c.workspace_id AND (p_workspace IS NULL OR c.workspace_id = p_workspace)
    RETURNING d.id, c.workspace_id, p.id AS old_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pointer.cleared', 'decision', jsonb_build_object('id', id), workspace_id, jsonb_build_object('project_id', old_target), jsonb_build_object('project_id', NULL) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('decision.project_id.cleared', n); END IF;

  -- contact pointers: re-point by email in the row's workspace, else clear
  WITH fixed AS (
    UPDATE public.actions a SET assignee_contact_id = sub.new_target
    FROM (SELECT a2.id, ct.id AS old_target, a2.workspace_id,
                 (SELECT c2.id FROM public.contact c2 WHERE c2.workspace_id = a2.workspace_id AND c2.email IS NOT NULL
                   AND lower(c2.email) = lower(ct.email) AND c2.merged_into_contact_id IS NULL ORDER BY c2.created_at LIMIT 1) AS new_target
          FROM public.actions a2 JOIN public.contact ct ON ct.id = a2.assignee_contact_id
          WHERE ct.workspace_id <> a2.workspace_id) sub
    WHERE a.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING a.id, sub.workspace_id, sub.old_target, sub.new_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NULL THEN 'pointer.cleared' ELSE 'pointer.relinked_by_email' END, 'actions', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('assignee_contact_id', old_target), jsonb_build_object('assignee_contact_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('actions.assignee_contact', n); END IF;

  WITH fixed AS (
    UPDATE public.capture_participant cp SET contact_id = sub.new_target
    FROM (SELECT cp2.id, ct.id AS old_target, c.workspace_id,
                 (SELECT c2.id FROM public.contact c2 WHERE c2.workspace_id = c.workspace_id AND c2.email IS NOT NULL
                   AND lower(c2.email) = lower(ct.email) AND c2.merged_into_contact_id IS NULL ORDER BY c2.created_at LIMIT 1) AS new_target
          FROM public.capture_participant cp2
          JOIN public.captures c ON c.id = cp2.capture_id
          JOIN public.contact ct ON ct.id = cp2.contact_id
          WHERE ct.workspace_id <> c.workspace_id) sub
    WHERE cp.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING cp.id, sub.workspace_id, sub.old_target, sub.new_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NULL THEN 'pointer.cleared' ELSE 'pointer.relinked_by_email' END, 'capture_participant', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('contact_id', old_target), jsonb_build_object('contact_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('capture_participant.contact', n); END IF;

  -- company pointers: re-point by domain, else clear
  WITH fixed AS (
    UPDATE public.contact c SET company_id = sub.new_target
    FROM (SELECT c1.id, co.id AS old_target, c1.workspace_id,
                 (SELECT c2.id FROM public.company c2 WHERE c2.workspace_id = c1.workspace_id AND COALESCE(c2.domain, '') <> ''
                   AND lower(c2.domain) = lower(co.domain) ORDER BY c2.created_at LIMIT 1) AS new_target
          FROM public.contact c1 JOIN public.company co ON co.id = c1.company_id
          WHERE co.workspace_id <> c1.workspace_id) sub
    WHERE c.id = sub.id AND (p_workspace IS NULL OR sub.workspace_id = p_workspace)
    RETURNING c.id, sub.workspace_id, sub.old_target, sub.new_target)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, CASE WHEN new_target IS NULL THEN 'pointer.cleared' ELSE 'pointer.relinked_by_domain' END, 'contact', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('company_id', old_target), jsonb_build_object('company_id', new_target) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('contact.company', n); END IF;

  -- ══ 5. labels, shares, edges, pins ══════════════════════════════════════════
  FOR r IN SELECT * FROM (VALUES
      ('action_label', 'action_id', 'actions'), ('capture_label', 'capture_id', 'captures'),
      ('project_label', 'project_id', 'projects'), ('initiative_label', 'initiative_id', 'initiative'),
      ('email_thread_label', 'thread_id', 'email_thread_index')
    ) AS v(junction, col, parent)
  LOOP
    -- the same-named label in the entity's workspace; one junction row per target label, the rest dropped below
    EXECUTE format($q$
      WITH fixed AS (
        UPDATE public.%1$I j SET label_id = sub.new_label
        FROM (SELECT j2.%2$I AS entity_id, j2.label_id AS old_label, loc.id AS new_label, e.workspace_id,
                     row_number() OVER (PARTITION BY j2.%2$I, loc.id ORDER BY l.created_at, l.id) AS rn
              FROM public.%1$I j2
              JOIN public.%3$I e ON e.id = j2.%2$I
              JOIN public.label l ON l.id = j2.label_id
              JOIN LATERAL (SELECT l2.id FROM public.label l2 WHERE l2.workspace_id = e.workspace_id AND lower(l2.name) = lower(l.name) ORDER BY l2.created_at LIMIT 1) loc ON true
              WHERE l.workspace_id <> e.workspace_id
                AND NOT EXISTS (SELECT 1 FROM public.%1$I x WHERE x.%2$I = j2.%2$I AND x.label_id = loc.id)) sub
        WHERE j.%2$I = sub.entity_id AND j.label_id = sub.old_label AND sub.rn = 1
          AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING j.%2$I AS entity_id, sub.old_label, sub.new_label, sub.workspace_id)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'label_junction.repointed', %4$L, jsonb_build_object(%5$L, f.entity_id, 'label_id', f.new_label), f.workspace_id,
             jsonb_build_object('label_id', f.old_label), jsonb_build_object('label_id', f.new_label) FROM fixed f
    $q$, r.junction, r.col, r.parent, r.junction, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.junction || '.repointed', n); END IF;
    EXECUTE format($q$
      WITH gone AS (
        DELETE FROM public.%1$I j USING public.%3$I e, public.label l
        WHERE e.id = j.%2$I AND l.id = j.label_id AND l.workspace_id <> e.workspace_id
          AND ($1 IS NULL OR e.workspace_id = $1)
        RETURNING j.%2$I AS entity_id, j.label_id, e.workspace_id)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'label_junction.dropped', %4$L, jsonb_build_object(%5$L, g.entity_id, 'label_id', g.label_id), g.workspace_id, jsonb_build_object('label_id', g.label_id), NULL FROM gone g
    $q$, r.junction, r.col, r.parent, r.junction, r.col) USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN v_out := v_out || jsonb_build_object(r.junction || '.dropped', n); END IF;
  END LOOP;

  -- a share on another workspace's entity: deactivated (221's rule), never deleted
  WITH fixed AS (
    UPDATE public.share s SET is_active = false
    FROM (SELECT s2.id FROM public.share s2
          LEFT JOIN public.captures c ON c.id = s2.shareable_id AND s2.shareable_type = 'capture'
          LEFT JOIN public.document d ON d.id = s2.shareable_id AND s2.shareable_type = 'document'
          WHERE s2.is_active AND COALESCE(c.workspace_id, d.workspace_id) <> s2.workspace_id) bad
    WHERE s.id = bad.id AND (p_workspace IS NULL OR s.workspace_id = p_workspace)
    RETURNING s.id, s.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'share.deactivated', 'share', jsonb_build_object('id', id), workspace_id, jsonb_build_object('is_active', true), jsonb_build_object('is_active', false) FROM fixed;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('share.deactivated', n); END IF;

  -- edges with an end outside their workspace
  WITH gone AS (
    DELETE FROM public.entity_link l
    WHERE (p_workspace IS NULL OR l.workspace_id = p_workspace) AND (
         EXISTS (SELECT 1 FROM public.actions a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.document a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.company a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id)
      OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> l.workspace_id))
    RETURNING l.*)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'edge.dropped', 'entity_link', jsonb_build_object('id', id), workspace_id, to_jsonb(g), NULL FROM gone g;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('entity_link.dropped', n); END IF;

  -- pins on another workspace's entity
  WITH gone AS (
    DELETE FROM public.knowledge_package_item i
    WHERE (p_workspace IS NULL OR i.workspace_id = p_workspace) AND (
         EXISTS (SELECT 1 FROM public.actions a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id)
      OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id = i.entity_id AND a.workspace_id <> i.workspace_id))
    RETURNING i.*)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'pin.dropped', 'knowledge_package_item', jsonb_build_object('package_id', package_id, 'entity_type', entity_type, 'entity_id', entity_id), workspace_id, to_jsonb(g), NULL FROM gone g;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('knowledge_package_item.dropped', n); END IF;

  -- action relations and action-document links with ends in different workspaces
  WITH gone AS (
    DELETE FROM public.action_relation ar USING public.actions a, public.actions b
    WHERE a.id = ar.action_id AND b.id = ar.related_action_id AND a.workspace_id <> b.workspace_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace OR b.workspace_id = p_workspace)
    RETURNING ar.id, ar.action_id, ar.related_action_id, ar.type, a.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'edge.dropped', 'action_relation', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('action_id', action_id, 'related_action_id', related_action_id, 'type', type), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_relation.dropped', n); END IF;
  WITH gone AS (
    DELETE FROM public.action_document ad USING public.actions a, public.document d
    WHERE a.id = ad.action_id AND d.id = ad.document_id AND a.workspace_id <> d.workspace_id
      AND (p_workspace IS NULL OR a.workspace_id = p_workspace OR d.workspace_id = p_workspace)
    RETURNING ad.id, ad.action_id, ad.document_id, a.workspace_id)
  INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
  SELECT v_run, 'edge.dropped', 'action_document', jsonb_build_object('id', id), workspace_id,
         jsonb_build_object('action_id', action_id, 'document_id', document_id), NULL FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('action_document.dropped', n); END IF;

  -- ══ 6. deals (DEV only today) ═══════════════════════════════════════════════
  IF to_regclass('public.deal') IS NOT NULL THEN
    EXECUTE $q$
      WITH fixed AS (
        UPDATE public.deal d SET team_id = sub.new_team, status_id = sub.new_status
        FROM (SELECT d2.id, d2.workspace_id, d2.team_id AS old_team, d2.status_id AS old_status,
                     public._wsrepair_first_team(d2.workspace_id) AS new_team,
                     (SELECT ws.id FROM public.workflow_state ws WHERE ws.team_id = public._wsrepair_first_team(d2.workspace_id) AND ws.is_default ORDER BY ws.sort_order, ws.id LIMIT 1) AS new_status
              FROM public.deal d2 JOIN public.team t ON t.id = d2.team_id
              WHERE t.workspace_id <> d2.workspace_id) sub
        WHERE d.id = sub.id AND sub.new_team IS NOT NULL AND sub.new_status IS NOT NULL
          AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING d.id, sub.workspace_id, sub.old_team, sub.old_status, d.team_id AS new_team, d.status_id AS new_status)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'team_ref.refiled', 'deal', jsonb_build_object('id', f.id), f.workspace_id,
             jsonb_build_object('team_id', f.old_team, 'status_id', f.old_status), jsonb_build_object('team_id', f.new_team, 'status_id', f.new_status) FROM fixed f
    $q$ USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('deal.team.refiled', n); END IF;
    -- a deal whose status belongs to another team: the deal's team's default
    EXECUTE $q$
      WITH fixed AS (
        UPDATE public.deal d SET status_id = sub.new_status
        FROM (SELECT d2.id, d2.workspace_id, d2.status_id AS old_status,
                     (SELECT ws.id FROM public.workflow_state ws WHERE ws.team_id = d2.team_id AND ws.is_default ORDER BY ws.sort_order, ws.id LIMIT 1) AS new_status
              FROM public.deal d2 JOIN public.workflow_state s ON s.id = d2.status_id
              WHERE s.team_id <> d2.team_id) sub
        WHERE d.id = sub.id AND sub.new_status IS NOT NULL AND ($1 IS NULL OR sub.workspace_id = $1)
        RETURNING d.id, sub.workspace_id, sub.old_status, d.status_id AS new_status)
      INSERT INTO public.workspace_repair_log (run_id, class, table_name, row_key, workspace_id, before, after)
      SELECT $2, 'status.remapped', 'deal', jsonb_build_object('id', f.id), f.workspace_id, jsonb_build_object('status_id', f.old_status), jsonb_build_object('status_id', f.new_status) FROM fixed f
    $q$ USING p_workspace, v_run;
    GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN v_out := v_out || jsonb_build_object('deal.status.remapped', n); END IF;
  END IF;

  -- ══ what the sweep still flags, in every workspace this run touched ═════════
  SELECT COALESCE(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'check', s.check_name, 'violations', s.violations)), '[]'::jsonb)
  INTO v_remaining
  FROM public.workspace w CROSS JOIN LATERAL public.workspace_integrity_sweep(w.id) s
  WHERE p_workspace IS NULL
     OR w.id = p_workspace
     OR w.id IN (SELECT DISTINCT lg.workspace_id FROM public.workspace_repair_log lg WHERE lg.run_id = v_run AND lg.workspace_id IS NOT NULL);

  RETURN jsonb_build_object('run_id', v_run, 'repaired', v_out,
                            'rows_logged', (SELECT count(*) FROM public.workspace_repair_log WHERE run_id = v_run),
                            'remaining', v_remaining);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.repair_cross_workspace_drift(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._wsrepair_first_team(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._wsrepair_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_cross_workspace_drift(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- The repair itself, once, for every workspace. The JSON is the report.
SELECT public.repair_cross_workspace_drift(NULL) AS repair;
