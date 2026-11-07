-- ============================================================
-- 452: the look-ahead (docs/plans/look-ahead-heartbeat.md)
-- ============================================================
-- At 19:00 local (tomorrow morning) and 08:00 (later today), the main agent
-- reads the calendar and the mail behind it (live, nothing stored: 344) and,
-- when something is worth it, writes one message in the person's home
-- thread, one agent-log line and one notice, and texts it when their phone
-- takes alert texts; a flight or train also gets a heads-up about 3 hours
-- before. This migration only widens three checks:
--   1. agent_log.kind: 'look_ahead' (450's list plus it);
--   2. notification.type: 'agent_look_ahead' (443's list plus it);
--   3. reach_notice.ref_type: 'look_ahead' (435's list plus it): a text is
--      claimed once per message.
-- No new table, no data change. Re-runnable.

-- ------------------------------------------------------------
-- 1. The log line's kind
-- ------------------------------------------------------------

alter table public.agent_log drop constraint if exists agent_log_kind_check;
alter table public.agent_log
  add constraint agent_log_kind_check
  check (kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint', 'doc_updated', 'pr_changed', 'mail_archived', 'action_done_from_mail', 'look_ahead'));

-- ------------------------------------------------------------
-- 2. The notice's type
-- ------------------------------------------------------------

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead'
]));

-- ------------------------------------------------------------
-- 3. The text's claim (reach_notice: one row per message and channel)
-- ------------------------------------------------------------

alter table public.reach_notice drop constraint if exists reach_notice_ref_type_check;
alter table public.reach_notice
  add constraint reach_notice_ref_type_check check (ref_type in ('tool_approval', 'guest_message', 'agent_link', 'look_ahead'));
