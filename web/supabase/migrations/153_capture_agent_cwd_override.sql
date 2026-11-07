-- Migration 153: persist the live agent's manually-chosen working directory.
--
-- The capture panel's "+ choose folder" control lets the user grant the local
-- Claude Code live agent read access to a specific folder (e.g. a docs/wiki repo)
-- so it can research the codebase to ground its proposals. Until now that path
-- lived ONLY in ephemeral React state (`agentCwdOverride` in
-- src/hooks/recording-context.tsx): it was never persisted, was reset to null on
-- every capture/panel switch, and was never restored on resume — so after a
-- resume (and always after an app reload / crash recovery) the agent silently
-- "forgot" the folder the user had granted it.
--
-- This column persists the manual override per capture so resume can restore it.
-- It is the MANUAL override only — the auto-inherited project path continues to
-- resolve from projects.project_local_path (per-user, per-machine) and is NOT
-- stored here. Null means "no manual override" (fall back to the project path or
-- no filesystem access), exactly as before.
--
-- Note: the path is a local filesystem path on the user's own machine and is only
-- ever consumed client-side (the desktop Tauri app spawns the CLI with it). It is
-- covered by the existing captures RLS (workspace-scoped), needs no new policy,
-- and is nullable with no default so existing rows are unaffected.

ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS agent_cwd_override text;

COMMENT ON COLUMN captures.agent_cwd_override IS
  'Manual "+ choose folder" override for the local live agent''s working directory (a local FS path on the user''s machine). Null = no override (use the project''s linked path or no FS access). Consumed client-side only.';
