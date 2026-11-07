-- ============================================================
-- 401: every notice reaches the agent (retire the notifications page)
-- ============================================================
-- docs/plans/retire-notifications-page.md. The notifications page (the Inbox
-- the bell opens) goes; before it does, every notification a person should
-- hear about becomes an event in the agent's inbox (336), so the home thread
-- is where it lives.
--
-- agent_event_source_check  dropped and re-added with 'reminder' and 'crm'.
-- agent_event_kind_check    dropped and re-added with four kinds the notice
--                           tap (src/lib/agent-events/notice.ts) records:
--     activity              a teammate changed something of yours (completed
--                           or reopened an action, unassigned you, a
--                           project's status, a sprint started, a decision
--                           confirmed);
--     reminder.due          a reminder you set came due;
--     contact.followup_due  a contact's follow-up date is near;
--     sequence.failed       a sequence you own failed or was paused.
--   The lists match src/lib/agent-events/types.ts (AGENT_EVENT_SOURCES,
--   AGENT_EVENT_KINDS); __tests__/migration-401.test.ts pins them.
--
-- notification              the page that listed these rows is gone; they stay
--                           for banners, sounds and the bots' notices.
--   rows of 13 dead types   deleted: nothing writes them (action_priority_changed,
--                           action_due_soon, action_overdue, action_mentioned,
--                           capture_processed, cycle_ending_soon,
--                           share_comment_added, followup_reminder,
--                           relationship_going_stale, feedback_requested) or
--                           they were retired long ago (email_drafts_ready,
--                           work_run_ready, work_run_input).
--   notification_type_check dropped and re-added with the 16 live types (the
--                           app's NOTIFICATION_TYPES, src/lib/notifications.ts).
--   cleanup_old_notifications()  dropped and re-made (it returned void, now
--                           the count): read rows go after 30 days, any row
--                           after 90. 031 made it but nothing ever ran it, so
--                           rows piled up forever. The daily cron
--                           /api/cron/notification-purge calls it; service
--                           role only.
--
-- notification_preference   dropped, with its seed trigger on member and its
--                           function (031, 032; policies from 031 and 270 go
--                           with the table). Settings > Notifications went
--                           (decision 2: no needless choices), and nothing
--                           reads a mute any more.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- BEFORE the PR that writes these kinds merges. Without it the tap's insert
-- fails the check: the recorder logs it and the notification still goes out,
-- so nothing breaks but the agent never hears of it; and the purge cron's
-- call fails (logged, nothing deleted). The app no longer reads
-- notification_preference, so dropping it before the merge is safe too: the
-- old app's read of a missing table returns an error it treats as "no
-- preference" (createNotification ignores the error).
--
-- Idempotent: drop if exists, then add. This file holds no backslash
-- anywhere: one MCP transport decodes escapes, so the applied SQL would differ
-- from the file.
-- ============================================================

alter table public.agent_event drop constraint if exists agent_event_source_check;
alter table public.agent_event
  add constraint agent_event_source_check check (source in ('email', 'capture', 'meeting', 'work', 'mention', 'digest', 'reminder', 'crm'));

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed'));

delete from public.notification where type in ('action_priority_changed', 'action_due_soon', 'action_overdue', 'action_mentioned', 'capture_processed', 'cycle_ending_soon', 'share_comment_added', 'followup_reminder', 'relationship_going_stale', 'feedback_requested', 'email_drafts_ready', 'work_run_ready', 'work_run_input');

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array['action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added', 'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon', 'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest']));

drop function if exists public.cleanup_old_notifications();
create function public.cleanup_old_notifications()
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.notification
    where (is_read = true and created_at < now() - interval '30 days')
       or created_at < now() - interval '90 days'
    returning 1
  )
  select count(*)::integer from gone;
$$;
revoke all on function public.cleanup_old_notifications() from public, anon, authenticated;
grant execute on function public.cleanup_old_notifications() to service_role;

drop trigger if exists member_seed_notification_preferences on public.member;
drop function if exists public.seed_notification_preferences();
drop table if exists public.notification_preference;
