-- Migration 265: project_embedding → anchor_embedding, and knowledge_brief
-- learns the company/campaign scopes.
--
-- Part of "anchors are configuration": knowledge anchoring generalizes from
-- project-only to a per-workspace anchor SET (project, company, campaign; the
-- contact anchor keeps its own `committed_to` machinery and is not cached
-- here). The weaver's embedding cache was keyed by `project_id` alone, which
-- can only ever hold one anchor type.
--
-- 1. EVOLVE, don't recreate. The table is RENAMEd and its key widened so every
--    row already embedded survives: re-embedding a workspace's projects from
--    scratch is real OpenAI spend, and `source_updated_at` is the only thing
--    that keeps it near-zero on quiet workspaces. Existing rows backfill as
--    entity_type='project' — which is what they are.
--
-- 2. The FK on project_id is DROPPED: anchor_embedding now holds rows for
--    several tables, so no single FK can fence `entity_id`. The cascade it
--    provided (a deleted project takes its cached embedding with it —
--    migration 263 calls this out as deliberate) is replaced by a trigger-free
--    rule: refreshAnchorEmbeddings only ever returns rows whose live entity it
--    just read, so an orphan row is invisible, and the per-type cleanup below
--    keeps it from accumulating. Orphans are pruned by the weaver's own
--    per-workspace refresh (it deletes cached rows for entities it no longer
--    sees) rather than by the database.
--
-- 3. knowledge_brief.scope_type gains 'company' and 'campaign' so brief.ts can
--    compile an anchor-scoped brief for them. 'campaign' is listed ahead of its
--    table for the same reason migration 264 lists it in claim_source: the
--    column carries no FK, so the value is inert until the campaign entity
--    lands, and widening once spares the campaign build this DROP/re-ADD dance.
--
-- SAFETY posture is unchanged from 184: service-role only, RLS enabled with no
-- client policies (same as tracked_job / mcp_oauth_client).

-- ============================================================
-- 1. project_embedding → anchor_embedding
-- ============================================================

DO $$
DECLARE
  conname_var TEXT;
BEGIN
  -- Idempotent: a re-run after a partial apply finds anchor_embedding already
  -- in place and skips straight to the constraint work below.
  IF to_regclass('public.project_embedding') IS NOT NULL
     AND to_regclass('public.anchor_embedding') IS NULL THEN
    ALTER TABLE public.project_embedding RENAME TO anchor_embedding;
    ALTER INDEX IF EXISTS project_embedding_workspace_idx
      RENAME TO anchor_embedding_workspace_idx;
  END IF;

  IF to_regclass('public.anchor_embedding') IS NULL THEN
    CREATE TABLE public.anchor_embedding (
      workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
      entity_type text NOT NULL,
      entity_id uuid NOT NULL,
      embedding vector(1536) NOT NULL,
      source_updated_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;

  -- The renamed table still carries `project_id` as its primary key and an FK
  -- to projects. Widen it: add the discriminant, rename the id column, drop
  -- the single-table FK and the single-column PK.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'anchor_embedding'
      AND column_name = 'project_id'
  ) THEN
    -- entity_type first, backfilled for every existing row, THEN made NOT NULL
    -- (an ALTER ... SET NOT NULL on a column with nulls would abort).
    ALTER TABLE public.anchor_embedding ADD COLUMN IF NOT EXISTS entity_type text;
    UPDATE public.anchor_embedding SET entity_type = 'project' WHERE entity_type IS NULL;
    ALTER TABLE public.anchor_embedding ALTER COLUMN entity_type SET NOT NULL;

    -- Drop the projects FK (whatever it is named) before renaming the column.
    SELECT con.conname INTO conname_var
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'anchor_embedding'
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) ILIKE '%REFERENCES%projects%'
    LIMIT 1;
    IF conname_var IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.anchor_embedding DROP CONSTRAINT %I', conname_var);
    END IF;

    -- Drop the project_id primary key; the composite one is added below.
    SELECT con.conname INTO conname_var
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'anchor_embedding'
      AND con.contype = 'p'
    LIMIT 1;
    IF conname_var IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.anchor_embedding DROP CONSTRAINT %I', conname_var);
    END IF;

    ALTER TABLE public.anchor_embedding RENAME COLUMN project_id TO entity_id;
  END IF;
END $$;

-- The key the weaver upserts on: one cached embedding per (workspace, type,
-- entity). workspace_id leads so the per-workspace load is an index scan on
-- the same index — the old workspace index is now redundant but harmless.
ALTER TABLE public.anchor_embedding
  DROP CONSTRAINT IF EXISTS anchor_embedding_pkey;
ALTER TABLE public.anchor_embedding
  ADD CONSTRAINT anchor_embedding_pkey
  PRIMARY KEY (workspace_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS anchor_embedding_workspace_idx
  ON public.anchor_embedding (workspace_id);

ALTER TABLE public.anchor_embedding ENABLE ROW LEVEL SECURITY;
-- No client policies: a derived cache written and read ONLY by the
-- service-role weaver, which bypasses RLS. RLS-on-with-no-policies denies
-- every authenticated/anon read and write.

-- `move_project` (migration 221, ~line 1465) re-stamps a moved project's cached
-- embedding with `UPDATE public.project_embedding SET workspace_id = …  WHERE
-- project_id = …`, and without that re-stamp the moved project becomes
-- invisible to the weaver's per-workspace cache read. Rather than redefine a
-- 275-line RPC to change two identifiers, keep the old name as an
-- auto-updatable view over the project rows: simple SELECT, one table, no
-- aggregates, so Postgres rewrites the RPC's UPDATE onto anchor_embedding.
-- New code writes anchor_embedding directly; this exists only for that RPC and
-- can be dropped when move_project is next rewritten.
CREATE OR REPLACE VIEW public.project_embedding
WITH (security_invoker = true) AS
  SELECT
    entity_id AS project_id,
    workspace_id,
    embedding,
    source_updated_at,
    updated_at
  FROM public.anchor_embedding
  WHERE entity_type = 'project';

REVOKE ALL ON public.project_embedding FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.project_embedding TO service_role;


-- ============================================================
-- 2. knowledge_brief.scope_type gains the anchor scopes
-- ============================================================

DO $$
DECLARE
  conname_var TEXT;
BEGIN
  SELECT con.conname INTO conname_var
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'knowledge_brief'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%scope_type %IN%'
  ORDER BY con.conname
  LIMIT 1;

  IF conname_var IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.knowledge_brief DROP CONSTRAINT %I', conname_var);
  END IF;

  ALTER TABLE public.knowledge_brief DROP CONSTRAINT IF EXISTS knowledge_brief_scope_type_check;

  ALTER TABLE public.knowledge_brief
    ADD CONSTRAINT knowledge_brief_scope_type_check CHECK (scope_type IN (
      'workspace', 'project', 'package', 'company', 'campaign'
    ));
END $$;
