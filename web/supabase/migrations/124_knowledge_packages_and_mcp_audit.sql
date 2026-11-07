-- Migration 124: Knowledge packages + MCP audit log.
--
-- KNOWLEDGE PACKAGES are the gating/sharing overlay on the workspace knowledge
-- graph. Storage stays workspace-flat (one graph, one dedup/contradiction
-- substrate); a package is a named, durable, access-controlled VIEW over it:
--
--   - membership = pinned entities (knowledge_package_item) + standing rules
--     (knowledge_package.rules JSONB, e.g. {"projects": [..], "min_confidence": 0.7})
--   - access     = personal / team / workspace visibility (mirrors the proven
--     `view` table pattern from migration 039)
--   - artifact   = a compiled brief (knowledge_brief, scope_type='package')
--   - export     = /api/account/knowledge-packages/[id]/export (markdown/JSONL)
--
-- The same claim can serve many packages — gating is a view problem, not a
-- storage problem. Cross-package dedup and contradiction detection keep
-- working because the graph is never fragmented.
--
-- MCP AUDIT LOG records every tool invocation made through the MCP server
-- (external agents acting on workspace data). Service-role managed; RLS
-- enabled with no policies so only server code can touch it.

CREATE TABLE IF NOT EXISTS public.knowledge_package (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('personal', 'team', 'workspace')),
  team_id UUID REFERENCES public.team(id) ON DELETE SET NULL,
  -- Standing inclusion rules, expanded at read time on top of pinned items:
  --   { "projects": ["<uuid>", ...],     claims `about` these projects
  --     "min_confidence": 0.7,           floor for rule-included claims
  --     "include_suggested": true }      false = confirmed claims only
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL,            -- auth.users id (mirrors `view`)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_package_workspace
  ON public.knowledge_package (workspace_id, visibility);

CREATE TABLE IF NOT EXISTS public.knowledge_package_item (
  package_id UUID NOT NULL REFERENCES public.knowledge_package(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  added_by UUID,                       -- auth.users id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_package_item_entity
  ON public.knowledge_package_item (workspace_id, entity_type, entity_id);

ALTER TABLE public.knowledge_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_package_item ENABLE ROW LEVEL SECURITY;

-- Package access mirrors the `view` table (migration 039): personal packages
-- are creator-only, team packages need team membership, workspace packages
-- are open to all members.
DROP POLICY IF EXISTS knowledge_package_select ON public.knowledge_package;
CREATE POLICY knowledge_package_select ON public.knowledge_package
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
    AND (
      (visibility = 'personal' AND created_by = auth.uid())
      OR (visibility = 'team' AND team_id IS NOT NULL AND public.is_team_member(team_id))
      OR (visibility = 'workspace')
    )
  );

DROP POLICY IF EXISTS knowledge_package_insert ON public.knowledge_package;
CREATE POLICY knowledge_package_insert ON public.knowledge_package
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id) AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS knowledge_package_update ON public.knowledge_package;
CREATE POLICY knowledge_package_update ON public.knowledge_package
  FOR UPDATE USING (
    created_by = auth.uid()
    OR (visibility = 'workspace' AND public.get_member_role(workspace_id) IN ('admin', 'owner'))
  );

DROP POLICY IF EXISTS knowledge_package_delete ON public.knowledge_package;
CREATE POLICY knowledge_package_delete ON public.knowledge_package
  FOR DELETE USING (
    created_by = auth.uid()
    OR (visibility = 'workspace' AND public.get_member_role(workspace_id) IN ('admin', 'owner'))
  );

-- Items inherit access from their package: the RLS-filtered EXISTS subquery
-- only sees packages the caller can already SELECT, so visibility gating
-- composes automatically. Mutating a personal package's items stays
-- creator-only.
DROP POLICY IF EXISTS knowledge_package_item_select ON public.knowledge_package_item;
CREATE POLICY knowledge_package_item_select ON public.knowledge_package_item
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.knowledge_package p WHERE p.id = package_id
    )
  );

DROP POLICY IF EXISTS knowledge_package_item_insert ON public.knowledge_package_item;
CREATE POLICY knowledge_package_item_insert ON public.knowledge_package_item
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.knowledge_package p
      WHERE p.id = package_id
        AND (p.visibility <> 'personal' OR p.created_by = auth.uid())
    )
  );

DROP POLICY IF EXISTS knowledge_package_item_delete ON public.knowledge_package_item;
CREATE POLICY knowledge_package_item_delete ON public.knowledge_package_item
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.knowledge_package p
      WHERE p.id = package_id
        AND (p.visibility <> 'personal' OR p.created_by = auth.uid())
    )
  );

-- ------------------------------------------------------------
-- MCP audit log — one row per tool invocation through the MCP server.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mcp_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id UUID REFERENCES public.mcp_oauth_token(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  workspace_id UUID,
  tool_name TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  error_type TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_user
  ON public.mcp_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_workspace
  ON public.mcp_audit_log (workspace_id, created_at DESC);

-- Server-managed only: RLS on, no policies — the service role bypasses RLS,
-- authenticated users get nothing. (Same posture as the mcp_oauth_* tables,
-- made explicit.)
ALTER TABLE public.mcp_audit_log ENABLE ROW LEVEL SECURITY;
