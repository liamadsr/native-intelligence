-- ============================================================
-- 454: reach follows you (docs/plans/reach-follows-you.md)
-- ============================================================
-- When the agent writes to someone who is not in any Dial8 app, the message
-- should find them (a text, later a push) instead of waiting in a thread
-- nobody is looking at. That needs two facts the database does not hold yet:
-- whether the person is at an app right now, and how far they have read
-- their home thread. Part B of the plan adds both, and changes no behaviour:
-- nothing reads them until the router (part C) lands.
--
--   user_presence            one row per person and browser or app install
--                            (client_id, a random id the client keeps in
--                            localStorage). The app pings POST /api/presence:
--     surface                'web', 'desktop' or 'ios'.
--     state                  'active', 'idle', 'locked' or 'hidden'. The web
--                            writes only 'active' (a stale row is its
--                            absence, so a closing tab can never mark a live
--                            one absent); the desktop's main window writes
--                            'active', 'idle' or 'locked'; iOS will write
--                            'active' or 'hidden'.
--     active_at              the last ping that said 'active'; NULL before
--                            the first. Present = an 'active' row whose
--                            active_at is under 5 minutes old
--                            (src/lib/presence/presence.ts isPresent).
--     updated_at             the last ping of any state. Rows untouched for
--                            30 days are pruned by the notification-purge
--                            cron.
--                            Service role only: RLS on with no policy, and
--                            nothing granted to anon or authenticated.
--   chat_conversations.seen_at
--                            home threads only: the newest message time the
--                            person had on screen while they were there
--                            (visible, focused, recent input). Written by one
--                            conditional update that clamps it to now() and
--                            never moves it backwards
--                            (src/lib/presence/store.ts markHomeSeen).
--
-- Part C (the router, src/lib/reach/route.ts) widens four checks and adds one
-- column: reach_notice.urgent, reach_notice.ref_type ('home_message'),
-- reach_notice.channel ('push', 'banner'), sms_message.kind ('away') and
-- notification.type ('agent_message'). Sections 3 to 5.
--
-- Later parts of the plan append to this file (re-check the number at merge).
--
-- Idempotent: create table if not exists, add column if not exists, drop
-- constraint if exists + add, create index if not exists; the REVOKE restates
-- the full privilege set. No backslashes anywhere in this file (one MCP
-- transport decodes escapes, so the applied SQL would differ from the file).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. user_presence (part B)
-- ------------------------------------------------------------

create table if not exists public.user_presence (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null,
  surface text not null,
  state text not null,
  active_at timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

alter table public.user_presence drop constraint if exists user_presence_client_id_shape;
alter table public.user_presence
  add constraint user_presence_client_id_shape check (client_id ~ '^[A-Za-z0-9_-]{8,64}$');

alter table public.user_presence drop constraint if exists user_presence_surface_check;
alter table public.user_presence
  add constraint user_presence_surface_check check (surface in ('web', 'desktop', 'ios'));

alter table public.user_presence drop constraint if exists user_presence_state_check;
alter table public.user_presence
  add constraint user_presence_state_check check (state in ('active', 'idle', 'locked', 'hidden'));

create index if not exists user_presence_user_updated_idx on public.user_presence (user_id, updated_at desc);

comment on table public.user_presence is
  'Whether a person is at a Dial8 app right now (454, docs/plans/reach-follows-you.md): one row per person and browser or app install, pinged by POST /api/presence. Present = a row in state active whose active_at is under 5 minutes old. Service role only; rows untouched for 30 days are pruned by the notification-purge cron.';
comment on column public.user_presence.client_id is
  'A random id the client keeps in localStorage: one per browser or app install (8 to 64 letters, digits, dashes or underscores).';
comment on column public.user_presence.surface is
  'Which app pinged: web, desktop or ios.';
comment on column public.user_presence.state is
  'What the last ping said. The web writes only active (a stale row is its absence); the desktop main window writes active, idle or locked; iOS will write active or hidden.';
comment on column public.user_presence.active_at is
  'When a ping last said active. Not touched by any other state, so it also says when the person was last active on this client. NULL before the first.';
comment on column public.user_presence.updated_at is
  'When the last ping of any state landed. The notification-purge cron deletes rows older than 30 days.';

alter table public.user_presence enable row level security;
revoke all on table public.user_presence from anon, authenticated;
grant all on table public.user_presence to service_role;

-- ------------------------------------------------------------
-- 2. chat_conversations.seen_at (part B)
-- ------------------------------------------------------------

alter table public.chat_conversations add column if not exists seen_at timestamptz null;

comment on column public.chat_conversations.seen_at is
  'Home threads only (454): the newest message time the person had on screen while visible, focused and recently active. Set by POST /api/presence through one conditional update that clamps it to now() and never moves it backwards. NULL: never reported.';

-- ------------------------------------------------------------
-- 3. reach_notice: the router's claims (part C)
-- ------------------------------------------------------------
-- The router (src/lib/reach/route.ts) claims every message it sends, one row
-- per message and channel, so nothing goes twice:
--   ref_type    452's list plus 'home_message' (any message the agent wrote in
--               the home thread: its chat_messages id). 'look_ahead' stays:
--               the look-ahead's text is now claimed by the router.
--   channel     'push' joins 'slack' and 'sms': the iOS app's slot, ordered
--               before a text, nothing sent on it until its adapter exists.
--               'banner' too: nothing is sent on it. A message the router
--               bannered for two hours while the person sat at an app and
--               never opened is claimed on it, so it is done for good and no
--               later run texts it; so is a message that only ever banners.
--   urgent      true when the message went through quiet hours because it
--               was urgent (part D). Nothing caps the person's texts; the
--               column only records it.

alter table public.reach_notice add column if not exists urgent boolean not null default false;

comment on column public.reach_notice.urgent is
  'True when the message went through quiet hours (21:00 to 08:00 local) because the agent marked it urgent (454, metadata.urgent_by). A record only: nothing caps the person''s texts.';

alter table public.reach_notice drop constraint if exists reach_notice_ref_type_check;
alter table public.reach_notice
  add constraint reach_notice_ref_type_check check (ref_type in ('tool_approval', 'guest_message', 'agent_link', 'look_ahead', 'home_message'));

alter table public.reach_notice drop constraint if exists reach_notice_channel_check;
alter table public.reach_notice
  add constraint reach_notice_channel_check check (channel in ('slack', 'sms', 'push', 'banner'));

-- ------------------------------------------------------------
-- 4. sms_message.kind: 'away' (part C)
-- ------------------------------------------------------------
-- An agent message the router texted while the person was away from the app.
-- 428's list plus it.

alter table public.sms_message drop constraint if exists sms_message_kind_check;
alter table public.sms_message
  add constraint sms_message_kind_check check (
    kind in (
      'text', 'stop', 'start', 'help', 'unknown', 'limited', 'approval', 'code_miss',
      'guest_text', 'guest_invite', 'guest_join',
      'verification', 'welcome', 'reply', 'notice', 'unknown_reply', 'auto_reply', 'needs_you', 'approval_result',
      'guest_reply', 'guest_welcome', 'guest_notice',
      'away'
    )
  );

comment on column public.sms_message.kind is
  'in: text, stop, start, help, unknown, limited, approval, code_miss, guest_text, guest_invite, guest_join. out: verification, welcome, reply, notice, unknown_reply, auto_reply (HELP / START answers), needs_you, approval_result, guest_reply, guest_welcome, guest_notice, away (an agent message texted while the person was away from the app, 454).';

-- ------------------------------------------------------------
-- 5. notification.type: 'agent_message' (part C)
-- ------------------------------------------------------------
-- The router's banner when the person is at an app and the agent wrote to
-- them: a native banner on the desktop when no Dial8 window is focused, a
-- toast otherwise; a click opens the home thread. 452's list plus it.

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message'
]));
