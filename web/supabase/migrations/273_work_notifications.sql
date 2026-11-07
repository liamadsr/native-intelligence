-- Migration 273: work-ledger notifications
-- (docs/loop-engine/ACTIVITY-AND-REVIEW-DESIGN.md §4.5).
--
-- Two notification types carry every work-shaped push from here on, emitted by
-- the ledger recorder (src/lib/work/notify.ts) as a side effect of status:
--   • work_needs_you — a run parked on a question, or a deliverable waiting on
--     the user (needs_input / needs_review);
--   • work_failed    — a run that failed, grouped: one per (workspace, kind) per
--     day.
-- Both target the work item (target_type = 'work_item' → the Activity detail
-- panel). 'email_draft' and 'sequence' join the target set so a draft in Mail
-- and a sequence can be deep-linked directly instead of shipping target-less
-- rows (the email_drafts_ready / sequences dead ends).
--
-- House pattern (172 / 197 / 200 / 224): DROP + full-enumeration ADD for each
-- CHECK. Widening only permits MORE values, so this applies cleanly with data
-- present. The legacy work-shaped types (flow_run_output, work_run_ready,
-- work_run_input, email_drafts_ready) stay in the CHECK for the rows already in
-- inboxes; their producers move onto the recorder.

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'action_priority_changed',
  'action_due_soon', 'action_overdue', 'action_mentioned', 'capture_processed', 'capture_shared',
  'comment_added', 'comment_reply', 'decision_confirmed', 'cycle_started', 'cycle_ending_soon',
  'share_comment_added', 'project_status_changed', 'meeting_starting_soon', 'followup_reminder',
  'contact_followup_due', 'relationship_going_stale', 'email_drafts_ready', 'feedback_requested',
  'flow_run_output', 'work_run_ready', 'work_run_input', 'reminder',
  'work_needs_you', 'work_failed'
]));

alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence'
));

-- Preference rows for existing members, in-app on / email off — the one-off
-- backfill every type since migration 033 has used (the seed trigger is not
-- edited; createNotification treats a missing row as allowed, so new members
-- get the same default without one).
insert into public.notification_preference (member_id, notification_type, in_app, email)
select m.id, t.type, true, false
from public.member m
cross join (values ('work_needs_you'), ('work_failed')) as t(type)
on conflict (member_id, notification_type) do nothing;
