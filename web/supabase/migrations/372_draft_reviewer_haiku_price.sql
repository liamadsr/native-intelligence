-- Migration 372: the draft reviewer's price.
--
-- The quality layer (src/lib/writing) reviews automatic email drafts on
-- another vendor than the writer (src/lib/ai/reviewer-model.ts). The drafts
-- are written by DeepSeek V4 Flash, so the reviewer is Claude Haiku 4.5
-- (anthropic/claude-haiku-4.5), logged under feature 'draft_review' with
-- provider 'claude' and the app model id 'claude-haiku-4-5-20251001'
-- (usageProviderLabel, CHAT_MODELS id): the key log_ai_usage prices an
-- unpriced call from. eve reports no per-call cost, so the row decides what a
-- review costs; without one it would fall to the punitive $15/$75 catch-all.
--
-- List price (Anthropic and the Vercel AI Gateway): 1.00 input / 5.00 output
-- USD per million tokens. PROD already has a hand-seeded current row
-- (2026-02-16) at 0.80 / 4.00, Haiku 3.5's price, so an insert-if-missing
-- would keep the wrong one.
--
-- Idempotent, three cases:
--   - a current row at another price: it is closed (effective_until = now())
--     and the new price inserted, so history keeps the old one;
--   - a current row at 1.00 / 5.00: nothing changes;
--   - no current row: the new price is inserted.

UPDATE public.ai_model_costs
SET effective_until = now()
WHERE provider = 'claude'
  AND model = 'claude-haiku-4-5-20251001'
  AND effective_until IS NULL
  AND (input_cost_per_million <> 1.00 OR output_cost_per_million <> 5.00);

INSERT INTO public.ai_model_costs (provider, model, input_cost_per_million, output_cost_per_million, effective_from)
SELECT 'claude', 'claude-haiku-4-5-20251001', 1.00, 5.00, now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_model_costs c
  WHERE c.provider = 'claude' AND c.model = 'claude-haiku-4-5-20251001' AND c.effective_until IS NULL
);
