-- ============================================================
-- 456: calling the agent (docs/plans/text-and-calling.md Phase 4, the
-- GPT-Live spike: src/lib/calls/).
-- ============================================================
--   home_turn.reason       may now be 'call' (443's list plus it): what the
--                          person said on a phone call to the Dial8 number,
--                          handed over by GPT-Live and run in-process by the
--                          call's bridge (src/lib/calls/call-turn-server.ts).
--                          Its carried messages go in text_message_ids, as
--                          every channel turn's do (413).
--
-- Nothing else: the person's words are chat_messages rows (metadata kind
-- 'channel_message', channel 'call'), whose metadata has no check.
-- ------------------------------------------------------------

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval', 'call'));
