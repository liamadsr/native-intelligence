-- Migration 025: Captures, Recipes, Documents, Participants & Decisions
-- Renames notes → captures, adds recipe processing templates, documents,
-- relational participant tracking, and first-class decisions.
-- Idempotent: safe to re-run if partially applied.

-- ============================================================
-- 1. Rename notes → captures
-- ============================================================

-- Rename columns BEFORE table renames (column refs use current table name)
DO $$ BEGIN
  ALTER TABLE public.note_chunks RENAME COLUMN note_id TO capture_id;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.note_references RENAME COLUMN note_id TO capture_id;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.actions RENAME COLUMN source_note_id TO source_capture_id;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- Rename tables
DO $$ BEGIN
  ALTER TABLE public.notes RENAME TO captures;
EXCEPTION WHEN undefined_table THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.note_chunks RENAME TO capture_chunks;
EXCEPTION WHEN undefined_table THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.note_references RENAME TO capture_references;
EXCEPTION WHEN undefined_table THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;

-- Rename indexes on captures (formerly notes)
ALTER INDEX IF EXISTS idx_notes_user_id RENAME TO idx_captures_user_id;
ALTER INDEX IF EXISTS idx_notes_project_id RENAME TO idx_captures_project_id;
ALTER INDEX IF EXISTS idx_notes_user_project RENAME TO idx_captures_user_project;
ALTER INDEX IF EXISTS idx_notes_type RENAME TO idx_captures_type;
ALTER INDEX IF EXISTS idx_notes_calendar_event_id RENAME TO idx_captures_calendar_event_id;
ALTER INDEX IF EXISTS idx_notes_status RENAME TO idx_captures_status;
ALTER INDEX IF EXISTS idx_notes_tags RENAME TO idx_captures_tags;
ALTER INDEX IF EXISTS idx_notes_created_at RENAME TO idx_captures_created_at;
ALTER INDEX IF EXISTS idx_notes_workspace RENAME TO idx_captures_workspace;
ALTER INDEX IF EXISTS idx_notes_user_workspace RENAME TO idx_captures_user_workspace;

-- Rename indexes on capture_chunks (formerly note_chunks)
ALTER INDEX IF EXISTS idx_note_chunks_note_id RENAME TO idx_capture_chunks_capture_id;
ALTER INDEX IF EXISTS idx_note_chunks_project_id RENAME TO idx_capture_chunks_project_id;
ALTER INDEX IF EXISTS idx_note_chunks_user_id RENAME TO idx_capture_chunks_user_id;
ALTER INDEX IF EXISTS idx_note_chunks_user_project RENAME TO idx_capture_chunks_user_project;
ALTER INDEX IF EXISTS idx_note_chunks_embedding RENAME TO idx_capture_chunks_embedding;
ALTER INDEX IF EXISTS idx_note_chunks_workspace RENAME TO idx_capture_chunks_workspace;

-- Rename indexes on capture_references (formerly note_references)
ALTER INDEX IF EXISTS idx_note_references_note_id RENAME TO idx_capture_references_capture_id;
ALTER INDEX IF EXISTS idx_note_references_user_id RENAME TO idx_capture_references_user_id;
ALTER INDEX IF EXISTS idx_note_references_user_note RENAME TO idx_capture_references_user_capture;
ALTER INDEX IF EXISTS idx_note_references_type RENAME TO idx_capture_references_type;

-- Rename index on actions
ALTER INDEX IF EXISTS idx_actions_source_note RENAME TO idx_actions_source_capture;

-- ============================================================
-- 2. Recipe table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.recipe (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid REFERENCES public.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text,
  color text,
  description text,
  system_prompt text NOT NULL,
  extraction_config jsonb NOT NULL DEFAULT '{"actions": true, "decisions": true}',
  is_system boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  sort_order real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipe_workspace_idx ON public.recipe (workspace_id) WHERE workspace_id IS NOT NULL;

-- Seed system recipes (only if not already present)
INSERT INTO public.recipe (name, icon, color, description, system_prompt, extraction_config, is_system, sort_order)
SELECT * FROM (VALUES
(
  'Meeting'::text,
  '📋'::text,
  '#3b82f6'::text,
  'Team meetings, client calls, 1:1s. Extracts decisions, action items, and key discussion points.'::text,
  'You are analyzing a meeting transcript. Extract and organize:
1. **Summary** — A concise overview of what was discussed (2-3 paragraphs)
2. **Key Discussion Points** — The main topics covered, organized by theme
3. **Decisions Made** — Specific decisions that were agreed upon, with who made them if clear
4. **Action Items** — Tasks that need to be done, with assignee if mentioned and any deadlines discussed
5. **Open Questions** — Anything left unresolved or needing follow-up

Format as structured markdown. Be specific — use names, dates, and concrete details from the transcript.'::text,
  '{"actions": true, "decisions": true}'::jsonb,
  true,
  0::real
),
(
  'Brainstorm',
  '💡',
  '#f59e0b',
  'Idea sessions and creative exploration. Organizes ideas into themes and suggests next steps.',
  'You are analyzing a brainstorming session. Extract and organize:
1. **Summary** — What was the brainstorm about and what direction emerged
2. **Ideas Generated** — All ideas discussed, grouped by theme or category
3. **Top Ideas** — The most promising ideas based on group enthusiasm or feasibility discussed
4. **Concerns & Constraints** — Any limitations, risks, or pushback mentioned
5. **Next Steps** — Suggested actions to move the best ideas forward

Format as structured markdown. Capture every idea even if briefly mentioned.',
  '{"actions": true, "decisions": false}',
  true,
  1
),
(
  'Standup',
  '🔄',
  '#10b981',
  'Daily standups and status updates. Extracts updates, blockers, and commitments per person.',
  'You are analyzing a standup or status update meeting. Extract and organize:
1. **Summary** — Brief overview of team status
2. **Per Person Updates:**
   - What they completed since last standup
   - What they are working on today
   - Any blockers or things they need help with
3. **Action Items** — Specific commitments and follow-ups
4. **Blockers** — Items that are blocking progress, with who is affected

Format as structured markdown. Organize by person.',
  '{"actions": true, "decisions": false}',
  true,
  2
),
(
  'Sales Call',
  '💼',
  '#8b5cf6',
  'Sales and client calls. Captures requirements, objections, follow-ups, and next steps.',
  'You are analyzing a sales or client call. Extract and organize:
1. **Summary** — Overview of the call and relationship context
2. **Client Needs & Requirements** — What the client is looking for
3. **Objections & Concerns** — Any pushback or hesitations raised
4. **Competitive Mentions** — Any competitors or alternatives discussed
5. **Commitments Made** — What was promised to the client
6. **Follow-ups** — Specific next steps with owners and deadlines
7. **Sentiment** — Overall client sentiment and relationship health

Format as structured markdown. Focus on actionable intelligence.',
  '{"actions": true, "decisions": true}',
  true,
  3
),
(
  'Idea',
  '✨',
  '#ec4899',
  'Solo idea capture. Breaks down your idea into structure, identifies what is needed to make it happen.',
  'You are analyzing a captured idea or voice note. The speaker is thinking through something — organize their thoughts:
1. **Core Idea** — What is the idea in one clear paragraph
2. **Key Components** — Break the idea down into its parts
3. **Why It Matters** — The motivation or problem it solves
4. **What is Needed** — Resources, people, tools, or steps to make it happen
5. **Open Questions** — Things to figure out
6. **Suggested Actions** — Concrete next steps to explore or build this idea

Format as structured markdown. Be constructive and help develop the idea further.',
  '{"actions": true, "decisions": false}',
  true,
  4
)
) AS v(name, icon, color, description, system_prompt, extraction_config, is_system, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.recipe WHERE is_system = true);

-- Add recipe_id to captures
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS recipe_id uuid REFERENCES public.recipe (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS captures_recipe_idx ON public.captures (recipe_id) WHERE recipe_id IS NOT NULL;

-- Backfill recipe_id from old type column (if type column still exists)
DO $$ BEGIN
  -- Check if the type column exists before backfilling
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'captures' AND column_name = 'type'
  ) THEN
    UPDATE public.captures c
    SET recipe_id = r.id
    FROM public.recipe r
    WHERE r.is_system = true
      AND c.recipe_id IS NULL
      AND (
        (c.type::text = 'meeting' AND r.name = 'Meeting')
        OR (c.type::text = 'journal' AND r.name = 'Idea')
        OR (c.type::text = 'idea' AND r.name = 'Idea')
        OR (c.type::text = 'webpage' AND r.name = 'Meeting')
      );

    -- Default any remaining NULL to Meeting
    UPDATE public.captures c
    SET recipe_id = (SELECT id FROM public.recipe WHERE name = 'Meeting' AND is_system = true LIMIT 1)
    WHERE c.recipe_id IS NULL;

    -- Drop old type column and enum
    ALTER TABLE public.captures DROP COLUMN type;
  END IF;
END $$;

-- Drop functions that depend on note_type before dropping the type
DROP FUNCTION IF EXISTS public.rag_search(text, text[], text[], text, integer, double precision);
DROP FUNCTION IF EXISTS public.rag_search(text, text[], text[], text, integer, double precision, text);
DROP FUNCTION IF EXISTS public.search_notes_by_text(uuid, uuid[], text, integer);

DROP TYPE IF EXISTS note_type;

-- Convert status column from note_status enum to text before dropping the type
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'captures' AND column_name = 'status'
      AND udt_name = 'note_status'
  ) THEN
    ALTER TABLE public.captures ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.captures ALTER COLUMN status TYPE text USING status::text;
  END IF;
END $$;

DROP TYPE IF EXISTS note_status;

-- ============================================================
-- 3. Document table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.document (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects (id) ON DELETE SET NULL,
  team_id uuid REFERENCES public.team (id) ON DELETE SET NULL,
  title text NOT NULL,
  content text,
  content_json jsonb,
  created_by uuid REFERENCES public.member (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_pinned boolean NOT NULL DEFAULT false,
  sort_order real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_workspace_idx ON public.document (workspace_id);
CREATE INDEX IF NOT EXISTS document_project_idx ON public.document (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_team_idx ON public.document (team_id) WHERE team_id IS NOT NULL;

-- Full-text search
DO $$ BEGIN
  ALTER TABLE public.document ADD COLUMN fts tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(content, '')), 'B')
    ) STORED;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS document_fts_idx ON public.document USING gin (fts);

-- ============================================================
-- 4. Capture participant table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.capture_participant (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  capture_id uuid NOT NULL REFERENCES public.captures (id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.member (id) ON DELETE SET NULL,
  external_name text,
  external_email text,
  company text,
  job_title text,
  speaker_label text,
  role text DEFAULT 'attendee' CHECK (role IN ('organizer', 'attendee', 'observer')),
  joined_at timestamptz,
  left_at timestamptz,

  CHECK (member_id IS NOT NULL OR external_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS capture_participant_capture_idx ON public.capture_participant (capture_id);
CREATE INDEX IF NOT EXISTS capture_participant_member_idx ON public.capture_participant (member_id) WHERE member_id IS NOT NULL;

-- Migrate existing JSONB participants
INSERT INTO public.capture_participant (capture_id, external_name, external_email, company, job_title, role)
SELECT
  c.id,
  COALESCE(NULLIF(p->>'name', ''), p->>'email', 'Unknown'),
  p->>'email',
  p->>'company',
  p->>'jobTitle',
  CASE WHEN (p->>'isOrganizer')::boolean = true THEN 'organizer' ELSE 'attendee' END
FROM public.captures c,
     jsonb_array_elements(c.participants) AS p
WHERE c.participants IS NOT NULL
  AND jsonb_array_length(c.participants) > 0
  AND NOT EXISTS (SELECT 1 FROM public.capture_participant cp WHERE cp.capture_id = c.id);

-- DO NOT drop participants JSONB column — iOS app still writes to it

-- ============================================================
-- 5. Decision table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.decision (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  capture_id uuid NOT NULL REFERENCES public.captures (id) ON DELETE CASCADE,
  content text NOT NULL,
  source_timestamp real,
  project_id uuid REFERENCES public.projects (id) ON DELETE SET NULL,
  confirmation text NOT NULL DEFAULT 'suggested'
    CHECK (confirmation IN ('suggested', 'confirmed', 'dismissed')),
  decided_by uuid REFERENCES public.member (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_capture_idx ON public.decision (capture_id);
CREATE INDEX IF NOT EXISTS decision_project_idx ON public.decision (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_confirmation_idx ON public.decision (confirmation) WHERE confirmation = 'suggested';

-- ============================================================
-- 6. New columns on captures
-- ============================================================

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_transcript_locked boolean NOT NULL DEFAULT false;

-- Backfill from existing data
UPDATE public.captures SET started_at = recorded_at
WHERE recorded_at IS NOT NULL AND started_at IS NULL;

UPDATE public.captures SET ended_at = started_at + (duration_seconds || ' seconds')::interval
WHERE started_at IS NOT NULL AND duration_seconds IS NOT NULL AND ended_at IS NULL;

UPDATE public.captures SET is_transcript_locked = true
WHERE ended_at IS NOT NULL AND transcript IS NOT NULL AND is_transcript_locked = false;

-- ============================================================
-- 7. Transcript locking triggers
-- ============================================================

CREATE OR REPLACE FUNCTION public.lock_transcript_on_end()
RETURNS trigger AS $$
BEGIN
  IF new.ended_at IS NOT NULL AND old.ended_at IS NULL THEN
    new.is_transcript_locked := true;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS capture_lock_transcript ON public.captures;
CREATE TRIGGER capture_lock_transcript
  BEFORE UPDATE ON public.captures
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_transcript_on_end();

CREATE OR REPLACE FUNCTION public.prevent_transcript_edit()
RETURNS trigger AS $$
BEGIN
  IF old.is_transcript_locked = true
     AND new.transcript IS DISTINCT FROM old.transcript THEN
    RAISE EXCEPTION 'Transcript is locked after capture has ended';
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS capture_prevent_transcript_edit ON public.captures;
CREATE TRIGGER capture_prevent_transcript_edit
  BEFORE UPDATE ON public.captures
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_transcript_edit();

-- ============================================================
-- 8. RLS policies
-- ============================================================

ALTER TABLE public.recipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decision ENABLE ROW LEVEL SECURITY;

-- Recipe policies
DROP POLICY IF EXISTS "Anyone can view system recipes" ON public.recipe;
CREATE POLICY "Anyone can view system recipes"
  ON public.recipe FOR SELECT
  USING (is_system = true OR public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Admins can create workspace recipes" ON public.recipe;
CREATE POLICY "Admins can create workspace recipes"
  ON public.recipe FOR INSERT
  WITH CHECK (
    is_system = false
    AND public.get_member_role(workspace_id) IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS "Admins can update workspace recipes" ON public.recipe;
CREATE POLICY "Admins can update workspace recipes"
  ON public.recipe FOR UPDATE
  USING (
    is_system = false
    AND public.get_member_role(workspace_id) IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS "Admins can delete workspace recipes" ON public.recipe;
CREATE POLICY "Admins can delete workspace recipes"
  ON public.recipe FOR DELETE
  USING (
    is_system = false
    AND public.get_member_role(workspace_id) IN ('owner', 'admin')
  );

-- Document policies
DROP POLICY IF EXISTS "Workspace members can view documents" ON public.document;
CREATE POLICY "Workspace members can view documents"
  ON public.document FOR SELECT
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Workspace members can create documents" ON public.document;
CREATE POLICY "Workspace members can create documents"
  ON public.document FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Workspace members can update documents" ON public.document;
CREATE POLICY "Workspace members can update documents"
  ON public.document FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Creator and admins can delete documents" ON public.document;
CREATE POLICY "Creator and admins can delete documents"
  ON public.document FOR DELETE
  USING (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR created_by = (
      SELECT id FROM public.member
      WHERE user_id = auth.uid() AND workspace_id = document.workspace_id
      LIMIT 1
    )
  );

-- Capture participant policies
DROP POLICY IF EXISTS "Workspace members can view capture participants" ON public.capture_participant;
CREATE POLICY "Workspace members can view capture participants"
  ON public.capture_participant FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

DROP POLICY IF EXISTS "Workspace members can manage capture participants" ON public.capture_participant;
CREATE POLICY "Workspace members can manage capture participants"
  ON public.capture_participant FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

-- Decision policies
DROP POLICY IF EXISTS "Workspace members can view decisions" ON public.decision;
CREATE POLICY "Workspace members can view decisions"
  ON public.decision FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

DROP POLICY IF EXISTS "Workspace members can manage decisions" ON public.decision;
CREATE POLICY "Workspace members can manage decisions"
  ON public.decision FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

-- ============================================================
-- 9. Update rag_search function
-- ============================================================

CREATE OR REPLACE FUNCTION rag_search(
    p_user_id TEXT,
    p_project_ids TEXT[],
    p_note_ids TEXT[],
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.0,
    p_workspace_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    chunk_id UUID,
    capture_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_index INTEGER,
    capture_title TEXT,
    recipe_name TEXT,
    similarity FLOAT
) AS $$
DECLARE
    v_user_id UUID := p_user_id::UUID;
    v_embedding vector(1536) := p_embedding::vector(1536);
    v_has_project_filter BOOLEAN := COALESCE(array_length(p_project_ids, 1), 0) > 0;
    v_has_capture_filter BOOLEAN := COALESCE(array_length(p_note_ids, 1), 0) > 0;
    v_workspace_id UUID := CASE WHEN p_workspace_id IS NOT NULL THEN p_workspace_id::UUID ELSE NULL END;
    v_project_ids UUID[];
    v_capture_ids UUID[];
BEGIN
    IF v_has_project_filter THEN
        v_project_ids := ARRAY(SELECT unnest(p_project_ids)::UUID);
    ELSE
        v_project_ids := NULL;
    END IF;

    IF v_has_capture_filter THEN
        v_capture_ids := ARRAY(SELECT unnest(p_note_ids)::UUID);
    ELSE
        v_capture_ids := NULL;
    END IF;

    RETURN QUERY
    SELECT
        cc.id as chunk_id,
        cc.capture_id,
        cc.project_id,
        cc.chunk_text,
        cc.chunk_index,
        c.title as capture_title,
        r.name as recipe_name,
        1 - (cc.embedding <=> v_embedding) as similarity
    FROM capture_chunks cc
    JOIN captures c ON c.id = cc.capture_id
    LEFT JOIN recipe r ON r.id = c.recipe_id
    WHERE cc.user_id = v_user_id
      AND cc.embedding IS NOT NULL
      AND 1 - (cc.embedding <=> v_embedding) >= p_threshold
      AND (v_workspace_id IS NULL OR cc.workspace_id = v_workspace_id)
      AND (
          (NOT v_has_project_filter AND NOT v_has_capture_filter)
          OR (v_has_project_filter AND cc.project_id = ANY(v_project_ids))
          OR (v_has_capture_filter AND cc.capture_id = ANY(v_capture_ids))
      )
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-grant permissions
GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT) TO anon;

-- ============================================================
-- 10. Triggers for updated_at
-- ============================================================

DROP TRIGGER IF EXISTS recipe_updated_at ON public.recipe;
CREATE TRIGGER recipe_updated_at
  BEFORE UPDATE ON public.recipe
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS document_updated_at ON public.document;
CREATE TRIGGER document_updated_at
  BEFORE UPDATE ON public.document
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
