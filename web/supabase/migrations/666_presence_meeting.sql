-- ============================================================
-- 666: presence knows when its person is in a meeting
-- ============================================================
-- The router (src/lib/reach/route.ts) holds the agent's routine messages
-- while their person is in a meeting, and tells them once afterwards. A call
-- inside the app it reads from team_call_participant. A meeting the desktop
-- is recording (or is showing a call it detected in another app) only the
-- desktop knows, so the desktop's presence ping says so
-- (src/lib/presence/client.ts) and the row keeps it:
--
--   user_presence.in_meeting   this client's last word: in a meeting or not.
--                              False on every row of a surface that never
--                              says (the web, iOS).
--   user_presence.meeting_at   when it last said "in a meeting". Re-sent
--                              every four minutes while the meeting lasts,
--                              and kept when it ends, so the router knows
--                              which messages were written during one. The
--                              router counts a meeting whose mark is at
--                              most ten minutes old (presence.ts
--                              MEETING_WINDOW_MS), so a desktop that quits
--                              mid-meeting holds nothing for long.
--
-- Two columns, no index (the router reads a person's few rows by the
-- existing user_presence_user_updated_idx). The boolean's default is a
-- constant, so neither is a rewrite or a scan of the table. Re-runnable. The
-- table stays service-role only (454).

SET LOCAL lock_timeout = '5s';

alter table public.user_presence add column if not exists in_meeting boolean not null default false;
alter table public.user_presence add column if not exists meeting_at timestamptz null;

comment on column public.user_presence.in_meeting is
  'This client''s last word on whether its person is in a meeting (the desktop only).';
comment on column public.user_presence.meeting_at is
  'When this client last said its person is in a meeting, kept after it ends. A meeting counts while in_meeting and this is at most ten minutes old.';

notify pgrst, 'reload schema';
