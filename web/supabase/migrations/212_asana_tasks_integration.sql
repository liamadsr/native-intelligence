-- ============================================================
-- 212: Asana Tasks Integration
-- ============================================================
-- Adds Asana as an OAuth provider (capability 'tasks'), introduces
-- task_sync_state (per connected account: the workspace/project destination +
-- the Phase-B webhook registration), and action_external_task — the generic
-- action ↔ external-task link table Jira/Linear will reuse.
--
-- Constraint changes follow the DROP-IF-EXISTS + re-ADD pattern of
-- 210_hubspot_crm_integration.sql. Each re-ADD restates the CURRENT full value
-- set (as of migration 210) plus the new asana/tasks values, and keeps each
-- table's existing predicate syntax (user_oauth_tokens uses `= ANY (ARRAY[…])`,
-- connected_account uses `IN (…)`).
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_oauth_tokens: allow provider 'asana' + capability 'tasks'
-- ------------------------------------------------------------
ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_provider_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_provider_check
  CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github', 'hubspot', 'asana']));

ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_capability_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_capability_check
  CHECK (capability = ANY (ARRAY['calendar', 'email', 'both', 'github', 'crm', 'tasks']));

-- ------------------------------------------------------------
-- 2. connected_account: allow provider 'asana' + capability 'tasks'
-- ------------------------------------------------------------
ALTER TABLE connected_account DROP CONSTRAINT IF EXISTS connected_account_provider_check;
ALTER TABLE connected_account ADD CONSTRAINT connected_account_provider_check
  CHECK (provider IN ('google', 'microsoft', 'github', 'hubspot', 'asana'));

ALTER TABLE connected_account DROP CONSTRAINT IF EXISTS connected_account_capability_check;
ALTER TABLE connected_account ADD CONSTRAINT connected_account_capability_check
  CHECK (capability IN ('calendar', 'email', 'github', 'crm', 'tasks'));

-- ------------------------------------------------------------
-- 3. task_sync_state — one row per connected_account (mirrors crm_sync_state
--    from 210). Holds the push DESTINATION (`config`) and, from Phase B, the
--    registered Asana webhook.
--
--    config shape:
--      {
--        "asana_workspace_gid":  "12345",
--        "asana_workspace_name": "Acme",
--        "project_gid":          "67890",
--        "project_name":         "Engineering",
--        "section_map": {
--          "not_started": "1|null", "in_progress": "1|null",
--          "done":        "1|null", "canceled":    "1|null"
--        }
--      }
--
--    webhook_gid / webhook_secret / webhook_registered_at / webhook_pending_at
--    are written by Phase B (Asana→Dial8 read-back); Phase A never populates
--    them. webhook_secret is the X-Hook-Secret Asana hands back on handshake and
--    is used to verify the X-Hook-Signature HMAC on every delivery —
--    service-role only, never exposed to the client (the SELECT policy is scoped
--    to the connecting user, and the settings API projects `config` only).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('asana')),
  account_id uuid NOT NULL REFERENCES public.connected_account (id) ON DELETE CASCADE,

  -- Destination + lifecycle→section mapping (see shape above).
  config jsonb NOT NULL DEFAULT '{}',

  -- Phase B: Asana webhook registration for read-back.
  webhook_gid text,
  webhook_secret text,
  webhook_registered_at timestamptz,
  -- Opens a short single-use window during which exactly one Asana handshake
  -- may claim/replace the secret. Set immediately before `POST /webhooks`;
  -- cleared by the handshake that claims it (and ignored once it ages out), so a
  -- handshake that arrives outside a window we opened is refused.
  webhook_pending_at timestamptz,

  -- Phase B: last full reconciliation sweep (drift repair).
  last_reconcile_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS task_sync_state_workspace_provider_idx
  ON public.task_sync_state (workspace_id, provider);

ALTER TABLE public.task_sync_state ENABLE ROW LEVEL SECURITY;

-- Mirror crm_sync_state's RLS (210:108-114): users read their own rows;
-- service_role (push + echo + Phase-B webhook) manages everything.
CREATE POLICY "Users can read their own task sync state"
  ON public.task_sync_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage task sync state"
  ON public.task_sync_state FOR ALL
  USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 4. action_external_task — the action ↔ external-task link table.
--    Deliberately provider-generic (`provider` + `external_id`) so the Jira and
--    Linear adapters reuse it rather than each minting a sibling table.
--    RLS mirrors action_github_pr (064): any workspace member may view/link/
--    update/unlink.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.action_external_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('asana')),

  -- Provider-side identity. `external_id` is the Asana task gid.
  external_id text NOT NULL,
  external_url text,
  external_title text,

  -- Last-known provider completion state, kept in step by the status echo
  -- (Dial8→Asana) and, from Phase B, by the webhook read-back (Asana→Dial8).
  completed boolean NOT NULL DEFAULT false,
  -- Free-text provider state label (Jira/Linear have real status names; Asana
  -- only has the completed boolean, so this stays null for asana rows).
  external_state_label text,

  created_by uuid REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  -- { code: 'unauthorized' | 'task_deleted' | …, at: <ISO> } — a permanent-ish
  -- failure marker stamped by the echo so it stops re-attempting a dead link.
  -- 'task_deleted' is TERMINAL (only an unlink clears it); 'unauthorized' is
  -- retried on the next status change in case a reconnect fixed the token.
  last_push_error jsonb,

  -- ONE external task per action per provider — the v1 model, enforced in the
  -- database rather than by the push's read-then-create pre-check. Keyed WITHOUT
  -- external_id on purpose: two concurrent pushes (two tabs, or the panel button
  -- racing the AI/MCP tool) each create a task and would arrive here with
  -- DIFFERENT gids, so an external_id-bearing key admits both and leaves the
  -- action double-linked. The loser of the 23505 re-reads the winning row and
  -- deletes the Asana task it just orphaned (src/lib/tasks/asana-push.ts).
  UNIQUE (action_id, provider)
);

-- Phase-B webhook lookup: resource gid → the Dial8 action it belongs to.
CREATE INDEX IF NOT EXISTS action_external_task_provider_external_idx
  ON public.action_external_task (provider, external_id);
CREATE INDEX IF NOT EXISTS action_external_task_workspace_action_idx
  ON public.action_external_task (workspace_id, action_id);

ALTER TABLE public.action_external_task ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace members can view linked external tasks"
  ON public.action_external_task FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "workspace members can link external tasks"
  ON public.action_external_task FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "workspace members can update external task status"
  ON public.action_external_task FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "workspace members can unlink external tasks"
  ON public.action_external_task FOR DELETE
  USING (public.is_workspace_member(workspace_id));
