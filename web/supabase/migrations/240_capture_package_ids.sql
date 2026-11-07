-- ============================================================================
-- 240: Context packages attached to a capture.
--
-- Slice 2 of context packages (design: "Context Packages, Live", 2026-08-24,
-- §3a): distribution is share + attach. The user attaches one or more
-- packages to a call via the "+ Packages" chip (the sibling of "+ choose
-- folder" in the capture control row); the attachment is stamped on the
-- CAPTURE row — the same home as agent_cwd_override (mig 153), because the
-- capture row exists for batch captures too (the chat_conversations row is
-- live-mode-only) and both live-agent runtimes already load it. Mid-call
-- attaches propagate for free: the cloud route re-reads the capture every
-- call; the local CC session picks them up at next spawn.
--
-- uuid[] (singular column, multi-select) — validated per-id at write
-- (package_visible_to, mig 238, in the captures PATCH) and RE-CHECKED at
-- injection time; the array is a pointer set, never an ACL.
--
-- (History note: first applied to DEV as chat_conversations.package_ids,
-- corrected to captures.package_ids the same day before any code read it.)
-- ============================================================================

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS package_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.captures.package_ids IS
  'Context packages attached to this capture via the + Packages chip. Validated per-id against package_visible_to (mig 238) at write and at injection; empty = no package context.';

ALTER TABLE public.chat_conversations
  DROP COLUMN IF EXISTS package_ids;
