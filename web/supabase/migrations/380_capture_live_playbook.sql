-- ============================================================
-- 380: the call playbook the live copilot loaded for a capture
-- (src/lib/live-agent/call-playbooks.ts).
-- ============================================================
-- Every live turn is a fresh, stateless eve session, so a playbook the
-- copilot loads with load_skill on one turn is gone on the next unless it is
-- written down. load_skill writes its name here; every later copilot turn
-- reads it and carries that playbook's body inline for the rest of the call.
--
-- The name of a built-in playbook ('investor-pitch', 'sales-call',
-- 'discovery') or of a workspace skill marked agent_config.live_playbook.
-- NULL means none loaded: the turn picks one from the goal and prep, or
-- lists the cards. Nothing reads it outside the live agent.
--
-- Rollout: DEV, then PROD, before or after the app PR (the app fails open
-- both ways: a missing column reads as none loaded and a failed write keeps
-- the playbook for that turn only). Nullable, no default, no backfill: a
-- metadata-only change, instant. Idempotent. No backslash anywhere in this
-- file (the MCP apply tool decodes them).

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS live_playbook text;

COMMENT ON COLUMN public.captures.live_playbook IS
  'The call playbook the live copilot loaded for this capture (load_skill). NULL: none loaded.';
