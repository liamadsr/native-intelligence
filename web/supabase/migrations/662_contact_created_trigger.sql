-- ============================================================
-- 662: loops that start on a new contact
-- ============================================================
-- One new loop trigger, firing only for its owner (src/lib/flows/event-triggers.ts):
--
--   contact_created    a contact is added to the CRM: by a public intake (a
--                      website form, a quote, a customer's first text: at
--                      once) or by a person by hand (about five minutes
--                      later). Never one an agent, an import, a sync or a
--                      meeting made. Only loops whose owner can see the
--                      contact fire, and their runs are private to the
--                      owner (640's private_to stamp, set in code).
--
-- Which contacts a loop takes (any, a form's, a person's own) lives in
-- trigger_config (jsonb), which has no check: nothing else changes.
--
-- Widens 660's flow_trigger_type_check, keeping every earlier value. Added
-- without a scan, then validated on its own, so the table is never held for
-- the check of its rows.
--
-- Re-runnable: the constraint is dropped if it exists and created again.

SET LOCAL lock_timeout = '5s';

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created', 'record_created', 'contact_created')) not valid;
alter table public.flow validate constraint flow_trigger_type_check;

notify pgrst, 'reload schema';
