-- ============================================================
-- 428: People who text your agent can text it (guest access, PR2 of 5).
--
-- A guest (agent_guest, 427) texts the Dial8 number. Their first text
-- carries the owner's invite code and makes them active; a text "JOIN
-- <code>" with the owner's request code asks for access. An active guest's
-- texts go into their own thread (chat_conversations.agent_guest_id) and a
-- text turn answers them as the agent made for that person
-- (src/lib/guests/).
--
--   chat_conversations.outside_channel  may now be 'sms', and only on a
--                            guest's own thread: the channel turn that answers
--                            a guest sends into it, as a Slack channel turn
--                            sends into its thread (414).
--   sms_message.guest_id     the guest a text came from or went to (their
--                            per-day caps). Null for everyone else.
--   sms_message.kind         in: 'guest_text' (a guest's text to their
--                            agent), 'guest_invite' (their invite code),
--                            'guest_join' (a JOIN request). out: 'guest_reply',
--                            'guest_welcome', 'guest_notice'.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── chat_conversations.outside_channel: a guest's thread is 'sms' ──────────

alter table public.chat_conversations drop constraint if exists chat_conversations_outside_channel_check;
alter table public.chat_conversations
  add constraint chat_conversations_outside_channel_check
  check (
    outside_channel is null
    or (
      is_home is null
      and (
        outside_channel = 'slack'
        or (outside_channel = 'sms' and agent_guest_id is not null)
      )
    )
  );

comment on column public.chat_conversations.outside_channel is
  'Slack (414): set on a person''s conversation for one Slack channel thread (slack_thread). SMS (428): set on a guest''s own thread. Never on the home thread. A channel turn may send into it.';

-- ── sms_message: who a guest's texts are ───────────────────────────────────

alter table public.sms_message
  add column if not exists guest_id uuid null references public.agent_guest(id) on delete set null;

comment on column public.sms_message.guest_id is
  'The guest (agent_guest, 427) this text came from or went to (428): their per-day caps. Null for everyone else.';

create index if not exists sms_message_guest_created_idx
  on public.sms_message (guest_id, created_at desc) where guest_id is not null;

comment on column public.sms_message.kind is
  'in: text, stop, start, help, unknown, limited, approval, code_miss, guest_text, guest_invite, guest_join. out: verification, welcome, reply, notice, unknown_reply, auto_reply (HELP / START answers), needs_you, approval_result, guest_reply, guest_welcome, guest_notice.';

alter table public.sms_message drop constraint if exists sms_message_kind_check;
alter table public.sms_message
  add constraint sms_message_kind_check check (
    kind in (
      'text', 'stop', 'start', 'help', 'unknown', 'limited', 'approval', 'code_miss',
      'guest_text', 'guest_invite', 'guest_join',
      'verification', 'welcome', 'reply', 'notice', 'unknown_reply', 'auto_reply', 'needs_you', 'approval_result',
      'guest_reply', 'guest_welcome', 'guest_notice'
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it: the row read. One row reading (true, 0):
--
--   select
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'sms_message'
--               and column_name = 'guest_id') as has_guest_id,
--     (select count(*) from public.chat_conversations where outside_channel = 'sms') as sms_threads;
