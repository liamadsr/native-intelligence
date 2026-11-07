-- Migration 056: Add 'contact' to commentable_type enum
-- Must be committed before values can be used in functions/policies.

ALTER TYPE public.commentable_type ADD VALUE IF NOT EXISTS 'contact';
