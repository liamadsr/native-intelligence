-- ============================================================
-- 687: a notification may point at a canvas or a spreadsheet.
-- ============================================================
-- A comment on a canvas (682) or a spreadsheet (675) can @-mention a
-- teammate, and a reply reaches the thread's author. The notice opens the
-- record it is about, so the notification's target is that record.
--
-- Redefines ONE existing object: notification_target_type_check, from its
-- newest definition (679: 572's list plus 'company'), widened by 'canvas'
-- and 'spreadsheet' and nothing else. No value is taken away, so every
-- existing row still passes.
--
-- Who is told is decided in the app, before the row is written: only a
-- member who can open that canvas or spreadsheet (canvas_visible_to,
-- spreadsheet_entity_visible_to). This file changes no policy.
--
-- Has its own begin/commit. Idempotent: safe to run twice. No backslashes.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact', 'company',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message', 'team_chat_channel',
  'canvas', 'spreadsheet'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

commit;

notify pgrst, 'reload schema';
