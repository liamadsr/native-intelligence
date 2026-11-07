-- Migration 158 — Billing schema snapshot (P3-1)
--
-- The entire billing/usage/credit system was built directly against the live
-- databases and never committed as migrations. This file captures the exact
-- as-built DDL of the billing tables and the two counter-management RPCs so
-- that (a) a fresh environment can be rebuilt, and (b) later billing migrations
-- (159 interim cap, 160 wallet) have a committed base to diff against.
--
-- ZERO behavior change. Everything is guarded (IF NOT EXISTS / OR REPLACE) so
-- applying this to the live DEV/PROD projects — which already have these
-- objects — is a no-op. Introspected from DEV (edrjddsxjoigpbecqgfb) 2026-07-02;
-- verified byte-identical to PROD (bzfthjzyzevjokbuhqci) for all three RPCs.
--
-- NOTE: log_ai_usage and check_ai_usage_limit are re-declared here at their
-- CURRENT (pre-fix) definitions on purpose — this migration is the "before"
-- snapshot. Migrations 159 and 160 replace them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_plan_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  display_name text NOT NULL,
  monthly_cost_limit_usd numeric,
  monthly_token_limit integer,
  max_requests_per_day integer,
  allowed_providers text[] NOT NULL DEFAULT ARRAY['claude','groq','openai'],
  allowed_models text[],
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  description text,
  feature_highlights text[] NOT NULL DEFAULT '{}'::text[],
  price_display text,
  price_subtext text,
  cta_label text,
  cta_href text,
  sort_order integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  badge_text text,
  allowed_model_labels text[] NOT NULL DEFAULT '{}'::text[],
  purchase_action text,
  icon text,
  stripe_price_id text
);

DO $$ BEGIN
  ALTER TABLE public.ai_plan_definitions ADD CONSTRAINT ai_plan_definitions_name_key UNIQUE (name);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_model_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  input_cost_per_million numeric NOT NULL,
  output_cost_per_million numeric NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  cost_per_audio_minute numeric
);

DO $$ BEGIN
  ALTER TABLE public.ai_model_costs
    ADD CONSTRAINT ai_model_costs_provider_model_effective_from_key UNIQUE (provider, model, effective_from);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  feature text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric NOT NULL DEFAULT 0,
  request_duration_ms integer,
  edge_function text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  cost_source text,
  audio_seconds integer NOT NULL DEFAULT 0,
  stripe_meter_event_id text
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
  ON public.ai_usage_logs USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_provider
  ON public.ai_usage_logs USING btree (user_id, provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created
  ON public.ai_usage_logs USING btree (created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_user_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.ai_plan_definitions(id),
  usage_reset_date timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  current_period_cost_usd numeric NOT NULL DEFAULT 0,
  current_period_tokens integer NOT NULL DEFAULT 0,
  current_period_requests integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  admin_override boolean NOT NULL DEFAULT false
);

DO $$ BEGIN
  ALTER TABLE public.ai_user_plans ADD CONSTRAINT ai_user_plans_user_id_key UNIQUE (user_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_user_credits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id text,
  balance_usd numeric(12,4) NOT NULL DEFAULT 0,
  lifetime_granted_usd numeric NOT NULL DEFAULT 0,
  lifetime_consumed_usd numeric NOT NULL DEFAULT 0,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_user_credits_stripe_customer
  ON public.ai_user_credits USING btree (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL,
  stripe_customer_id text,
  status text NOT NULL DEFAULT 'active',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check
    CHECK (status = ANY (ARRAY['active','past_due','canceled','incomplete','trialing']));
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
  ON public.subscriptions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_id
  ON public.subscriptions USING btree (stripe_subscription_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger for subscriptions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_subscriptions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_subscriptions_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_plan_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_costs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_user_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_user_credits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions       ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Plans readable by authenticated" ON public.ai_plan_definitions
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Costs readable by authenticated" ON public.ai_model_costs
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can view own usage" ON public.ai_usage_logs
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can view own plan" ON public.ai_user_plans
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users read own credit balance" ON public.ai_user_credits
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can view own subscriptions" ON public.subscriptions
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- RPC: reset_expired_ai_user_plans  (unchanged snapshot)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reset_expired_ai_user_plans()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_rows_reset integer;
BEGIN
    UPDATE ai_user_plans
    SET
        current_period_cost_usd = 0,
        current_period_tokens = 0,
        current_period_requests = 0,
        usage_reset_date = date_trunc('month', now()) + interval '1 month',
        updated_at = now()
    WHERE usage_reset_date <= now();

    GET DIAGNOSTICS v_rows_reset = ROW_COUNT;
    RETURN v_rows_reset;
END;
$function$;

-- ---------------------------------------------------------------------------
-- RPC: log_ai_usage  (unchanged snapshot — matches migration 097; replaced in 160)
-- ---------------------------------------------------------------------------

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
RETURNS TABLE (log_id uuid, cost_usd numeric)
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
BEGIN
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

    INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests)
    SELECT
        p_user_id,
        (SELECT id FROM ai_plan_definitions WHERE is_default = true LIMIT 1),
        v_estimated_cost,
        v_total_tokens,
        1
    ON CONFLICT (user_id) DO UPDATE SET
        current_period_cost_usd = ai_user_plans.current_period_cost_usd + v_estimated_cost,
        current_period_tokens = ai_user_plans.current_period_tokens + v_total_tokens,
        current_period_requests = ai_user_plans.current_period_requests + 1,
        updated_at = now();

    RETURN QUERY SELECT v_log_id, v_estimated_cost::numeric;
END;
$function$;

-- ---------------------------------------------------------------------------
-- RPC: check_ai_usage_limit  (unchanged snapshot — the PRE-FIX version;
--       migration 159 tightens the credit branches, 160 rewrites for the wallet)
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
BEGIN
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    IF v_user_plan IS NOT NULL AND v_user_plan.admin_override = true THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    IF v_plan_def IS NULL THEN
        IF EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = p_user_id AND s.status IN ('active', 'trialing')
        ) THEN
            SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
        END IF;
    END IF;

    IF v_plan_def IS NULL AND v_user_plan IS NOT NULL THEN
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

    IF v_user_plan IS NOT NULL AND v_user_plan.usage_reset_date <= now() THEN
        UPDATE ai_user_plans SET
            current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = date_trunc('month', now()) + interval '1 month', updated_at = now()
        WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0;
        v_user_plan.current_period_tokens := 0;
        v_user_plan.current_period_requests := 0;
        v_user_plan.usage_reset_date := date_trunc('month', now()) + interval '1 month';
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
