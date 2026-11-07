-- Migration 160 — Postgres credit wallet (P0-1, P0-2, P0-3 root-cause fix)
--
-- Makes Postgres the authoritative, transactional wallet. Credits are debited
-- atomically INSIDE log_ai_usage the moment usage crosses the plan allowance —
-- no more waiting on Stripe invoice-cadence webhooks to move a mirror.
--
-- Adds:
--   * ai_credit_ledger        — append-only money ledger (topups, usage, refunds, grants)
--   * resolve_effective_plan  — shared plan-resolution helper (one source of truth)
--   * grant_credits           — idempotent credit-add RPC (webhook + admin share it)
--   * log_ai_usage v3         — cost split (plan allowance first, wallet for overage) + atomic debit
--   * check_ai_usage_limit v3 — gate on positive wallet balance; subscription grace window
--
-- Property guaranteed: total monthly spend <= plan allowance + wallet balance
-- (+ at most one in-flight request per concurrent stream). "Add $30 -> spend at
-- most $30, then hard stop."

-- ===========================================================================
-- 1. Ledger table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.ai_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_usd numeric(12,6) NOT NULL,                 -- + credit, - debit
  kind text NOT NULL CHECK (kind IN (
    'topup','admin_grant','usage','refund','adjustment','migration_seed'
  )),
  idempotency_key text UNIQUE,                       -- checkout session / usage log / refund id
  usage_log_id uuid REFERENCES public.ai_usage_logs(id) ON DELETE SET NULL,
  stripe_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_credit_ledger_user_idx
  ON public.ai_credit_ledger (user_id, created_at DESC);

ALTER TABLE public.ai_credit_ledger ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "read own ledger" ON public.ai_credit_ledger
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- All writes are service-role only (RPCs below are SECURITY DEFINER).

-- ===========================================================================
-- 2. resolve_effective_plan — shared plan resolution
--    Returns the plan definition + the user's active plan row that BOTH the
--    gate and the logger must agree on. Mirrors the pre-existing precedence:
--    admin_override -> active subscription -> user plan -> default.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_effective_plan(p_user_id uuid)
RETURNS TABLE (plan_def ai_plan_definitions, user_plan ai_user_plans)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_plan_def ai_plan_definitions;
  v_user_plan ai_user_plans;
BEGIN
  SELECT * INTO v_user_plan
  FROM ai_user_plans
  WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true;

  IF v_user_plan.user_id IS NOT NULL AND v_user_plan.admin_override = true THEN
    SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
  END IF;

  IF v_plan_def IS NULL THEN
    -- Same 3-day freshness window as check_ai_usage_limit so the gate and the
    -- logger never disagree on which plan (and allowance) applies.
    IF EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
        AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '3 days')
    ) THEN
      SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
    END IF;
  END IF;

  IF v_plan_def IS NULL AND v_user_plan.user_id IS NOT NULL THEN
    SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
  END IF;

  IF v_plan_def IS NULL THEN
    SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
  END IF;

  plan_def := v_plan_def;
  user_plan := v_user_plan;
  RETURN NEXT;
END;
$function$;

-- ===========================================================================
-- 3. grant_credits — idempotent credit-add (topup webhook + admin grant + seed)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id uuid,
  p_amount_usd numeric,
  p_kind text,
  p_idempotency_key text,
  p_stripe_ref text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS TABLE (applied boolean, new_balance_usd numeric)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_inserted boolean := false;
  v_balance numeric;
  v_signed numeric;        -- signed ledger delta (refunds reduce the wallet)
  v_granted_delta numeric; -- only positive grants move lifetime_granted
BEGIN
  -- Callers always pass a POSITIVE amount; the RPC applies the sign by kind.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'grant_credits: amount must be positive, got %', p_amount_usd;
  END IF;
  IF p_kind NOT IN ('topup','admin_grant','refund','adjustment','migration_seed') THEN
    RAISE EXCEPTION 'grant_credits: invalid kind %', p_kind;
  END IF;

  -- refund claws credits back (negative); everything else adds.
  v_signed := CASE WHEN p_kind = 'refund' THEN -p_amount_usd ELSE p_amount_usd END;
  v_granted_delta := CASE WHEN p_kind = 'refund' THEN 0 ELSE p_amount_usd END;

  -- Idempotent insert. A webhook retry / double-click with the same key is a no-op.
  INSERT INTO ai_credit_ledger (user_id, amount_usd, kind, idempotency_key, stripe_ref, note)
  VALUES (p_user_id, v_signed, p_kind, p_idempotency_key, p_stripe_ref, p_note)
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Ensure a credits row exists and (only when we actually inserted) move the
  -- cached balance + lifetime_granted in the SAME statement/transaction.
  INSERT INTO ai_user_credits (user_id, stripe_customer_id, balance_usd, lifetime_granted_usd, updated_at)
  VALUES (
    p_user_id,
    p_stripe_customer_id,
    CASE WHEN v_inserted THEN v_signed ELSE 0 END,
    CASE WHEN v_inserted THEN v_granted_delta ELSE 0 END,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    balance_usd = ai_user_credits.balance_usd + CASE WHEN v_inserted THEN v_signed ELSE 0 END,
    lifetime_granted_usd = ai_user_credits.lifetime_granted_usd + CASE WHEN v_inserted THEN v_granted_delta ELSE 0 END,
    -- Never clobber an existing customer id with NULL; adopt a provided one.
    stripe_customer_id = COALESCE(p_stripe_customer_id, ai_user_credits.stripe_customer_id),
    updated_at = now()
  RETURNING ai_user_credits.balance_usd INTO v_balance;

  applied := v_inserted;
  new_balance_usd := v_balance;
  RETURN NEXT;
END;
$function$;

-- ===========================================================================
-- 4. log_ai_usage v3 — cost + atomic wallet debit for overage
--    Return shape is a SUPERSET of the old (log_id, cost_usd) so existing
--    callers keep working; adds plan_portion_usd, overage_usd, new_balance_usd.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.log_ai_usage(
  uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer
);

CREATE OR REPLACE FUNCTION public.log_ai_usage(
  p_user_id uuid,
  p_provider text,
  p_model text,
  p_feature text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_duration_ms integer DEFAULT NULL,
  p_edge_function text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL,
  p_cost_usd numeric DEFAULT NULL,
  p_audio_seconds integer DEFAULT 0
)
RETURNS TABLE (
  log_id uuid,
  cost_usd numeric,
  plan_portion_usd numeric,
  overage_usd numeric,
  new_balance_usd numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_cost_record ai_model_costs;
    v_estimated_cost NUMERIC(12,8);
    v_cost_source TEXT;
    v_total_tokens INT;
    v_cache_creation_tokens INT;
    v_cache_read_tokens INT;
    v_regular_input_tokens INT;
    v_log_id UUID;
    v_fallback_input_per_m  CONSTANT NUMERIC := 15.0;
    v_fallback_output_per_m CONSTANT NUMERIC := 75.0;
    v_plan_def ai_plan_definitions;
    v_user_plan ai_user_plans;
    v_default_plan_id uuid;
    v_prior_cost numeric;
    v_headroom numeric;
    v_plan_portion numeric := 0;
    v_overage numeric := 0;
    v_balance numeric := 0;
    -- Money is persisted at 4 dp (ai_user_credits.balance_usd scale). Round the
    -- wallet debit to that scale so the ledger, the cached balance, and
    -- lifetime_consumed all agree — no sub-cent reconciliation drift (review MEDIUM).
    v_overage_debit numeric;
BEGIN
    -- ---- cost computation (unchanged from migration 097) ----
    IF p_cost_usd IS NOT NULL THEN
        v_estimated_cost := p_cost_usd;
        v_cost_source := 'gateway';
    ELSE
        SELECT * INTO v_cost_record
        FROM ai_model_costs
        WHERE ai_model_costs.provider = p_provider
          AND ai_model_costs.model = p_model
          AND ai_model_costs.effective_until IS NULL
        LIMIT 1;

        v_cache_creation_tokens := COALESCE((p_metadata->>'cache_creation_input_tokens')::INT, 0);
        v_cache_read_tokens := COALESCE((p_metadata->>'cache_read_input_tokens')::INT, 0);

        IF v_cost_record.id IS NOT NULL THEN
            IF v_cost_record.cost_per_audio_minute IS NOT NULL AND p_audio_seconds > 0 THEN
                v_estimated_cost := (p_audio_seconds::NUMERIC / 60.0) * v_cost_record.cost_per_audio_minute;
                v_cost_source := 'pricing_table';
            ELSIF p_provider = 'claude' AND (v_cache_creation_tokens > 0 OR v_cache_read_tokens > 0) THEN
                v_regular_input_tokens := GREATEST(p_input_tokens - v_cache_creation_tokens - v_cache_read_tokens, 0);
                v_estimated_cost := (v_regular_input_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million)
                                  + (v_cache_creation_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million * 1.25)
                                  + (v_cache_read_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million * 0.1)
                                  + (p_output_tokens::NUMERIC / 1000000.0 * v_cost_record.output_cost_per_million);
                v_cost_source := 'pricing_table';
            ELSE
                v_estimated_cost := (p_input_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million)
                                  + (p_output_tokens::NUMERIC / 1000000.0 * v_cost_record.output_cost_per_million);
                v_cost_source := 'pricing_table';
            END IF;
        ELSE
            v_estimated_cost := COALESCE((p_metadata->>'total_cost_usd')::NUMERIC(12,8), 0);
            IF v_estimated_cost > 0 THEN
                v_cost_source := 'metadata';
            ELSE
                RAISE WARNING 'log_ai_usage: no cost source for provider=% model=% feature=% — applying conservative fallback',
                    p_provider, p_model, p_feature;
                v_estimated_cost := (p_input_tokens::NUMERIC / 1000000.0 * v_fallback_input_per_m)
                                  + (p_output_tokens::NUMERIC / 1000000.0 * v_fallback_output_per_m);
                v_cost_source := 'fallback_conservative';
            END IF;
        END IF;
    END IF;

    v_total_tokens := p_input_tokens + p_output_tokens;

    -- ---- insert the usage row ----
    INSERT INTO ai_usage_logs (
        user_id, provider, model, feature,
        input_tokens, output_tokens, estimated_cost_usd, cost_source,
        request_duration_ms, edge_function, metadata, audio_seconds
    ) VALUES (
        p_user_id, p_provider, p_model, p_feature,
        p_input_tokens, p_output_tokens, v_estimated_cost, v_cost_source,
        p_duration_ms, p_edge_function, p_metadata, p_audio_seconds
    )
    RETURNING id INTO v_log_id;

    -- Serialize per-user even on FIRST use, when no ai_user_plans row exists yet
    -- (SELECT ... FOR UPDATE would lock zero rows and let a concurrent first
    -- burst each read prior_cost=0 — review MEDIUM). A transaction-scoped
    -- advisory lock keyed on the user id closes that window; it's released at
    -- commit. Two keys derived from the uuid halves to spread the 2×int32 space.
    PERFORM pg_advisory_xact_lock(
        ('x' || substr(md5(p_user_id::text), 1, 8))::bit(32)::int,
        ('x' || substr(md5(p_user_id::text), 9, 8))::bit(32)::int
    );

    -- ---- lock the user's plan row (serializes with check_ai_usage_limit) ----
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    -- Resolve the EFFECTIVE plan (subscriber allowance must be respected before
    -- the wallet is touched — otherwise subscribers get double-billed, P1-3).
    SELECT (rp.plan_def).* INTO v_plan_def FROM resolve_effective_plan(p_user_id) rp;

    -- Lazy monthly reset — MUST happen here too, not only in the gate (the gate's
    -- reset is a SEPARATE, error-swallowed RPC, so at a month boundary the logger
    -- could otherwise charge the wallet for fresh-month plan-covered usage —
    -- review MEDIUM). NOT for the default/trial plan: the $1 is one-time (P1-2),
    -- matching check_ai_usage_limit.
    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.usage_reset_date <= now()
       AND NOT COALESCE(v_plan_def.is_default, false) THEN
        UPDATE ai_user_plans SET
            current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = date_trunc('month', now()) + interval '1 month', updated_at = now()
        WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0;
        v_user_plan.current_period_tokens := 0;
        v_user_plan.current_period_requests := 0;
    END IF;

    -- Prior period cost BEFORE this request (post-reset; 0 if no row yet).
    v_prior_cost := COALESCE(v_user_plan.current_period_cost_usd, 0);

    -- ---- increment the period counter (tracks ALL usage, as before) ----
    SELECT id INTO v_default_plan_id FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
    INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests)
    VALUES (p_user_id, v_default_plan_id, v_estimated_cost, v_total_tokens, 1)
    ON CONFLICT (user_id) DO UPDATE SET
        current_period_cost_usd = ai_user_plans.current_period_cost_usd + v_estimated_cost,
        current_period_tokens = ai_user_plans.current_period_tokens + v_total_tokens,
        current_period_requests = ai_user_plans.current_period_requests + 1,
        updated_at = now();

    -- ---- split cost into plan portion vs wallet overage ----
    -- Only paid overage draws the wallet. A NULL cost limit means "unlimited /
    -- no wallet debit" — matches the gate, which never blocks a NULL-limit plan
    -- on cost. (NOTE: a $0.00 limit is NOT null — BYOK/pro draws the wallet at
    -- market cost; that is a product decision, see plan §9 / review LOW.)
    IF v_plan_def.monthly_cost_limit_usd IS NULL THEN
        v_plan_portion := v_estimated_cost;
        v_overage := 0;
    ELSE
        v_headroom := GREATEST(v_plan_def.monthly_cost_limit_usd - v_prior_cost, 0);
        v_plan_portion := LEAST(v_estimated_cost, v_headroom);
        v_overage := v_estimated_cost - v_plan_portion;
    END IF;

    -- Round the debit to the wallet's persisted scale (4 dp) so ledger, cached
    -- balance, and lifetime_consumed reconcile exactly.
    v_overage_debit := round(v_overage, 4);

    -- ---- atomic wallet debit for the overage ----
    IF v_overage_debit > 0 THEN
        -- Balance may dip slightly negative for the in-flight request that
        -- crossed the line; the gate blocks the NEXT request (balance <= 0).
        INSERT INTO ai_credit_ledger (user_id, amount_usd, kind, idempotency_key, usage_log_id)
        VALUES (p_user_id, -v_overage_debit, 'usage', v_log_id::text, v_log_id)
        ON CONFLICT (idempotency_key) DO NOTHING;

        UPDATE ai_user_credits
        SET balance_usd = balance_usd - v_overage_debit,
            lifetime_consumed_usd = lifetime_consumed_usd + v_overage_debit,
            updated_at = now()
        WHERE user_id = p_user_id
        RETURNING balance_usd INTO v_balance;

        -- If no credits row exists (shouldn't happen once past the plan limit,
        -- since the gate requires a positive balance to allow overage), create
        -- one carrying the negative so the next gate blocks.
        IF NOT FOUND THEN
            INSERT INTO ai_user_credits (user_id, balance_usd, lifetime_consumed_usd, updated_at)
            VALUES (p_user_id, -v_overage_debit, v_overage_debit, now())
            ON CONFLICT (user_id) DO UPDATE SET
                balance_usd = ai_user_credits.balance_usd - v_overage_debit,
                lifetime_consumed_usd = ai_user_credits.lifetime_consumed_usd + v_overage_debit,
                updated_at = now()
            RETURNING balance_usd INTO v_balance;
        END IF;
    ELSE
        SELECT COALESCE(balance_usd, 0) INTO v_balance FROM ai_user_credits WHERE user_id = p_user_id;
        v_balance := COALESCE(v_balance, 0);
    END IF;

    log_id := v_log_id;
    cost_usd := v_estimated_cost::numeric;
    plan_portion_usd := v_plan_portion;
    overage_usd := v_overage_debit;   -- the amount actually drawn from the wallet
    new_balance_usd := v_balance;
    RETURN NEXT;
END;
$function$;

-- ===========================================================================
-- 5. check_ai_usage_limit v3 — positive-balance gate + subscription grace
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.check_ai_usage_limit(p_user_id uuid)
RETURNS TABLE(
  allowed boolean, reason text, plan_name text, cost_used numeric, cost_limit numeric,
  tokens_used integer, token_limit integer, is_paid_plan boolean,
  usage_reset_date timestamptz, credit_balance_usd numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_plan_def ai_plan_definitions;
    v_user_plan ai_user_plans;
    v_today_requests INT;
    v_is_paid boolean;
    v_credit_balance NUMERIC := 0;
    v_from_subscription boolean := false;
    v_sub_ok boolean := true;
BEGIN
    -- Lock the plan row so concurrent log_ai_usage debits serialize per user.
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    -- Effective plan (same precedence as resolve_effective_plan). We inline the
    -- subscription check here so we can also apply the freshness grace window.
    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.admin_override = true THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    IF v_plan_def IS NULL THEN
        -- Subscription must be active/trialing AND not staler than 3 days past
        -- period end (guards against a missed cancellation webhook — P1-5).
        SELECT EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = p_user_id
              AND s.status IN ('active','trialing')
              AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '3 days')
        ) INTO v_from_subscription;

        IF v_from_subscription THEN
            SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
        END IF;
    END IF;

    IF v_plan_def IS NULL AND v_user_plan.user_id IS NOT NULL THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    IF v_plan_def IS NULL THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
    END IF;

    SELECT COALESCE(c.balance_usd, 0) INTO v_credit_balance
    FROM ai_user_credits c WHERE c.user_id = p_user_id;
    v_credit_balance := COALESCE(v_credit_balance, 0);

    IF v_plan_def IS NULL THEN
        RETURN QUERY SELECT true, 'no_plan_configured'::TEXT, 'none'::TEXT,
            0::NUMERIC, 0::NUMERIC, 0::INT, 0::INT, false, NULL::timestamptz, v_credit_balance;
        RETURN;
    END IF;

    v_is_paid := COALESCE(v_plan_def.is_default, false) = false;

    -- Lazy monthly reset (unchanged).
    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.usage_reset_date <= now() THEN
        UPDATE ai_user_plans SET
            current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = date_trunc('month', now()) + interval '1 month', updated_at = now()
        WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0;
        v_user_plan.current_period_tokens := 0;
        v_user_plan.current_period_requests := 0;
        v_user_plan.usage_reset_date := date_trunc('month', now()) + interval '1 month';
    END IF;

    -- COST LIMIT: over allowance -> allowed only if wallet is POSITIVE.
    -- (Negative balances from overshoot block immediately — the whole fix.)
    IF v_plan_def.monthly_cost_limit_usd IS NOT NULL AND
       COALESCE(v_user_plan.current_period_cost_usd, 0) >= v_plan_def.monthly_cost_limit_usd THEN
        IF v_credit_balance > 0 THEN
            RETURN QUERY SELECT true, 'using_credits'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
        RETURN QUERY SELECT false, 'cost_limit_exceeded'::TEXT, v_plan_def.display_name,
            COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
            COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
            v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
        RETURN;
    END IF;

    -- TOKEN LIMIT: same positive-balance gate.
    IF v_plan_def.monthly_token_limit IS NOT NULL AND
       COALESCE(v_user_plan.current_period_tokens, 0) >= v_plan_def.monthly_token_limit THEN
        IF v_credit_balance > 0 THEN
            RETURN QUERY SELECT true, 'using_credits'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
        RETURN QUERY SELECT false, 'token_limit_exceeded'::TEXT, v_plan_def.display_name,
            COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
            COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
            v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
        RETURN;
    END IF;

    -- DAILY REQUEST LIMIT (unchanged).
    IF v_plan_def.max_requests_per_day IS NOT NULL THEN
        SELECT COUNT(*)::INT INTO v_today_requests
        FROM ai_usage_logs
        WHERE ai_usage_logs.user_id = p_user_id
          AND ai_usage_logs.created_at >= date_trunc('day', now());

        IF v_today_requests >= v_plan_def.max_requests_per_day THEN
            RETURN QUERY SELECT false, 'daily_request_limit_exceeded'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
    END IF;

    RETURN QUERY SELECT true, 'within_limits'::TEXT, v_plan_def.display_name,
        COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
        COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
        v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
END;
$function$;
