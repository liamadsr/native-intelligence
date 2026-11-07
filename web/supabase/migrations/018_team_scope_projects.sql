-- Migration 018: Add team_id to projects for team scoping
-- Projects (folders) should be scoped to teams just like actions and notes

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES public.team(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS projects_team_idx ON public.projects(team_id);
