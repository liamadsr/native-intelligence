-- verify-allowance-reset-alignment.sql
--
-- Self-contained assertion battery for migration 199 (subscription-aligned AI
-- allowance reset). Run on the DEV database AFTER applying migration 199 (the
-- new check_ai_usage_limit / log_ai_usage / reset_expired_ai_user_plans must be
-- live). It creates its own synthetic auth.users + billing rows, exercises the
-- lazy and cron reset paths, records pass/fail booleans, RAISEs on any failure,
-- and rolls everything back — nothing is persisted.
--
-- Usage (psql):    \i scripts/verify-allowance-reset-alignment.sql
-- Usage (MCP):     paste the whole file into execute_sql.
--
-- On success it returns the `_v199_results` table (all pass=true) then rolls
-- back. On failure it RAISEs EXCEPTION with the failing scenario + detail, which
-- aborts and rolls back the transaction.

BEGIN;

-- Results sink. TEMP + ON COMMIT DROP so it never leaks past the rollback.
CREATE TEMP TABLE _v199_results (
  scenario text PRIMARY KEY,
  pass boolean NOT NULL,
  detail text
) ON COMMIT DROP;

DO $battery$
DECLARE
  v_default_plan_id uuid;
  v_sub_plan_id uuid;
  v_sub_limit numeric;      -- subscriber plan's monthly_cost_limit_usd (env-driven)

  -- Synthetic users (fixed UUIDs in a private range so they never collide).
  u_a uuid := '00000000-0000-4199-a000-000000000001'; -- (a) lazy check reset via subscription
  u_b uuid := '00000000-0000-4199-a000-000000000002'; -- (b) lazy log reset via subscription
  u_c uuid := '00000000-0000-4199-a000-000000000003'; -- (c) granted sub (NULL period end) -> calendar
  u_d uuid := '00000000-0000-4199-a000-000000000004'; -- (d) default/free plan -> never reset
  u_e uuid := '00000000-0000-4199-a000-000000000005'; -- (e) stale sub within 3-day grace
  u_f uuid := '00000000-0000-4199-a000-000000000006'; -- (f) cron realigns dormant misaligned row
  u_f2 uuid := '00000000-0000-4199-a000-000000000007'; -- (f) already-aligned row cron must leave alone
  u_g uuid := '00000000-0000-4199-a000-000000000008'; -- (g) first-ever log_ai_usage born aligned
  u_h uuid := '00000000-0000-4199-a000-000000000009'; -- (h) cancelling-stale sub: no free reset
  u_h2 uuid := '00000000-0000-4199-a000-000000000010'; -- (h) control: not cancelling -> reset fires

  v_future timestamptz := date_trunc('day', now()) + interval '20 days'; -- a clean future anniversary
  v_future2 timestamptz := date_trunc('day', now()) + interval '25 days';
  v_stale  timestamptz := now() - interval '1 day';   -- past, but inside the 3-day plan-resolution grace
  v_h_stale timestamptz := now() - interval '1 hour'; -- (h) period end just passed, pre-webhook window
  v_cal    timestamptz := date_trunc('month', now()) + interval '1 month'; -- calendar fallback

  r record;
  v_cost numeric; v_reset timestamptz; v_reqs int;
  v_bal numeric;
BEGIN
  SELECT id INTO v_default_plan_id FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
  SELECT id, monthly_cost_limit_usd INTO v_sub_plan_id, v_sub_limit
  FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
  IF v_default_plan_id IS NULL OR v_sub_plan_id IS NULL THEN
    RAISE EXCEPTION 'setup: could not resolve default/subscriber plan ids (default=%, sub=%)', v_default_plan_id, v_sub_plan_id;
  END IF;
  IF v_sub_limit IS NULL OR v_sub_limit <= 0 THEN
    RAISE EXCEPTION 'setup: subscriber plan has no positive monthly_cost_limit_usd (got %)', v_sub_limit;
  END IF;

  -- ── Synthetic auth.users ──────────────────────────────────────────────────
  -- The `on_auth_user_created` trigger (handle_new_user) fires on insert and
  -- provisions a workspace/member/contact from full_name + email. We supply both
  -- so the trigger succeeds naturally; that scaffolding also rolls back at the
  -- end. (email + full_name given rather than disabling the trigger, so the
  -- battery needs no DDL privilege on auth.users.)
  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
    (u_a, 'v199-a@example.test', jsonb_build_object('full_name','V199 A'), now() - interval '60 days'),
    (u_b, 'v199-b@example.test', jsonb_build_object('full_name','V199 B'), now() - interval '60 days'),
    (u_c, 'v199-c@example.test', jsonb_build_object('full_name','V199 C'), now() - interval '60 days'),
    (u_d, 'v199-d@example.test', jsonb_build_object('full_name','V199 D'), now()), -- fresh: 14-day trial open
    (u_e, 'v199-e@example.test', jsonb_build_object('full_name','V199 E'), now() - interval '60 days'),
    (u_f, 'v199-f@example.test', jsonb_build_object('full_name','V199 F'), now() - interval '60 days'),
    (u_f2, 'v199-f2@example.test', jsonb_build_object('full_name','V199 F2'), now() - interval '60 days'),
    (u_g, 'v199-g@example.test', jsonb_build_object('full_name','V199 G'), now() - interval '60 days'),
    (u_h, 'v199-h@example.test', jsonb_build_object('full_name','V199 H'), now() - interval '60 days'),
    (u_h2, 'v199-h2@example.test', jsonb_build_object('full_name','V199 H2'), now() - interval '60 days');

  -- ════════════════════════════════════════════════════════════════════════
  -- (a) Subscriber with a FUTURE period end that differs from usage_reset_date.
  --     First check_ai_usage_limit call must reset counters AND set
  --     usage_reset_date = period end. Second call is a no-op (idempotent).
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_a, 'sub_test_a', 'active', now() - interval '10 days', v_future);
  -- Pre-mig-199 state: allowance was calendar-aligned and heavily used.
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_a, v_sub_plan_id, v_sub_limit + 5, 12345, 42, v_cal);

  SELECT * INTO r FROM check_ai_usage_limit(u_a);
  SELECT current_period_cost_usd, usage_reset_date, current_period_requests
    INTO v_cost, v_reset, v_reqs FROM ai_user_plans WHERE user_id = u_a;

  INSERT INTO _v199_results VALUES ('a_reset_zeroes_counter', v_cost = 0,
    format('cost_used=%s (want 0)', v_cost));
  INSERT INTO _v199_results VALUES ('a_reset_aligns_date', v_reset = v_future,
    format('usage_reset_date=%s (want %s)', v_reset, v_future));
  INSERT INTO _v199_results VALUES ('a_reset_zeroes_requests', v_reqs = 0,
    format('requests=%s (want 0)', v_reqs));
  INSERT INTO _v199_results VALUES ('a_allowed_within_limits', r.allowed AND r.reason = 'within_limits',
    format('allowed=%s reason=%s', r.allowed, r.reason));

  -- Second call: no drift, counter must stay zero, date unchanged.
  PERFORM * FROM check_ai_usage_limit(u_a);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_a;
  INSERT INTO _v199_results VALUES ('a_idempotent_second_call', v_cost = 0 AND v_reset = v_future,
    format('cost_used=%s reset=%s (want 0 / %s)', v_cost, v_reset, v_future));

  -- ════════════════════════════════════════════════════════════════════════
  -- (b) Same alignment via log_ai_usage. Cost splits against FRESH headroom, so
  --     a spend below the (now reset) limit debits NO credits from the wallet.
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_b, 'sub_test_b', 'active', now() - interval '10 days', v_future);
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_b, v_sub_plan_id, v_sub_limit + 5, 9999, 30, v_cal); -- "already over" pre-reset
  INSERT INTO ai_user_credits (user_id, balance_usd, lifetime_granted_usd) VALUES (u_b, 20, 20);

  -- Log a $1 spend. If the reset fired first, prior_cost=0 and $1 < limit -> no overage.
  SELECT * INTO r FROM log_ai_usage(u_b, 'claude', 'test-model', 'unit', 100, 100, NULL, NULL, NULL, 1.0, 0);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_b;
  SELECT balance_usd INTO v_bal FROM ai_user_credits WHERE user_id = u_b;

  INSERT INTO _v199_results VALUES ('b_reset_then_charge', v_cost = 1.0,
    format('cost_used=%s (want 1.0 = reset to 0 then +1)', v_cost));
  INSERT INTO _v199_results VALUES ('b_reset_aligns_date', v_reset = v_future,
    format('usage_reset_date=%s (want %s)', v_reset, v_future));
  INSERT INTO _v199_results VALUES ('b_no_overage_debit', r.overage_usd = 0 AND r.plan_portion_usd = 1.0,
    format('overage=%s plan_portion=%s (want 0 / 1.0)', r.overage_usd, r.plan_portion_usd));
  INSERT INTO _v199_results VALUES ('b_wallet_untouched', v_bal = 20,
    format('balance=%s (want 20, no debit while under limit)', v_bal));

  -- ════════════════════════════════════════════════════════════════════════
  -- (c) Admin-granted subscription (stripe_subscription_id LIKE 'granted_%',
  --     current_period_end NULL). Expired row must reset to CALENDAR month, not
  --     to a subscription date (there is none).
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_c, 'granted_test_c', 'active', now() - interval '10 days', NULL);
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_c, v_sub_plan_id, 3, 100, 5, now() - interval '2 days'); -- expired

  PERFORM * FROM check_ai_usage_limit(u_c);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_c;
  INSERT INTO _v199_results VALUES ('c_granted_resets', v_cost = 0,
    format('cost_used=%s (want 0)', v_cost));
  INSERT INTO _v199_results VALUES ('c_granted_calendar_fallback', v_reset = v_cal,
    format('usage_reset_date=%s (want calendar %s)', v_reset, v_cal));

  -- ════════════════════════════════════════════════════════════════════════
  -- (d) Default/free plan. Even with an "expired" usage_reset_date, the one-time
  --     trial counter must NEVER be lazily reset (unchanged semantics).
  -- ════════════════════════════════════════════════════════════════════════
  -- Fresh user (created now) so the 14-day trial window is open -> not blocked.
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_d, v_default_plan_id, 0.42, 500, 3, now() - interval '5 days'); -- "expired" but must stick

  SELECT * INTO r FROM check_ai_usage_limit(u_d);
  SELECT current_period_cost_usd, usage_reset_date, current_period_requests
    INTO v_cost, v_reset, v_reqs FROM ai_user_plans WHERE user_id = u_d;
  INSERT INTO _v199_results VALUES ('d_free_never_resets', v_cost = 0.42 AND v_reqs = 3 AND v_reset = (now() - interval '5 days')::timestamptz,
    format('cost_used=%s reqs=%s reset unchanged? (want 0.42 / 3)', v_cost, v_reqs));

  -- ════════════════════════════════════════════════════════════════════════
  -- (e) Stale subscription: period end in the PAST but inside the 3-day plan-
  --     resolution grace. Grace must NOT drive alignment (the stale date is not
  --     "future"), so no premature reset while usage_reset_date is still future;
  --     and an EXPIRED row still resets to the CALENDAR fallback (not the stale
  --     date).
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_e, 'sub_test_e', 'active', now() - interval '31 days', v_stale);
  -- e1: usage_reset_date is FUTURE (calendar) and no future sub end -> no reset.
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_e, v_sub_plan_id, 4, 200, 7, v_cal);

  PERFORM * FROM check_ai_usage_limit(u_e);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_e;
  INSERT INTO _v199_results VALUES ('e_stale_no_premature_reset', v_cost = 4 AND v_reset = v_cal,
    format('cost_used=%s reset=%s (want 4 / calendar unchanged — stale end must not realign)', v_cost, v_reset));

  -- e2: now make the row EXPIRED. It must reset, but to the calendar fallback,
  -- NEVER to the stale past subscription end.
  UPDATE ai_user_plans SET usage_reset_date = now() - interval '1 hour', current_period_cost_usd = 4 WHERE user_id = u_e;
  PERFORM * FROM check_ai_usage_limit(u_e);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_e;
  INSERT INTO _v199_results VALUES ('e_expired_calendar_not_stale', v_cost = 0 AND v_reset = v_cal,
    format('cost_used=%s reset=%s (want 0 / calendar %s, NOT stale %s)', v_cost, v_reset, v_cal, v_stale));

  -- ════════════════════════════════════════════════════════════════════════
  -- (f) reset_expired_ai_user_plans(): the daily sweeper must reset + realign a
  --     DORMANT misaligned subscriber row (future sub end != usage_reset_date,
  --     row NOT otherwise expired) and leave an already-aligned row alone.
  -- ════════════════════════════════════════════════════════════════════════
  -- f: misaligned dormant row. usage_reset_date is FUTURE (so `<= now()` is
  --    false) but differs from the future subscription end -> must realign.
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_f, 'sub_test_f', 'active', now() - interval '10 days', v_future);
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_f, v_sub_plan_id, 6, 3000, 15, v_cal); -- calendar != v_future, and v_cal is in the future

  -- f2: already-aligned dormant row. Sweeper must NOT touch it.
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_f2, 'sub_test_f2', 'active', now() - interval '10 days', v_future2);
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_f2, v_sub_plan_id, 2, 111, 4, v_future2); -- already == sub end

  PERFORM reset_expired_ai_user_plans();

  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_f;
  INSERT INTO _v199_results VALUES ('f_cron_realigns_dormant', v_cost = 0 AND v_reset = v_future,
    format('cost_used=%s reset=%s (want 0 / realigned to %s)', v_cost, v_reset, v_future));

  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_f2;
  INSERT INTO _v199_results VALUES ('f_cron_leaves_aligned_alone', v_cost = 2 AND v_reset = v_future2,
    format('cost_used=%s reset=%s (want 2 / unchanged %s)', v_cost, v_reset, v_future2));

  -- ════════════════════════════════════════════════════════════════════════
  -- (g) First-ever log_ai_usage for an already-subscribed user (no
  --     ai_user_plans row yet). The freshly created row must be born ALIGNED
  --     (usage_reset_date = the sub's future period end) with call 1's usage
  --     intact; call 2 must ACCUMULATE, not wipe (no IS-DISTINCT-FROM misfire
  --     against a calendar-DEFAULT birth date).
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (u_g, 'sub_test_g', 'active', now() - interval '10 days', v_future);
  -- deliberately NO ai_user_plans row for u_g

  PERFORM * FROM log_ai_usage(u_g, 'claude', 'test-model', 'unit', 100, 100, NULL, NULL, NULL, 1.0, 0);
  SELECT current_period_cost_usd, usage_reset_date, current_period_requests
    INTO v_cost, v_reset, v_reqs FROM ai_user_plans WHERE user_id = u_g;
  INSERT INTO _v199_results VALUES ('g_first_usage_born_aligned', v_reset = v_future,
    format('usage_reset_date=%s (want %s, not the calendar DEFAULT)', v_reset, v_future));
  INSERT INTO _v199_results VALUES ('g_first_usage_counted', v_cost = 1.0 AND v_reqs = 1,
    format('cost_used=%s reqs=%s (want 1.0 / 1)', v_cost, v_reqs));

  PERFORM * FROM log_ai_usage(u_g, 'claude', 'test-model', 'unit', 100, 100, NULL, NULL, NULL, 2.0, 0);
  SELECT current_period_cost_usd, usage_reset_date, current_period_requests
    INTO v_cost, v_reset, v_reqs FROM ai_user_plans WHERE user_id = u_g;
  INSERT INTO _v199_results VALUES ('g_second_usage_accumulates', v_cost = 3.0 AND v_reqs = 2 AND v_reset = v_future,
    format('cost_used=%s reqs=%s reset=%s (want 3.0 / 2 / %s — call 1 must not be wiped)', v_cost, v_reqs, v_reset, v_future));

  -- ════════════════════════════════════════════════════════════════════════
  -- (h) Cancellation zombie-grace: an active sub with cancel_at_period_end=true
  --     whose period end (== usage_reset_date, post-199) just passed. In the
  --     pre-webhook window the 3-day grace still resolves the paid plan, so the
  --     expiry reset must be SUPPRESSED — no free post-cancel allowance. Both
  --     the lazy path and the cron must leave the row alone.
  --     Control: same shape with cancel_at_period_end=false -> the clause-1
  --     calendar-fallback reset DOES fire (the accepted-generous renewal path).
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, cancel_at_period_end, current_period_start, current_period_end)
    VALUES (u_h, 'sub_test_h', 'active', true, now() - interval '31 days', v_h_stale);
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_h, v_sub_plan_id, 5, 800, 9, v_h_stale); -- post-199 reality: reset date == period end

  PERFORM * FROM check_ai_usage_limit(u_h);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_h;
  INSERT INTO _v199_results VALUES ('h_cancelling_check_no_reset', v_cost = 5 AND v_reset = v_h_stale,
    format('cost_used=%s reset=%s (want 5 / %s unchanged — no free post-cancel refill)', v_cost, v_reset, v_h_stale));

  -- Control: identical shape, but NOT cancelling -> clause-1 reset fires with
  -- the calendar fallback (accepted-generous renewal-gap behavior).
  INSERT INTO subscriptions (user_id, stripe_subscription_id, status, cancel_at_period_end, current_period_start, current_period_end)
    VALUES (u_h2, 'sub_test_h2', 'active', false, now() - interval '31 days', v_h_stale);
  INSERT INTO ai_user_plans (user_id, plan_id, current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date)
    VALUES (u_h2, v_sub_plan_id, 5, 800, 9, v_h_stale);

  PERFORM * FROM check_ai_usage_limit(u_h2);
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_h2;
  INSERT INTO _v199_results VALUES ('h_control_not_cancelling_resets', v_cost = 0 AND v_reset = v_cal,
    format('cost_used=%s reset=%s (want 0 / calendar %s — renewal-gap reset stays generous)', v_cost, v_reset, v_cal));

  -- Cron sweep: must also leave the cancelling-stale row alone.
  PERFORM reset_expired_ai_user_plans();
  SELECT current_period_cost_usd, usage_reset_date INTO v_cost, v_reset FROM ai_user_plans WHERE user_id = u_h;
  INSERT INTO _v199_results VALUES ('h_cancelling_cron_no_reset', v_cost = 5 AND v_reset = v_h_stale,
    format('cost_used=%s reset=%s (want 5 / %s unchanged after cron)', v_cost, v_reset, v_h_stale));

  -- ── Fail loudly if any assertion failed (aborts + rolls back the txn) ──────
  FOR r IN SELECT scenario, detail FROM _v199_results WHERE NOT pass ORDER BY scenario LOOP
    RAISE WARNING 'FAIL %: %', r.scenario, r.detail;
  END LOOP;
  IF EXISTS (SELECT 1 FROM _v199_results WHERE NOT pass) THEN
    RAISE EXCEPTION 'verify-allowance-reset-alignment: % of % assertions FAILED',
      (SELECT count(*) FROM _v199_results WHERE NOT pass),
      (SELECT count(*) FROM _v199_results);
  END IF;
END;
$battery$;

-- All green: show the results table before rolling back.
SELECT scenario, pass, detail FROM _v199_results ORDER BY scenario;

ROLLBACK;
