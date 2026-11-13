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
-- 2. Fences these loops' runs to the person they ran for. A run's step
--    results hold output previews (flow_run.action_results), and these
--    loops summarize the owner's own mail, DMs and documents. Each run is
--    stamped when it is written: flow_run.private_to, the run-as user of a
--    fire of one of the three (src/lib/flows/types.ts flowRunPrivateTo).
--    A stamped run is readable only by that user; every other run stays
--    readable by every member of its workspace, as 107's policy has it (107
--    is its only definition; is_workspace_member is 028's). The stamp is the
--    RUN's: changing the loop's trigger or handing it to someone else later
--    exposes none of its old runs. No foreign key, on purpose: a removed
--    user's runs stay private to nobody rather than going public (a SET
--    NULL would open them to the workspace). Service-role reads apply the
--    same rule in code (canReadFlowRun).
--
-- Re-runnable: the column is added if missing, the constraint and the
-- policy are dropped if they exist and created again.

SET LOCAL lock_timeout = '5s';

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created'));

alter table public.flow_run add column if not exists private_to uuid;

comment on column public.flow_run.private_to is
  'The one user who may read this run (its run-as user, for a fire of email_received, chat_message or document_created); NULL = every member of the workspace. Stamped at insert; never changed.';

drop policy if exists "members read workspace flow runs" on public.flow_run;
create policy "members read workspace flow runs"
  on public.flow_run for select
  using (
    exists (
      select 1 from public.flow f
      where f.id = flow_run.flow_id
        and public.is_workspace_member(f.workspace_id)
    )
    and (flow_run.private_to is null or flow_run.private_to = auth.uid())
  );
