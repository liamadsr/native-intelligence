-- Email through the agent, E2 (docs/plans/email-through-the-agent.md):
-- arriving mail that needs no drafted reply is understood (Jev
-- email.understand) and reaches the agent's inbox as 'email.arrived'.
--
-- agent_event_kind_check  dropped and re-added with 'email.arrived'.
--
-- Additive and idempotent. Facts stay templated (sender address, kind and
-- two yes/no answers): no subject or body is stored. Follows 405 (403 and
-- 404 are taken: main; an open branch).

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'meeting.changed', 'email.arrived'));
