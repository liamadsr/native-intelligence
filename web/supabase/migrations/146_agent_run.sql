-- Migration 146: Server-side agent runs
-- Depends on: 145_action_assign_ai_team_member.sql (actions.agent_run_status),
--             144_ai_team_members.sql (ai_team_member)
--
-- Phase 3 of "assign an action to an agent": the coding run executes
-- SERVER-SIDE in an ephemeral Vercel Sandbox (no desktop app required), driven
-- by an Inngest job. agent_run is the durable record of each such run — its
-- status, the sandbox it ran in, the PR it opened, and a log tail for the UI.
--
-- One action can have many runs over time (retries / re-runs); the LATEST run
-- drives actions.agent_run_status.

CREATE TABLE public.agent_run (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  -- The agent that ran. SET NULL (not cascade) so a run's history survives the
  -- teammate being removed from the team.
  ai_team_member_id UUID REFERENCES public.ai_team_member (id) ON DELETE SET NULL,
  -- The human who pressed Start — whose GitHub token authorizes the PR and whose
  -- usage the run is attributed to in the AI Gateway.
  triggered_by UUID REFERENCES auth.users (id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'pr_open', 'completed', 'failed', 'canceled')),

  -- Execution detail
  sandbox_id TEXT,             -- the Vercel Sandbox id, for debugging/teardown
  repo_full_name TEXT,         -- "owner/repo" the run targeted
  pr_url TEXT,                 -- the PR the agent opened, if any
  branch TEXT,                 -- the branch the agent pushed
  error_message TEXT,
  -- Tail of the agent's stdout/log for a peek in the UI (full logs not stored).
  log_tail TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX agent_run_action_idx ON public.agent_run (action_id, created_at DESC);
CREATE INDEX agent_run_workspace_idx ON public.agent_run (workspace_id);
CREATE INDEX agent_run_status_idx ON public.agent_run (status) WHERE status IN ('queued', 'running');

-- ============================================================
-- RLS — workspace-scoped, mirrors action_github_pr
-- ============================================================

ALTER TABLE public.agent_run ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_run_select"
  ON public.agent_run FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "agent_run_insert"
  ON public.agent_run FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "agent_run_update"
  ON public.agent_run FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "agent_run_delete"
  ON public.agent_run FOR DELETE
  USING (public.is_workspace_member(workspace_id));
