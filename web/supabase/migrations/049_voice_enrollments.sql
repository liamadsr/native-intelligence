-- ============================================================
-- 049: Voice Enrollments for Speaker Identification
-- Stores speaker embedding vectors linked to CRM contacts.
-- Uses pgvector (already enabled) for cosine similarity search.
-- A contact can have multiple enrollment records; matching
-- averages all enrollments per contact for the centroid vector.
-- ============================================================

-- ============================================================
-- 1. Voice enrollment table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.voice_enrollment (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contact (id) ON DELETE CASCADE,
  embedding vector(512) NOT NULL,
  session_id text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_enrollment_workspace_idx
  ON public.voice_enrollment (workspace_id);

CREATE INDEX IF NOT EXISTS voice_enrollment_contact_idx
  ON public.voice_enrollment (contact_id);

-- IVFFlat index for fast cosine similarity search.
-- lists = 50 is suitable for up to ~50k rows; adjust if needed.
CREATE INDEX IF NOT EXISTS voice_enrollment_embedding_idx
  ON public.voice_enrollment
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ============================================================
-- 2. Add voice match confidence to capture_participant
-- ============================================================

ALTER TABLE public.capture_participant
  ADD COLUMN IF NOT EXISTS voice_match_confidence real;

-- ============================================================
-- 3. RLS policies — workspace member access
-- ============================================================

ALTER TABLE public.voice_enrollment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view voice enrollments"
  ON public.voice_enrollment FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can manage voice enrollments"
  ON public.voice_enrollment FOR ALL
  USING (public.is_workspace_member(workspace_id));
