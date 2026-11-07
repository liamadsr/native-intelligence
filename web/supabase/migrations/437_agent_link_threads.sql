-- ============================================================
-- 437: A linked agent's thread can be made (agent links, fix to 435).
--
-- An ask from another Dial8 user's agent goes into the thread of the half
-- this owner set up for them (src/lib/agent-links/exchange.ts askAgent,
-- src/lib/guests/texting.ts ensureGuestThread), with outside_channel
-- 'dial8'. The check last set in 428 allowed only 'slack', or 'sms' on a
-- guest's thread, so every ask failed to make its thread.
--
--   chat_conversations.outside_channel  may now be 'dial8', and only on a
--                            guest's own thread, as 'sms'.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

alter table public.chat_conversations drop constraint if exists chat_conversations_outside_channel_check;
alter table public.chat_conversations
  add constraint chat_conversations_outside_channel_check
  check (
    outside_channel is null
    or (
      is_home is null
      and (
        outside_channel = 'slack'
        or (outside_channel in ('sms', 'dial8') and agent_guest_id is not null)
      )
    )
  );

comment on column public.chat_conversations.outside_channel is
  'Slack (414): set on a person''s conversation for one Slack channel thread (slack_thread). SMS (428) and dial8 (437, another Dial8 user''s agent): set on a guest''s own thread. Never on the home thread. A channel turn may send into it.';

-- Verify:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'chat_conversations_outside_channel_check';
