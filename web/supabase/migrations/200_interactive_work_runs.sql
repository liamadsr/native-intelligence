-- Migration 200: Interactive work runs — mid-run questions + follow-up chat
-- (Loops v3 Phase 3; docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
--
-- Extends the shipped work-proposals system (migs 197/198) so a running work
-- agent can PARK on a question the user answers, and a settled run keeps an
-- interrogable eve session for follow-up chat. Three widenings, no new tables:
--   1. agent_run.status gains 'needs_input' — a NON-terminal, live, cancelable
--      state a run enters when the work agent asks the user something mid-run.
--   2. actions.agent_run_status gains 'needs_input' — the board chip mirror
--      ("waiting on you"); the dispatcher flips it at park, resume flips it back
--      to 'working'.
--   3. agent_run gains session_state + pending_input JSONB (both nullable,
--      shape-checked to objects), and notification.type gains 'work_run_input'.
--
-- SAFETY: pure widenings + nullable columns — no existing row can be rejected;
-- applies cleanly with data present.

-- ── 1. agent_run.status — add 'needs_input' (DROP+ADD, house pattern 147) ─────
-- The full enumeration is copied from migration 147 verbatim + the new value;
-- DROP+ADD never drops an existing value.
ALTER TABLE public.agent_run DROP CONSTRAINT IF EXISTS agent_run_status_check;

ALTER TABLE public.agent_run ADD CONSTRAINT agent_run_status_check
  CHECK (status = ANY (ARRAY[
    'queued'::text,
    'running'::text,
    'needs_input'::text,
    'canceling'::text,
    'pr_open'::text,
    'completed'::text,
    'failed'::text,
    'canceled'::text
  ]));

-- ── 2. actions.agent_run_status — add 'needs_input' (DROP+ADD) ────────────────
-- Migration 145 declared the inline CHECK → Postgres auto-named it
-- actions_agent_run_status_check. DROP+ADD with the full existing set + the new
-- value.
ALTER TABLE public.actions
  DROP CONSTRAINT IF EXISTS actions_agent_run_status_check;
ALTER TABLE public.actions
  ADD CONSTRAINT actions_agent_run_status_check
  CHECK (agent_run_status IN (
    'idle', 'starting', 'working', 'needs_input', 'pr_open', 'failed'
  ));

-- ── 3. agent_run interaction columns ─────────────────────────────────────────
-- session_state: the eve resume + replay handle for THIS run's durable session,
--   { continuationToken: text, streamIndex: int, settleStreamIndex?: int }.
--   Written at EVERY park (a question park, the post-settle park, each
--   post-follow-up-turn park). The three fields play THREE distinct roles:
--     • continuationToken — the SEND capability (advances every turn; in the chat
--       route it is captured from the send() RESPONSE, since an aborted stream
--       resets eve's post-drain state to a tokenless initial state).
--     • streamIndex — the ADVANCING read cursor a follow-up POST resumes streaming
--       from (so it streams only the new turn, not a replay of the prior one).
--     • settleStreamIndex — the FROZEN follow-up-transcript boundary, stamped once
--       when the run reaches a terminal park and preserved thereafter; GET /chat
--       replay reads from here so a reload reconstructs the full transcript.
--   SERVER-ONLY: never returned by any account API route.
-- pending_input: present iff status='needs_input',
--   { requestId, approveOptionId, denyOptionId, questions, askedAt }. Cleared
--   on resume. `questions` is the request tool's input (QuestionPicker-shaped).
ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS session_state JSONB,
  ADD COLUMN IF NOT EXISTS pending_input JSONB;

ALTER TABLE public.agent_run
  ADD CONSTRAINT agent_run_session_state_is_object
  CHECK (session_state IS NULL OR jsonb_typeof(session_state) = 'object');
ALTER TABLE public.agent_run
  ADD CONSTRAINT agent_run_pending_input_is_object
  CHECK (pending_input IS NULL OR jsonb_typeof(pending_input) = 'object');

-- ── 4. notification.type — add 'work_run_input' (DROP+ADD, house pattern) ─────
-- Full enumeration copied from migration 197 verbatim + the new value.
-- target_type 'agent_run' (added in 197) already covers the deep-link target.
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
  'work_run_ready',
  'work_run_input'
]));

-- ── 5. Drop the member-wide agent_run UPDATE policy ──────────────────────────
-- Phase 3 adds interaction-control state to agent_run — session_state (the eve
-- resume/send token), pending_input (the eve HITL requestId + approve/deny option
-- ids the resume driver echoes back), status, sandbox_id. The member-wide UPDATE
-- policy (migs 146/149: USING/WITH CHECK is_workspace_member(workspace_id)) let ANY
-- workspace member — not just the run's starter — rewrite those columns via direct
-- PostgREST, bypassing the app routes' starter-only steering gate (triggered_by ===
-- caller). Concretely a non-starter member could: overwrite pending_input.questions
-- with attacker-crafted questions the starter then answers under their identity;
-- corrupt session_state.continuationToken to fail the resume send and kill the run
-- (a one-PATCH DoS); or copy another run's sandbox_id/session_state to steer a
-- session they didn't start. Since Phase 3, ALL agent_run writes are service-role
-- via API routes that authorize themselves (the respond/cancel/chat routes check
-- membership + triggered_by, then write with the service client). No client
-- component updates agent_run directly. So the member UPDATE policy is pure attack
-- surface — drop it. (SELECT/INSERT/DELETE policies are UNTOUCHED.)
DROP POLICY IF EXISTS "agent_run_update" ON public.agent_run;

-- ACCEPTED RISK (documented, not closed here): session_state is still member-READABLE
-- via the member-wide SELECT policy — over Supabase Realtime (agent_run is in the
-- supabase_realtime publication with REPLICA IDENTITY FULL, so UPDATE payloads carry
-- the full row) and via direct PostgREST SELECT. The continuationToken it exposes is
-- NOT a standalone capability: the work-agent eve mount admits only shared-secret /
-- vercel-OIDC / loopback auth (no cookie/JWT path), so a browser holding the token
-- cannot send into the session without AGENT_RUN_INTERNAL_SECRET, which never reaches
-- the browser. The GET /api/account/agent-runs/[id] route already strips session_state
-- from its response. Column-level REVOKE or a separate table would close the realtime/
-- PostgREST read door if this is later deemed insufficient; deferred as defense-in-depth.
