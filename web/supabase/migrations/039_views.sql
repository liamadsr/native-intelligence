-- Migration 039: Universal Custom Views System
-- Stores saved view configurations (filters, grouping, ordering, layout)
-- for any entity type: actions, captures, contacts, companies, email threads, documents

-- ============================================================
-- 1. Enums
-- ============================================================

CREATE TYPE public.view_entity_type AS ENUM (
  'action',
  'capture',
  'contact',
  'company',
  'email_thread',
  'document'
);

CREATE TYPE public.view_layout AS ENUM ('list', 'board');

CREATE TYPE public.view_visibility AS ENUM ('personal', 'team', 'workspace');

-- ============================================================
-- 2. view table
-- ============================================================

CREATE TABLE public.view (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  team_id UUID REFERENCES public.team (id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  -- Identity
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  slug TEXT,

  -- What this view shows
  entity_type public.view_entity_type NOT NULL,

  -- Visibility
  visibility public.view_visibility NOT NULL DEFAULT 'personal',

  -- Layout
  layout public.view_layout NOT NULL DEFAULT 'list',

  -- Configuration (heart of the view)
  filters JSONB NOT NULL DEFAULT '[]',
  grouping JSONB DEFAULT NULL,
  sub_grouping JSONB DEFAULT NULL,
  ordering JSONB NOT NULL DEFAULT '[{"field": "created_at", "direction": "desc"}]',
  display_properties TEXT[] DEFAULT '{}',

  -- Board-specific config
  board_group_by TEXT,

  -- Completed/archived items
  show_completed BOOLEAN DEFAULT true,
  completed_filter TEXT DEFAULT 'all'
    CHECK (completed_filter IN ('all', 'recent', 'none')),

  -- Sub-items
  show_sub_items BOOLEAN DEFAULT true,
  nested_sub_items BOOLEAN DEFAULT false,

  -- Empty groups
  show_empty_groups BOOLEAN DEFAULT false,

  -- Pinned / favorites
  is_pinned BOOLEAN DEFAULT false,
  pin_order INT DEFAULT 0,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (workspace_id, slug)
);

-- ============================================================
-- 3. view_favorite table
-- ============================================================

CREATE TABLE public.view_favorite (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  view_id UUID NOT NULL REFERENCES public.view (id) ON DELETE CASCADE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (user_id, view_id)
);

-- ============================================================
-- 4. Indexes
-- ============================================================

CREATE INDEX idx_view_workspace ON public.view (workspace_id);
CREATE INDEX idx_view_team ON public.view (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX idx_view_creator ON public.view (created_by);
CREATE INDEX idx_view_entity_type ON public.view (workspace_id, entity_type);
CREATE INDEX idx_view_visibility ON public.view (workspace_id, visibility);

CREATE INDEX idx_view_favorite_user ON public.view_favorite (user_id, sort_order);

-- ============================================================
-- 5. Updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_view_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_view_updated_at
  BEFORE UPDATE ON public.view
  FOR EACH ROW
  EXECUTE FUNCTION public.update_view_updated_at();

-- ============================================================
-- 6. Slug generation trigger
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_view_slug()
RETURNS TRIGGER AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  counter INT := 0;
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base_slug := lower(regexp_replace(trim(NEW.name), '[^a-zA-Z0-9]+', '-', 'g'));
    base_slug := trim(both '-' from base_slug);
    final_slug := base_slug;

    LOOP
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.view
        WHERE workspace_id = NEW.workspace_id AND slug = final_slug AND id IS DISTINCT FROM NEW.id
      );
      counter := counter + 1;
      final_slug := base_slug || '-' || counter;
    END LOOP;

    NEW.slug := final_slug;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_view_slug
  BEFORE INSERT OR UPDATE OF name ON public.view
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_view_slug();

-- ============================================================
-- 7. RLS policies
-- ============================================================

ALTER TABLE public.view ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.view_favorite ENABLE ROW LEVEL SECURITY;

-- Views: visibility-based access
CREATE POLICY "Users can view accessible views"
  ON public.view FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      (visibility = 'personal' AND created_by = auth.uid())
      OR (visibility = 'team' AND team_id IS NOT NULL AND public.is_team_member(team_id))
      OR (visibility = 'workspace')
    )
  );

CREATE POLICY "Users can create views in their workspace"
  ON public.view FOR INSERT
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND created_by = auth.uid()
  );

CREATE POLICY "Users can update their own views or workspace views as admin"
  ON public.view FOR UPDATE
  USING (
    created_by = auth.uid()
    OR (visibility = 'workspace' AND public.get_member_role(workspace_id) IN ('admin', 'owner'))
  );

CREATE POLICY "Users can delete their own views or workspace views as admin"
  ON public.view FOR DELETE
  USING (
    created_by = auth.uid()
    OR (visibility = 'workspace' AND public.get_member_role(workspace_id) IN ('admin', 'owner'))
  );

-- Favorites: user-scoped
CREATE POLICY "Users can manage their own view favorites"
  ON public.view_favorite FOR ALL
  USING (auth.uid() = user_id);
