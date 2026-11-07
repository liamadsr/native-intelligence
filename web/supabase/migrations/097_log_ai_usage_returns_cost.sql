-- Update log_ai_usage to return both the inserted log id and the computed cost.
-- Callers need the cost back so they can fire Stripe meter events for usage
-- whose cost is computed inside the RPC (e.g. Deepgram audio priced from
-- ai_model_costs, which has no upstream gateway marketCost). Without this,
-- only Gateway-routed calls drove the meter and Deepgram spend never drew
-- down credit grants.
--
-- Also adds an UPDATE-friendly RPC for writing back the Stripe meter event
-- id to ai_usage_logs after the fire-and-forget meter call returns.
--
-- Returning a composite (uuid, numeric) instead of just uuid is a signature
-- change. We drop the old function first because Postgres treats the return
-- type as part of the function identity for CREATE OR REPLACE.

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
