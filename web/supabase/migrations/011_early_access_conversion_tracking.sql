-- Track when early access users convert to actual signups
-- Adds user_id + converted_at columns and a trigger on auth.users INSERT

-- ============================================================
-- STEP 1: Add conversion columns to early_access
-- ============================================================
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

-- Index for lookups and dashboard queries
CREATE INDEX IF NOT EXISTS early_access_user_id_idx ON early_access (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS early_access_converted_at_idx ON early_access (converted_at) WHERE converted_at IS NOT NULL;

-- ============================================================
-- STEP 2: Trigger function — on new auth.users row, check if
-- the email exists in early_access and link them
-- ============================================================
CREATE OR REPLACE FUNCTION link_early_access_on_signup()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE early_access
  SET
    user_id = NEW.id,
    converted_at = NOW(),
    status = 'signed_up'
  WHERE email = lower(trim(NEW.email))
    AND user_id IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- STEP 3: Create trigger on auth.users
-- ============================================================
DROP TRIGGER IF EXISTS trg_link_early_access ON auth.users;
CREATE TRIGGER trg_link_early_access
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION link_early_access_on_signup();

-- ============================================================
-- STEP 4: Backfill existing users who already signed up
-- ============================================================
UPDATE early_access ea
SET
  user_id = au.id,
  converted_at = au.created_at,
  status = 'signed_up'
FROM auth.users au
WHERE lower(trim(au.email)) = ea.email
  AND ea.user_id IS NULL;
