-- ============================================================
-- Migration 110: Document wiki layer
-- Extends the existing `document` table to support a wiki-style surface
-- over the claims-based knowledge graph (migration 109).
--
-- Adds: slug, type, tags, frontmatter, published_status, published_at,
-- last_edited_by. Creates document_revision (history) and document_draft
-- (per-user in-progress edits).
--
-- The existing `status` column ('active'/'archived') is left untouched —
-- published_status (draft/published) is an independent axis.
-- ============================================================

-- ============================================================
-- 1. Extend `document` with wiki fields
-- ============================================================

ALTER TABLE public.document
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'note'
    CHECK (type IN ('note', 'system', 'entity', 'analysis', 'source_summary', 'spec')),
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS published_status TEXT NOT NULL DEFAULT 'published'
    CHECK (published_status IN ('draft', 'published')),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_edited_by UUID REFERENCES public.member(id) ON DELETE SET NULL;

-- Backfill: any existing rows are considered published as of their updated_at
UPDATE public.document
SET published_at = updated_at
WHERE published_at IS NULL AND published_status = 'published';

-- Workspace-unique slug (nullable to allow legacy/unslugged rows)
CREATE UNIQUE INDEX IF NOT EXISTS document_workspace_slug_idx
  ON public.document (workspace_id, slug) WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_workspace_type
  ON public.document (workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_document_workspace_tags
  ON public.document USING gin (tags);

-- ============================================================
-- 2. document_revision — append-only history
-- ============================================================

CREATE TABLE IF NOT EXISTS public.document_revision (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES public.document(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  title TEXT,
  content TEXT,
  content_json JSONB,
  frontmatter JSONB,
  tags TEXT[],
  author_id UUID REFERENCES public.member(id) ON DELETE SET NULL,
  change_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_document_revision_document
  ON public.document_revision (document_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_document_revision_workspace
  ON public.document_revision (workspace_id);

-- ============================================================
-- 3. document_draft — per-user in-progress edits
-- One row per (document, author). Drained into the document on publish.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.document_draft (
  document_id UUID NOT NULL REFERENCES public.document(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  title TEXT,
  content TEXT,
  content_json JSONB,
  frontmatter JSONB,
  tags TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, author_id)
);

CREATE INDEX IF NOT EXISTS idx_document_draft_workspace
  ON public.document_draft (workspace_id);
CREATE INDEX IF NOT EXISTS idx_document_draft_author
  ON public.document_draft (author_id);

CREATE OR REPLACE FUNCTION public._document_draft_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS document_draft_set_updated_at ON public.document_draft;
CREATE TRIGGER document_draft_set_updated_at
  BEFORE UPDATE ON public.document_draft
  FOR EACH ROW
  EXECUTE FUNCTION public._document_draft_set_updated_at();

-- ============================================================
-- 4. RLS
-- ============================================================

-- document_revision: workspace members can read; only writes via the
-- publish path (which goes through the API), but allow inserts from any
-- workspace member for now since RLS is the backstop.
ALTER TABLE public.document_revision ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can read document revisions" ON public.document_revision;
CREATE POLICY "Workspace members can read document revisions"
  ON public.document_revision FOR SELECT
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Workspace members can write document revisions" ON public.document_revision;
CREATE POLICY "Workspace members can write document revisions"
  ON public.document_revision FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

-- document_draft: members can only see/edit their own drafts.
ALTER TABLE public.document_draft ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read their own drafts" ON public.document_draft;
CREATE POLICY "Members read their own drafts"
  ON public.document_draft FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.id = document_draft.author_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Members write their own drafts" ON public.document_draft;
CREATE POLICY "Members write their own drafts"
  ON public.document_draft FOR ALL
  USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.id = document_draft.author_id
        AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.id = document_draft.author_id
        AND m.user_id = auth.uid()
    )
  );

-- ============================================================
-- 5. Realtime
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.document_draft;
ALTER PUBLICATION supabase_realtime ADD TABLE public.document_revision;
