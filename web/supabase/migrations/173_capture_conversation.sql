-- Migration 173: capture-scoped chat conversations (live-agent → chat merge, Phase 1).
-- Plan: docs/live-agent-chat-merge/PLAN.md (WS-1a).
--
-- Gives each live capture ONE chat conversation the meeting agent writes into
-- (greeting, say_to_user, proposal batches, questions) as server-inserted
-- assistant messages, delivered to the open panel via Realtime postgres_changes.
--
-- 1. chat_conversations.capture_id — the capture this conversation belongs to.
--    Plain (non-partial) UNIQUE index: Postgres treats NULLs as distinct, so
--    every normal conversation (capture_id NULL) is unaffected, while non-null
--    capture ids are unique. Non-partial on purpose — PostgREST's
--    `on_conflict=capture_id` upsert cannot target a partial index, and the
--    get-or-create endpoint relies on ON CONFLICT DO NOTHING so concurrent
--    creates (strict-mode double effects / first live turn racing the recording
--    client) converge on one row instead of 23505-ing.
-- 2. chat_conversations.recipe_id — the meeting persona (persona continuity:
--    the same agent that greets the user also answers their talk-back turns).
-- 3. chat_messages.ui_message_id — STORED generated column mirroring
--    ui_message->>'id' (immutable jsonb extraction), so writers can upsert via
--    PostgREST `on_conflict=conversation_id,ui_message_id` — the DB-level guard
--    against the double-persist class (autosave re-inserting Realtime-injected
--    rows). An expression index alone wouldn't be targetable by PostgREST.
-- 4. chat_messages into the supabase_realtime publication. RLS SELECT on
--    chat_messages is auth.uid() = user_id (migration 012), so postgres_changes
--    deliver ONLY to the conversation owner — the v1 audience decision (plan
--    D6): team members on a team-scoped capture do NOT receive the thread.
--
-- Safe to re-run: IF NOT EXISTS / exception guards throughout.

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS capture_id UUID REFERENCES captures(id) ON DELETE SET NULL;
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS recipe_id UUID REFERENCES recipe(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_chat_conversations_capture
  ON chat_conversations (capture_id);

-- Message identity: a STORED generated column (immutable expression) that
-- PostgREST upserts can target. Backfills existing rows on ADD COLUMN.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS ui_message_id TEXT
  GENERATED ALWAYS AS (ui_message->>'id') STORED;

-- Duplicate ui_message ids can exist from the historical positional-autosave
-- path (a remount race could re-PATCH the same slice). Keep the OLDEST row of
-- each (conversation_id, message id) pair — it's the one the original save
-- wrote; later copies are re-inserts of identical content — then pin uniqueness.
DELETE FROM chat_messages a
USING chat_messages b
WHERE a.conversation_id = b.conversation_id
  AND a.ui_message_id = b.ui_message_id
  AND a.ui_message_id IS NOT NULL
  AND (a.created_at > b.created_at
       OR (a.created_at = b.created_at AND a.id > b.id));

CREATE UNIQUE INDEX IF NOT EXISTS uidx_chat_messages_convo_msg
  ON chat_messages (conversation_id, ui_message_id);

-- Realtime: INSERT + UPDATE events for the live conversation's messages.
-- REPLICA IDENTITY FULL so UPDATE events (the rolling proposals message, the
-- ask_user answer flip) carry the columns the client filters on, matching the
-- attention_item precedent (migration 167).
ALTER TABLE chat_messages REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
EXCEPTION
  -- Already a member of the publication — nothing to do (idempotent re-run).
  WHEN duplicate_object THEN NULL;
END $$;
