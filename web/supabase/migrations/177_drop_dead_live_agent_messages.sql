-- Migration 175: drop the dead captures.live_agent_messages column.
-- Plan: docs/live-agent-chat-merge/PLAN.md (WS-3b).
--
-- Added by migration 078 to persist the live session's ModelMessage[] server-
-- side. The live-agent route later became fully STATELESS — continuity is
-- reconstructed from serialized capture state each call — and nothing under
-- src/ has read or written this column since. Grep-confirmed dead: 0 references.
--
-- Reversible: re-add with `ALTER TABLE captures ADD COLUMN live_agent_messages
-- jsonb;` (it always defaulted to NULL, so no data is lost on drop). IF EXISTS
-- makes this idempotent and a no-op on any environment where it's already gone.

ALTER TABLE captures DROP COLUMN IF EXISTS live_agent_messages;
