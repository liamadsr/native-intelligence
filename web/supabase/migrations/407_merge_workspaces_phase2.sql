-- 407: merge workspaces, phase 2 — what the routes need
-- (docs/plans/merge-workspaces.md, "Phases", 2; decided by Liam 2026-10-21).
--
--   statement_timeout for service_role   Measured on DEV: the service role
--                                        inherits the authenticator's 8 s through
--                                        PostgREST (a 12 s probe was cancelled at
--                                        8.1 s). A whole-workspace merge is one
--                                        statement, so the server-only role gets
--                                        120 s. Every call from our own code runs
--                                        under it; the only long ones are the
--                                        merge and the paged export. PostgREST
--                                        applies impersonated-role settings per
--                                        request and re-reads them on a CONFIG
--                                        reload (the schema reload is for the
--                                        function signature below).
--   storage bucket workspace-merges      Private, JSON only, 50 MB a file. The
--                                        route stores the paged snapshot of the
--                                        source workspace here before calling
--                                        merge_workspace (<source>/<snapshot>/
--                                        <table>.<page>.json plus manifest.json).
--                                        Service role only: no storage policies,
--                                        so no client reads.
--   notification type workspace_merged   The notice every destination member
--                                        gets through the agent ("X was merged
--                                        into Y: …"). NOTIFICATION_TYPES in
--                                        src/lib/notifications.ts and
--                                        NOTICE_EVENT_KIND (kind 'activity') in
--                                        src/lib/agent-events/types.ts carry the
--                                        same addition; the CHECK is 401's list
--                                        plus this one type.
--   export_workspace_rows, again         402's export paged by row count with
--                                        OFFSET. On PROD a 5,000-row page of
--                                        claim_chunks or capture_chunks is ~95 MB
--                                        of JSON, twice the file limit, and a row
--                                        written while the snapshot runs shifts
--                                        an OFFSET page (skipped or doubled). The
--                                        page is now cut by JSON bytes along the
--                                        primary key (keyset) and says where to
--                                        continue; every column whose name says
--                                        secret, token, password or encrypted
--                                        stays out, besides 402's named ones.

ALTER ROLE service_role SET statement_timeout = '120s';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('workspace-merges', 'workspace-merges', false, 52428800, ARRAY['application/json'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 52428800, allowed_mime_types = ARRAY['application/json'];

ALTER TABLE public.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE public.notification ADD CONSTRAINT notification_type_check CHECK (type = ANY (ARRAY[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged'
]));

-- ------------------------------------------------------------
-- The export, paged by bytes along the primary key.
--
--   export_workspace_rows(p_workspace, p_table, p_after, p_max_bytes)
--     → { rows: [...], count, bytes, cursor: {pk col: value, …} | null, done }
--
-- Rows come in primary-key order, after `p_after` (the previous page's
-- cursor; NULL for the first page), at most 5,000 and at most `p_max_bytes` of
-- JSON (the row that crosses the budget is the last one kept; a single row
-- always fits a page, however big). `done` is true when the table has nothing
-- after this page; the caller then compares the rows it wrote with the
-- manifest's count. Every exported table has a primary key (checked on DEV
-- and PROD); one without is refused rather than paged by ctid.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.export_workspace_rows(uuid, text, int, int);

CREATE OR REPLACE FUNCTION public.export_workspace_rows(p_workspace uuid, p_table text, p_after jsonb DEFAULT NULL, p_max_bytes int DEFAULT 20971520)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pred text; v_cols text; v_keys text[]; v_types text[];
  v_order text; v_cursor text; v_after_vals text; v_after_pred text := 'TRUE';
  v_out jsonb;
BEGIN
  SELECT predicate INTO v_pred FROM public._wsmerge_export_tables() WHERE table_name = p_table;
  IF v_pred IS NULL OR to_regclass('public.' || quote_ident(p_table)) IS NULL THEN
    RAISE EXCEPTION 'table % is not exported', p_table USING ERRCODE = '22023';
  END IF;
  IF p_max_bytes IS NULL OR p_max_bytes < 1024 OR p_max_bytes > 52428800 THEN
    RAISE EXCEPTION 'max bytes must be between 1 KB and 50 MB' USING ERRCODE = '22023';
  END IF;

  -- the columns: no vectors, no search vectors, no credential material
  SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = p_table
    AND c.udt_name NOT IN ('vector', 'halfvec', 'tsvector')
    AND NOT (c.table_name = 'cloud_environment' AND c.column_name = 'env_vars')
    AND NOT (c.table_name = 'connected_mcp_server' AND c.column_name IN ('access_token_encrypted', 'refresh_token_encrypted'))
    AND NOT (c.table_name = 'task_sync_state' AND c.column_name = 'webhook_secret')
    AND c.column_name !~* '(secret|password|passwd|api_key|private_key|_encrypted$|^token$|_token$|^env_vars$)';

  -- the key: the primary key, in index order
  SELECT array_agg(a.attname::text ORDER BY k.ord), array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY k.ord)
  INTO v_keys, v_types
  FROM pg_index i
  CROSS JOIN LATERAL unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indrelid = ('public.' || quote_ident(p_table))::regclass AND i.indisprimary;
  IF v_keys IS NULL THEN
    RAISE EXCEPTION 'table % has no primary key to page by', p_table USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(format('x.%I', k), ', ') INTO v_order FROM unnest(v_keys) AS k;
  SELECT string_agg(format('%L, x.%I', k, k), ', ') INTO v_cursor FROM unnest(v_keys) AS k;
  IF p_after IS NOT NULL THEN
    SELECT string_agg(format('($2->>%L)::%s', u.k, u.t), ', ' ORDER BY u.ord) INTO v_after_vals
    FROM unnest(v_keys, v_types) WITH ORDINALITY AS u(k, t, ord);
    v_after_pred := format('(%s) > (%s)', v_order, v_after_vals);
  END IF;

  EXECUTE format($q$
    WITH page AS (
      SELECT %1$s FROM public.%2$I x WHERE (%3$s) AND (%4$s) ORDER BY %5$s LIMIT 5000
    ),
    sized AS (
      SELECT x.*, octet_length(to_jsonb(x)::text) AS __bytes FROM page x
    ),
    running AS (
      SELECT x.*, sum(x.__bytes) OVER (ORDER BY %5$s) AS __running FROM sized x
    ),
    kept AS (
      SELECT x.* FROM running x WHERE x.__running - x.__bytes < $3
    )
    SELECT jsonb_build_object(
      'rows',   COALESCE((SELECT jsonb_agg(to_jsonb(x) - '__bytes' - '__running' ORDER BY %5$s) FROM kept x), '[]'::jsonb),
      'count',  (SELECT count(*) FROM kept),
      'bytes',  COALESCE((SELECT sum(x.__bytes) FROM kept x), 0),
      'cursor', (SELECT jsonb_build_object(%6$s) FROM kept x ORDER BY %5$s DESC LIMIT 1),
      'done',   (SELECT count(*) FROM page) < 5000 AND (SELECT count(*) FROM kept) = (SELECT count(*) FROM page)
    )
  $q$, v_cols, p_table, v_pred, v_after_pred, v_order, v_cursor)
  INTO v_out USING p_workspace, p_after, p_max_bytes;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.export_workspace_rows(uuid, text, jsonb, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_workspace_rows(uuid, text, jsonb, int) TO service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
