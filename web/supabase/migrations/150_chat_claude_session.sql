-- 150_chat_claude_session.sql
--
-- Persist the local Claude Code CLI session id (and the device that minted it)
-- per conversation, so loading an old Claude Code chat on the SAME device can
-- `--resume` the original local CLI session and recover the model's full
-- context — not just the rendered transcript.
--
-- Why a device id too: the CLI session uuid only exists on the machine that
-- created it (the transcript lives in ~/.claude on that device). Resuming a
-- uuid that isn't present locally fails HARD at spawn ("No conversation found
-- with session ID …"). So we record which device minted it; the client only
-- attempts `--resume` when the stored device id matches the current one, and
-- otherwise starts a fresh session seeded by the reloaded message history.
--
-- Both columns are nullable: cloud-API conversations never set them, and a
-- Claude Code conversation only gets them once its first turn mints a session.

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS claude_session_id TEXT,
  ADD COLUMN IF NOT EXISTS claude_session_device_id TEXT;

COMMENT ON COLUMN chat_conversations.claude_session_id IS
  'Local Claude Code CLI session uuid for --resume. Device-local; only valid on the device named by claude_session_device_id. Null for cloud-API chats.';
COMMENT ON COLUMN chat_conversations.claude_session_device_id IS
  'Opaque per-device id (client-generated) of the machine that minted claude_session_id. Resume is only attempted when this matches the current device.';
