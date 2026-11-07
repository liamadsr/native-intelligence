-- Migration 162 — Billing reconciliation helper RPCs (Phase 4 ops, P3-2)
--
-- Read-only auditors used by /api/cron/billing-reconciliation to catch any
-- divergence between the cached wallet balance and the append-only ledger, and
-- any user who has somehow spent past plan + wallet (the §8 invariant should
-- make both impossible — these are the alarm bells if they ever fire).

-- Users whose cached ai_user_credits.balance_usd disagrees with the sum of
-- their ledger rows (tolerance covers numeric scale noise).
CREATE OR REPLACE FUNCTION public.billing_wallet_drift()
RETURNS TABLE (user_id uuid, cached_balance numeric, ledger_balance numeric, diff numeric)
LANGUAGE sql
SECURITY DEFINER
AS $function$
  SELECT c.user_id,
         c.balance_usd AS cached_balance,
         COALESCE(l.total, 0) AS ledger_balance,
         c.balance_usd - COALESCE(l.total, 0) AS diff
  FROM ai_user_credits c
  LEFT JOIN (
    SELECT ai_credit_ledger.user_id, SUM(amount_usd) AS total
    FROM ai_credit_ledger GROUP BY ai_credit_ledger.user_id
  ) l ON l.user_id = c.user_id
  WHERE ABS(c.balance_usd - COALESCE(l.total, 0)) > 0.01;
$function$;

-- Users whose current-period spend exceeds their EFFECTIVE plan allowance +
-- wallet by more than a generous single-request slack ($0.50). Should be empty.
-- Uses resolve_effective_plan so subscribers aren't false-flagged against the
-- free-plan limit.
CREATE OR REPLACE FUNCTION public.billing_overspenders()
RETURNS TABLE (user_id uuid, plan_name text, cost_used numeric, plan_limit numeric, wallet numeric, over_by numeric)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  r record;
  eff ai_plan_definitions;
  v_wallet numeric;
BEGIN
  FOR r IN SELECT up.user_id, up.current_period_cost_usd FROM ai_user_plans up LOOP
    SELECT (rp.plan_def).* INTO eff FROM resolve_effective_plan(r.user_id) rp;
    IF eff.monthly_cost_limit_usd IS NULL THEN CONTINUE; END IF;  -- unlimited plan
    SELECT COALESCE(balance_usd, 0) INTO v_wallet FROM ai_user_credits WHERE ai_user_credits.user_id = r.user_id;
    v_wallet := COALESCE(v_wallet, 0);
    IF r.current_period_cost_usd > eff.monthly_cost_limit_usd + GREATEST(v_wallet, 0) + 0.50 THEN
      user_id := r.user_id;
      plan_name := eff.name;
      cost_used := r.current_period_cost_usd;
      plan_limit := eff.monthly_cost_limit_usd;
      wallet := v_wallet;
      over_by := r.current_period_cost_usd - (eff.monthly_cost_limit_usd + GREATEST(v_wallet, 0));
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;
