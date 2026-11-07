-- Migration 161 — Trial semantics: one-time $1, 14-day window (P1-2)
--
-- BEFORE: the free (default) plan's counters reset every month, so "free" was
-- actually "$1 of AI every month forever, per email address" — a standing
-- abuse vector (N gmail addresses × $1 × monthly). The UI already advertises a
-- 14-day trial that was never enforced.
--
-- AFTER:
--   * The default plan's usage counter is NEVER auto-reset — the $1 is a
--     one-time trial allowance. (Paid plans still reset monthly.)
--   * A hard 14-day cutoff: once a default-plan user is >14 days past signup,
--     they're blocked (reason 'trial_expired') regardless of remaining dollars,
--     unless they hold credits (wallet still works — a free user CAN top up).
--
-- Trial window can be extended per-user via auth.users.raw_user_meta_data
-- ->> 'trial_end_override' (ISO timestamp), matching /api/billing/status.

-- ---------------------------------------------------------------------------
-- reset_expired_ai_user_plans: skip the default (free/trial) plan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_expired_ai_user_plans()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_rows_reset integer;
    v_default_plan_id uuid;
BEGIN
    SELECT id INTO v_default_plan_id FROM ai_plan_definitions WHERE is_default = true LIMIT 1;

    UPDATE ai_user_plans
    SET
        current_period_cost_usd = 0,
        current_period_tokens = 0,
        current_period_requests = 0,
        usage_reset_date = date_trunc('month', now()) + interval '1 month',
        updated_at = now()
    WHERE usage_reset_date <= now()
      -- One-time trial: never reset the free/default plan's spend counter.
      AND plan_id IS DISTINCT FROM v_default_plan_id;

    GET DIAGNOSTICS v_rows_reset = ROW_COUNT;
    RETURN v_rows_reset;
END;
$function$;

-- ---------------------------------------------------------------------------
-- check_ai_usage_limit: skip lazy reset for the default plan + 14-day cutoff.
-- Only the reset guard and a new trial-window block are added; everything else
-- is identical to migration 160.
-- ---------------------------------------------------------------------------
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
    v_trial_end timestamptz;
    v_override text;
BEGIN
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.admin_override = true THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    IF v_plan_def IS NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
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

    -- Lazy monthly reset — but NOT for the default (one-time-$1) plan.
    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.usage_reset_date <= now()
       AND NOT COALESCE(v_plan_def.is_default, false) THEN
        UPDATE ai_user_plans SET
            current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = date_trunc('month', now()) + interval '1 month', updated_at = now()
        WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0;
        v_user_plan.current_period_tokens := 0;
        v_user_plan.current_period_requests := 0;
        v_user_plan.usage_reset_date := date_trunc('month', now()) + interval '1 month';
    END IF;

    -- 14-day trial cutoff for default-plan users. Credits still let a free user
    -- keep working (they can top up), so only block when balance is not positive.
    IF COALESCE(v_plan_def.is_default, false) AND v_credit_balance <= 0 THEN
        SELECT u.created_at, (u.raw_user_meta_data->>'trial_end_override')
          INTO v_trial_end, v_override
        FROM auth.users u WHERE u.id = p_user_id;
        IF v_override IS NOT NULL THEN
            v_trial_end := v_override::timestamptz;
        ELSE
            v_trial_end := v_trial_end + interval '14 days';
        END IF;
        IF v_trial_end IS NOT NULL AND v_trial_end <= now() THEN
            RETURN QUERY SELECT false, 'trial_expired'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
    END IF;

    -- COST LIMIT
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

    -- TOKEN LIMIT
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

    -- DAILY REQUEST LIMIT
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

-- ---------------------------------------------------------------------------
-- log_ai_usage: the lazy reset must ALSO skip the default/trial plan, else a
-- free user's one-time $1 counter would reset via the logger. Resolve the plan
-- before the reset and guard on is_default (mirrors check_ai_usage_limit).
-- (Only the reset block moved/guarded; the rest is identical to migration 160.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_ai_usage(
  p_user_id uuid, p_provider text, p_model text, p_feature text,
  p_input_tokens integer, p_output_tokens integer, p_duration_ms integer DEFAULT NULL,
  p_edge_function text DEFAULT NULL, p_metadata jsonb DEFAULT NULL,
  p_cost_usd numeric DEFAULT NULL, p_audio_seconds integer DEFAULT 0
)
RETURNS TABLE (log_id uuid, cost_usd numeric, plan_portion_usd numeric, overage_usd numeric, new_balance_usd numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
    v_cost_record ai_model_costs; v_estimated_cost NUMERIC(12,8); v_cost_source TEXT;
    v_total_tokens INT; v_cache_creation_tokens INT; v_cache_read_tokens INT; v_regular_input_tokens INT;
    v_log_id UUID; v_fallback_input_per_m CONSTANT NUMERIC := 15.0; v_fallback_output_per_m CONSTANT NUMERIC := 75.0;
    v_plan_def ai_plan_definitions; v_user_plan ai_user_plans; v_default_plan_id uuid;
    v_prior_cost numeric; v_headroom numeric; v_plan_portion numeric := 0; v_overage numeric := 0;
    v_balance numeric := 0; v_overage_debit numeric;
BEGIN
    IF p_cost_usd IS NOT NULL THEN v_estimated_cost := p_cost_usd; v_cost_source := 'gateway';
    ELSE
        SELECT * INTO v_cost_record FROM ai_model_costs
        WHERE ai_model_costs.provider = p_provider AND ai_model_costs.model = p_model AND ai_model_costs.effective_until IS NULL LIMIT 1;
        v_cache_creation_tokens := COALESCE((p_metadata->>'cache_creation_input_tokens')::INT, 0);
        v_cache_read_tokens := COALESCE((p_metadata->>'cache_read_input_tokens')::INT, 0);
        IF v_cost_record.id IS NOT NULL THEN
            IF v_cost_record.cost_per_audio_minute IS NOT NULL AND p_audio_seconds > 0 THEN
                v_estimated_cost := (p_audio_seconds::NUMERIC / 60.0) * v_cost_record.cost_per_audio_minute; v_cost_source := 'pricing_table';
            ELSIF p_provider = 'claude' AND (v_cache_creation_tokens > 0 OR v_cache_read_tokens > 0) THEN
                v_regular_input_tokens := GREATEST(p_input_tokens - v_cache_creation_tokens - v_cache_read_tokens, 0);
                v_estimated_cost := (v_regular_input_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million)
                                  + (v_cache_creation_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million * 1.25)
                                  + (v_cache_read_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million * 0.1)
                                  + (p_output_tokens::NUMERIC / 1000000.0 * v_cost_record.output_cost_per_million); v_cost_source := 'pricing_table';
            ELSE
                v_estimated_cost := (p_input_tokens::NUMERIC / 1000000.0 * v_cost_record.input_cost_per_million)
                                  + (p_output_tokens::NUMERIC / 1000000.0 * v_cost_record.output_cost_per_million); v_cost_source := 'pricing_table';
            END IF;
        ELSE
            v_estimated_cost := COALESCE((p_metadata->>'total_cost_usd')::NUMERIC(12,8), 0);
            IF v_estimated_cost > 0 THEN v_cost_source := 'metadata';
            ELSE
                v_estimated_cost := (p_input_tokens::NUMERIC / 1000000.0 * v_fallback_input_per_m)
                                  + (p_output_tokens::NUMERIC / 1000000.0 * v_fallback_output_per_m); v_cost_source := 'fallback_conservative';
            END IF;
        END IF;
    END IF;
    v_total_tokens := p_input_tokens + p_output_tokens;
    INSERT INTO ai_usage_logs (user_id, provider, model, feature, input_tokens, output_tokens, estimated_cost_usd, cost_source, request_duration_ms, edge_function, metadata, audio_seconds)
    VALUES (p_user_id, p_provider, p_model, p_feature, p_input_tokens, p_output_tokens, v_estimated_cost, v_cost_source, p_duration_ms, p_edge_function, p_metadata, p_audio_seconds)
    RETURNING id INTO v_log_id;
    PERFORM pg_advisory_xact_lock(
        ('x' || substr(md5(p_user_id::text), 1, 8))::bit(32)::int,
        ('x' || substr(md5(p_user_id::text), 9, 8))::bit(32)::int);
    SELECT * INTO v_user_plan FROM ai_user_plans WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true FOR UPDATE;
    SELECT (rp.plan_def).* INTO v_plan_def FROM resolve_effective_plan(p_user_id) rp;
    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.usage_reset_date <= now() AND NOT COALESCE(v_plan_def.is_default, false) THEN
        UPDATE ai_user_plans SET current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = date_trunc('month', now()) + interval '1 month', updated_at = now() WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0; v_user_plan.current_period_tokens := 0; v_user_plan.current_period_requests := 0;
    END IF;
    v_prior_cost := COALESCE(v_user_plan.current_period_cost_usd, 0);
    SELECT id INTO v_default_plan_id FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
    INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests)
    VALUES (p_user_id, v_default_plan_id, v_estimated_cost, v_total_tokens, 1)
    ON CONFLICT (user_id) DO UPDATE SET
        current_period_cost_usd = ai_user_plans.current_period_cost_usd + v_estimated_cost,
        current_period_tokens = ai_user_plans.current_period_tokens + v_total_tokens,
        current_period_requests = ai_user_plans.current_period_requests + 1, updated_at = now();
    IF v_plan_def.monthly_cost_limit_usd IS NULL THEN v_plan_portion := v_estimated_cost; v_overage := 0;
    ELSE
        v_headroom := GREATEST(v_plan_def.monthly_cost_limit_usd - v_prior_cost, 0);
        v_plan_portion := LEAST(v_estimated_cost, v_headroom);
        v_overage := v_estimated_cost - v_plan_portion;
    END IF;
    v_overage_debit := round(v_overage, 4);
    IF v_overage_debit > 0 THEN
        INSERT INTO ai_credit_ledger (user_id, amount_usd, kind, idempotency_key, usage_log_id)
        VALUES (p_user_id, -v_overage_debit, 'usage', v_log_id::text, v_log_id) ON CONFLICT (idempotency_key) DO NOTHING;
        UPDATE ai_user_credits SET balance_usd = balance_usd - v_overage_debit,
            lifetime_consumed_usd = lifetime_consumed_usd + v_overage_debit, updated_at = now()
        WHERE user_id = p_user_id RETURNING balance_usd INTO v_balance;
        IF NOT FOUND THEN
            INSERT INTO ai_user_credits (user_id, balance_usd, lifetime_consumed_usd, updated_at)
            VALUES (p_user_id, -v_overage_debit, v_overage_debit, now())
            ON CONFLICT (user_id) DO UPDATE SET
                balance_usd = ai_user_credits.balance_usd - v_overage_debit,
                lifetime_consumed_usd = ai_user_credits.lifetime_consumed_usd + v_overage_debit, updated_at = now()
            RETURNING balance_usd INTO v_balance;
        END IF;
    ELSE
        SELECT COALESCE(balance_usd, 0) INTO v_balance FROM ai_user_credits WHERE user_id = p_user_id;
        v_balance := COALESCE(v_balance, 0);
    END IF;
    log_id := v_log_id; cost_usd := v_estimated_cost::numeric; plan_portion_usd := v_plan_portion;
    overage_usd := v_overage_debit; new_balance_usd := v_balance; RETURN NEXT;
END; $function$;

-- ---------------------------------------------------------------------------
-- Free plan: set a daily request cap as a second guard rail (P1-2 defense).
-- The RPC enforces max_requests_per_day when non-NULL.
-- ---------------------------------------------------------------------------
UPDATE ai_plan_definitions SET max_requests_per_day = 200
WHERE is_default = true AND max_requests_per_day IS NULL;
