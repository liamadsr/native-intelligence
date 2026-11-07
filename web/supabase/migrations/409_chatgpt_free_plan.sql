-- Migration 409: the ChatGPT free tier's plan (docs/plans/chatgpt-free-tier.md,
-- phase 2).
--
-- A person who signed in with ChatGPT and granted plan usage
-- (chatgpt_connection.plan_enabled, migration 404) may use Dial8 without a
-- subscription: their AI runs on their own ChatGPT plan, never on Dial8's.
--
--   check_ai_usage_limit   a two-argument form (p_user_id, p_chatgpt_plan) with
--                          one new branch, after the admin override, staff and
--                          subscription checks (those still win: a paying
--                          person uses Dial8's models). An 'active' connection
--                          is allowed, reason 'chatgpt_plan', ONLY when the
--                          caller passes p_chatgpt_plan => true: it is an AI
--                          path that runs on the person's own ChatGPT plan.
--                          Every other caller (TS or SQL, e.g. start_chat_helper)
--                          gets refused, reason 'chatgpt_plan_unsupported', so
--                          no unconverted path can run a free user on Dial8's
--                          models. An 'exhausted' connection (the last call
--                          ran out of plan credits) is still allowed for an
--                          opted-in caller, reason 'chatgpt_plan_exhausted':
--                          the next try costs Dial8 nothing, and a plan that
--                          has reset just works again.
--                          Everything else is verbatim from migration 244. The
--                          existing one-argument form stays (same signature and
--                          grants) and calls it with p_chatgpt_plan => false.
--   chatgpt_plan_status()  the CALLER's own connection status ('active' |
--                          'exhausted' | 'revoked', or null), for the web trial
--                          wall. It never returns tokens; chatgpt_connection
--                          itself stays service-role only.
--
-- ⛔ PROD ORDER: apply this BEFORE app code that passes p_chatgpt_plan ships
-- (the call would name an unknown parameter). Applying it early is harmless:
-- without the opt-in, a ChatGPT user is refused, never billed to Dial8.
--
-- Applied by hand, from this file: DEV first, PROD on the owner's word.
-- Safe to run twice. Test: supabase/tests/409_chatgpt_free_plan.sql.
--
-- Renumbered 408 -> 409 on 2026-10-21: main's 408 is merge workspaces' review
-- fixes. DEV already holds these objects (applied as 408_chatgpt_free_plan);
-- the SQL is unchanged, and re-applying it is harmless.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.check_ai_usage_limit(p_user_id uuid, p_chatgpt_plan boolean)
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

    -- ChatGPT free tier (migration 409): no override, not staff, no live
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
$function$;

REVOKE ALL ON FUNCTION public.check_ai_usage_limit(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_ai_usage_limit(uuid, boolean) TO service_role;

-- The one-argument form every existing caller uses (TS and SQL alike) keeps its
-- signature and grants and answers as a caller that does NOT run on the
-- person's plan. It is kept, not removed, and the two-argument form has no
-- default: with p_chatgpt_plan required, a one-argument call can only mean
-- this function.
CREATE OR REPLACE FUNCTION public.check_ai_usage_limit(p_user_id uuid)
RETURNS TABLE(
  allowed boolean, reason text, plan_name text, cost_used numeric, cost_limit numeric,
  tokens_used integer, token_limit integer, is_paid_plan boolean,
  usage_reset_date timestamptz, credit_balance_usd numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    RETURN QUERY SELECT * FROM public.check_ai_usage_limit(p_user_id, false);
END;
$function$;


create or replace function public.chatgpt_plan_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.status
  from public.chatgpt_connection c
  where c.user_id = auth.uid() and c.plan_enabled
$$;

revoke all on function public.chatgpt_plan_status() from public, anon;
grant execute on function public.chatgpt_plan_status() to authenticated, service_role;
