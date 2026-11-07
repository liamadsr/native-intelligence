-- Migration 345: automatic model selection (no model picker).
--
-- 1. agent_run.model_tier: the tier a background helper run was given when it
--    started ('fast', 'think' or 'strong', src/lib/ai/model-route.ts). The
--    work-run spec rebuild reads it (run-work-spec-rebuild.ts); NULL means
--    the default, Think, which is what every run did before this column.
--    agent_run.model_tier_by: who decided it ('rule', 'jev', 'timeout', 'cap'
--    or 'fixed'), for the usage rows' model_route: a run refused Strong by the
--    daily cap or the plan logs 'cap'.
--
-- 2. The Strong tier's price: anthropic/claude-sonnet-5.5 as the Vercel AI
--    Gateway lists it (2026-10-15): 2.00 input / 10.00 output USD per million
--    tokens. Provider 'claude' and the app model id, the key log_ai_usage
--    prices an unpriced call from (usageProviderLabel, CHAT_MODELS id).
--    Without the row a Sonnet 5.5 turn falls to the punitive catch-all.
--
-- 3. The old model pins, dropped (Liam, 2026-10-15): workspace.settings
--    ai_models (Settings, AI Models) and each flow action's config.model (the
--    flow model pin). Nothing reads them after this change, and the code
--    before it reads both as optional (a missing value is the default), so
--    this is safe to apply ahead of the deploy.
--
-- Idempotent: the column is added only when missing, the price row only when
-- no effective row exists for the model, and the pins are removed only where
-- present.

ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS model_tier text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_run_model_tier_check'
      AND conrelid = 'public.agent_run'::regclass
  ) THEN
    ALTER TABLE public.agent_run
      ADD CONSTRAINT agent_run_model_tier_check
      CHECK (model_tier IN ('fast', 'think', 'strong'));
  END IF;
END $$;

COMMENT ON COLUMN public.agent_run.model_tier IS
  'Auto model selection tier the run started with (fast, think, strong); NULL is think.';

ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS model_tier_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_run_model_tier_by_check'
      AND conrelid = 'public.agent_run'::regclass
  ) THEN
    ALTER TABLE public.agent_run
      ADD CONSTRAINT agent_run_model_tier_by_check
      CHECK (model_tier_by IN ('rule', 'jev', 'timeout', 'cap', 'fixed'));
  END IF;
END $$;

COMMENT ON COLUMN public.agent_run.model_tier_by IS
  'Who decided model_tier (rule, jev, timeout, cap, fixed); cap means Strong was refused.';

INSERT INTO public.ai_model_costs (provider, model, input_cost_per_million, output_cost_per_million, effective_from)
SELECT 'claude', 'claude-sonnet-5-5', 2.00, 10.00, now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_model_costs c
  WHERE c.provider = 'claude' AND c.model = 'claude-sonnet-5-5' AND c.effective_until IS NULL
);

UPDATE public.workspace
SET settings = settings - 'ai_models'
WHERE settings ? 'ai_models';

UPDATE public.flow f
SET actions = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(a -> 'config') = 'object' AND (a -> 'config') ? 'model'
        THEN jsonb_set(a, '{config}', (a -> 'config') - 'model')
      ELSE a
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(f.actions) WITH ORDINALITY AS t(a, ord)
)
WHERE jsonb_typeof(f.actions) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(f.actions) AS e(a)
    WHERE jsonb_typeof(e.a -> 'config') = 'object' AND (e.a -> 'config') ? 'model'
  );
