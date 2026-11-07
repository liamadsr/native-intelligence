-- Migration 197: Work proposals — loops propose WORK, user approves, an agent
-- executes (Loops v3 Phases 1-2; docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
--
-- Three widenings, no new tables:
--   1. attention_item.kind gains 'work_proposal' — the approval card class for
--      "should I go do this?" (vs today's board-mutation cards).
--   2. agent_run generalizes from "coding run" to "agent work run": a `kind`
--      discriminator plus origin linkage back to the card/proposal and the
--      settle-time result (summary + deliverables) and the declared-resources
--      snapshot. Work runs always carry action_id (the tracked action filed at
--      Start), so agent_run_has_origin (mig 158) holds unchanged.
--   3. notification gains the 'work_run_ready' type and the 'agent_run' deep-
--      link target for the "ready for review" moment.
--
-- SAFETY: pure widenings + nullable columns with defaults — no existing row
-- can be rejected; applies cleanly with data present.

-- ── 1. attention_item.kind ──────────────────────────────────────────────────
-- Inline unnamed CHECK from migration 165 → Postgres auto-named it
-- attention_item_kind_check. DROP+ADD, the house pattern (099/157/172).
ALTER TABLE public.attention_item
  DROP CONSTRAINT IF EXISTS attention_item_kind_check;
ALTER TABLE public.attention_item
  ADD CONSTRAINT attention_item_kind_check
  CHECK (kind IN ('action_card', 'draft_email', 'question', 'work_proposal'));

-- ── 2. agent_run generalization ─────────────────────────────────────────────
ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'coding'
    CHECK (kind IN ('coding', 'workspace')),
  -- Origin card. SET NULL: the card expires/gets swept on its own 7d TTL
  -- schedule; run history must survive it.
  ADD COLUMN IF NOT EXISTS attention_item_id UUID
    REFERENCES public.attention_item (id) ON DELETE SET NULL,
  -- Backing proposed_change (provenance chain: capture → proposal → card → run).
  ADD COLUMN IF NOT EXISTS proposal_id UUID
    REFERENCES public.proposed_change (id) ON DELETE SET NULL,
  -- Settle-time result: the agent's one-paragraph "what I did"...
  ADD COLUMN IF NOT EXISTS result_summary TEXT,
  -- ...and the reviewable artifacts: [{type:'email_draft'|'document'|'action'|
  -- 'entity', id, label, entity_type?}] (WorkDeliverable in
  -- src/lib/agent-run/types.ts — the TS contract is the source of truth,
  -- Postgres only shape-checks the container).
  ADD COLUMN IF NOT EXISTS deliverables JSONB,
  -- Snapshot of the card's declared resources at Start: [{type, id?, label}].
  ADD COLUMN IF NOT EXISTS resources JSONB;

ALTER TABLE public.agent_run
  ADD CONSTRAINT agent_run_deliverables_is_array
  CHECK (deliverables IS NULL OR jsonb_typeof(deliverables) = 'array');
ALTER TABLE public.agent_run
  ADD CONSTRAINT agent_run_resources_is_array
  CHECK (resources IS NULL OR jsonb_typeof(resources) = 'array');

-- The Activity feed reads workspace-kind runs by recency (14d window + live).
CREATE INDEX IF NOT EXISTS agent_run_workspace_kind_idx
  ON public.agent_run (workspace_id, created_at DESC)
  WHERE kind = 'workspace';

-- ── 3. notification widenings ───────────────────────────────────────────────
ALTER TABLE public.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE public.notification ADD CONSTRAINT notification_type_check CHECK (type = ANY (ARRAY[
  'action_assigned',
  'action_unassigned',
  'action_status_changed',
  'action_priority_changed',
  'action_due_soon',
  'action_overdue',
  'action_mentioned',
  'capture_processed',
  'capture_shared',
  'comment_added',
  'comment_reply',
  'decision_confirmed',
  'cycle_started',
  'cycle_ending_soon',
  'share_comment_added',
  'project_status_changed',
  'meeting_starting_soon',
  'followup_reminder',
  'contact_followup_due',
  'relationship_going_stale',
  'email_drafts_ready',
  'feedback_requested',
  'flow_run_output',
  'work_run_ready'
]));

ALTER TABLE public.notification
  DROP CONSTRAINT IF EXISTS notification_target_type_check;
ALTER TABLE public.notification
  ADD CONSTRAINT notification_target_type_check
  CHECK (target_type IN (
    'action', 'capture', 'document', 'project', 'contact',
    'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run'
  ));
