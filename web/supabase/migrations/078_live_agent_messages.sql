-- Store the live agent conversation messages on the capture.
-- This keeps the persistent conversation server-side (no sensitive data on the client).
-- Reset to NULL when a new capture starts or the session is cleared.

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS live_agent_messages JSONB DEFAULT NULL;

COMMENT ON COLUMN public.captures.live_agent_messages IS
  'Persistent conversation messages for the live agent session (AI SDK ModelMessage[])';
