-- Migration 176: add an UPDATE RLS policy to chat_messages.
-- Plan: docs/live-agent-chat-merge/PLAN.md — fixes review findings #1/#4/#5/#8.
--
-- chat_messages (migration 012) shipped with only SELECT + INSERT policies —
-- chat history was append-only, so no row was ever updated in place. The
-- live-agent → chat merge introduced three update-in-place paths, all of which
-- run under an RLS-scoped client (the browser cookie session, or the JWT the
-- live-agent/stage routes authenticate with — NOT service-role, since every
-- merge caller sends a Supabase access token, not a device token):
--
--   1. syncProposalsCard — the rolling "proposals from this meeting" card grows
--      by `INSERT ... ON CONFLICT DO UPDATE`. Postgres validates the DO-UPDATE
--      arm against a permissive UPDATE policy; with none, every turn after the
--      first was rejected (SQLSTATE 42501) and the card froze at its first
--      snapshot.
--   2. the ask_user answer flip (PATCH /chat-history/[id]/messages/answer) —
--      a plain UPDATE that, with no UPDATE policy, matched 0 rows and silently
--      no-op'd, so the DB question stayed input-available → the one-pending
--      guard tripped permanently and the agent could never ask again.
--   3. updateAgentMessage — same 0-row silent no-op.
--
-- chat_conversations already has an analogous FOR UPDATE policy (012:24-26);
-- this closes the asymmetry. Owner-scoped (auth.uid() = user_id) preserves the
-- D6 boundary: a member still cannot update another user's messages. The
-- WITH CHECK arm is REQUIRED here (the conversations policy omits it) because
-- the ON CONFLICT DO UPDATE arm validates the post-update row against WITH CHECK.
--
-- Safe to re-run.

DROP POLICY IF EXISTS "users_update_own_chat_messages" ON chat_messages;
CREATE POLICY "users_update_own_chat_messages" ON chat_messages
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
