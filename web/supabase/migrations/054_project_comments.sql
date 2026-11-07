-- Migration 054: Add 'project' to commentable_type enum
-- Must be in its own transaction — new enum values must be committed
-- before they can be referenced in functions or policies (see 055).

ALTER TYPE public.commentable_type ADD VALUE IF NOT EXISTS 'project';
