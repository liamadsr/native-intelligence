-- ============================================================
-- Migration 143: Workspace description
-- Adds an optional free-text description to workspaces, surfaced on the
-- "Manage Workspaces" page and editable from workspace settings.
-- ============================================================

ALTER TABLE public.workspace
  ADD COLUMN IF NOT EXISTS description TEXT;
