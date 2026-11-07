-- Migration 154: persist the working directory a Claude Code chat session ran in.
--
-- The local `claude` CLI stores each conversation under a directory-scoped path
-- (~/.claude/projects/<slugified-cwd>/<session-id>.jsonl), so `claude --resume
-- <uuid>` only finds the conversation when it runs from the SAME cwd the session
-- was created in. Until now the chat's cwd (`activeClaudeCwd`) lived only in
-- ephemeral React state that reset to null on restart — so a resumed conversation
-- usually spawned in a different directory than it was created in, the CLI
-- reported "No conversation found", and the resume silently failed. Persisting the
-- cwd alongside claude_session_id (migration 150) lets a resume spawn in the right
-- directory so native --resume actually rehydrates the conversation.
--
-- Device-scoped like claude_session_id: the path is a local filesystem path on the
-- machine named by claude_session_device_id, meaningful only there. Null = the
-- session ran in the CLI's default (home) directory, or it's a cloud-API chat.

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS claude_cwd TEXT;

COMMENT ON COLUMN chat_conversations.claude_cwd IS
  'Working directory the local Claude Code session ran in, so --resume can spawn from the same cwd (the CLI session store is cwd-scoped). Local FS path on the device named by claude_session_device_id; null = default/home dir or cloud chat.';
