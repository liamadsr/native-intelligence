-- ============================================================
-- 445: The agent carries on once the person approves a call it held.
--
-- An approved call runs in the card's own Accept, outside any agent turn
-- (src/lib/safety/approvals.ts approveToolCall). Since GEN-1172 the agent
-- reads how it ended at its conversation's next turn; now, once the call
-- has run, Dial8 also starts that turn itself in the person's home thread
-- (a home turn with reason 'approval', src/lib/safety/approval-turn.ts),
-- so the agent picks up where it left off without the person typing.
--
--   home_turn.reason           may now be 'approval'. 443 (the Now file,
--                              PR 970, also unapplied) rewrites the same
--                              check: both files list 'check_in' and
--                              'approval', so either may be applied first.
--   tool_approval.home_turn_id the approval turn that carried the call's
--                              outcome to the agent: each settled call is
--                              carried once, as an agent link's answer is
--                              (435's agent_link_message.home_turn_id).
--   tool_approval_conversation_settled_idx
--                              the conversation's settled calls, newest
--                              first: the turn context's approval sections,
--                              the already-ran check and the approval turn
--                              all read them.
--
-- Applied by hand, from this file, to DEV and then to PROD before the code
-- that reads it merges. Additive (one nullable column, an index, a widened
-- check every existing row meets). Idempotent. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── tool_approval: carried by an approval turn ─────────────────────────────

alter table public.tool_approval
  add column if not exists home_turn_id uuid null;

comment on column public.tool_approval.home_turn_id is
  'The home turn (reason approval, 445) that carried this settled call''s outcome to the agent that raised it. NULL until one did.';

create index if not exists tool_approval_conversation_settled_idx
  on public.tool_approval (conversation_id, decided_at desc)
  where status <> 'pending';

-- ── home_turn.reason: 'approval' ───────────────────────────────────────────

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval'));

-- Verify:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'home_turn_reason_check';
--   -- expect the list to end with 'approval'
--   select column_name from information_schema.columns
--     where table_name = 'tool_approval' and column_name = 'home_turn_id';
