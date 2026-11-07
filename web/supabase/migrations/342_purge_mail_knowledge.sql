-- ============================================================
-- 342: purge the knowledge Dial8 learned from mail. IRREVERSIBLE.
-- ============================================================
-- THIS DELETES DATA AND CANNOT BE UNDONE. Take a backup (or confirm PITR)
-- before applying it to PROD.
--
-- Decision, 2026-10-15: Dial8 stops learning from mail (341), and the owner
-- authorized deleting all mail and what was derived from it, on DEV and PROD
-- ("okay to delete all mail from prod and dev"). This file deletes the
-- DERIVED knowledge only. The stored mail itself (email_message,
-- email_thread_index and the rest) is a later migration's.
--
-- Apply right after 341 (341 is what keeps anything left hidden in the
-- meantime). The purge does not depend on 341's objects; the hardening step
-- below acts only when 341's private schema and functions exist.
--
-- 0. Hardening of 341's private schema (kept here so 341 stays byte-identical
--    to what DEV already ran). 341 grants USAGE on schema private to
--    authenticated; should that schema already hold other functions, their
--    default PUBLIC EXECUTE would then reach authenticated. So: REVOKE ALL ON
--    ALL FUNCTIONS IN SCHEMA private FROM PUBLIC (and anon), stop future
--    functions there from defaulting to PUBLIC EXECUTE, and grant EXECUTE on
--    exactly 341's two functions to authenticated and service_role.
--
-- What goes, in this order (foreign keys: claim_source and claim_chunks
-- reference claim ON DELETE CASCADE, claim.superseded_by is ON DELETE SET
-- NULL; entity_link and knowledge_package_item point at claims by
-- (type, id) with no foreign key, so they are deleted by hand first):
--   1. every claim_source row with source_type 'email';
--   2. the claims that had a mail source and now have NO source left, with
--      their knowledge_package_item pins, their entity_link rows at either
--      end, and their claim_chunks, then the claims themselves. A claim that
--      still has a non-mail source stays (only its mail evidence goes);
--   3. every entity_link row with source_type or target_type 'email', and
--      every knowledge_package_item pinning an email;
--   4. every knowledge_brief row in each workspace that had any of the
--      above (a brief may paraphrase a mail claim). The nightly weaver
--      rebuilds them: knowledge-weaver.ts Phase 3 counts a workspace with no
--      workspace-scope brief row and at least 3 active claims among the 4000
--      most recently updated as brief-stale, and regenerateWorkspaceBriefs
--      then compiles its workspace, project, package and anchor briefs. It
--      runs daily at 09:00 UTC (the Inngest cron, plus the /api/cron/weave
--      Vercel cron); to rebuild at once, send knowledge/weave.requested. A
--      scope with fewer than 3 readable claims gets no brief, as before;
--   5. the Mail tone pass's output, and nothing else: an area_memory line is
--      the pass's only when it is area 'mail', scope 'personal', source
--      'learned', has no author (created_by NULL) AND its exact text is in
--      the `proposed` list of an area_memory_learning_run row for the same
--      workspace, person and area 'mail' (memory-learning.ts stores exactly
--      the texts it inserted there). The chat capture pass also writes
--      learned, authorless mail lines (capture-pass.ts via memory-write.ts);
--      those came from chat, not mail, and stay. Then every
--      area_memory_learning_run row for area 'mail' (after the lines, which
--      need them), and every memory_learning_setting row (the table holds
--      only the "learn from my sent mail" switch, which the app no longer
--      offers).
--
-- The purge is one DO block, so it all happens or none of it does.
-- Idempotent: a second run finds no mail source, no email link or pin and no
-- mail tone rows, and deletes nothing; the hardening re-states the same
-- grants. Each step reports its count with RAISE NOTICE. This file holds no
-- backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- 0. Hardening of 341's private schema.
DO $harden$
BEGIN
  IF to_regnamespace('private') IS NULL THEN
    RAISE NOTICE '342: no schema private (341 not applied?); hardening skipped';
    RETURN;
  END IF;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  IF to_regprocedure('private.claim_sources_hidden_from_me()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() TO authenticated, service_role;
  END IF;
  IF to_regprocedure('private.claims_hidden_from_me()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION private.claims_hidden_from_me() TO authenticated, service_role;
  END IF;
END
$harden$;

DO $purge$
DECLARE
  v_mail_claims uuid[];
  v_workspaces uuid[];
  v_orphans uuid[];
  v_count integer;
BEGIN
  -- The claims with a mail source, and every workspace mail touched.
  SELECT coalesce(array_agg(DISTINCT cs.claim_id), '{}')
    INTO v_mail_claims
    FROM public.claim_source cs
   WHERE cs.source_type = 'email';

  SELECT coalesce(array_agg(DISTINCT w.workspace_id), '{}')
    INTO v_workspaces
    FROM (
      SELECT cl.workspace_id FROM public.claim cl WHERE cl.id = ANY (v_mail_claims)
      UNION
      SELECT cs.workspace_id FROM public.claim_source cs
       WHERE cs.source_type = 'email' AND cs.workspace_id IS NOT NULL
      UNION
      SELECT el.workspace_id FROM public.entity_link el
       WHERE el.source_type = 'email' OR el.target_type = 'email'
      UNION
      SELECT pi.workspace_id FROM public.knowledge_package_item pi
       WHERE pi.entity_type = 'email'
    ) AS w;

  -- 1. The mail evidence.
  DELETE FROM public.claim_source WHERE source_type = 'email';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: claim_source mail rows deleted: %', v_count;

  -- 2. Claims that had mail and have no source left.
  SELECT coalesce(array_agg(cl.id), '{}')
    INTO v_orphans
    FROM public.claim cl
   WHERE cl.id = ANY (v_mail_claims)
     AND NOT EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = cl.id);
  RAISE NOTICE '342: claims with mail: %, left with no source (deleted): %',
    cardinality(v_mail_claims), cardinality(v_orphans);

  DELETE FROM public.knowledge_package_item
   WHERE entity_type = 'claim' AND entity_id = ANY (v_orphans);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: knowledge_package_item pins deleted: %', v_count;

  DELETE FROM public.entity_link
   WHERE (source_type = 'claim' AND source_id = ANY (v_orphans))
      OR (target_type = 'claim' AND target_id = ANY (v_orphans));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: entity_link rows of deleted claims deleted: %', v_count;

  DELETE FROM public.claim_chunks WHERE claim_id = ANY (v_orphans);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: claim_chunks deleted: %', v_count;

  DELETE FROM public.claim WHERE id = ANY (v_orphans);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: claims deleted: %', v_count;

  -- 3. Graph edges to or from an email.
  DELETE FROM public.entity_link
   WHERE source_type = 'email' OR target_type = 'email';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: entity_link email rows deleted: %', v_count;

  DELETE FROM public.knowledge_package_item WHERE entity_type = 'email';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: knowledge_package_item email pins deleted: %', v_count;

  -- 4. Briefs that may paraphrase mail; the nightly weaver rebuilds them.
  DELETE FROM public.knowledge_brief WHERE workspace_id = ANY (v_workspaces);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: knowledge_brief rows deleted: % (in % workspaces)', v_count, cardinality(v_workspaces);

  -- 5. The Mail tone pass's output.
  -- Only the lines the Mail tone pass wrote: its runs recorded their exact
  -- texts. Before the runs go.
  DELETE FROM public.area_memory am
   WHERE am.area = 'mail'
     AND am.scope = 'personal'
     AND am.source = 'learned'
     AND am.created_by IS NULL
     AND EXISTS (
       SELECT 1 FROM public.area_memory_learning_run run
        WHERE run.workspace_id = am.workspace_id
          AND run.user_id = am.user_id
          AND run.area = 'mail'
          AND am.text = ANY (run.proposed)
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: area_memory Mail tone lines deleted: %', v_count;

  DELETE FROM public.area_memory_learning_run WHERE area = 'mail';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: area_memory_learning_run mail rows deleted: %', v_count;

  DELETE FROM public.memory_learning_setting;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '342: memory_learning_setting rows deleted: %', v_count;
END
$purge$;

-- ============================================================
-- Checks (run by hand; not part of the migration)
-- ============================================================
--
-- PRE-CHECK, before applying. Note every number: the post-check compares.
--
-- WITH mail AS (
--   SELECT DISTINCT claim_id FROM public.claim_source WHERE source_type = 'email'
-- ),
-- doomed AS (
--   SELECT m.claim_id FROM mail m
--   WHERE NOT EXISTS (
--     SELECT 1 FROM public.claim_source cs
--     WHERE cs.claim_id = m.claim_id AND cs.source_type <> 'email'
--   )
-- ),
-- touched AS (
--   SELECT cl.workspace_id FROM public.claim cl JOIN mail m ON m.claim_id = cl.id
--   UNION SELECT cs.workspace_id FROM public.claim_source cs
--     WHERE cs.source_type = 'email' AND cs.workspace_id IS NOT NULL
--   UNION SELECT el.workspace_id FROM public.entity_link el
--     WHERE el.source_type = 'email' OR el.target_type = 'email'
--   UNION SELECT pi.workspace_id FROM public.knowledge_package_item pi
--     WHERE pi.entity_type = 'email'
-- ),
-- mail_tone AS (
--   SELECT am.id FROM public.area_memory am
--   WHERE am.area = 'mail' AND am.scope = 'personal' AND am.source = 'learned'
--     AND am.created_by IS NULL
--     AND EXISTS (
--       SELECT 1 FROM public.area_memory_learning_run run
--       WHERE run.workspace_id = am.workspace_id AND run.user_id = am.user_id
--         AND run.area = 'mail' AND am.text = ANY (run.proposed)
--     )
-- )
-- SELECT
--   (SELECT count(*) FROM public.claim_source WHERE source_type = 'email') AS mail_sources,
--   (SELECT count(*) FROM mail) AS claims_with_mail,
--   (SELECT count(*) FROM doomed) AS claims_to_delete,
--   (SELECT count(*) FROM mail) - (SELECT count(*) FROM doomed) AS claims_kept_with_other_sources,
--   (SELECT count(*) FROM public.claim_chunks ch JOIN doomed d ON d.claim_id = ch.claim_id) AS chunks_to_delete,
--   (SELECT count(*) FROM public.knowledge_package_item pi JOIN doomed d
--      ON pi.entity_type = 'claim' AND pi.entity_id = d.claim_id) AS claim_pins_to_delete,
--   (SELECT count(*) FROM public.knowledge_package_item
--     WHERE entity_type = 'email') AS email_pins_to_delete,
--   (SELECT count(*) FROM public.entity_link el
--     WHERE (el.source_type = 'claim' AND el.source_id IN (SELECT claim_id FROM doomed))
--        OR (el.target_type = 'claim' AND el.target_id IN (SELECT claim_id FROM doomed))
--        OR el.source_type = 'email' OR el.target_type = 'email') AS links_to_delete,
--   (SELECT count(*) FROM public.knowledge_brief kb
--     WHERE kb.workspace_id IN (SELECT workspace_id FROM touched)) AS briefs_to_delete,
--   (SELECT count(*) FROM mail_tone) AS mail_tone_lines,
--   (SELECT count(*) FROM public.area_memory
--     WHERE area = 'mail' AND source = 'learned' AND created_by IS NULL
--       AND id NOT IN (SELECT id FROM mail_tone)) AS chat_learned_mail_lines_kept,
--   (SELECT count(*) FROM public.area_memory_learning_run WHERE area = 'mail') AS mail_tone_runs,
--   (SELECT count(*) FROM public.memory_learning_setting) AS mail_switch_rows,
--   (SELECT count(*) FROM public.claim) AS claims_total,
--   (SELECT count(*) FROM public.claim_source) AS claim_sources_total,
--   (SELECT count(*) FROM public.claim_chunks) AS claim_chunks_total,
--   (SELECT count(*) FROM public.entity_link) AS links_total,
--   (SELECT count(*) FROM public.knowledge_package_item) AS pins_total,
--   (SELECT count(*) FROM public.knowledge_brief) AS briefs_total,
--   (SELECT count(*) FROM public.area_memory) AS area_memory_total;
--
-- POST-CHECK, after applying. Every *_left must be 0 (the dangling ones: no
-- more than before); the totals must equal the pre-check's total minus what
-- it said would go. Also: the area_memory_total line, and that private holds
-- only 341's two functions as executable by authenticated:
--   SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'private';
--
-- SELECT
--   (SELECT count(*) FROM public.claim_source WHERE source_type = 'email') AS mail_sources_left,
--   (SELECT count(*) FROM public.entity_link
--     WHERE source_type = 'email' OR target_type = 'email') AS email_links_left,
--   (SELECT count(*) FROM public.knowledge_package_item
--     WHERE entity_type = 'email') AS email_pins_left,
--   (SELECT count(*) FROM public.area_memory
--     WHERE area = 'mail' AND source = 'learned' AND created_by IS NULL) AS learned_mail_lines,
--     -- = pre.chat_learned_mail_lines_kept (the chat capture pass's lines stay)
--   (SELECT count(*) FROM public.area_memory_learning_run WHERE area = 'mail') AS mail_tone_runs_left,
--   (SELECT count(*) FROM public.memory_learning_setting) AS mail_switch_rows_left,
--   (SELECT count(*) FROM public.entity_link el
--     WHERE (el.source_type = 'claim'
--            AND NOT EXISTS (SELECT 1 FROM public.claim c WHERE c.id = el.source_id))
--        OR (el.target_type = 'claim'
--            AND NOT EXISTS (SELECT 1 FROM public.claim c WHERE c.id = el.target_id))) AS dangling_claim_links_left,
--   (SELECT count(*) FROM public.knowledge_package_item pi
--     WHERE pi.entity_type = 'claim'
--       AND NOT EXISTS (SELECT 1 FROM public.claim c WHERE c.id = pi.entity_id)) AS dangling_pins_left,
--   (SELECT count(*) FROM public.claim) AS claims_total,
--     -- = pre.claims_total - pre.claims_to_delete
--   (SELECT count(*) FROM public.claim_source) AS claim_sources_total,
--     -- = pre.claim_sources_total - pre.mail_sources
--   (SELECT count(*) FROM public.claim_chunks) AS claim_chunks_total,
--     -- = pre.claim_chunks_total - pre.chunks_to_delete
--   (SELECT count(*) FROM public.entity_link) AS links_total,
--     -- = pre.links_total - pre.links_to_delete
--   (SELECT count(*) FROM public.knowledge_package_item) AS pins_total,
--     -- = pre.pins_total - pre.claim_pins_to_delete - pre.email_pins_to_delete
--   (SELECT count(*) FROM public.knowledge_brief) AS briefs_total,
--     -- = pre.briefs_total - pre.briefs_to_delete (until the next weave)
--   (SELECT count(*) FROM public.area_memory) AS area_memory_total;
--     -- = pre.area_memory_total - pre.mail_tone_lines
--
-- dangling_claim_links_left and dangling_pins_left count rows left pointing
-- at a missing claim from ANY cause; compare them with the same query before
-- the purge (this file adds none).
