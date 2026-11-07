-- Migration 245: re-price DeepSeek V4 Flash / Pro in ai_model_costs to what the
-- Vercel AI Gateway actually charges.
--
-- Migration 207 seeded DeepSeek's own list prices as of 2026-07-21
-- (flash 0.14 / 0.28, pro 0.435 / 0.87 USD per million tokens). Two things
-- changed since:
--   1. DeepSeek raised its direct-API prices on 2026-08-16 and moved to
--      peak/off-peak billing (flash 0.22–0.44 / 0.66–1.32, pro 0.66–1.32 /
--      1.98–3.96).
--   2. Dial8 does not buy from DeepSeek directly — every call goes through the
--      Gateway, which serves these models from third-party hosts at a flat
--      rate with no peak surcharge. The Gateway catalog lists (2026-09-03):
--        deepseek/deepseek-v4-flash   0.08 input / 0.18 output
--        deepseek/deepseek-v4-pro     0.66 input / 1.98 output
--
-- The log_ai_usage RPC prices a call from the row whose effective_until IS
-- NULL, so a price change is: close the current row (set effective_until) and
-- insert the new one. Old ai_usage_logs keep their already-computed cost.
--
-- This matters more now that DeepSeek V4 Flash is the default for every AI
-- surface (Settings → AI Models, same PR): the 207 prices overbilled Flash
-- input by 1.75x and output by 1.55x against what the Gateway charges.
--
-- Idempotent: a model is only touched when its currently-effective row does
-- not already carry the target price. Applied to DEV + PROD via MCP on
-- 2026-09-03; kept here for history/parity.

DO $$
DECLARE
  target RECORD;
  now_ts timestamptz := now();
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('deepseek', 'deepseek-v4-flash', 0.08::numeric, 0.18::numeric),
      ('deepseek', 'deepseek-v4-pro',   0.66::numeric, 1.98::numeric)
    ) AS v(provider, model, inp, outp)
  LOOP
    -- Skip when the live row already matches (re-run safe).
    IF EXISTS (
      SELECT 1 FROM ai_model_costs c
      WHERE c.provider = target.provider AND c.model = target.model
        AND c.effective_until IS NULL
        AND c.input_cost_per_million = target.inp
        AND c.output_cost_per_million = target.outp
    ) THEN
      CONTINUE;
    END IF;

    UPDATE ai_model_costs
    SET effective_until = now_ts
    WHERE provider = target.provider AND model = target.model
      AND effective_until IS NULL;

    INSERT INTO ai_model_costs (provider, model, input_cost_per_million, output_cost_per_million, effective_from)
    VALUES (target.provider, target.model, target.inp, target.outp, now_ts);
  END LOOP;
END $$;
