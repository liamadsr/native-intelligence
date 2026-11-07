-- ============================================================
-- 455: A guest's calendar addresses (Liam, 2026-10-31).
--
-- On a three-day trip every calendar event was an invite from his wife, one
-- of his guests: meeting prep ran for each one ("Prep: Lunch", "Prep: Corn
-- Maze"), and the look-ahead kept every unanswered invite of hers in the
-- app, as it does a stranger's. A guest row held a phone number only, so
-- nothing could match a calendar organizer or attendee to them.
--
--   agent_guest.calendar_emails  the addresses this person's calendar
--                                invites come from, as the owner types
--                                them on the person's People page. Stored
--                                trimmed, lower case and deduped (the app
--                                cleans them), at most 5. Empty by default.
--
-- An active guest's addresses (and an agent-linked guest's own Dial8 sign-in
-- address) are the owner's trusted people: an event whose only other
-- attendees are guests gets no meeting prep, and the look-ahead treats a
-- guest's invite as confirmed (src/lib/guests/store.ts trustedGuestEmails).
--
-- Who reads and writes: unchanged from 427 (the owner selects their own rows;
-- only the service role writes).
--
-- Applied by hand, from this file, to DEV first, then PROD, before the code
-- that reads it (the guest reads select this column). Additive (one column
-- with a default every row meets, one check). Idempotent. No backslashes
-- anywhere in this file (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

alter table public.agent_guest
  add column if not exists calendar_emails text[] not null default '{}';

comment on column public.agent_guest.calendar_emails is
  'The addresses this person''s calendar invites come from, as the owner listed them (455): trimmed, lower case, deduped, at most 5. An active guest''s addresses count as the owner''s trusted people for meeting prep and the look-ahead.';

alter table public.agent_guest drop constraint if exists agent_guest_calendar_emails_max;
alter table public.agent_guest
  add constraint agent_guest_calendar_emails_max check (cardinality(calendar_emails) <= 5);
