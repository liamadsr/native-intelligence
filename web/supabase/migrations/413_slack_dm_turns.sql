-- ============================================================
-- 413: Slack as a customer connection, part 2 (DMs reach the agent).
--
-- docs/plans/slack-connect.md §4 piece 5. A DM from the person's linked Slack
-- account is written into their home thread as their message and answered by
-- a home turn with reason 'slack' (src/lib/inngest/slack-turn.ts), whose reply
-- is posted back to Slack. Slack and SMS (migration 411) are one channel layer
-- (src/lib/chat/channel-turn.ts): a Slack turn uses the columns 411 added for
-- texts. This widens home_turn (migration 333):
--
--   reason 'slack'           the person messaging from Slack.
--   text_message_ids         (411) the person's channel messages a turn
--                            carried, a Slack turn's too: a skipped or sent
--                            turn carried them, so none is answered twice.
--   reply_sent_at            (411) set once, by one conditional update, before
--                            the reply is sent: a retried step never sends
--                            twice.
--
-- Both columns are `add column if not exists`, as 411 defines them, so this
-- applies with or without 411. The reason check keeps 411's 'text'.
--
-- Idempotent. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

alter table public.home_turn
  add column if not exists text_message_ids text[] not null default '{}';

alter table public.home_turn
  add column if not exists reply_sent_at timestamptz null;

comment on column public.home_turn.text_message_ids is
  'A channel turn (reason text, 411; reason slack, 413): the chat_messages ids of the person''s messages from that channel it carried.';

comment on column public.home_turn.reply_sent_at is
  'When the reply was sent back to the outside channel (one conditional update before the send: never twice).';

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack'));

alter table public.home_turn drop constraint if exists home_turn_texts_cap;
alter table public.home_turn
  add constraint home_turn_texts_cap check (cardinality(text_message_ids) <= 20);
