-- Migration 190: chat_conversations.eve_session_id — ownership record for the
-- root `dial8` agent's chat sessions (Phase 4, eve durable main chat).
--
-- WHY (session-ownership ACL): the root agent's eve channel authenticates the
-- caller but must also verify the caller OWNS the eve `sessionId` on
-- continue/stream routes (GET/POST /eve/agents/dial8/eve/v1/session/:id[/stream]).
-- Phase 4 is the first production UI to drive root-agent sessions, so this is a
-- hard prerequisite. A chat eve session is created for a (user, workspace,
-- conversation) triple; the conversation is the natural owner. This column
-- records {eve_session_id -> the owning chat_conversations row}, whose user_id
-- (mig 012) + workspace_id (mig 014) are BOTH the verified owner. The
-- EveChatTransport claims ownership by writing eve_session_id onto its
-- conversation the instant eve mints the session id, BEFORE any continue/stream
-- request targets it — so the ACL can fail CLOSED on any id it can't resolve to
-- an owner (mirrors the onboarding-researcher's research.sessionId registry).
--
-- Nullable: cloud-route and Claude-CLI conversations never mint an eve session,
-- and an eve conversation only gets an id once its first turn creates the
-- session. A UNIQUE index (NULLs distinct in Postgres) pins one owner per eve
-- session without touching the many null rows, and lets the ownership lookup be
-- a single indexed probe.
--
-- Safe to re-run: IF NOT EXISTS throughout.

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS eve_session_id TEXT;

COMMENT ON COLUMN chat_conversations.eve_session_id IS
  'eve durable session id for the root dial8 agent that backs this chat. Written by the EveChatTransport the instant eve mints it; the root agent''s session-ownership ACL resolves {eve_session_id -> conversation.user_id + workspace_id} to authorize continue/stream. Null for cloud-route / Claude-CLI conversations.';

-- One owner per eve session. Non-partial UNIQUE (Postgres treats NULLs as
-- distinct) so the many null rows are unaffected while any non-null id is
-- unique — and the ACL's owner lookup is an indexed single-row probe.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_chat_conversations_eve_session
  ON chat_conversations (eve_session_id);
