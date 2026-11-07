-- In-App Messaging System
-- Enables two-way communication between admin console and macOS app users
-- Safe to re-run: uses IF NOT EXISTS / DROP IF EXISTS throughout

-- 1. Message Campaigns — reusable templates with scheduling rules
CREATE TABLE IF NOT EXISTS message_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message_title TEXT NOT NULL,
  message_body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'feedback_prompt',
  cta_text TEXT DEFAULT 'Share Feedback',
  cta_action TEXT DEFAULT 'respond',
  cta_url TEXT,
  schedule_trigger TEXT,
  priority TEXT DEFAULT 'normal',
  is_active BOOLEAN DEFAULT true,
  expires_after_days INT DEFAULT 7,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. In-App Messages — individual message instances delivered to users
CREATE TABLE IF NOT EXISTS in_app_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES message_campaigns(id) ON DELETE SET NULL,
  message_title TEXT NOT NULL,
  message_body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'feedback_prompt',
  cta_text TEXT DEFAULT 'Share Feedback',
  cta_action TEXT DEFAULT 'respond',
  cta_url TEXT,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_by TEXT
);

ALTER TABLE in_app_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_messages" ON in_app_messages;
CREATE POLICY "users_read_own_messages" ON in_app_messages
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_update_own_messages" ON in_app_messages;
CREATE POLICY "users_update_own_messages" ON in_app_messages
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_insert_own_messages" ON in_app_messages;
CREATE POLICY "users_insert_own_messages" ON in_app_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Realtime (safe to re-run — will no-op if already added)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'in_app_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE in_app_messages;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_app_messages_user_status ON in_app_messages(user_id, status);
CREATE INDEX IF NOT EXISTS idx_in_app_messages_campaign ON in_app_messages(campaign_id);

-- 3. Message Responses — user feedback
CREATE TABLE IF NOT EXISTS message_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES in_app_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating INT,
  response_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE message_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_insert_own_responses" ON message_responses;
CREATE POLICY "users_insert_own_responses" ON message_responses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_read_own_responses" ON message_responses;
CREATE POLICY "users_read_own_responses" ON message_responses
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_message_responses_message ON message_responses(message_id);
