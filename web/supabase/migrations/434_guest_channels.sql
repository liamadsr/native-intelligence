-- ============================================================
-- 434: Which channels each guest reaches the owner's agent on (guest access,
-- Liam 2026-10-25: "when you add someone you should also select what
-- channels they have access to whether it's text and slack or just text or
-- just slack").
--
--   agent_guest.channels       'sms' (Text), 'slack' (Slack), or both. At
--                              least one. Every guest so far was added for
--                              text, so the default is {sms}. "Within Dial8"
--                              (agent to agent) is planned separately and
--                              would be a new value here.
--   agent_guest.phone_e164     now nullable: someone who reaches the agent
--                              only on Slack needs no number. A guest on Text
--                              must have one.
--   agent_guest.phone_bound_at when the guest's number was proven theirs:
--                              their first text with the invite code, or
--                              the JOIN they texted. Until then a text from
--                              it doesn't reach their agent. Every guest
--                              active before 434 texted in, so they're
--                              backfilled.
--   agent_guest.slack_team_id,
--   agent_guest.slack_user_id  the Slack account a guest on Slack is bound
--                              to, written when they first DM the Dial8 bot
--                              with their invite. Null until then. A Slack
--                              account is active for one owner at most, as a
--                              phone is.
--
-- A guest on both channels binds each with the same invite code: the first
-- binding makes them active, and the code is spent once every channel they
-- have is bound.
--
-- Who reads and writes: unchanged from 427 (the owner selects their own rows;
-- only the service role writes).
--
-- Applied by hand, from this file, to DEV first, then PROD, before the code
-- that reads it. Additive (new columns with defaults, a NOT NULL dropped, new
-- checks every existing row meets, and one backfill of phone_bound_at). Idempotent. No backslashes anywhere in this file (one MCP transport
-- decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

alter table public.agent_guest
  add column if not exists channels text[] not null default '{sms}';

comment on column public.agent_guest.channels is
  'Where this person reaches the owner''s agent: sms (Text), slack (Slack), or both (434). A text from their number, or a DM from their Slack account, reaches their agent only on a channel listed here.';

alter table public.agent_guest drop constraint if exists agent_guest_channels_check;
alter table public.agent_guest
  add constraint agent_guest_channels_check check (cardinality(channels) >= 1 and channels <@ array['sms', 'slack']::text[]);

alter table public.agent_guest alter column phone_e164 drop not null;

alter table public.agent_guest drop constraint if exists agent_guest_text_has_phone;
alter table public.agent_guest
  add constraint agent_guest_text_has_phone check (phone_e164 is not null or not ('sms' = any (channels)));

alter table public.agent_guest
  add column if not exists phone_bound_at timestamptz null;

update public.agent_guest
  set phone_bound_at = coalesce(activated_at, now())
  where state = 'active' and phone_e164 is not null and phone_bound_at is null;

alter table public.agent_guest
  add column if not exists slack_team_id text null,
  add column if not exists slack_user_id text null;

comment on column public.agent_guest.slack_user_id is
  'The Slack account (with slack_team_id) this guest reaches the agent from, bound when they first DM the Dial8 bot with their invite (434).';

alter table public.agent_guest drop constraint if exists agent_guest_slack_pair;
alter table public.agent_guest
  add constraint agent_guest_slack_pair check ((slack_team_id is null) = (slack_user_id is null));

-- One Slack account reaches one agent, as one phone does.
create unique index if not exists agent_guest_active_slack_key
  on public.agent_guest (slack_team_id, slack_user_id) where state = 'active' and slack_user_id is not null;
