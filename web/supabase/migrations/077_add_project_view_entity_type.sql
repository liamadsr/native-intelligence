-- Add 'project' to view_entity_type enum
-- Fixes: "invalid input value for enum view_entity_type: project"

ALTER TYPE public.view_entity_type ADD VALUE IF NOT EXISTS 'project';
