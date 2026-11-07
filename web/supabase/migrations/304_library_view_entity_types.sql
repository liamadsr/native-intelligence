-- Agents and skills use the existing saved-view table and its RLS policies.
-- Only the view enum changes; library data and permissions stay unchanged.
ALTER TYPE public.view_entity_type ADD VALUE IF NOT EXISTS 'agent';
ALTER TYPE public.view_entity_type ADD VALUE IF NOT EXISTS 'skill';
