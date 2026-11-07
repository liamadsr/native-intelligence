-- Migration 148: Cloud environments
-- Depends on: 146_agent_run.sql (cloud agent runs), 013 (is_workspace_member,
--             update_updated_at), 066 (projects.github_repo — the link precedent)
--
-- A cloud environment configures the Vercel Sandbox the server-side coding agent
-- runs in: its network reach, the env vars exported into the run, and a setup
-- script run after clone (e.g. `npm install`). Environments are workspace-scoped
-- and shared; a project links to AT MOST ONE via projects.cloud_env_id, exactly
-- the way a project links to a GitHub repo. Different projects can use different
-- environments.
--
-- env_vars is raw `.env`-format text, stored PLAINTEXT for v1 with a "don't add
-- secrets" warning in the UI. The schema intentionally leaves room to add an
-- encrypted secrets column later (see src/lib/crypto/credentials.ts) without a
-- breaking change.

CREATE TABLE public.cloud_environment (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name TEXT NOT NULL,

  -- How much network the sandbox gets. Maps to @vercel/sandbox networkPolicy:
  --   trusted    -> "allow-all"  (default; clone + npm + MCP all work)
  --   restricted -> { allow: [...] }  (fixed allowlist for v1)
  --   isolated   -> "deny-all"
  network_access TEXT NOT NULL DEFAULT 'trusted'
    CHECK (network_access IN ('trusted', 'restricted', 'isolated')),

  env_vars TEXT,        -- raw .env-format text (plaintext v1; parsed at run time)
  setup_script TEXT,    -- bash, runs after clone before the agent starts

  -- The human who created it. SET NULL (not cascade) so an env survives its
  -- author leaving — mirrors agent_run.triggered_by.
  created_by UUID REFERENCES auth.users (id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cloud_environment_workspace_idx ON public.cloud_environment (workspace_id);

-- ============================================================
-- RLS — workspace-scoped, mirrors agent_run
-- ============================================================

ALTER TABLE public.cloud_environment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cloud_environment_select"
  ON public.cloud_environment FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "cloud_environment_insert"
  ON public.cloud_environment FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "cloud_environment_update"
  ON public.cloud_environment FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "cloud_environment_delete"
  ON public.cloud_environment FOR DELETE
  USING (public.is_workspace_member(workspace_id));

CREATE TRIGGER cloud_environment_updated_at
  BEFORE UPDATE ON public.cloud_environment
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- The project link — mirrors github_repo, but as an FK.
-- ON DELETE SET NULL: deleting an environment unlinks its projects rather than
-- cascading the project away.
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN cloud_env_id UUID REFERENCES public.cloud_environment (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.projects.cloud_env_id IS
  'Cloud environment the server-side agent runs in for this project (see cloud_environment).';
