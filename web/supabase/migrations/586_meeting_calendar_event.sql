begin;
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 586: where a scheduled meeting link's calendar event was written (calls
-- plan, phase 7 follow-up).
--
-- A meeting made with a start time from team chat goes on its host's
-- calendar (src/lib/meeting-links/calendar-events.ts): on the connected
-- Google or Outlook account they chose (or their default), created once with
-- the meeting's id as its idempotency key, our link as its location. These
-- two columns remember that event and that account, so a new link, a revoke,
-- an end for everyone, a move or a rename later updates or removes the event
-- on the SAME calendar. A host with no connected calendar gets no provider
-- event: the app's calendar shows the meeting from this table itself.
--
--   meeting.calendar_event_id    the provider's event id (null: none written)
--   meeting.calendar_account_id  the connected account it was written to; set
--                                null when that account is disconnected (the
--                                updates then do nothing, quietly)
--
-- Both server only: never in the members' column grant (573). A booking's
-- meeting (585) never uses them: its booking keeps its own event.
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: two nullable columns (no rewrite; the deployed app selects its
-- columns by name and never reads these). lock_timeout bounds the wait for
-- the lock. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ------------------------------------------------------------

alter table public.meeting add column if not exists calendar_event_id text;
alter table public.meeting add column if not exists calendar_account_id uuid references public.connected_account(id) on delete set null;
comment on column public.meeting.calendar_event_id is
  'The provider event a scheduled meeting link was put on its host''s calendar as (586). Server only.';
comment on column public.meeting.calendar_account_id is
  'The connected account that event is on (586); null when there is none or the account was disconnected. Server only.';

notify pgrst, 'reload schema';

commit;
