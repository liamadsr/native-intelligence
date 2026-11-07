-- Migration 199 — Subscription-aligned AI allowance reset (billing incident fix)
--
-- INCIDENT (confirmed in prod, 2026-07):
--   A subscriber's monthly AI allowance (ai_user_plans.current_period_cost_usd,
--   $8/mo for the `subscriber` plan) reset on CALENDAR-MONTH boundaries
--   (usage_reset_date = date_trunc('month', now()) + interval '1 month'), while
--   their Stripe subscription bills on the SIGNUP ANNIVERSARY (e.g. the 14th).
--   Nothing realigned the counter when the subscription renewed, so a subscriber
--   who paid on the 14th got zero fresh allowance (the counter still read "$18
--   used since the 1st"). Their usage then silently drained their prepaid credit
--   wallet to negative and hard-blocked them. The billing UI meanwhile promised
--   "Resets {subscriptions.current_period_end}" — anniversary alignment the
--   backend never implemented.
--
-- FIX (semantics):
--   For NON-default (paid) plans, the allowance period aligns to the Stripe
--   billing period when one exists. Let
--     v_sub_period_end := max(current_period_end) over the user's active/trialing
--                         subscriptions WHERE current_period_end > now()
--   Only FUTURE period ends qualify for alignment. (The existing 3-day-grace
--   subquery used for PLAN RESOLUTION must NOT be reused here: grace keeps a
--   just-lapsed subscriber on their plan for a few days, but a stale/past period
--   end must never drive the allowance-reset date.)
--
--   Reset condition (replaces `usage_reset_date <= now()`):
--     usage_reset_date <= now()
--     OR (v_sub_period_end IS NOT NULL AND usage_reset_date IS DISTINCT FROM v_sub_period_end)
--   The second clause makes a mid-period renewal (new period end written to
--   `subscriptions` by the Stripe webhook / reconcile cron) grant a fresh
--   allowance on the very next request, and self-corrects any drift.
--
--   New reset date on reset:
--     COALESCE(v_sub_period_end, date_trunc('month', now()) + interval '1 month')
--
--   Cancelling-stale suppression: clause 1 is additionally suppressed while a
--   CANCELLING subscription sits past its period end, i.e. when
--     EXISTS (... status IN ('active','trialing') AND cancel_at_period_end
--             AND current_period_end <= now())
--   Without this, a subscriber who set cancel_at_period_end and reached their
--   period end (which post-199 EQUALS usage_reset_date) would get a free
--   calendar-fallback allowance in the window before the
--   customer.subscription.deleted webhook downgrades them — while the 3-day
--   plan-resolution grace still resolves them to the paid plan. Clause 2 is
--   untouched: cancel-then-resubscribe still earns a fresh allowance through
--   the NEW subscription's future period end, which is correct. Granted subs
--   (cancel_at_period_end false, NULL period end) and users with no
--   subscription rows never match the EXISTS — behavior identical for them.
--
--   First-usage alignment: when log_ai_usage creates the ai_user_plans row
--   (first-ever usage), the INSERT sets usage_reset_date to the same
--   COALESCE(sub period end, calendar) expression instead of taking the
--   column's calendar-month DEFAULT. Otherwise an already-subscribed user's
--   first row would be born misaligned and the NEXT call's IS-DISTINCT-FROM
--   clause would fire, wiping the first request's usage.
--
--   ACCEPTED TRADE-OFF (renewal-window double reset): between a subscription
--   period ending and Stripe's invoice webhook writing the new period end
--   (typically ~1h; worst-case ~24h via the reconcile cron), clause 1 resets
--   the counter with the calendar fallback; when the webhook lands, clause 2
--   realigns and zeroes again, discarding whatever was metered during the gap.
--   This is deliberately generous: the alternative — holding the old counter
--   until sync — would block a just-paid subscriber, which is the exact
--   incident this migration fixes. The giveaway is bounded to the gap window's
--   usage only, and it never produces wrong wallet debits (the counter is at 0
--   during the gap, so nothing spills to credits).
--
--   Default/free plan semantics are UNCHANGED — the $1 is a one-time trial that
--   is never lazily reset (the NOT COALESCE(v_plan_def.is_default,false) guard
--   stays exactly as in migration 161).
--
--   Admin-granted subscriptions carry stripe_subscription_id LIKE 'granted_%'
--   with current_period_end IS NULL, so they naturally fall back to calendar
--   month via the NULL/future filter — no special-casing needed.
--
-- These bodies are based verbatim on migration 161 (the verified live-prod
-- definitions); ONLY the reset logic changes. Signatures, SECURITY DEFINER,
-- the FOR UPDATE row lock, the advisory lock in log_ai_usage, statement
-- ordering, and every other branch are preserved.

-- ---------------------------------------------------------------------------
-- reset_expired_ai_user_plans: the daily-cron sweeper. Now also resets +
-- realigns dormant paid-plan rows whose qualifying (future, max-per-user)
-- subscription period end differs from usage_reset_date, so a renewal becomes
-- visible within a day even for users who make no AI requests. Stays a
-- set-based UPDATE. The default/free plan is still skipped.
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

    -- Per-user qualifying subscription period end: future-only, max across the
    -- user's active/trialing subscriptions; NULL when none qualifies. A
    -- correlated scalar subquery (not a FROM LATERAL) because Postgres forbids
    -- referencing the UPDATE target from a FROM-clause entry.
    UPDATE ai_user_plans p
    SET
        current_period_cost_usd = 0,
        current_period_tokens = 0,
        current_period_requests = 0,
        -- Align to the subscription's future period end when one exists,
        -- else fall back to the calendar month.
        usage_reset_date = COALESCE(
          (SELECT max(s.current_period_end) FROM subscriptions s
             WHERE s.user_id = p.user_id AND s.status IN ('active','trialing')
               AND s.current_period_end > now()),
          date_trunc('month', now()) + interval '1 month'),
        updated_at = now()
    WHERE
      -- (a) the calendar/anniversary period is over — UNLESS a cancelling
      --     subscription sits past its period end (the pre-webhook window
      --     where grace still resolves the paid plan: no free reset), OR
      -- (b) a fresh subscription period end differs from what's stored (renewal).
      (
        (
          p.usage_reset_date <= now()
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = p.user_id AND s.status IN ('active','trialing')
              AND s.cancel_at_period_end = true
              AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()
          )
        )
        OR (
          (SELECT max(s.current_period_end) FROM subscriptions s
             WHERE s.user_id = p.user_id AND s.status IN ('active','trialing')
               AND s.current_period_end > now()) IS NOT NULL
          AND p.usage_reset_date IS DISTINCT FROM
            (SELECT max(s.current_period_end) FROM subscriptions s
               WHERE s.user_id = p.user_id AND s.status IN ('active','trialing')
                 AND s.current_period_end > now())
        )
      )
      -- One-time trial: never reset the free/default plan's spend counter.
      AND p.plan_id IS DISTINCT FROM v_default_plan_id;

    GET DIAGNOSTICS v_rows_reset = ROW_COUNT;
    RETURN v_rows_reset;
END;
$function$;

-- ---------------------------------------------------------------------------
-- check_ai_usage_limit: lazy reset now aligns to the subscription period end.
-- Only the lazy-reset block changes; the 14-day trial cutoff, the cost/token/
-- daily-request guards, and every RETURN shape are identical to migration 161.
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

    -- Subscription-aligned lazy reset — but NOT for the default (one-time-$1)
    -- plan. A FUTURE, max-across-subscriptions period end drives alignment; the
    -- 3-day grace window (used only for plan resolution above) is deliberately
    -- excluded so a stale/past period end never sets the allowance date.
    SELECT max(s.current_period_end) INTO v_sub_period_end
    FROM subscriptions s
    WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
      AND s.current_period_end > now();

    -- A cancelling subscription past its period end suppresses the expiry
    -- reset: grace still resolves the paid plan pre-webhook, and handing out a
    -- calendar-fallback allowance then would be a free post-cancel refill.
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
-- log_ai_usage: the lazy reset must ALSO align to the subscription period end
-- (and still skip the default/trial plan). The reset stays BEFORE v_prior_cost
-- is captured, and the local v_user_plan mirror (including usage_reset_date) is
-- zeroed/updated exactly as before. Everything else is identical to mig 161.
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
    v_sub_period_end timestamptz; v_cancelling_stale boolean := false; v_new_reset timestamptz;
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
    -- Subscription-aligned lazy reset (skips default/trial). FUTURE, max period
    -- end drives alignment; the 3-day grace window is excluded here on purpose.
    SELECT max(s.current_period_end) INTO v_sub_period_end
    FROM subscriptions s
    WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
      AND s.current_period_end > now();
    -- Cancelling sub past its period end: suppress the expiry reset (no free
    -- post-cancel refill in the pre-webhook grace window).
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
        UPDATE ai_user_plans SET current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = v_new_reset, updated_at = now() WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0; v_user_plan.current_period_tokens := 0; v_user_plan.current_period_requests := 0;
        v_user_plan.usage_reset_date := v_new_reset;
    END IF;
    v_prior_cost := COALESCE(v_user_plan.current_period_cost_usd, 0);
    SELECT id INTO v_default_plan_id FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
    -- First-ever usage: the freshly created row must be born ALIGNED, not on
    -- the column's calendar DEFAULT — else the next call's IS-DISTINCT-FROM
    -- clause would immediately reset it and wipe this request's usage. The
    -- conflict branch deliberately leaves usage_reset_date alone.
    INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (p_user_id, v_default_plan_id, v_estimated_cost, v_total_tokens, 1,
            COALESCE(v_sub_period_end, date_trunc('month', now()) + interval '1 month'))
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
