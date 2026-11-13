-- ============================================================
-- 640: loops that start on the owner's own events
-- ============================================================
-- Three new loop triggers, each firing only for its owner's own items
-- (src/lib/flows/event-triggers.ts):
--
--   email_received     new mail arrives in the owner's connected inbox
--   chat_message       a person posts in team chat (a channel the owner
--                      reads, or anywhere they are @mentioned)
--   document_created   a person creates a document the owner can see
--
-- The schedule trigger's new cadences (monthly, cron, once) live in
-- trigger_config (jsonb), which has no check: nothing else changes.
--
-- Widens 458's flow_trigger_type_check, keeping every earlier value.
-- Re-runnable: the constraint is dropped if it exists and added again.

SET LOCAL lock_timeout = '5s';

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created'));
