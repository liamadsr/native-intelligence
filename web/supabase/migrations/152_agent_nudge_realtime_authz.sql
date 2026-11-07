-- Migration 152: authorize the live-agent "talk back" Realtime broadcast channel.
--
-- The say_to_user tool broadcasts ephemeral nudges over a Realtime BROADCAST
-- channel named `agent-nudge:<captureId>` (no DB row — see
-- src/lib/live-agent/nudge-channel.ts). The producer is a service-role client;
-- the consumer is the main app window (use-agent-nudge-relay.ts), which now
-- subscribes with `private: true`.
--
-- A PRIVATE Realtime channel gates subscription via RLS on realtime.messages.
-- Without this policy the channel was effectively public: the topic name (a
-- capture UUID — visible in URLs, other channel names, logs) was the only
-- secret, so any client holding the anon key could (a) eavesdrop on another
-- meeting's nudges, or (b) inject spoofed nudges that render in the victim's HUD
-- as if the AI agent said them. This policy closes both: only an authenticated
-- user who is a MEMBER of the capture's workspace may read (subscribe to) the
-- channel.
--
-- Scope:
--   * SELECT only (the subscribe/receive path). The producer publishes with the
--     service-role client, which BYPASSES RLS, so we intentionally do NOT grant
--     INSERT to `authenticated` — that's what prevents a malicious client from
--     spoofing nudges into the channel.
--   * Topic shape is `agent-nudge:<captureId>`. realtime.topic() returns the full
--     topic string; the captureId is the part after the single ':'. We guard the
--     prefix so this policy never widens access to any other private channel.

-- realtime.messages already has RLS enabled by the Realtime extension; we only
-- add our policy. (CREATE POLICY is idempotent-guarded via DROP IF EXISTS.)
DROP POLICY IF EXISTS "agent_nudge_workspace_members_can_subscribe" ON realtime.messages;

CREATE POLICY "agent_nudge_workspace_members_can_subscribe"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  -- Only applies to our channel; other private topics are unaffected by this policy.
  realtime.topic() LIKE 'agent-nudge:%'
  AND EXISTS (
    SELECT 1
    FROM public.captures c
    JOIN public.member m
      ON m.workspace_id = c.workspace_id
     AND m.user_id = auth.uid()
    -- captureId is everything after the single ':' in `agent-nudge:<uuid>`.
    WHERE c.id = NULLIF(split_part(realtime.topic(), ':', 2), '')::uuid
  )
);
