-- 157: loop engine — allow the 'flow_run_output' notification type.
-- (docs/loop-engine/DESIGN.md, "Notifications" — run_skill flow actions deliver
-- their output document with an in-app notification, target_id = document id.)
--
-- The notification.type CHECK is maintained by DROP+ADD (pattern from 032/033/
-- 136); without this the executor's createNotification insert violates the
-- constraint and is silently swallowed (createNotification logs and moves on),
-- so report deliveries would never reach the inbox.
--
-- Idempotent: safe to re-run.

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
  'flow_run_output'
]));
