-- ============================================================
-- 210: HubSpot CRM Integration
-- ============================================================
-- Adds HubSpot as an OAuth provider (capability 'crm'), extends the CRM
-- contact/company tables with provider provenance, and introduces
-- crm_sync_state to track backfill + incremental sync progress per
-- connected account.
--
-- Constraint changes follow the DROP-IF-EXISTS + re-ADD pattern of
-- 064_action_github_prs.sql / 068_oauth_tokens_allow_github_capability.sql.
-- Each re-ADD restates the CURRENT full value set (as of migrations 068/064/091)
-- plus the new hubspot/crm values.
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_oauth_tokens: allow provider 'hubspot' + capability 'crm'
-- ------------------------------------------------------------
ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_provider_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_provider_check
  CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github', 'hubspot']));

ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_capability_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_capability_check
  CHECK (capability = ANY (ARRAY['calendar', 'email', 'both', 'github', 'crm']));

-- ------------------------------------------------------------
-- 2. connected_account: allow provider 'hubspot' + capability 'crm'
-- ------------------------------------------------------------
ALTER TABLE connected_account DROP CONSTRAINT IF EXISTS connected_account_provider_check;
ALTER TABLE connected_account ADD CONSTRAINT connected_account_provider_check
  CHECK (provider IN ('google', 'microsoft', 'github', 'hubspot'));

ALTER TABLE connected_account DROP CONSTRAINT IF EXISTS connected_account_capability_check;
ALTER TABLE connected_account ADD CONSTRAINT connected_account_capability_check
  CHECK (capability IN ('calendar', 'email', 'github', 'crm'));

-- ------------------------------------------------------------
-- 3. contact.source: allow 'hubspot_sync' (re-ADD current 6 values + new)
-- ------------------------------------------------------------
ALTER TABLE public.contact DROP CONSTRAINT IF EXISTS contact_source_check;
ALTER TABLE public.contact ADD CONSTRAINT contact_source_check
  CHECK (source IN ('manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'member', 'hubspot_sync'));

-- ------------------------------------------------------------
-- 4. company: add provider provenance columns
--    (contact already has source_provider + provider_contact_id from 033)
-- ------------------------------------------------------------
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS source_provider text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS provider_company_id text;

-- ------------------------------------------------------------
-- 5. Partial unique indexes for idempotent HubSpot upsert.
--    Scoped to source_provider = 'hubspot' so pre-existing google/microsoft
--    rows (which may share a provider_contact_id namespace) can never collide.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS contact_hubspot_id_key
  ON public.contact (workspace_id, provider_contact_id)
  WHERE source_provider = 'hubspot' AND provider_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS company_hubspot_id_key
  ON public.company (workspace_id, provider_company_id)
  WHERE source_provider = 'hubspot' AND provider_company_id IS NOT NULL;

-- ------------------------------------------------------------
-- 6. crm_sync_state — one row per connected_account (mirrors email_sync_state
--    from 040). Tracks backfill cursors, incremental watermark, and status.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('hubspot')),
  account_id uuid NOT NULL REFERENCES public.connected_account (id) ON DELETE CASCADE,

  -- Backfill paging cursors (HubSpot list `after` tokens).
  companies_cursor text,
  contacts_cursor text,

  -- Incremental watermark: hs_lastmodifieddate boundary. Snapshotted to now()
  -- BEFORE the backfill lists anything, so records modified mid-backfill are
  -- re-caught by the first incremental run. Only ever advanced, never regressed.
  sync_watermark timestamptz,

  initial_import_status text NOT NULL DEFAULT 'pending'
    CHECK (initial_import_status IN ('pending', 'importing_companies', 'importing_contacts', 'complete', 'failed')),
  initial_import_started_at timestamptz,
  initial_import_completed_at timestamptz,

  total_contacts_synced int NOT NULL DEFAULT 0,
  total_companies_synced int NOT NULL DEFAULT 0,

  last_sync_at timestamptz,
  last_sync_error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS crm_sync_state_workspace_idx ON public.crm_sync_state (workspace_id);
CREATE INDEX IF NOT EXISTS crm_sync_state_user_idx ON public.crm_sync_state (user_id);

ALTER TABLE public.crm_sync_state ENABLE ROW LEVEL SECURITY;

-- Mirror email_sync_state's RLS (040:203-209): users read their own rows;
-- service_role (background sync) manages everything.
CREATE POLICY "Users can read their own crm sync state"
  ON public.crm_sync_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage crm sync state"
  ON public.crm_sync_state FOR ALL
  USING (auth.role() = 'service_role');
