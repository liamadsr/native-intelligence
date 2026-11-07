-- ============================================================
-- 217: Linear Tasks Integration
-- ============================================================
-- Linear is the THIRD provider through the task-sync seams Asana opened in 212
-- (task_sync_state + action_external_task, both written provider-generic) and
-- Jira widened in 216. It is also the CHEAPEST of the three at the schema layer:
-- 216 already added the one structural column the family needed
-- (`action_external_task.external_scope`), and Linear does not even use it.
--
-- So this migration is exactly the four CHECK constraints that hardcode the
-- provider list — the same four 216 widened, for the same reason: they are the
-- single place 212's stated "so the Jira and Linear adapters reuse it" intent is
-- contradicted by the enforced schema. Every Linear INSERT fails at the DB layer
-- until they accept the value, however correct the application code is.
--
-- Constraint changes follow the DROP-IF-EXISTS + re-ADD pattern of 216 (itself
-- from 212, itself from 210_hubspot_crm_integration.sql). Each re-ADD restates
-- the CURRENT full value set (as of 216) plus 'linear', and keeps each table's
-- existing predicate syntax (user_oauth_tokens uses `= ANY (ARRAY[…])`,
-- connected_account and the two 212 tables use `IN (…)`).
--
-- The capability CHECKs are untouched: Linear reuses the 'tasks' capability
-- Asana introduced, so they already accept it.
--
-- NO new tables and NO new columns. Two Linear facts are why, and both are
-- worth recording because they are the reasons a reviewer expects columns that
-- are deliberately absent:
--
--   * `external_scope` STAYS NULL for every linear row. It exists because Jira
--     issue ids are a per-SITE sequence that every Atlassian site starts at
--     10000, so a Jira id identifies nothing on its own. Linear issue ids are
--     globally-unique UUIDs — Asana-like, not Jira-like — so there is no
--     container to scope them to and inventing one would be noise on every row.
--
--   * The webhook columns (`webhook_gid`, `webhook_registered_at`,
--     `webhook_secret`, `webhook_pending_at`) stay NULL FOREVER for linear rows,
--     and unlike Jira that is not "no handshake" but "no REGISTRATION AT ALL".
--     Linear webhooks are APP-level: the URL, the resource types and the signing
--     secret are configured once in the Linear OAuth app console, and Linear
--     auto-provisions a webhook per organization that authorizes the app. There
--     is nothing per-account to create, refresh (no 30-day Jira expiry), store
--     or tear down — the signing secret is one app-wide env var
--     (LINEAR_WEBHOOK_SECRET), never a per-row value. Deliveries ARE signed
--     (hex HMAC-SHA256 over the raw body), so unlike Jira's unsigned dynamic
--     webhooks the receiver has a real security boundary; it still re-fetches
--     the issue over an authenticated call, because the signature proves the
--     SENDER and only a re-fetch proves the STATE.
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_oauth_tokens: allow provider 'linear'
-- ------------------------------------------------------------
ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_provider_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_provider_check
  CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github', 'hubspot', 'asana', 'jira', 'linear']));

-- ------------------------------------------------------------
-- 2. connected_account: allow provider 'linear'
-- ------------------------------------------------------------
ALTER TABLE connected_account DROP CONSTRAINT IF EXISTS connected_account_provider_check;
ALTER TABLE connected_account ADD CONSTRAINT connected_account_provider_check
  CHECK (provider IN ('google', 'microsoft', 'github', 'hubspot', 'asana', 'jira', 'linear'));

-- ------------------------------------------------------------
-- 3. task_sync_state: allow provider 'linear'
--
--    The Linear `config` shape:
--      {
--        "organization_id":   "<uuid>",       -- the Linear workspace/org
--        "organization_name": "Acme",
--        "team_id":           "<uuid>",       -- THE gate: no team_id → unconfigured
--        "team_key":          "ENG",
--        "team_name":         "Engineering",
--        "project_id":        "<uuid>|absent", -- OPTIONAL, see below
--        "project_name":      "Q3 Launch",
--        "state_map": {                        -- AUTO-DERIVED, not user-picked
--          "not_started": { "id": "<uuid>", "name": "Todo" },
--          "in_progress": { "id": "<uuid>", "name": "In Progress" },
--          "done":        { "id": "<uuid>", "name": "Done" },
--          "canceled":    { "id": "<uuid>", "name": "Canceled" }
--        },
--        "include_dial8_attribution": true|absent
--      }
--
--    TWO deliberate divergences from the jira config next door:
--
--    * The PROJECT is optional. A Jira issue cannot exist outside a project, so
--      216's gate is the whole site+project+issue-type triple. A Linear issue
--      belongs to a TEAM and may have no project at all, so `team_id` alone is a
--      complete destination and a project is a refinement.
--
--    * `state_map` stores {id, name} PAIRS, where jira's status_map stores bare
--      status-id strings. Two reasons: the map is derived rather than picked, so
--      the UI has no user-chosen label to fall back on and needs the name to
--      render the mapping read-only; and a stored name lets the echo detect that
--      a saved state id has been deleted and re-derive by TYPE instead of
--      failing. It is derived at destination-save time by folding the team's
--      workflow states on `WorkflowState.type` — the stable 7-value enum
--      (triage/backlog/unstarted/started/completed/canceled/duplicate) — which
--      is why Linear needs no bucket→status mapping UI at all.
--
--    A bucket with no state of the right type on the team (a `canceled` entry is
--    the common one — Linear does not guarantee every team has one) is simply
--    ABSENT from the map, and the echo declines that bucket with `no_target_state`
--    rather than writing a guessed state.
-- ------------------------------------------------------------
ALTER TABLE public.task_sync_state DROP CONSTRAINT IF EXISTS task_sync_state_provider_check;
ALTER TABLE public.task_sync_state ADD CONSTRAINT task_sync_state_provider_check
  CHECK (provider IN ('asana', 'jira', 'linear'));

-- ------------------------------------------------------------
-- 4. action_external_task: allow provider 'linear'
--
--    Identity for a linear row: `external_id` is the Linear issue **id** (a
--    UUID). It is permanent AND globally unique, which is why `external_scope`
--    stays NULL here — the Asana stance, not the Jira one.
--
--    The `identifier` ("ENG-123") is deliberately NOT the identity: Linear
--    CHANGES it when an issue moves to another team. It is display-only and is
--    refreshed on every read-back. `external_url` holds `issue.url`, and
--    `external_state_label` holds the workflow state NAME ("In Progress") —
--    the same slot 212 provisioned for exactly this ("Jira/Linear have real
--    status names") and 216 filled with the Jira status name.
--
--    UNIQUE (action_id, provider) from 212 is unchanged and still the guard the
--    push's lost-race handling depends on — one issue per action per provider,
--    and an action may now hold an asana AND a jira AND a linear link.
-- ------------------------------------------------------------
ALTER TABLE public.action_external_task DROP CONSTRAINT IF EXISTS action_external_task_provider_check;
ALTER TABLE public.action_external_task ADD CONSTRAINT action_external_task_provider_check
  CHECK (provider IN ('asana', 'jira', 'linear'));
