-- ============================================================
-- 244: Dial8 staff are exempt from the subscription gate
-- ============================================================
-- Migration 243 made check_ai_usage_limit refuse anyone without a trialing/
-- active subscription. That swept up Dial8's own employees, who do not buy
-- seats in their own product. The rule is the same one the admin console
-- uses (lib/admin isAuthorizedAdmin, lib/billing/access isDial8Staff): an
-- auth.users email ending in @dial8.ai.
--
-- Placement: right after the admin_override check and BEFORE subscription
-- resolution, so staff land on the subscriber plan (no token cap) whether or
-- not they hold a subscriptions row. Everything else is verbatim from 243.
-- ============================================================

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
    v_override text;
    v_free_until timestamptz;
    v_sub_period_end timestamptz;
    v_cancelling_stale boolean := false;
    v_new_reset timestamptz;
BEGIN
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.admin_override = true THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    -- Dial8 staff: subscriber plan regardless of subscriptions rows.
    IF v_plan_def IS NULL AND EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND lower(u.email) LIKE '%@dial8.ai'
    ) THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
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

    SELECT max(s.current_period_end) INTO v_sub_period_end
    FROM subscriptions s
    WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
      AND s.current_period_end > now();

    SELECT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
          AND s.cancel_at_period_end = true
          AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()
    ) INTO v_cancelling_stale;

    IF v_user_plan.user_id IS NOT NULL
       AND NOT COALESCE(v_plan_def.is_default, false)
       AND (
         (v_user_plan.usage_reset_date <= now() AND NOT v_cancelling_stale)
         OR (v_sub_period_end IS NOT NULL AND v_user_plan.usage_reset_date IS DISTINCT FROM v_sub_period_end)
       ) THEN
        v_new_reset := COALESCE(v_sub_period_end, date_trunc('month', now()) + interval '1 month');
        UPDATE ai_user_plans SET
            current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = v_new_reset, updated_at = now()
        WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0;
        v_user_plan.current_period_tokens := 0;
        v_user_plan.current_period_requests := 0;
        v_user_plan.usage_reset_date := v_new_reset;
    END IF;

    IF COALESCE(v_plan_def.is_default, false) AND v_credit_balance <= 0 THEN
        SELECT (u.raw_user_meta_data->>'trial_end_override') INTO v_override
        FROM auth.users u WHERE u.id = p_user_id;
        v_free_until := NULL;
        IF v_override IS NOT NULL THEN
            BEGIN
                v_free_until := v_override::timestamptz;
            EXCEPTION WHEN OTHERS THEN
                v_free_until := NULL;
            END;
        END IF;
        IF v_free_until IS NULL OR v_free_until <= now() THEN
            RETURN QUERY SELECT false, 'subscription_required'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
    END IF;

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
