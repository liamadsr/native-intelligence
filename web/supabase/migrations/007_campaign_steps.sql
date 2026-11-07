-- Campaign Steps — multi-step message sequences within a campaign
-- Each campaign can have multiple steps with different timing, content, and delivery channels
-- Safe to re-run: uses IF NOT EXISTS

-- 1. Campaign steps table
CREATE TABLE IF NOT EXISTS campaign_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
  step_order INT NOT NULL DEFAULT 0,
  step_name TEXT NOT NULL DEFAULT 'Step 1',
  message_title TEXT NOT NULL,
  message_body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'announcement',
  cta_text TEXT,
  cta_action TEXT DEFAULT 'dismiss',
  cta_url TEXT,
  priority TEXT DEFAULT 'normal',
  delay_days INT NOT NULL DEFAULT 0,
  delivery_channel TEXT NOT NULL DEFAULT 'in_app',
  expires_after_days INT DEFAULT 7,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_steps_campaign ON campaign_steps(campaign_id, step_order);

-- 2. Add delivery_channel + target_audience to message_campaigns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message_campaigns' AND column_name = 'delivery_channel'
  ) THEN
    ALTER TABLE message_campaigns ADD COLUMN delivery_channel TEXT DEFAULT 'in_app';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message_campaigns' AND column_name = 'target_audience'
  ) THEN
    ALTER TABLE message_campaigns ADD COLUMN target_audience JSONB DEFAULT '{"mode": "all"}'::jsonb;
  END IF;
END $$;

-- 3. Add step_id to in_app_messages for tracking which step generated the message
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'in_app_messages' AND column_name = 'step_id'
  ) THEN
    ALTER TABLE in_app_messages ADD COLUMN step_id UUID REFERENCES campaign_steps(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_app_messages_step ON in_app_messages(step_id);
