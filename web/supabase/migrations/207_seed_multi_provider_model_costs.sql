-- Migration 207: seed ai_model_costs list prices for the PR #255 multi-provider
-- chat models (Kimi K2.6/K3 on moonshotai, DeepSeek V4 Flash/Pro on deepseek).
--
-- Why this exists: the log_ai_usage RPC (mig 158) prices an unpriced call from
-- ai_model_costs, and when NO effective row matches the (provider, model) it
-- falls to a punitive $15/$75-per-Mtok catch-all tagged cost_source=
-- 'fallback_conservative'. On the eve chat path eve 0.22.4 delivers no usable
-- per-turn cost (its harness reads only providerMetadata.gateway.cost, never
-- marketCost), so EVERY Kimi/DeepSeek turn arrives cost-less and, absent these
-- rows, was priced at the $15/$75 catch-all — confirmed live 2026-07-21 (six
-- prod rows all landed fallback_conservative). These list-price rows preempt
-- that fallback so the RPC prices the four models correctly.
--
-- List prices (input/output USD per million tokens):
--   moonshotai/kimi-k2.6            0.95 / 4.00
--   moonshotai/kimi-k3             3.00 / 15.00
--   deepseek/deepseek-v4-flash    0.14 / 0.28
--   deepseek/deepseek-v4-pro     0.435 / 0.87
--
-- NOTE: these rows were ALREADY applied to DEV + PROD on 2026-07-21 via MCP
-- (direct SQL). This migration reproduces that exact seed for history/parity —
-- idempotent, safe to re-run: it only inserts a (provider, model) that has no
-- currently-effective (effective_until IS NULL) row.

INSERT INTO ai_model_costs (provider, model, input_cost_per_million, output_cost_per_million, effective_from)
SELECT v.provider, v.model, v.inp, v.outp, now()
FROM (VALUES
  ('moonshotai', 'kimi-k2.6', 0.95, 4.00),
  ('moonshotai', 'kimi-k3', 3.00, 15.00),
  ('deepseek', 'deepseek-v4-flash', 0.14, 0.28),
  ('deepseek', 'deepseek-v4-pro', 0.435, 0.87)
) AS v(provider, model, inp, outp)
WHERE NOT EXISTS (
  SELECT 1 FROM ai_model_costs c
  WHERE c.provider = v.provider AND c.model = v.model AND c.effective_until IS NULL
);
