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
-- 1. Widens 458's flow_trigger_type_check, keeping every earlier value.
-- 2. Fences these loops' runs to their owner. A run's step results hold
--    output previews (flow_run.action_results), and these loops summarize
--    the owner's own mail, DMs and documents: only the loop's owner
--    (flow.created_by) reads the runs of a loop on one of the three. Every
--    other loop's runs stay readable by every member of its workspace, as
--    107's policy has it (107 is its only definition; is_workspace_member
--    is 028's). Service-role reads apply the same rule in code
--    (src/lib/flows/types.ts canReadFlowRuns).
--
-- Re-runnable: the constraint and the policy are dropped if they exist and
-- created again.

SET LOCAL lock_timeout = '5s';

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created'));

drop policy if exists "members read workspace flow runs" on public.flow_run;
create policy "members read workspace flow runs"
  on public.flow_run for select
  using (
    exists (
      select 1 from public.flow f
      where f.id = flow_run.flow_id
        and public.is_workspace_member(f.workspace_id)
        and (
          f.trigger_type not in ('email_received', 'chat_message', 'document_created')
          or f.created_by = auth.uid()
        )
    )
  );
