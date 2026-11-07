-- 193_security_hardening.sql
--
-- Pre-launch security review (2026-07-12). Closes confirmed, live-exploitable
-- holes found via the Supabase security advisor + direct read-only probes on
-- PROD. Every item below was reproduced with `has_function_privilege` /
-- `pg_policies` / row-count queries before writing this migration.
--
-- Idempotent + re-runnable: guarded with IF EXISTS / OR REPLACE throughout.
-- All REVOKEs are additive (they only remove public/anon access) — service_role
-- bypasses grants and RLS, so every legitimate server-side caller is unaffected.
--
-- ── Blocks ──────────────────────────────────────────────────────────────────
--  1. Close the pg_default_acl root cause (future fns closed by default)
--  2. REVOKE anon/authenticated EXECUTE on dangerous server-only SECURITY
--     DEFINER RPCs (grant_credits, search/upsert_email_messages, …)
--  3. Defense-in-depth auth.uid() guard inside search_email_messages
--  4. Fix broken RLS policies (purchases, knowledge_package_item, stt/insights)
--  5. device_token — enable RLS deny-all + revoke table grants
--  6. devices / feature_usage — tighten open-INSERT policies
-- ─────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK 1 — Root cause: default ACL grants EXECUTE on every FUTURE public
-- function directly to anon + authenticated. Migrations that did
-- `REVOKE ... FROM PUBLIC` were no-ops against these direct grants. Close it so
-- new functions are locked down by default; grant back explicitly where needed.
-- (Only affects functions created AFTER this runs; existing ones handled below.)
-- ════════════════════════════════════════════════════════════════════════════
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK 2 — REVOKE EXECUTE on dangerous server-only SECURITY DEFINER RPCs.
-- These run as owner (bypass RLS) and trust caller-supplied p_user_id /
-- p_workspace_id / jsonb params with no auth.uid() check. They are only ever
-- called server-side via the service-role client, which is unaffected by these
-- revokes. Each overload is revoked by its exact identity signature.
--
-- Applied via a DO-loop that skips any function absent in this environment
-- (DEV and PROD have drifted — some of these exist only on PROD). This keeps the
-- migration idempotent and portable across both databases.
-- ════════════════════════════════════════════════════════════════════════════
DO $block2$
DECLARE
  target text;
  targets text[] := ARRAY[
    -- billing / credits / plans / devices
    'public.grant_credits(uuid, numeric, text, text, text, text, text)',
    'public.billing_overspenders()',
    'public.billing_wallet_drift()',
    'public.reset_expired_ai_user_plans()',
    'public.check_ai_usage_limit(uuid)',
    'public.check_feature_access(text, uuid, text)',
    'public.resolve_effective_plan(uuid)',
    'public.log_ai_usage(uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer)',
    'public.get_trial_status(text)',
    'public.transfer_device_purchases_to_user(text, uuid)',
    'public.track_device_activity(uuid, text, text, text, text)',
    -- email (cross-tenant read / injection)
    'public.search_email_messages(uuid, text, text, integer, integer)',
    'public.search_email_messages(uuid, text, text, integer, integer, uuid[])',
    'public.search_email_messages(uuid, text, text, integer, integer, uuid[], uuid)',
    'public.upsert_email_messages(jsonb)',
    'public.get_email_folder_counts(uuid, uuid)',
    'public.get_email_folder_counts(uuid, uuid, uuid[])',
    'public.get_decisions_by_participant_emails(uuid, text[], integer)',
    -- accounts / contacts / misc server-only helpers
    'public.disconnect_account(uuid, uuid)',
    'public.update_contact_interaction_stats(uuid, timestamptz)',
    'public.merge_contacts(uuid, uuid, text, numeric, jsonb, text)',
    'public.unmerge_contacts(uuid)',
    'public.get_note_attachment_size(uuid)',
    'public.list_companies_with_stats(uuid, text, integer, integer)',
    -- bulk cross-workspace mutator (server/cron only)
    'public.age_out_stale_proposals(timestamptz, uuid, integer)'
  ];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    -- to_regprocedure returns NULL (no error) if the function is absent here.
    -- Revoke from PUBLIC *and* anon/authenticated: some of these carry a PUBLIC
    -- EXECUTE grant (ACL entry `=X/postgres`), through which anon/authenticated
    -- inherit EXECUTE — so revoking only the named roles leaves the hole open.
    IF to_regprocedure(target) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', target);
    END IF;
  END LOOP;

  -- move_capture self-guards via auth.uid() + membership checks (not critical),
  -- but should never be anon-callable. authenticated retains it (the app calls
  -- it as the user; the function re-derives identity internally). Revoking
  -- PUBLIC + anon while leaving an explicit authenticated grant in place.
  IF to_regprocedure('public.move_capture(uuid, uuid, uuid[], boolean, boolean)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.move_capture(uuid, uuid, uuid[], boolean, boolean) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.move_capture(uuid, uuid, uuid[], boolean, boolean) TO authenticated;
  END IF;
END
$block2$;

-- NOTE (no action): the following SECURITY DEFINER functions intentionally KEEP
-- `authenticated` EXECUTE because RLS policies invoke them as the calling role —
-- revoking would break RLS platform-wide:
--   is_workspace_member, is_team_member, is_workspace_member_via_team,
--   get_member_role, get_team_member_role, can_view_contact, can_edit_contact,
--   can_manage_team_members,
--   has_active_share_for_commentable — invoked in the `comment` table's RLS
--     policy (mig 088, external-commenter branch); it's SECURITY DEFINER and
--     self-scopes, so it must stay callable by `authenticated` or every comment
--     read/insert on the shared-link path fails. Re-grant defensively in case a
--     prior run of this migration revoked it before this carve-out existed:
GRANT EXECUTE ON FUNCTION public.has_active_share_for_commentable(commentable_type, uuid) TO authenticated;
-- The knowledge/search RPCs (hybrid_search, unified_search, rag_search,
-- match_claims, claim_neighborhood, attachment_rag_search, delete_*_with_knowledge,
-- cleanup_attachment_knowledge) already self-scope via auth.uid()/workspace and
-- are authenticated-only (no anon). See Block-4-adjacent note about the
-- backwards NULL-guard in hybrid/unified_search — tracked as a separate
-- lower-severity item, not fixed here.

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK 3 — Defense-in-depth: reject cross-user calls inside search_email_messages.
-- The revoke above already removes client reachability; this hardens the body so
-- a future re-grant or service-adjacent misuse can't leak. Only rejects when a
-- real authenticated user is present AND mismatches p_user_id — service-role
-- calls (auth.uid() = NULL, the legit caller) still work. Body preserved verbatim
-- from prod with only the guard prepended.
-- (Applied to the base 5-arg overload; the 6/7-arg overloads are covered by the
-- Block-2 revoke — bodies left unchanged to avoid drift.)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.search_email_messages(
  p_user_id uuid, p_query text, p_folder text DEFAULT NULL::text,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
)
RETURNS TABLE(message_id uuid, thread_id text, subject text, from_name text,
  from_email text, snippet text, message_date timestamp with time zone,
  rank real, headline text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    em.id AS message_id,
    em.provider_thread_id AS thread_id,
    em.subject,
    em.from_name,
    em.from_email,
    em.snippet,
    em.message_date,
    ts_rank(em.search_vector, websearch_to_tsquery('english', p_query)) AS rank,
    ts_headline('english', coalesce(em.body_text, em.snippet, ''),
      websearch_to_tsquery('english', p_query),
      'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
    ) AS headline
  FROM public.email_message em
  LEFT JOIN public.email_thread_index eti ON em.email_thread_id = eti.id
  WHERE em.user_id = p_user_id
    AND em.search_vector @@ websearch_to_tsquery('english', p_query)
    AND (p_folder IS NULL OR eti.folder = p_folder)
  ORDER BY rank DESC, em.message_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;
-- CREATE OR REPLACE re-opens the default/PUBLIC grant; re-assert the revoke.
REVOKE EXECUTE ON FUNCTION public.search_email_messages(uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
-- Keep search_path pinned on the extra overloads too (search_path_mutable hardening).
ALTER FUNCTION public.search_email_messages(uuid, text, text, integer, integer) SET search_path = public, pg_temp;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK 4 — Broken RLS policies (all reproduced cross-tenant on PROD).
-- ════════════════════════════════════════════════════════════════════════════

-- 4a. purchases — free BYOK entitlement / Stripe bypass.
-- Old INSERT policy allowed (auth.uid() = user_id) OR (device_id IS NOT NULL) —
-- the 2nd disjunct lets anyone insert a completed purchase for any user_id.
-- The sole legitimate writer is the Stripe webhook (service-role, unaffected).
DROP POLICY IF EXISTS "Purchases can be inserted by authenticated users or devices" ON public.purchases;
CREATE POLICY "Purchases inserted only for the authenticated owner"
  ON public.purchases FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
REVOKE INSERT ON public.purchases FROM anon;

-- 4b. knowledge_package_item — cross-tenant read: old SELECT policy only checked
-- the parent package row EXISTS anywhere. Require workspace membership on the
-- parent, matching every other child-table policy in this schema.
DROP POLICY IF EXISTS "knowledge_package_item_select" ON public.knowledge_package_item;
CREATE POLICY "knowledge_package_item_select"
  ON public.knowledge_package_item FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.knowledge_package p
      WHERE p.id = knowledge_package_item.package_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

-- 4c. stt_activity_items + insights_* — the "OR devices.user_id IS NULL" branch
-- returned every unclaimed device to every authenticated user (100% of prod
-- devices are unclaimed → global read/write of ambient activity data). Drop the
-- NULL branch. The sibling "Users own <table>" policies (user_id = auth.uid())
-- already provide correct per-user access, OR-combined with these.
DROP POLICY IF EXISTS "Devices can access stt_activity_items" ON public.stt_activity_items;
CREATE POLICY "Devices can access stt_activity_items"
  ON public.stt_activity_items FOR ALL TO authenticated
  USING (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()))
  WITH CHECK (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()));

DROP POLICY IF EXISTS "Devices can access insights_entities" ON public.insights_entities;
CREATE POLICY "Devices can access insights_entities"
  ON public.insights_entities FOR ALL TO authenticated
  USING (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()))
  WITH CHECK (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()));

DROP POLICY IF EXISTS "Devices can access insights_suggestions" ON public.insights_suggestions;
CREATE POLICY "Devices can access insights_suggestions"
  ON public.insights_suggestions FOR ALL TO authenticated
  USING (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()))
  WITH CHECK (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()));

DROP POLICY IF EXISTS "Devices can access insights_daily_briefings" ON public.insights_daily_briefings;
CREATE POLICY "Devices can access insights_daily_briefings"
  ON public.insights_daily_briefings FOR ALL TO authenticated
  USING (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()))
  WITH CHECK (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()));

DROP POLICY IF EXISTS "Devices can access insights_dependencies" ON public.insights_dependencies;
CREATE POLICY "Devices can access insights_dependencies"
  ON public.insights_dependencies FOR ALL TO authenticated
  USING (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()))
  WITH CHECK (device_id IN (SELECT d.device_id FROM public.devices d WHERE d.user_id = auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK 5 — device_token: enable RLS deny-all + revoke table grants.
-- Bearer auth tokens (SHA-256 hashed). RLS was disabled AND anon held SELECT →
-- any anon caller could dump all users' token metadata + hashes. All real access
-- is service-role (bypasses RLS). Mirrors mcp_oauth_client / project_embedding.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.device_token ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_token FROM anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK 6 — devices / feature_usage: tighten open-INSERT (legacy device tables).
-- Old policies were WITH CHECK(true) / "inserted by anyone" + anon INSERT grant →
-- anyone could spoof device + feature-usage rows for arbitrary device_id.
-- Require an authenticated caller at minimum (device-licensing writes should be
-- authenticated or service-role).
-- ════════════════════════════════════════════════════════════════════════════
REVOKE INSERT ON public.devices, public.feature_usage FROM anon;

DROP POLICY IF EXISTS "Devices can be inserted by anyone" ON public.devices;
CREATE POLICY "Devices inserted by authenticated callers"
  ON public.devices FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Feature usage can be inserted by anyone" ON public.feature_usage;
CREATE POLICY "Feature usage inserted by authenticated callers"
  ON public.feature_usage FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);
