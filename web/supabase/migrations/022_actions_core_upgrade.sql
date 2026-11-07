-- Chunk 4: Actions Core Upgrade
-- Adds: identifier, assignee_id, parent_id, priority enum, estimate, full-text search, action relations
-- Drops: list_id, action_lists table, milestone_id

-- ============================================================
-- 1a. Drop legacy columns and tables
-- ============================================================

ALTER TABLE public.actions DROP COLUMN IF EXISTS list_id;

-- Drop default_list_id FK on projects before dropping action_lists
ALTER TABLE public.projects DROP COLUMN IF EXISTS default_list_id;

DROP TABLE IF EXISTS public.action_lists CASCADE;

ALTER TABLE public.actions DROP COLUMN IF EXISTS milestone_id;

-- ============================================================
-- 1b. Add identifier column (auto-generated like ENG-42)
-- ============================================================

ALTER TABLE public.actions ADD COLUMN identifier text;

-- Backfill identifiers for all existing actions
DO $$
DECLARE
  t record;
  a record;
  current_counter integer;
  prefix text;
BEGIN
  FOR t IN SELECT id, issue_prefix, issue_counter FROM public.team LOOP
    prefix := t.issue_prefix;
    current_counter := t.issue_counter;

    FOR a IN
      SELECT id FROM public.actions
      WHERE team_id = t.id AND identifier IS NULL
      ORDER BY created_at ASC
    LOOP
      current_counter := current_counter + 1;
      UPDATE public.actions SET identifier = prefix || '-' || current_counter WHERE id = a.id;
    END LOOP;

    UPDATE public.team SET issue_counter = current_counter WHERE id = t.id;
  END LOOP;
END $$;

ALTER TABLE public.actions ALTER COLUMN identifier SET NOT NULL;
-- Identifiers are unique within a workspace (different workspaces can have the same prefix)
CREATE UNIQUE INDEX actions_identifier_workspace_idx ON public.actions (workspace_id, identifier);

-- ============================================================
-- 1c. Add assignee_id (FK → member)
-- ============================================================

ALTER TABLE public.actions ADD COLUMN assignee_id uuid REFERENCES public.member (id) ON DELETE SET NULL;
CREATE INDEX actions_assignee_idx ON public.actions (assignee_id) WHERE assignee_id IS NOT NULL;

-- ============================================================
-- 1d. Add parent_id for sub-actions
-- ============================================================

ALTER TABLE public.actions ADD COLUMN parent_id uuid REFERENCES public.actions (id) ON DELETE SET NULL;
CREATE INDEX actions_parent_idx ON public.actions (parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- 1e. Convert priority from integer to enum
-- ============================================================

CREATE TYPE public.action_priority AS ENUM ('none', 'low', 'medium', 'high', 'urgent');

ALTER TABLE public.actions ADD COLUMN priority_new public.action_priority NOT NULL DEFAULT 'none';

UPDATE public.actions SET priority_new = CASE priority
  WHEN 1 THEN 'urgent'::public.action_priority
  WHEN 2 THEN 'high'::public.action_priority
  WHEN 3 THEN 'medium'::public.action_priority
  WHEN 4 THEN 'low'::public.action_priority
  WHEN 5 THEN 'none'::public.action_priority
  ELSE 'none'::public.action_priority
END;

ALTER TABLE public.actions DROP COLUMN priority;
ALTER TABLE public.actions RENAME COLUMN priority_new TO priority;

CREATE INDEX actions_priority_idx ON public.actions (priority) WHERE priority != 'none';

-- ============================================================
-- 1f. Add estimate column
-- ============================================================

ALTER TABLE public.actions ADD COLUMN estimate real;

-- ============================================================
-- 1g. Add full-text search
-- ============================================================

ALTER TABLE public.actions ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX actions_fts_idx ON public.actions USING gin (fts);

-- ============================================================
-- 1h. Create action_relation table
-- ============================================================

CREATE TYPE public.action_relation_type AS ENUM ('blocks', 'blocked_by', 'related', 'duplicate');

CREATE TABLE public.action_relation (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  action_id uuid NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  related_action_id uuid NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  type public.action_relation_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (action_id, related_action_id, type),
  CHECK (action_id != related_action_id)
);

CREATE INDEX action_relation_action_idx ON public.action_relation (action_id);
CREATE INDEX action_relation_related_idx ON public.action_relation (related_action_id);

-- ============================================================
-- 1i. RLS on action_relation
-- ============================================================

ALTER TABLE public.action_relation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view action relations"
  ON public.action_relation FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.actions a
      JOIN public.team t ON t.id = a.team_id
      WHERE a.id = action_relation.action_id
        AND public.is_workspace_member(t.workspace_id)
    )
  );

CREATE POLICY "Workspace members can insert action relations"
  ON public.action_relation FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.actions a
      JOIN public.team t ON t.id = a.team_id
      WHERE a.id = action_id
        AND public.is_workspace_member(t.workspace_id)
    )
  );

CREATE POLICY "Workspace members can delete action relations"
  ON public.action_relation FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.actions a
      JOIN public.team t ON t.id = a.team_id
      WHERE a.id = action_relation.action_id
        AND public.is_workspace_member(t.workspace_id)
    )
  );

-- ============================================================
-- 1j. Trigger: Auto-generate identifier on insert
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_action_identifier()
RETURNS trigger AS $$
DECLARE
  prefix text;
  counter integer;
BEGIN
  UPDATE public.team
  SET issue_counter = issue_counter + 1
  WHERE id = new.team_id
  RETURNING issue_prefix, issue_counter INTO prefix, counter;

  new.identifier := prefix || '-' || counter;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER action_generate_identifier
  BEFORE INSERT ON public.actions
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_action_identifier();

-- ============================================================
-- 1k. Enable Realtime for actions
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.actions;
