-- Migration 439: Opus 5.5 runs the main chat, and it picks each helper's model.
--
-- 1. Prices for the models the app now runs (src/lib/ai/models.ts CHAT_MODELS),
--    as the Vercel AI Gateway lists them on 2026-10-26, in USD per million
--    tokens, under the key log_ai_usage prices an unpriced call from: the
--    provider label (usageProviderLabel: 'claude' for Anthropic, the Gateway
--    provider otherwise) and the app model id. A turn is list-priced from
--    this row whenever the Gateway reports no cost for a step (or the turn
--    used web search); without a row it falls to the punitive $15 / $75
--    catch-all, so APPLY THIS MIGRATION BEFORE THE DEPLOY.
--      claude / claude-opus-5-5   4.00 / 20.00  (MAIN_MODEL, the main chat; the `opus` helper)
--      claude / claude-haiku-5-5  0.10 /  0.50  (the `haiku` helper; the Gateway
--                                               charges 0.50 / 2.50 past 100K input
--                                               tokens, which one flat row can't say)
--      openai / gpt-5.6-terra     2.00 / 12.00  (the `gpt-terra` helper)
--      openai / gpt-5.6-luna      0.20 /  1.20  (the `gpt-luna` helper)
--
-- 2. agent_run.helper_model: the roster model a background helper run started
--    on (HELPER_MODELS keys), chosen by the main agent or the rules
--    (src/lib/chat/start-helper.ts). The work-run spec reads it before
--    model_tier (run-work-spec-rebuild.ts); NULL means model_tier's model, as
--    before this column.
--
-- 3. agent_run.model_tier_by gains 'agent': the main agent chose the model.
--
-- Idempotent: each price row only when no effective row exists for the
-- model, the column only when missing, and the check constraints rebuilt.

INSERT INTO public.ai_model_costs (provider, model, input_cost_per_million, output_cost_per_million, effective_from)
SELECT v.provider, v.model, v.input_cost, v.output_cost, now()
FROM (
  VALUES
    ('claude', 'claude-opus-5-5', 4.00::numeric, 20.00::numeric),
    ('claude', 'claude-haiku-5-5', 0.10::numeric, 0.50::numeric),
    ('openai', 'gpt-5.6-terra', 2.00::numeric, 12.00::numeric),
    ('openai', 'gpt-5.6-luna', 0.20::numeric, 1.20::numeric)
) AS v(provider, model, input_cost, output_cost)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_model_costs c
  WHERE c.provider = v.provider AND c.model = v.model AND c.effective_until IS NULL
);

ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS helper_model text;

ALTER TABLE public.agent_run
  DROP CONSTRAINT IF EXISTS agent_run_helper_model_check;
ALTER TABLE public.agent_run
  ADD CONSTRAINT agent_run_helper_model_check
  CHECK (helper_model IN ('flash', 'flash-thinking', 'haiku', 'gpt-luna', 'sonnet', 'gpt-terra', 'opus'));

COMMENT ON COLUMN public.agent_run.helper_model IS
  'The helper roster model (src/lib/ai/models.ts HELPER_MODELS) a background helper run started on; NULL is model_tier''s model.';

ALTER TABLE public.agent_run
  DROP CONSTRAINT IF EXISTS agent_run_model_tier_by_check;
ALTER TABLE public.agent_run
  ADD CONSTRAINT agent_run_model_tier_by_check
  CHECK (model_tier_by IN ('rule', 'jev', 'timeout', 'cap', 'fixed', 'agent'));

COMMENT ON COLUMN public.agent_run.model_tier_by IS
  'Who decided model_tier (rule, jev, timeout, cap, fixed, agent); cap means Strong was refused, agent that the main agent chose the model.';
