-- Migration 016: Add team_id to actions and notes for team scoping
-- Depends on: 015_teams_team_members.sql (team table)

-- Add nullable team_id to actions
ALTER TABLE public.actions ADD COLUMN team_id UUID REFERENCES public.team(id) ON DELETE SET NULL;
CREATE INDEX actions_team_idx ON public.actions(team_id);

-- Add nullable team_id to notes
ALTER TABLE public.notes ADD COLUMN team_id UUID REFERENCES public.team(id) ON DELETE SET NULL;
CREATE INDEX notes_team_idx ON public.notes(team_id);
