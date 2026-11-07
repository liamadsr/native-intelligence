-- ============================================================
-- 438: A held call may be an internal write (guest access).
--
-- A guest's tool the owner set to Needs approval (agent_guest.ask_tools,
-- 429) that only changes Dial8 (create_action, update_action, ...) was
-- refused, because tool_approval (335) held only the reviewer's classes. It
-- is now held as the owner's card like every other guest ask
-- (src/lib/safety/action-review.ts holdEveryCallAs).
--
--   tool_approval.side_effect  may now be 'internal-write'.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

alter table public.tool_approval drop constraint if exists tool_approval_side_effect_check;
alter table public.tool_approval
  add constraint tool_approval_side_effect_check
  check (side_effect in ('external-write', 'delete', 'automation-write', 'unclassified', 'internal-write'));

-- Verify:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'tool_approval_side_effect_check';
--   -- expect the list to include 'internal-write'
