-- Migration 019: Fix team scoping model
--
-- Current (wrong): teams are mini-workspaces — actions, notes, AND projects all have team_id
-- Target: teams own the execution layer only
--   - actions.team_id → NOT NULL (every action belongs to a team)
--   - notes.team_id   → nullable soft tag (not a visibility boundary)
--   - projects.team_id → REMOVED (projects are workspace-scoped, not team-scoped)

-- ============================================================
-- 1. Projects: remove team_id (projects are workspace-level)
-- ============================================================

-- Drop the index first, then the column
DROP INDEX IF EXISTS projects_team_idx;
ALTER TABLE public.projects DROP COLUMN IF EXISTS team_id;

-- ============================================================
-- 2. Actions: make team_id NOT NULL
-- ============================================================

-- Backfill: assign any actions with NULL team_id to the workspace's
-- oldest team (the auto-created "General" team).
UPDATE public.actions a
SET team_id = (
  SELECT t.id
  FROM public.team t
  WHERE t.workspace_id = a.workspace_id
  ORDER BY t.created_at ASC
  LIMIT 1
)
WHERE a.team_id IS NULL;

-- Now make the column NOT NULL
ALTER TABLE public.actions ALTER COLUMN team_id SET NOT NULL;
