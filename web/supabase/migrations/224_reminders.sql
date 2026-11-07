-- 224: Reminders — per-user "Remind me about this" on any entity
--
-- Linear-parity feature: a user picks a future instant on an action / project /
-- initiative / capture / document ("An hour from now", "Tomorrow", a chrono-
-- parsed phrase, or a calendar date) and at that instant a notification lands
-- in their inbox — and, on desktop, as a native banner.
--
-- Design decisions:
--
--   * A NEW TABLE, not a column on public.notification. The notification
--     platform (migration 031) has no deferred-delivery concept: a row is
--     delivered the instant it is inserted (realtime → notification-context →
--     Tauri banner). Reminders are therefore INTENT rows that a cron pass
--     converts into a notification at fire time. Keeping the intent separate
--     also means rescheduling is an UPDATE of one row rather than a delete +
--     re-insert of an undelivered notification, and the inbox never shows a
--     future-dated row.
--
--   * PER-USER, not per-member. A reminder belongs to the human, so RLS is
--     owner-only on auth.uid() (the 201_user_voice_profile idiom) — a workspace
--     co-tenant can neither read nor cancel your reminders, unlike almost every
--     other table here whose policies are is_workspace_member(workspace_id).
--     The recipient the cron eventually addresses is notification.recipient_id,
--     which is member.id, not user_id (gotcha: one user has one member row PER
--     workspace). That member id is deliberately NOT stored here: a denormalised
--     recipient column is client-writable under any owner-only UPDATE policy, and
--     RLS cannot compare a WITH CHECK against the OLD row, so the column would be
--     a notification-injection primitive (set it to a co-tenant's member id and
--     the service-role cron delivers into their inbox). The firing pass resolves
--     it instead with the only join that can be correct:
--       SELECT id FROM member WHERE user_id = <owner> AND workspace_id = <ws>.
--     No such member row (the user left the workspace) = silent cancel.
--
--   * ONE PENDING reminder per (user, entity), enforced by a PARTIAL unique
--     index on delivered_at IS NULL. Setting a reminder again on the same
--     entity REPLACES the pending one (the API route updates remind_at in
--     place); fired rows keep delivered_at set and accumulate as history, so the
--     partial predicate is what lets a user be reminded about the same action
--     repeatedly over time.
--
--   * entity_id carries NO foreign key — the five permitted entity_types live
--     in five different tables (actions, projects, initiative, captures,
--     documents), which is the same free-form-uuid shape notification.target_id
--     already uses. Consequence: a deleted entity leaves an orphan reminder.
--     That is handled at fire time, not by the schema — the cron pass re-reads
--     the entity title fresh and, finding nothing, marks the row delivered and
--     inserts no notification (a silent cancel). ON DELETE CASCADE from
--     workspace/user covers the cases that DO matter for cleanup.
--
--   * remind_at is timestamptz (an absolute instant). All the "9:00 AM" /
--     "next Monday" local-time math happens in the browser, which is the only
--     place that knows the user's timezone; the DB and the cron pass only ever
--     compare instants.
--
-- SAFETY: one new table plus two CHECK widenings on public.notification. No
-- existing row can be rejected (a widened CHECK only permits more values), so
-- this applies cleanly with data present.

-- ── 1. reminder ──────────────────────────────────────────────────────────────
CREATE TABLE public.reminder (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN (
                 'action', 'project', 'initiative', 'capture', 'document'
               )),
  entity_id    uuid NOT NULL,
  remind_at    timestamptz NOT NULL,
  -- NULL = pending. Stamped by the cron pass when it claims the row (CAS), so
  -- it doubles as the claim token: exactly one tick can flip NULL → now().
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One PENDING reminder per user per entity; delivered history may accumulate.
CREATE UNIQUE INDEX reminder_pending_unique_idx
  ON public.reminder (user_id, entity_type, entity_id)
  WHERE delivered_at IS NULL;

-- Due-scan hot path for the 5-minute cron tick. Partial so the (growing)
-- delivered majority never enters it — mirrors idx_flow_schedule_due
-- (156_loop_engine.sql:30).
CREATE INDEX reminder_due_idx
  ON public.reminder (remind_at)
  WHERE delivered_at IS NULL;

-- ── 2. RLS — owner-only, four per-verb policies ──────────────────────────────
-- Pattern: 201_user_voice_profile.sql. Direct auth.uid() = user_id (this table
-- carries user_id, so no join idiom is needed). INSERT and UPDATE additionally
-- require membership of the workspace the reminder is filed under, so a user
-- cannot park rows against a workspace they do not belong to.
--
-- UPDATE must restate the membership term VERBATIM: an UPDATE policy that only
-- checks ownership is an insert-then-update bypass of the INSERT guard, and
-- workspace_id is what the cron stamps onto the notification.
ALTER TABLE public.reminder ENABLE ROW LEVEL SECURITY;

CREATE POLICY reminder_owner_select ON public.reminder
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY reminder_owner_insert ON public.reminder
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND public.is_workspace_member(workspace_id)
  );
CREATE POLICY reminder_owner_update ON public.reminder
  FOR UPDATE
  USING (auth.uid() = user_id AND public.is_workspace_member(workspace_id))
  WITH CHECK (auth.uid() = user_id AND public.is_workspace_member(workspace_id));
CREATE POLICY reminder_owner_delete ON public.reminder
  FOR DELETE USING (auth.uid() = user_id);

REVOKE ALL ON public.reminder FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminder TO authenticated;

-- Identity is IMMUTABLE after insert; only remind_at is user-mutable.
--
-- RLS WITH CHECK sees only the NEW row, so it can validate the post-image but
-- never compare it against the pre-image — a policy can therefore permit a
-- rewrite of entity_id or workspace_id that it would have rejected as an
-- INSERT's target. Only a trigger can see OLD. This is what stops the two
-- retarget attacks the owner-only policy set otherwise allows:
--
--   * entity_id/entity_type rewrite — the POST route's existence probe binds the
--     entity to a workspace the caller belongs to, but it runs ONCE at set time.
--     Repointing the row afterwards makes the service-role cron read (and put in
--     a notification body) the title of an entity in a workspace the caller
--     cannot see.
--   * workspace_id rewrite — parks the fired notification in a tenant the caller
--     is not a member of. A reminder crossing workspaces has no legitimate
--     meaning; the route re-homes a moved entity by writing the column on the
--     server, which is not subject to RLS-level policies but IS subject to this
--     trigger, so the route deletes + re-inserts rather than moving in place.
--
-- delivered_at is intentionally NOT frozen: the cron's service-role CAS claim
-- (and its rollback) is exactly an UPDATE of that column.
CREATE OR REPLACE FUNCTION public.reminder_freeze_identity()
RETURNS trigger AS $$
BEGIN
  IF new.workspace_id IS DISTINCT FROM old.workspace_id
     OR new.user_id     IS DISTINCT FROM old.user_id
     OR new.entity_type IS DISTINCT FROM old.entity_type
     OR new.entity_id   IS DISTINCT FROM old.entity_id THEN
    RAISE EXCEPTION 'reminder identity (workspace_id, user_id, entity_type, entity_id) is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reminder_freeze_identity ON public.reminder;
CREATE TRIGGER reminder_freeze_identity
  BEFORE UPDATE ON public.reminder
  FOR EACH ROW EXECUTE FUNCTION public.reminder_freeze_identity();

CREATE TRIGGER reminder_updated_at
  BEFORE UPDATE ON public.reminder
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── 3. notification.type — add 'reminder' (DROP+ADD, house pattern) ──────────
-- Full enumeration copied from migration 200 verbatim + the new value. Note
-- createNotification swallows insert errors (src/lib/notifications.ts), so a
-- value missing from this CHECK is a SILENT drop — the failure mode migration
-- 172's header documents.
ALTER TABLE public.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE public.notification ADD CONSTRAINT notification_type_check CHECK (type = ANY (ARRAY[
  'action_assigned',
  'action_unassigned',
  'action_status_changed',
  'action_priority_changed',
  'action_due_soon',
  'action_overdue',
  'action_mentioned',
  'capture_processed',
  'capture_shared',
  'comment_added',
  'comment_reply',
  'decision_confirmed',
  'cycle_started',
  'cycle_ending_soon',
  'share_comment_added',
  'project_status_changed',
  'meeting_starting_soon',
  'followup_reminder',
  'contact_followup_due',
  'relationship_going_stale',
  'email_drafts_ready',
  'feedback_requested',
  'flow_run_output',
  'work_run_ready',
  'work_run_input',
  'reminder'
]));

-- ── 4. notification.target_type — add 'initiative' (DROP+ADD) ────────────────
-- Full enumeration copied from migration 197 verbatim + the new value.
-- Reminders can target an initiative, and resolveNotificationDetailPanel
-- (src/app/account/notification-panel.tsx) has ALWAYS handled 'initiative' — the
-- CHECK was the only thing rejecting it, silently, at insert time. The other
-- four reminder entity types (action / project / capture / document) are
-- already permitted.
ALTER TABLE public.notification
  DROP CONSTRAINT IF EXISTS notification_target_type_check;
ALTER TABLE public.notification
  ADD CONSTRAINT notification_target_type_check
  CHECK (target_type IN (
    'action', 'capture', 'document', 'project', 'contact',
    'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
    'initiative'
  ));

-- ── 5. Workspace-move residue — pending reminders ───────────────────────────
-- public.reminder is workspace-pinned (workspace_id) and points at entities
-- polymorphically, exactly the shape _wsmove_residue (221:560) already sweeps
-- for knowledge_package_item and notification. The move engine relocates
-- action / document / project / capture in place (same uuid, new
-- workspace_id), so a pending reminder set before the move would otherwise
-- keep pointing at the SOURCE workspace, deep-linking an entity that has left.
--
-- Replacing the whole function is the only option: the working set lives in
-- pg_temp._wsmove_set, created and ON COMMIT DROPped inside this body, so no
-- statement outside it can see the moving ids. The body below is 221:560-642
-- verbatim (diff-verified against the live definition) plus one reminder
-- DELETE and its counter.
--
-- DELETE, not translate: repointing workspace_id to the destination is only
-- correct when the owner is also a member there, which the move engine does
-- not guarantee, and the fire-time recipient join (user_id + workspace_id)
-- would then silently cancel anyway. Dropping the pending row matches how
-- notification residue is handled and fails closed — the user loses a reminder
-- rather than receiving a broken one in a workspace the work has left.
-- Only PENDING rows (delivered_at IS NULL) are swept: delivered rows are
-- history the partial unique index (224:75) intentionally lets accumulate.
CREATE OR REPLACE FUNCTION public._wsmove_residue(
  p_source uuid,
  p_dest uuid,
  p_moving jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pins int := 0;
  v_notifications int := 0;
  v_threads int := 0;
  v_reminders int := 0;
BEGIN
  -- pg_temp-qualified so no same-named object in `public` can ever shadow it
  DROP TABLE IF EXISTS pg_temp._wsmove_set;
  CREATE TABLE pg_temp._wsmove_set (t text, i uuid, PRIMARY KEY (t, i)) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmove_set (t, i)
  SELECT DISTINCT m->>'t', (m->>'i')::uuid
  FROM jsonb_array_elements(COALESCE(p_moving, '[]'::jsonb)) m
  ON CONFLICT DO NOTHING;

  WITH gone AS (
    DELETE FROM public.knowledge_package_item i
    WHERE i.workspace_id = p_source
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = i.entity_type AND s.i = i.entity_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_pins FROM gone;

  WITH gone AS (
    DELETE FROM public.notification n
    WHERE n.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = n.target_type AND s.i = n.target_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = n.context_type AND s.i = n.context_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_notifications FROM gone;

  -- 224: pending reminders on moved entities (see section header for why DELETE).
  WITH gone AS (
    DELETE FROM public.reminder r
    WHERE r.workspace_id = p_source
      AND r.delivered_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = r.entity_type AND s.i = r.entity_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_reminders FROM gone;

  WITH cleared AS (
    UPDATE public.email_thread_index e
    SET linked_action_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'action' AND s.i = e.linked_action_id)
          THEN NULL ELSE e.linked_action_id END,
        linked_capture_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'capture' AND s.i = e.linked_capture_id)
          THEN NULL ELSE e.linked_capture_id END,
        linked_project_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = e.linked_project_id)
          THEN NULL ELSE e.linked_project_id END
    WHERE e.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'action' AND s.i = e.linked_action_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'capture' AND s.i = e.linked_capture_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = e.linked_project_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_threads FROM cleared;

  -- Workspace briefs: invalidate, don't delete — the stale brief keeps
  -- serving until the weaver's next pass recompiles it (a deleted brief
  -- blanks the AI's world model for up to a day).
  UPDATE public.knowledge_brief b
  SET source_fingerprint = NULL
  WHERE b.workspace_id IN (p_source, p_dest)
    AND b.scope_type = 'workspace';

  -- Project briefs for MOVED projects: delete outright. The project no
  -- longer exists in the source workspace, so a fingerprint-nulled row would
  -- just make the weaver try to recompile a brief for a foreign project.
  DELETE FROM public.knowledge_brief b
  WHERE b.workspace_id = p_source
    AND b.scope_type = 'project'
    AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = b.scope_id);

  RETURN jsonb_build_object(
    'package_pins_removed', v_pins,
    'notifications_removed', v_notifications,
    'email_threads_unlinked', v_threads,
    'reminders_removed', v_reminders
  );
END;
$$;

-- CREATE OR REPLACE preserves the 221:2048 revoke, but restate it so the
-- lock-down is visible at the definition site (193/221 house pattern).
REVOKE ALL ON FUNCTION public._wsmove_residue(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
