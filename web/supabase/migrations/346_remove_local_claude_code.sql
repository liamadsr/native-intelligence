-- ============================================================
-- 346: remove the local Claude Code runtime's schema
-- ============================================================
-- Run straight after the web deploy; after this runs, never roll the web back
-- past that deploy (old code selects the dropped columns).
--
-- Decision, 2026-10-15 (Liam): the local Claude Code pipeline is removed.
-- Chat, one-shot generations, live calls and loops run on eve only; the
-- desktop no longer runs the `claude` CLI, claims local runs or writes a
-- per-session MCP config. The external Dial8 MCP server and its OAuth (Claude
-- Code, Cursor and other OUTSIDE clients) stay untouched.
--
-- Apply ONLY after the web deploy that removed the pipeline (branch
-- claude/remove-claude-code): that code no longer reads or writes anything
-- dropped here. 345 is reserved for another branch; this file does not depend
-- on it.
--
-- In order:
--   0. guards: no function (any non-system schema), view, materialized view,
--      row security policy, column default, trigger WHEN clause or pg_cron
--      job still names a table, column or key dropped here (a word match, so
--      no spacing or quoting hides one); no foreign key outside the dropped
--      tables points at local_run_queue or project_local_path; and none but
--      mcp_auth_code and mcp_oauth_token points at mcp_oauth_client.
--   1. flow_run rows still 'pending' (only the removed desktop dispatcher
--      wrote that state; nothing settles them now) become 'failed' with an
--      error message that says why, and so does their live work item
--      (tracked_job queued or running on that run). Pending approvals the
--      retired 'mcp' door raised (a desktop run's held call) expire, with
--      their cards. The door stays in tool_approval's CHECK for history.
--   2. MCP tokens the removed pipeline minted are deleted (deleting is how
--      this codebase revokes): every token pinned to a workspace (only the
--      removed run and live-agent token minting pinned one; dropping the pin
--      column with such a token alive would UNPIN it, widening its reach),
--      every token and auth code of the 'dial8-cloud-agent' client, and every
--      token and auth code of the clients the desktop registered as
--      'Dial8 Desktop (in-app)' (one per setup, so found by name, never by a
--      hard-coded id). This also kills the bearer in any stray temp MCP config
--      file a desktop left behind. Then those client rows go, when nothing
--      references them any more.
--   3. local_run_queue goes (with its indexes and its SELECT policy), and so
--      does its realtime policy local_run_owner_can_subscribe on
--      realtime.messages; project_local_path goes (with its policy).
--   4. the columns go: chat_conversations.claude_session_id,
--      claude_session_device_id and claude_cwd; captures.agent_cwd_override;
--      mcp_oauth_token.pinned_workspace_id; agent_run.mcp_token_hash.
--   5. workspace.settings loses its compute_policy key.
--
-- Idempotent: the guards only read the catalog; every update and delete is
-- fenced on what it changes; drop ... if exists and drop column if exists; the
-- token deletes that need a dropped column check for it first. A second run
-- changes nothing. Each step reports its count with RAISE NOTICE. This file
-- holds no backslash anywhere: one MCP transport decodes escapes, so the
-- applied SQL would differ from the file.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

-- ── 0. Guards ───────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_name text;
  v_words constant text :=
    '(^|[^a-z_])(local_run_queue|project_local_path|pinned_workspace_id|mcp_token_hash|claude_session_id|claude_session_device_id|claude_cwd|agent_cwd_override|compute_policy)([^a-z_]|$)';
BEGIN
  FOR v_name IN
    SELECT 'function ' || n.nspname || '.' || p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND p.prokind IN ('f', 'p')
       AND pg_get_functiondef(p.oid) ~* v_words
    UNION ALL
    SELECT 'view ' || v.schemaname || '.' || v.viewname
      FROM pg_views v
     WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')
       AND v.definition ~* v_words
    UNION ALL
    SELECT 'materialized view ' || mv.schemaname || '.' || mv.matviewname
      FROM pg_matviews mv
     WHERE mv.definition ~* v_words
    UNION ALL
    SELECT 'policy ' || pol.policyname || ' on ' || pol.schemaname || '.' || pol.tablename
      FROM pg_policies pol
     WHERE NOT (pol.schemaname = 'public' AND pol.tablename IN ('local_run_queue', 'project_local_path'))
       AND (coalesce(pol.qual, '') ~* v_words OR coalesce(pol.with_check, '') ~* v_words)
    UNION ALL
    SELECT 'column default on ' || d.adrelid::regclass::text
      FROM pg_attrdef d
     WHERE d.adrelid NOT IN (
             coalesce(to_regclass('public.local_run_queue')::oid, 0::oid),
             coalesce(to_regclass('public.project_local_path')::oid, 0::oid))
       AND pg_get_expr(d.adbin, d.adrelid) ~* v_words
    UNION ALL
    SELECT 'trigger ' || t.tgname || ' on ' || t.tgrelid::regclass::text
      FROM pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgqual IS NOT NULL
       AND t.tgrelid NOT IN (
             coalesce(to_regclass('public.local_run_queue')::oid, 0::oid),
             coalesce(to_regclass('public.project_local_path')::oid, 0::oid))
       AND pg_get_triggerdef(t.oid) ~* v_words
  LOOP
    RAISE EXCEPTION '346: % still names a local Claude Code table, column or key; redefine it first', v_name;
  END LOOP;

  -- Scheduled SQL (pg_cron), when the extension is installed.
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR v_name IN EXECUTE
      'SELECT ''cron job '' || jobid::text FROM cron.job WHERE command ~* $1'
      USING v_words
    LOOP
      RAISE EXCEPTION '346: % still names a local Claude Code table, column or key; change it first', v_name;
    END LOOP;
  END IF;

  -- Foreign keys INTO the dropped tables from anywhere else.
  FOR v_name IN
    SELECT c.conname || ' on ' || c.conrelid::regclass::text
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid = ANY (ARRAY[
         coalesce(to_regclass('public.local_run_queue')::oid, 0::oid),
         coalesce(to_regclass('public.project_local_path')::oid, 0::oid)
       ])
       AND c.conrelid <> c.confrelid
  LOOP
    RAISE EXCEPTION '346: foreign key % points at a table dropped here', v_name;
  END LOOP;

  -- mcp_oauth_client: only the two tables 065 created may reference it.
  FOR v_name IN
    SELECT c.conname || ' on ' || c.conrelid::regclass::text
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid = coalesce(to_regclass('public.mcp_oauth_client')::oid, 0::oid)
       AND c.conrelid <> ALL (ARRAY[
         coalesce(to_regclass('public.mcp_auth_code')::oid, 0::oid),
         coalesce(to_regclass('public.mcp_oauth_token')::oid, 0::oid)
       ])
  LOOP
    RAISE EXCEPTION '346: unexpected foreign key % references mcp_oauth_client', v_name;
  END LOOP;
END
$guard$;

-- ── 1. Pending flow runs, their work items and the retired door's approvals ─
DO $flows$
DECLARE
  v_count integer;
BEGIN
  -- The work item of a run still waiting on a desktop (first: it is found
  -- through the run's pending status).
  UPDATE public.tracked_job j
     SET status = 'failed',
         error_message = 'Never finished: this run was waiting for a desktop (local Claude Code) run, and that runtime was removed on 2026-10-15.',
         current_step = NULL,
         finished_at = coalesce(j.finished_at, now())
    FROM public.flow_run r
   WHERE r.id = j.flow_run_id
     AND r.status = 'pending'
     AND j.status IN ('queued', 'running');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: work items of pending flow runs failed: %', v_count;

  UPDATE public.flow_run
     SET status = 'failed',
         error_message = 'Never finished: this run was waiting for a desktop (local Claude Code) run, and that runtime was removed on 2026-10-15. Run the loop again; it runs in the cloud now.'
   WHERE status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: pending flow_run rows failed: %', v_count;

  -- The retired 'mcp' door: a desktop run's held calls, and their cards.
  UPDATE public.attention_item a
     SET status = 'expired',
         resolved_at = now()
    FROM public.tool_approval ta
   WHERE ta.card_id = a.id
     AND ta.door = 'mcp'
     AND ta.status = 'pending'
     AND a.status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: cards of pending mcp-door approvals expired: %', v_count;

  UPDATE public.tool_approval
     SET status = 'expired',
         decided_at = now(),
         result = jsonb_build_object(
           'ran', false,
           'code', 'RUNTIME_REMOVED',
           'error', 'Not run: the desktop run that asked for it was removed with the local Claude Code runtime on 2026-10-15.')
   WHERE door = 'mcp'
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: pending mcp-door approvals expired: %', v_count;
END
$flows$;

-- ── 2. The pipeline's MCP tokens, codes and clients ─────────────────────────
DO $tokens$
DECLARE
  v_clients text[];
  v_count integer;
BEGIN
  -- Pinned tokens first: dropping the pin column (step 4) must never leave one
  -- alive and unpinned.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mcp_oauth_token' AND column_name = 'pinned_workspace_id'
  ) THEN
    EXECUTE 'DELETE FROM public.mcp_oauth_token WHERE pinned_workspace_id IS NOT NULL';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE '346: pinned mcp_oauth_token rows deleted: %', v_count;
  END IF;

  SELECT coalesce(array_agg(c.client_id), '{}')
    INTO v_clients
    FROM public.mcp_oauth_client c
   WHERE c.client_id = 'dial8-cloud-agent'
      OR c.client_name = 'Dial8 Desktop (in-app)';
  RAISE NOTICE '346: pipeline MCP clients found: %', cardinality(v_clients);

  DELETE FROM public.mcp_oauth_token WHERE client_id = ANY (v_clients);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: their mcp_oauth_token rows deleted: %', v_count;

  DELETE FROM public.mcp_auth_code WHERE client_id = ANY (v_clients);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: their mcp_auth_code rows deleted: %', v_count;

  DELETE FROM public.mcp_oauth_client c
   WHERE c.client_id = ANY (v_clients)
     AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_token t WHERE t.client_id = c.client_id)
     AND NOT EXISTS (SELECT 1 FROM public.mcp_auth_code a WHERE a.client_id = c.client_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: pipeline MCP client rows deleted: %', v_count;
END
$tokens$;

-- ── 3. The tables and the realtime policy ───────────────────────────────────
DO $realtime$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS "local_run_owner_can_subscribe" ON realtime.messages;
  END IF;
END
$realtime$;

-- CASCADE reaches only each table's own indexes, constraints and policies:
-- step 0 aborts on any view, function, policy or foreign key elsewhere that
-- depends on them.
DROP TABLE IF EXISTS public.local_run_queue CASCADE;
DROP TABLE IF EXISTS public.project_local_path CASCADE;

-- ── 4. The columns ──────────────────────────────────────────────────────────
ALTER TABLE public.chat_conversations DROP COLUMN IF EXISTS claude_session_id;
ALTER TABLE public.chat_conversations DROP COLUMN IF EXISTS claude_session_device_id;
ALTER TABLE public.chat_conversations DROP COLUMN IF EXISTS claude_cwd;
ALTER TABLE public.captures DROP COLUMN IF EXISTS agent_cwd_override;
ALTER TABLE public.mcp_oauth_token DROP COLUMN IF EXISTS pinned_workspace_id;
ALTER TABLE public.agent_run DROP COLUMN IF EXISTS mcp_token_hash;

-- ── 5. The workspace compute policy ─────────────────────────────────────────
DO $settings$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.workspace
     SET settings = settings - 'compute_policy'
   WHERE jsonb_typeof(settings) = 'object'
     AND settings ? 'compute_policy';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '346: workspace rows with compute_policy stripped: %', v_count;
END
$settings$;

-- ============================================================
-- Checks (run by hand; not part of the migration)
-- ============================================================
--
-- PRE-CHECK, before applying. Note every number: the post-check compares.
-- (Run it before the drops: it reads the tables and columns this removes.)
--
-- SELECT
--   (SELECT count(*) FROM public.flow_run WHERE status = 'pending') AS pending_flow_runs,
--   (SELECT count(*) FROM public.flow_run WHERE status = 'failed') AS failed_flow_runs,
--   (SELECT count(*) FROM public.tracked_job j JOIN public.flow_run r ON r.id = j.flow_run_id
--     WHERE r.status = 'pending' AND j.status IN ('queued', 'running')) AS work_items_waiting,
--   (SELECT count(*) FROM public.tool_approval WHERE door = 'mcp' AND status = 'pending') AS pending_mcp_approvals,
--   (SELECT count(*) FROM public.local_run_queue) AS local_run_rows,
--   (SELECT count(*) FROM public.local_run_queue
--     WHERE status IN ('waiting_for_device', 'claimed', 'running')) AS open_local_runs,
--   (SELECT count(*) FROM public.project_local_path) AS project_local_paths,
--   (SELECT count(*) FROM public.chat_conversations
--     WHERE claude_session_id IS NOT NULL OR claude_cwd IS NOT NULL) AS conversations_with_cc_fields,
--   (SELECT count(*) FROM public.captures WHERE agent_cwd_override IS NOT NULL) AS captures_with_cwd,
--   (SELECT count(*) FROM public.agent_run WHERE mcp_token_hash IS NOT NULL) AS runs_with_token_hash,
--   (SELECT count(*) FROM public.mcp_oauth_token WHERE pinned_workspace_id IS NOT NULL) AS pinned_tokens,
--   (SELECT count(*) FROM public.mcp_oauth_client
--     WHERE client_id = 'dial8-cloud-agent' OR client_name = 'Dial8 Desktop (in-app)') AS pipeline_clients,
--   (SELECT count(*) FROM public.mcp_oauth_token t JOIN public.mcp_oauth_client c ON c.client_id = t.client_id
--     WHERE c.client_id = 'dial8-cloud-agent' OR c.client_name = 'Dial8 Desktop (in-app)') AS pipeline_tokens,
--   (SELECT count(*) FROM public.mcp_oauth_token t JOIN public.mcp_oauth_client c ON c.client_id = t.client_id
--     WHERE NOT (c.client_id = 'dial8-cloud-agent' OR c.client_name = 'Dial8 Desktop (in-app)')
--       AND t.pinned_workspace_id IS NULL) AS external_tokens_kept,
--   (SELECT count(*) FROM public.mcp_oauth_client
--     WHERE NOT (client_id = 'dial8-cloud-agent' OR client_name = 'Dial8 Desktop (in-app)')) AS external_clients_kept,
--   (SELECT count(*) FROM public.workspace WHERE settings ? 'compute_policy') AS workspaces_with_compute_policy,
--   (SELECT count(*) FROM pg_policies
--     WHERE schemaname = 'realtime' AND policyname = 'local_run_owner_can_subscribe') AS realtime_policy;
--
-- POST-CHECK, after applying. Every *_left is 0 and every *_gone is true;
-- failed_flow_runs = pre.failed_flow_runs + pre.pending_flow_runs.
-- external_tokens_kept and external_clients_kept should equal the pre-check's,
-- but outside clients keep registering, refreshing and expiring tokens while
-- this runs (and the mcp-cleanup cron deletes expired ones), so a small drift
-- either way between the two reads is expected. What must hold: no pipeline
-- client or token is left, and no outside client lost its tokens to this file
-- (step 2 deletes only by the two pipeline client filters and the pin).
--
-- SELECT
--   (SELECT count(*) FROM public.flow_run WHERE status = 'pending') AS pending_flow_runs_left,
--   (SELECT count(*) FROM public.flow_run WHERE status = 'failed') AS failed_flow_runs,
--   (SELECT count(*) FROM public.tool_approval WHERE door = 'mcp' AND status = 'pending') AS pending_mcp_approvals_left,
--   to_regclass('public.local_run_queue') IS NULL AS local_run_queue_gone,
--   to_regclass('public.project_local_path') IS NULL AS project_local_path_gone,
--   (SELECT count(*) FROM information_schema.columns
--     WHERE table_schema = 'public'
--       AND ((table_name = 'chat_conversations' AND column_name IN ('claude_session_id', 'claude_session_device_id', 'claude_cwd'))
--         OR (table_name = 'captures' AND column_name = 'agent_cwd_override')
--         OR (table_name = 'mcp_oauth_token' AND column_name = 'pinned_workspace_id')
--         OR (table_name = 'agent_run' AND column_name = 'mcp_token_hash'))) AS dropped_columns_left,
--   (SELECT count(*) FROM public.mcp_oauth_client
--     WHERE client_id = 'dial8-cloud-agent' OR client_name = 'Dial8 Desktop (in-app)') AS pipeline_clients_left,
--   (SELECT count(*) FROM public.mcp_oauth_token t JOIN public.mcp_oauth_client c ON c.client_id = t.client_id
--     WHERE c.client_id = 'dial8-cloud-agent' OR c.client_name = 'Dial8 Desktop (in-app)') AS pipeline_tokens_left,
--   (SELECT count(*) FROM public.mcp_oauth_token) AS external_tokens_kept,
--   (SELECT count(*) FROM public.mcp_oauth_client) AS external_clients_kept,
--   (SELECT count(*) FROM public.workspace WHERE settings ? 'compute_policy') AS workspaces_with_compute_policy_left,
--   (SELECT count(*) FROM pg_policies
--     WHERE schemaname = 'realtime' AND policyname = 'local_run_owner_can_subscribe') AS realtime_policy_left;
-- ============================================================
