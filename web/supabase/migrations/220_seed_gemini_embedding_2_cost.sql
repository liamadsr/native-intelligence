-- Migration 220: seed ai_model_costs list price for google/gemini-embedding-2.
--
-- The embedding path logs usage with no cost, so the log_ai_usage RPC (mig 158)
-- prices it from ai_model_costs — and with no (google, gemini-embedding-2) row
-- every call lands on the punitive $15/$75-per-Mtok catch-all tagged
-- cost_source='fallback_conservative'. The weekly billing-reconciliation cron
-- has been alerting on these rows since 2026-07-15 (Sentry JAVASCRIPT-NEXTJS-BC
-- family). Dollar impact is ~zero (embedding token counts are tiny) but the
-- alert fires until the row exists.
--
-- List price (USD per million tokens): 0.20 input / 0.00 output.
-- (Numbering skips 218/219, claimed by the eve-channels branch, PR #289.)
--
-- Idempotent: only inserts when no currently-effective row exists.

INSERT INTO ai_model_costs (provider, model, input_cost_per_million, output_cost_per_million, effective_from)
SELECT 'google', 'gemini-embedding-2', 0.20, 0.00, now()
WHERE NOT EXISTS (
  SELECT 1 FROM ai_model_costs c
  WHERE c.provider = 'google' AND c.model = 'gemini-embedding-2' AND c.effective_until IS NULL
);
