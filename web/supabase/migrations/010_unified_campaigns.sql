-- Unified Campaigns — merge email_campaigns + message_campaigns into one table
-- Merge email_campaign_steps into campaign_steps
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT throughout

-- ============================================================
-- STEP 1: Rename message_campaigns → campaigns
-- ============================================================
-- PostgreSQL automatically updates all FK references when renaming a table
ALTER TABLE IF EXISTS message_campaigns RENAME TO campaigns;

-- Add columns from email_campaigns that don't exist on the old message_campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_source TEXT NOT NULL DEFAULT 'auth_users';

-- Add unique constraint on slug (some rows may be NULL until we backfill)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_slug_key'
  ) THEN
    -- Backfill slugs for existing messaging campaigns that lack one
    UPDATE campaigns
    SET slug = lower(regexp_replace(title, '[^a-z0-9]+', '-', 'gi'))
    WHERE slug IS NULL;

    -- Handle duplicate slugs by appending a short UUID fragment
    UPDATE campaigns c
    SET slug = c.slug || '-' || substring(c.id::text, 1, 8)
    WHERE c.slug IN (
      SELECT slug FROM campaigns GROUP BY slug HAVING count(*) > 1
    );

    ALTER TABLE campaigns ADD CONSTRAINT campaigns_slug_key UNIQUE (slug);
  END IF;
END $$;

-- ============================================================
-- STEP 2: Migrate email_campaigns data into campaigns
-- ============================================================
-- First, deduplicate email_campaigns slugs that collide with existing campaigns slugs
-- by appending a short UUID fragment to the email_campaigns side
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_campaigns') THEN
    UPDATE email_campaigns ec
    SET slug = ec.slug || '-' || substring(ec.id::text, 1, 8)
    WHERE ec.slug IN (SELECT slug FROM campaigns);
  END IF;
END $$;

INSERT INTO campaigns (id, title, slug, description, trigger_type, audience_source, is_active, created_by, created_at, updated_at,
  -- messaging-specific columns get defaults
  message_title, message_body, message_type, priority)
SELECT
  ec.id, ec.title, ec.slug, ec.description, ec.trigger_type, ec.audience_source, ec.is_active, ec.created_by, ec.created_at, ec.updated_at,
  '', '', 'announcement', 'normal'
FROM email_campaigns ec
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_campaigns')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- STEP 3: Extend campaign_steps with email-specific columns
-- ============================================================
ALTER TABLE campaign_steps ADD COLUMN IF NOT EXISTS template_slug TEXT REFERENCES email_templates(slug);
ALTER TABLE campaign_steps ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Make message_title and message_body nullable (email-only steps won't have them)
ALTER TABLE campaign_steps ALTER COLUMN message_title DROP NOT NULL;
ALTER TABLE campaign_steps ALTER COLUMN message_body DROP NOT NULL;

-- ============================================================
-- STEP 4: Migrate email_campaign_steps into campaign_steps
-- ============================================================
INSERT INTO campaign_steps (id, campaign_id, step_order, step_name, delay_days, delivery_channel, template_slug, is_active, created_at, updated_at,
  -- in-app fields are nullable for email-only steps
  message_title, message_body, message_type)
SELECT
  ecs.id, ecs.campaign_id, ecs.step_order, ecs.step_name, ecs.delay_days, 'email', ecs.template_slug, ecs.is_active, ecs.created_at, ecs.updated_at,
  NULL, NULL, 'announcement'
FROM email_campaign_steps ecs
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_campaign_steps')
ON CONFLICT (id) DO NOTHING;

-- Ensure delivery_channel is 'email' for migrated steps that have template_slug but no message content
UPDATE campaign_steps
SET delivery_channel = 'email'
WHERE template_slug IS NOT NULL AND (message_title IS NULL OR message_title = '');

-- ============================================================
-- STEP 5: Update email_campaign_log FK to point to campaigns
-- ============================================================
ALTER TABLE email_campaign_log DROP CONSTRAINT IF EXISTS email_campaign_log_campaign_id_fkey;
ALTER TABLE email_campaign_log ADD CONSTRAINT email_campaign_log_campaign_id_fkey
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

-- ============================================================
-- STEP 6: Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns (slug);
CREATE INDEX IF NOT EXISTS idx_campaigns_active ON campaigns (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_campaign_steps_template ON campaign_steps (template_slug);

-- ============================================================
-- STEP 7: Drop old tables (now redundant)
-- ============================================================
DROP TABLE IF EXISTS email_campaign_steps;
DROP TABLE IF EXISTS email_campaigns;
