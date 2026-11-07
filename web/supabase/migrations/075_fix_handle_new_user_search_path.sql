-- Migration 075: Fix handle_new_user trigger search_path
-- The supabase_auth_admin role has search_path=auth, so the unqualified
-- "early_access" table reference fails with "relation does not exist".
-- Fix: fully qualify the table name AND pin the function's search_path.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_workspace_id UUID;
  user_name TEXT;
BEGIN
  -- derive display name from email or metadata
  user_name := coalesce(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    split_part(NEW.email, '@', 1)
  );

  -- create default workspace
  INSERT INTO public.workspace (name, slug)
  VALUES (
    user_name || '''s Workspace',
    lower(replace(user_name, ' ', '-')) || '-' || substr(NEW.id::text, 1, 8)
  )
  RETURNING id INTO new_workspace_id;

  -- create owner member record
  INSERT INTO public.member (user_id, workspace_id, role, display_name)
  VALUES (NEW.id, new_workspace_id, 'owner', user_name);

  -- preserve early_access conversion tracking
  UPDATE public.early_access
  SET
    user_id = NEW.id,
    converted_at = now(),
    status = 'signed_up'
  WHERE email = lower(trim(NEW.email))
    AND user_id IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;
