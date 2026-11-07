-- Add campaign tracking columns to early_access
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'waitlisted';
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS last_email_step TEXT;
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS last_email_sent_at TIMESTAMPTZ;
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS unsubscribed BOOLEAN DEFAULT false;
ALTER TABLE early_access ADD COLUMN IF NOT EXISTS feedback JSONB DEFAULT '{}';

-- Index for querying by status (drip campaign queries)
CREATE INDEX IF NOT EXISTS early_access_status_idx ON early_access (status);
CREATE INDEX IF NOT EXISTS early_access_unsubscribed_idx ON early_access (unsubscribed) WHERE unsubscribed = false;

-- Email campaign log for tracking individual sends
CREATE TABLE IF NOT EXISTS email_campaign_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  early_access_id UUID REFERENCES early_access(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  campaign_step TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  resend_id TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS email_campaign_log_email_idx ON email_campaign_log (email);
CREATE INDEX IF NOT EXISTS email_campaign_log_step_idx ON email_campaign_log (campaign_step);

-- RLS: only service_role can access campaign log
ALTER TABLE email_campaign_log ENABLE ROW LEVEL SECURITY;

-- No public policies = only service_role (bypasses RLS) can read/write
