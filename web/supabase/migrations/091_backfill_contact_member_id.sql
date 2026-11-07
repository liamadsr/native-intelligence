-- ============================================================
-- 091: Ensure every workspace member has a CRM contact record
-- ============================================================
-- 1. Extend the source check constraint to allow 'member'.
-- 2. Link existing contacts to members where emails match.
-- 3. Create contact records for members who don't have one yet.
-- This enables the Internal / External scope toggle on CRM.
-- ============================================================

-- Step 0: Add 'member' as a valid contact source
ALTER TABLE public.contact DROP CONSTRAINT IF EXISTS contact_source_check;
ALTER TABLE public.contact ADD CONSTRAINT contact_source_check
  CHECK (source IN ('manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'member'));

-- Step 1: Link existing contacts to their workspace member
UPDATE public.contact c
SET member_id = m.id,
    relationship_type = 'internal',
    visibility = 'workspace'
FROM public.member m
JOIN auth.users u ON u.id = m.user_id
WHERE c.workspace_id = m.workspace_id
  AND c.email IS NOT NULL
  AND lower(c.email) = lower(u.email)
  AND c.member_id IS NULL;

-- Step 2: Create contact records for members who have no contact yet
INSERT INTO public.contact (
  workspace_id, member_id, email, full_name, first_name, last_name,
  avatar_url, relationship_type, relationship_strength, visibility, source
)
SELECT
  m.workspace_id,
  m.id,
  lower(u.email),
  COALESCE(m.display_name, split_part(u.email, '@', 1)),
  split_part(COALESCE(m.display_name, ''), ' ', 1),
  CASE
    WHEN position(' ' in COALESCE(m.display_name, '')) > 0
    THEN substring(m.display_name from position(' ' in m.display_name) + 1)
    ELSE NULL
  END,
  m.avatar_url,
  'internal',
  'strong',
  'workspace',
  'member'
FROM public.member m
JOIN auth.users u ON u.id = m.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.contact c
  WHERE c.workspace_id = m.workspace_id
    AND c.member_id = m.id
)
AND NOT EXISTS (
  SELECT 1 FROM public.contact c
  WHERE c.workspace_id = m.workspace_id
    AND c.email IS NOT NULL
    AND lower(c.email) = lower(u.email)
);
