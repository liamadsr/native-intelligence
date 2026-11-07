-- Migration 040: Email Message Storage
-- Stores full email message bodies, attachments metadata, and sync state
-- Evolves from metadata-only index to a full local mirror of the user's email

-- ============================================
-- 1. Create email_message table
-- ============================================
CREATE TABLE public.email_message (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  -- Provider references
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_message_id text NOT NULL,
  provider_thread_id text NOT NULL,

  -- FK to our thread index
  email_thread_id uuid REFERENCES public.email_thread_index (id) ON DELETE CASCADE,

  -- Headers
  subject text,
  from_name text,
  from_email text NOT NULL,
  to_recipients jsonb DEFAULT '[]',
  cc_recipients jsonb DEFAULT '[]',
  bcc_recipients jsonb DEFAULT '[]',
  reply_to text,
  in_reply_to text,
  references_header text,

  -- Body content
  body_html text,
  body_text text,
  snippet text,

  -- Full-text search
  search_vector tsvector,

  -- Message metadata
  message_date timestamptz NOT NULL,
  is_unread boolean DEFAULT false,
  is_starred boolean DEFAULT false,
  is_draft boolean DEFAULT false,
  has_attachments boolean DEFAULT false,

  -- Gmail-specific
  gmail_label_ids text[] DEFAULT '{}',
  gmail_internal_date bigint,

  -- Microsoft-specific
  outlook_folder_id text,
  outlook_categories text[] DEFAULT '{}',

  -- Sync metadata
  raw_size_bytes int,
  synced_at timestamptz DEFAULT now(),

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  -- Unique constraint: one message per user per provider message ID
  UNIQUE (user_id, provider_message_id)
);

-- Performance indexes
CREATE INDEX email_message_thread_idx
  ON public.email_message (user_id, provider_thread_id, message_date ASC);

CREATE INDEX email_message_date_idx
  ON public.email_message (user_id, message_date DESC);

CREATE INDEX email_message_email_thread_idx
  ON public.email_message (email_thread_id, message_date ASC)
  WHERE email_thread_id IS NOT NULL;

-- Full-text search index
CREATE INDEX email_message_search_idx
  ON public.email_message USING gin (search_vector);

-- RLS
ALTER TABLE public.email_message ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own messages"
  ON public.email_message FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage messages"
  ON public.email_message FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================
-- 2. Auto-generate search_vector on insert/update
-- ============================================
CREATE OR REPLACE FUNCTION email_message_search_vector_trigger()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.from_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.from_email, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.body_text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.snippet, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_message_search_vector_update
  BEFORE INSERT OR UPDATE OF subject, from_name, from_email, body_text, snippet
  ON public.email_message
  FOR EACH ROW
  EXECUTE FUNCTION email_message_search_vector_trigger();


-- ============================================
-- 3. Create email_attachment table
-- ============================================
CREATE TABLE public.email_attachment (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email_message_id uuid NOT NULL REFERENCES public.email_message (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  -- Provider references (for fetching content on demand)
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_attachment_id text NOT NULL,
  provider_message_id text NOT NULL,

  -- Metadata
  filename text NOT NULL,
  mime_type text,
  size_bytes int,
  content_id text,
  is_inline boolean DEFAULT false,

  -- Optional: cached in Supabase Storage
  storage_path text,
  cached_at timestamptz,

  created_at timestamptz DEFAULT now(),

  -- Unique constraint for upsert
  UNIQUE (email_message_id, provider_attachment_id)
);

CREATE INDEX email_attachment_message_idx
  ON public.email_attachment (email_message_id);

ALTER TABLE public.email_attachment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own attachments"
  ON public.email_attachment FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage attachments"
  ON public.email_attachment FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================
-- 4. Create email_sync_state table
-- ============================================
CREATE TABLE public.email_sync_state (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,

  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),

  -- Gmail sync state
  gmail_history_id text,
  gmail_watch_expiration timestamptz,
  gmail_watch_resource_id text,

  -- Microsoft sync state
  ms_delta_link text,
  ms_subscription_id text,
  ms_subscription_expiration timestamptz,

  -- Import progress
  initial_import_status text DEFAULT 'pending'
    CHECK (initial_import_status IN ('pending', 'importing_recent', 'backfilling', 'complete', 'failed')),
  initial_import_started_at timestamptz,
  initial_import_completed_at timestamptz,
  oldest_message_synced_at timestamptz,
  total_messages_synced int DEFAULT 0,

  -- Sync timing
  last_sync_at timestamptz,
  last_sync_messages_added int DEFAULT 0,
  last_sync_messages_modified int DEFAULT 0,
  last_sync_error text,
  next_sync_at timestamptz,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE (user_id, provider)
);

ALTER TABLE public.email_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own sync state"
  ON public.email_sync_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage sync state"
  ON public.email_sync_state FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================
-- 5. Add body_stored flag to email_thread_index
-- ============================================
ALTER TABLE public.email_thread_index
  ADD COLUMN IF NOT EXISTS messages_stored boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS message_count_stored int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_size_bytes int DEFAULT 0;


-- ============================================
-- 6. Full-text search function for emails
-- ============================================
CREATE OR REPLACE FUNCTION search_email_messages(
  p_user_id uuid,
  p_query text,
  p_folder text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  message_id uuid,
  thread_id text,
  subject text,
  from_name text,
  from_email text,
  snippet text,
  message_date timestamptz,
  rank real,
  headline text
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id AS message_id,
    em.provider_thread_id AS thread_id,
    em.subject,
    em.from_name,
    em.from_email,
    em.snippet,
    em.message_date,
    ts_rank(em.search_vector, websearch_to_tsquery('english', p_query)) AS rank,
    ts_headline('english', coalesce(em.body_text, em.snippet, ''),
      websearch_to_tsquery('english', p_query),
      'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
    ) AS headline
  FROM public.email_message em
  LEFT JOIN public.email_thread_index eti ON em.email_thread_id = eti.id
  WHERE em.user_id = p_user_id
    AND em.search_vector @@ websearch_to_tsquery('english', p_query)
    AND (p_folder IS NULL OR eti.folder = p_folder)
  ORDER BY rank DESC, em.message_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================
-- 7. Updated_at trigger for email_sync_state
-- ============================================
CREATE OR REPLACE FUNCTION public.update_email_sync_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_email_sync_state_updated_at
  BEFORE UPDATE ON public.email_sync_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_email_sync_state_updated_at();

CREATE OR REPLACE FUNCTION public.update_email_message_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_email_message_updated_at
  BEFORE UPDATE ON public.email_message
  FOR EACH ROW
  EXECUTE FUNCTION public.update_email_message_updated_at();
