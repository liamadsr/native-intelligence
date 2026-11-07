-- Migration 145: Assign actions to AI team members
-- Depends on: 022_actions_core_upgrade.sql (actions.assignee_id → member)
--             144_ai_team_members.sql (ai_team_member)
--
-- Lets an action be assigned to an AI team member (an agent) in PARALLEL to the
-- existing human assignee path. Agents are NOT members (member requires a
-- non-null user_id → auth.users), so they get their own nullable FK rather than
-- forcing the member model open — which would break every RLS helper that
-- assumes member.user_id is non-null.
--
-- The human assignee_id (→ member) and the action_assignee join table are left
-- completely untouched. Read paths flatten both columns into a single
-- assignee descriptor; an action's primary assignee is either a member or an
-- AI member, never both in the single-assignee slot.

-- ============================================================
-- 1. Agent assignee column
-- ============================================================

ALTER TABLE public.actions
  ADD COLUMN assignee_ai_member_id UUID
    REFERENCES public.ai_team_member (id) ON DELETE SET NULL;

CREATE INDEX actions_assignee_ai_member_idx
  ON public.actions (assignee_ai_member_id)
  WHERE assignee_ai_member_id IS NOT NULL;

-- ============================================================
-- 2. Agent run lifecycle
-- ============================================================
-- Drives the "Start" button + "agent working" UI on an agent-assigned action.
--   idle     — assigned to an agent, not started (or no agent assigned)
--   starting — Start clicked, launch in flight
--   working  — agent run underway
--   pr_open  — a PR has been linked back to the action
--   failed   — the run errored out
-- PR linkage itself continues to flow through action_github_pr + the GitHub
-- webhook auto-link; this column is just the action-local status.

ALTER TABLE public.actions
  ADD COLUMN agent_run_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (agent_run_status IN ('idle', 'starting', 'working', 'pr_open', 'failed'));
