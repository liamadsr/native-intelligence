-- DB-level test for migration 409: the ChatGPT free tier in check_ai_usage_limit
-- (refused unless the caller opts in with p_chatgpt_plan), and
-- chatgpt_plan_status() answering only for the caller.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/409_chatgpt_free_plan.sql
-- Prints "409 chatgpt free plan: all checks passed" and leaves nothing behind:
-- everything runs in one transaction that is rolled back. A failed check raises.

begin;

-- Throwaway users (handle_new_user needs an email and a full_name).
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000407', 't407@example.invalid', '{"full_name":"t407"}'::jsonb),
  ('00000000-0000-4000-8000-000000004071', 't4071@example.invalid', '{"full_name":"t4071"}'::jsonb);

do $t$
declare
  u constant uuid := '00000000-0000-4000-8000-000000000407';
  other constant uuid := '00000000-0000-4000-8000-000000004071';
  r record;
  s text;
begin
  -- No subscription, no connection: the trial wall's answer, unchanged.
  select * into r from public.check_ai_usage_limit(u);
  if r.allowed or r.reason <> 'subscription_required' then
    raise exception '409: baseline expected subscription_required, got % %', r.allowed, r.reason;
  end if;

  -- An active connection with the plan grant.
  insert into public.chatgpt_connection (user_id, issuer, subject, client_id, access_token_enc, expires_at, plan_enabled, status)
  values (u, 'https://auth.openai.com', 't407-sub', 'oaiapp_t407', 'v1.x.y.z', now() + interval '1 hour', true, 'active');
  -- A caller that doesn't run on the person's plan (no opt-in): refused, so no
  -- unconverted path can spend Dial8's models on a free user.
  select * into r from public.check_ai_usage_limit(u);
  if r.allowed or r.reason <> 'chatgpt_plan_unsupported' then
    raise exception '409: no opt-in expected refused chatgpt_plan_unsupported, got % %', r.allowed, r.reason;
  end if;
  -- A caller that does (opt-in): allowed on the ChatGPT plan, unpaid, uncapped.
  select * into r from public.check_ai_usage_limit(u, true);
  if not r.allowed or r.reason <> 'chatgpt_plan' or r.is_paid_plan or r.cost_limit is not null or r.token_limit is not null then
    raise exception '409: active expected allowed chatgpt_plan unpaid uncapped, got % % paid=% limits=%/%',
      r.allowed, r.reason, r.is_paid_plan, r.cost_limit, r.token_limit;
  end if;

  -- Without the plan grant the connection doesn't count.
  update public.chatgpt_connection set plan_enabled = false where user_id = u;
  select * into r from public.check_ai_usage_limit(u, true);
  if r.allowed or r.reason <> 'subscription_required' then
    raise exception '409: no plan grant expected subscription_required, got % %', r.allowed, r.reason;
  end if;
  update public.chatgpt_connection set plan_enabled = true where user_id = u;

  -- Out of plan credits: an opted-in caller may still try (it costs Dial8
  -- nothing), named; every other caller is still refused.
  update public.chatgpt_connection set status = 'exhausted' where user_id = u;
  select * into r from public.check_ai_usage_limit(u, true);
  if not r.allowed or r.reason <> 'chatgpt_plan_exhausted' or r.is_paid_plan then
    raise exception '409: exhausted expected allowed chatgpt_plan_exhausted, got % %', r.allowed, r.reason;
  end if;
  select * into r from public.check_ai_usage_limit(u);
  if r.allowed or r.reason <> 'chatgpt_plan_unsupported' then
    raise exception '409: exhausted without opt-in expected refused chatgpt_plan_unsupported, got % %', r.allowed, r.reason;
  end if;

  -- Revoked: back to the trial wall.
  update public.chatgpt_connection set status = 'revoked' where user_id = u;
  select * into r from public.check_ai_usage_limit(u, true);
  if r.allowed or r.reason <> 'subscription_required' then
    raise exception '409: revoked expected subscription_required, got % %', r.allowed, r.reason;
  end if;

  -- A paying person keeps Dial8's plan even with a connection.
  update public.chatgpt_connection set status = 'active' where user_id = u;
  insert into public.subscriptions (user_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end)
  values (u, 'sub_t407', 'cus_t407', 'active', now() - interval '1 day', now() + interval '29 days');
  select * into r from public.check_ai_usage_limit(u, true);
  if not r.allowed or r.reason = 'chatgpt_plan' or not r.is_paid_plan then
    raise exception '409: subscriber expected the paid plan, got % % paid=%', r.allowed, r.reason, r.is_paid_plan;
  end if;

  -- chatgpt_plan_status() answers for the caller only.
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  s := public.chatgpt_plan_status();
  if s is distinct from 'active' then
    raise exception '409: caller status expected active, got %', s;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
  s := public.chatgpt_plan_status();
  if s is not null then
    raise exception '409: another caller must see null, got %', s;
  end if;

  -- Grants: a signed-in client may call the status function but never read the table.
  if not has_function_privilege('authenticated', 'public.chatgpt_plan_status()', 'execute') then
    raise exception '409: authenticated cannot call chatgpt_plan_status';
  end if;
  if has_function_privilege('anon', 'public.chatgpt_plan_status()', 'execute') then
    raise exception '409: anon must not call chatgpt_plan_status';
  end if;
  if has_table_privilege('authenticated', 'public.chatgpt_connection', 'select') then
    raise exception '409: authenticated must not read chatgpt_connection';
  end if;
  if has_function_privilege('authenticated', 'public.check_ai_usage_limit(uuid, boolean)', 'execute')
     or has_function_privilege('anon', 'public.check_ai_usage_limit(uuid, boolean)', 'execute') then
    raise exception '409: check_ai_usage_limit must stay service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.check_ai_usage_limit(uuid, boolean)', 'execute') then
    raise exception '409: service_role cannot call check_ai_usage_limit';
  end if;

  raise notice '409 chatgpt free plan: all checks passed';
end;
$t$;

rollback;
