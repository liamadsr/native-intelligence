-- ============================================================
-- 468: check_ai_usage_limit's staff exemption names the admins
-- ============================================================
-- Security review 2026-10-31 (docs/SECURITY-REVIEW-2026-10-31.md, "Still
-- open"). The two-argument check_ai_usage_limit (409) gave the subscriber
-- plan to any auth.users email ending in @dial8.ai, so a new Workspace user
-- or alias on the domain had unlimited AI on day one. The app's own billing
-- exemption (src/lib/billing/access.ts) and the admin panel already use the
-- explicit list in src/lib/admin-emails.ts; this matches them.
--
-- KEEP IN STEP with ADMIN_EMAILS in src/lib/admin-emails.ts: the IN list
-- below is that set, lower-cased (src/lib/__tests__/admin-emails-sql.test.ts
-- fails when they differ). Add a person there and here, never a domain.
--
-- The body is DEV's live definition (pg_get_functiondef, md5
-- 38d4b2d09d51b6bb9e64901930e948f9 on 2026-11-07: 409's text, applied on DEV
-- as 408, hence its comment) with ONLY the staff check changed:
--   lower(u.email) LIKE '%@dial8.ai'  ->  lower(btrim(u.email)) IN (<ADMIN_EMAILS>)
-- Same signature, return type, language, SECURITY DEFINER and (no) settings.
-- The one-argument overload delegates to this one and is unchanged.
--
-- Re-runnable; one transaction.

begin;

set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.check_ai_usage_limit(p_user_id uuid, p_chatgpt_plan boolean)
 RETURNS TABLE(allowed boolean, reason text, plan_name text, cost_used numeric, cost_limit numeric, tokens_used integer, token_limit integer, is_paid_plan boolean, usage_reset_date timestamp with time zone, credit_balance_usd numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $$
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
    v_chatgpt_status text;
BEGIN
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.admin_override = true THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    -- Dial8 staff: subscriber plan regardless of subscriptions rows.
    -- The admins by address, never a domain: the same people as ADMIN_EMAILS
    -- in src/lib/admin-emails.ts (keep the two in step; migration 468).
    IF v_plan_def IS NULL AND EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND lower(btrim(u.email)) IN ('liam@dial8.ai')
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

    -- ChatGPT free tier (migration 408): no override, not staff, no live
    -- subscription, but a ChatGPT connection with the plan grant. Allowed only
    -- for a caller that runs AI on the person's own ChatGPT plan
    -- (p_chatgpt_plan); no Dial8 cost or token caps apply, nothing is paid.
    -- Out of plan credits ('exhausted') is allowed too, named: OpenAI refuses
    -- the call itself while the plan is spent, and a try costs Dial8 nothing.
    -- A revoked connection falls through to the default plan
    -- (subscription_required).
    IF v_plan_def IS NULL THEN
        SELECT c.status INTO v_chatgpt_status
        FROM public.chatgpt_connection c
        WHERE c.user_id = p_user_id AND c.plan_enabled;
        IF v_chatgpt_status IN ('active', 'exhausted') THEN
            SELECT COALESCE(c.balance_usd, 0) INTO v_credit_balance
            FROM ai_user_credits c WHERE c.user_id = p_user_id;
            RETURN QUERY SELECT p_chatgpt_plan,
                CASE
                    WHEN NOT p_chatgpt_plan THEN 'chatgpt_plan_unsupported'
                    WHEN v_chatgpt_status = 'exhausted' THEN 'chatgpt_plan_exhausted'
                    ELSE 'chatgpt_plan'
                END::TEXT,
                'ChatGPT plan'::TEXT, 0::NUMERIC, NULL::NUMERIC, 0::INT, NULL::INT, false,
                NULL::timestamptz, COALESCE(v_credit_balance, 0);
            RETURN;
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
$$;

-- CREATE OR REPLACE keeps the grants; restated (as 409) for a database that
-- never had the function.
REVOKE ALL ON FUNCTION public.check_ai_usage_limit(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_ai_usage_limit(uuid, boolean) TO service_role;

commit;

-- Verify (read-only):
--   select position('LIKE ''%@dial8.ai''' in pg_get_functiondef('public.check_ai_usage_limit(uuid, boolean)'::regprocedure)) > 0;   -> false
--   select proacl from pg_proc where oid = 'public.check_ai_usage_limit(uuid, boolean)'::regprocedure;
--     -> {postgres=X/postgres,service_role=X/postgres}
