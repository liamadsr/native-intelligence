-- ============================================================
-- 270: Fix notification_preference RLS for multi-workspace members
-- ============================================================
-- 031_notifications.sql defined notification_preference_select and
-- notification_preference_update with:
--
--   member_id = (SELECT id FROM public.member WHERE user_id = auth.uid() LIMIT 1)
--
-- public.member is one row per (user_id, workspace_id) (013), and
-- notification_preference is keyed per member — UNIQUE (member_id,
-- notification_type) — i.e. preferences are per WORKSPACE, not per user.
-- A bare `LIMIT 1` with no workspace correlation picks one arbitrary member
-- row for the whole account, regardless of which workspace's preferences are
-- actually being requested.
--
-- GET /api/account/notifications/preferences (route.ts) resolves the
-- CALLER'S CURRENT-WORKSPACE member id and selects `.eq('member_id',
-- member.id)` under RLS with the ordinary (non-service-role) client. For any
-- workspace other than the one arbitrary row the old policy happens to admit,
-- the USING clause is false for every row belonging to the caller's real
-- member id, so the SELECT silently returns zero preference rows — the user
-- appears to have no preferences (and thus the UI's defaults) in every
-- workspace but one. Contrast the correct per-row correlation `notification_
-- select` already uses one policy above (031:120-126): `recipient_id = (...
-- WHERE user_id = auth.uid() AND workspace_id = notification.workspace_id
-- LIMIT 1)`. notification_preference has no workspace_id column of its own to
-- correlate against, but it doesn't need one: member_id already identifies
-- both the user AND the workspace (member's UNIQUE (user_id, workspace_id)),
-- so the fix is simply to drop the `LIMIT 1` and accept ANY of the caller's
-- own member rows across every workspace they belong to, via
-- `member_id IN (SELECT id FROM public.member WHERE user_id = auth.uid())`.
--
-- No INSERT policy is added here. The PATCH handler in the same route
-- upserts via getServiceClient() specifically because notification_preference
-- has no INSERT policy (see the route's own comment) — that write bypasses
-- RLS entirely and is unaffected by this bug. The only other writer,
-- createNotification (src/lib/notifications.ts) and the flow-schedule cron's
-- fetchMutedReminderMembers, both read via the service-role client too.
-- notification_preference_update is therefore not currently exercised by any
-- RLS-bound code path, but is fixed here anyway for the same correctness
-- reason and in case a future caller updates through the member client.
--
-- The seed_notification_preferences trigger (031:82-113, SECURITY DEFINER,
-- fires AFTER INSERT ON public.member) is unaffected — SECURITY DEFINER
-- functions bypass RLS, and this migration touches only the two SELECT/UPDATE
-- policies, not the trigger or its function.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY, safe to re-run.

DROP POLICY IF EXISTS "notification_preference_select" ON public.notification_preference;
DROP POLICY IF EXISTS "notification_preference_update" ON public.notification_preference;

CREATE POLICY "notification_preference_select"
  ON public.notification_preference FOR SELECT
  USING (member_id IN (
    SELECT id FROM public.member WHERE user_id = auth.uid()
  ));

CREATE POLICY "notification_preference_update"
  ON public.notification_preference FOR UPDATE
  USING (member_id IN (
    SELECT id FROM public.member WHERE user_id = auth.uid()
  ));
