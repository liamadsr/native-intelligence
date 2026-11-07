-- Chat History
-- Persists AI chat conversations so users can browse and restore past chats
-- Safe to re-run: uses IF NOT EXISTS / DROP IF EXISTS throughout

-- 1. Chat Conversations — one record per conversation thread
CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own_conversations" ON chat_conversations;
CREATE POLICY "users_select_own_conversations" ON chat_conversations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_insert_own_conversations" ON chat_conversations;
CREATE POLICY "users_insert_own_conversations" ON chat_conversations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_update_own_conversations" ON chat_conversations;
CREATE POLICY "users_update_own_conversations" ON chat_conversations
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_delete_own_conversations" ON chat_conversations;
CREATE POLICY "users_delete_own_conversations" ON chat_conversations
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id, updated_at DESC);

-- 2. Chat Messages — individual messages within a conversation
-- Stores the full UIMessage object as JSONB to preserve tool calls, parts, etc.
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  ui_message JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own_chat_messages" ON chat_messages;
CREATE POLICY "users_select_own_chat_messages" ON chat_messages
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_insert_own_chat_messages" ON chat_messages;
CREATE POLICY "users_insert_own_chat_messages" ON chat_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at ASC);
