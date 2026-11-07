-- Email Campaigns — DB-driven email sequences replacing hardcoded DRIP_SEQUENCE
-- Each campaign has ordered steps, each step references an email_template by slug

CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'cron',  -- 'cron' or 'manual'
  is_active BOOLEAN DEFAULT true,
  audience_source TEXT NOT NULL DEFAULT 'early_access',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_slug ON email_campaigns (slug);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_active ON email_campaigns (is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS email_campaign_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  step_order INT NOT NULL DEFAULT 0,
  step_name TEXT NOT NULL DEFAULT 'Step 1',
  template_slug TEXT NOT NULL REFERENCES email_templates(slug),
  delay_days INT NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_campaign_steps_campaign ON email_campaign_steps (campaign_id, step_order);
CREATE INDEX IF NOT EXISTS idx_email_campaign_steps_template ON email_campaign_steps (template_slug);

-- Add campaign_id to existing log table
ALTER TABLE email_campaign_log
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES email_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_campaign_log_campaign ON email_campaign_log (campaign_id);

-- RLS: service_role only (consistent with email_campaign_log)
ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaign_steps ENABLE ROW LEVEL SECURITY;

-- Seed the two existing campaigns
INSERT INTO email_campaigns (title, slug, description, trigger_type, audience_source, is_active)
VALUES
  ('Early Access', 'early-access', 'Onboarding drip sequence for early access users', 'cron', 'early_access', true),
  ('Win-back', 'win-back', 'Re-engage lapsed users with trial extensions', 'manual', 'auth_users', true)
ON CONFLICT (slug) DO NOTHING;

-- Seed Early Access steps (only inserts if the templates exist)
INSERT INTO email_campaign_steps (campaign_id, step_order, step_name, template_slug, delay_days)
SELECT c.id, v.step_order, v.step_name, v.template_slug, v.delay_days
FROM email_campaigns c
CROSS JOIN (VALUES
  (0, 'Invite',           'invite',           0),
  (1, 'Getting Started',  'getting_started',  1),
  (2, 'Setup Tips',       'setup_tips',       3),
  (3, 'Feedback Request', 'feedback_request', 7),
  (4, 'Trial Ending',     'trial_ending',     14)
) AS v(step_order, step_name, template_slug, delay_days)
WHERE c.slug = 'early-access'
  AND EXISTS (SELECT 1 FROM email_templates WHERE slug = v.template_slug)
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_steps s
    WHERE s.campaign_id = c.id AND s.template_slug = v.template_slug
  );

-- Seed Win-back step
INSERT INTO email_campaign_steps (campaign_id, step_order, step_name, template_slug, delay_days)
SELECT c.id, 0, 'Trial Extended', 'trial_extended', 0
FROM email_campaigns c
WHERE c.slug = 'win-back'
  AND EXISTS (SELECT 1 FROM email_templates WHERE slug = 'trial_extended')
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_steps s
    WHERE s.campaign_id = c.id AND s.template_slug = 'trial_extended'
  );
