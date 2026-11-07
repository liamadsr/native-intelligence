-- ============================================================
-- 216: Jira Tasks Integration
-- ============================================================
-- Jira Cloud is the SECOND provider through the task-sync seams Asana opened in
-- 212 (task_sync_state + action_external_task, both written provider-generic on
-- purpose). Almost nothing structural is needed: no new tables, and
-- `external_state_label` was already provisioned in 212 for exactly this
-- provider ("Jira/Linear have real status names"), with every index keyed on
-- `provider` as a VALUE rather than per-provider.
--
-- ONE new column, `action_external_task.external_scope` (section 5), because
-- Asana's assumption that an external id identifies a task on its own does not
-- hold for Jira — see there.
--
-- What IS needed is the four CHECK constraints that hardcode the provider list.
-- They are the single place 212's stated "so the Jira and Linear adapters reuse
-- it" intent is contradicted by the enforced schema — every Jira INSERT fails at
-- the DB layer until they're widened, however correct the application code is.
--
-- Constraint changes follow the DROP-IF-EXISTS + re-ADD pattern of 212 (itself
-- from 210_hubspot_crm_integration.sql). Each re-ADD restates the CURRENT full
-- value set (as of 212) plus 'jira', and keeps each table's existing predicate
-- syntax (user_oauth_tokens uses `= ANY (ARRAY[…])`, connected_account and the
-- two 212 tables use `IN (…)`).
--
-- The capability CHECKs are untouched: Jira reuses the 'tasks' capability Asana
-- introduced, so both already accept it.
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_oauth_tokens: allow provider 'jira'
-- ------------------------------------------------------------
ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_provider_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_provider_check
  CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github', 'hubspot', 'asana', 'jira']));

-- ------------------------------------------------------------
-- 2. connected_account: allow provider 'jira'
-- ------------------------------------------------------------
ALTER TABLE connected_account DROP CONSTRAINT IF EXISTS connected_account_provider_check;
ALTER TABLE connected_account ADD CONSTRAINT connected_account_provider_check
  CHECK (provider IN ('google', 'microsoft', 'github', 'hubspot', 'asana', 'jira'));

-- ------------------------------------------------------------
-- 3. task_sync_state: allow provider 'jira'
--
--    The Jira `config` shape (explicit user picks ONLY — a guessed value is
--    never persisted, the lesson Asana's picker paid for):
--      {
--        "cloud_id":        "…",                       -- accessible-resources id
--        "site_name":       "Acme",
--        "site_url":        "https://acme.atlassian.net",
--        "project_id":      "10000",
--        "project_key":     "ENG",
--        "project_name":    "Engineering",
--        "issue_type_id":   "10001",
--        "issue_type_name": "Task",
--        "status_map": {
--          "not_started": "<statusId>|null", "in_progress": "<statusId>|null",
--          "done":        "<statusId>|null", "canceled":    "<statusId>|null"
--        }
--      }
--
--    Webhook columns diverge from Asana's usage and the difference is
--    deliberate: `webhook_gid` holds the dynamic webhook's `createdWebhookId`
--    (stringified) and `webhook_registered_at` the last successful
--    register/refresh (Atlassian expires a dynamic webhook 30 days after
--    create/refresh, so that timestamp drives the refresh sweep).
--    `webhook_secret` and `webhook_pending_at` stay NULL FOREVER for jira rows:
--    Atlassian has no handshake to open a window for and mints no secret —
--    dynamic-webhook deliveries are UNSIGNED, which is why the Jira receiver
--    treats every delivery as an untrusted wake-up trigger and re-fetches the
--    issue over an authenticated call instead of trusting the payload.
-- ------------------------------------------------------------
ALTER TABLE public.task_sync_state DROP CONSTRAINT IF EXISTS task_sync_state_provider_check;
ALTER TABLE public.task_sync_state ADD CONSTRAINT task_sync_state_provider_check
  CHECK (provider IN ('asana', 'jira'));

-- ------------------------------------------------------------
-- 4. action_external_task: allow provider 'jira'
--
--    Identity for a jira row: `external_id` is the Jira issue **id** (the
--    numeric string, NOT the key) — it survives a project move / key rename,
--    which the key does not. `external_url` is the human `{site_url}/browse/
--    {KEY}` permalink (Jira redirects an old key server-side, so a stale one
--    still resolves). `external_state_label` carries the real Jira status name.
--
--    UNIQUE (action_id, provider) from 212 is unchanged and still the guard the
--    push's lost-race handling depends on — one issue per action per provider,
--    and an action may hold BOTH an asana and a jira link.
-- ------------------------------------------------------------
ALTER TABLE public.action_external_task DROP CONSTRAINT IF EXISTS action_external_task_provider_check;
ALTER TABLE public.action_external_task ADD CONSTRAINT action_external_task_provider_check
  CHECK (provider IN ('asana', 'jira'));

-- ------------------------------------------------------------
-- 5. action_external_task.external_scope — WHICH CONTAINER the id belongs to
--
--    Asana gids are globally unique, so 212 could treat `external_id` as a
--    complete identity. Jira issue ids are NOT: they are a per-SITE sequence and
--    Atlassian starts every site at 10000, so id "10001" exists on essentially
--    every Jira site in the world and means something different on each. The
--    identity of a jira link is therefore the PAIR (external_scope, external_id).
--
--    Without it, an admin re-pointing the workspace at a second Atlassian site
--    (a sandbox → production switch, a personal → company site) leaves every
--    existing link resolving against the NEW tenant on the next read-back: the
--    sweep GETs an unrelated issue, and if its statusCategory is `done` it
--    completes a Dial8 action nobody touched. Storing the site the issue was
--    created on makes every later read address the right one, whatever the
--    destination config says today.
--
--    NULLABLE and provider-generic: asana rows leave it null (a gid needs no
--    scope), and the read paths fall back to the configured site for any jira
--    row written before this column existed. No index — it is never a lookup
--    key, only carried alongside a row already found by (provider, external_id)
--    or by workspace.
-- ------------------------------------------------------------
ALTER TABLE public.action_external_task
  ADD COLUMN IF NOT EXISTS external_scope text;

COMMENT ON COLUMN public.action_external_task.external_scope IS
  'Provider-scoped container the external id belongs to. jira: the Atlassian cloudId (issue ids are per-site). asana: null (gids are global).';
