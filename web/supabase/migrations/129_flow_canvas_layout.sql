-- 129_flow_canvas_layout.sql
--
-- Adds a `canvas_layout` jsonb column to the flow table so the Flows canvas
-- editor can persist node positions across sessions/devices. This is pure UI
-- presentation data — separate from trigger_config/action_config — so it has
-- no effect on flow matching or the runner.
--
-- Shape (all keys optional; the editor falls back to the default layout):
--   { "trigger": { "x": <number>, "y": <number> },
--     "action":  { "x": <number>, "y": <number> } }
--
-- Idempotent: safe to re-run.

ALTER TABLE flow
  ADD COLUMN IF NOT EXISTS canvas_layout jsonb NOT NULL DEFAULT '{}'::jsonb;
