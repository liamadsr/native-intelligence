-- ============================================================
-- 092: Auto-create CRM contact in handle_new_user trigger
-- ============================================================
-- When a new user signs up, the trigger creates their workspace
-- and member. Now it also creates a CRM contact record so they
-- appear in the Internal tab immediately.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_workspace_id UUID;
  new_member_id UUID;
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
  VALUES (NEW.id, new_workspace_id, 'owner', user_name)
  RETURNING id INTO new_member_id;

  -- create CRM contact for the new member
  INSERT INTO public.contact (
    workspace_id, member_id, email, full_name, first_name, last_name,
    avatar_url, relationship_type, relationship_strength, visibility, source
  ) VALUES (
    new_workspace_id,
    new_member_id,
    lower(NEW.email),
    user_name,
    split_part(user_name, ' ', 1),
    CASE
      WHEN position(' ' in user_name) > 0
      THEN substring(user_name from position(' ' in user_name) + 1)
      ELSE NULL
    END,
    NEW.raw_user_meta_data ->> 'avatar_url',
    'internal',
    'strong',
    'workspace',
    'member'
  );

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
