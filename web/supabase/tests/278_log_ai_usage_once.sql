-- DB-level test for migration 278's log_ai_usage_once: EXACTLY ONCE per key,
-- and a failed bill leaves NO claim behind (the claim and the bill share one
-- transaction). The TS tests fake this RPC; this file runs the real SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/278_log_ai_usage_once.sql
-- Prints "278 log_ai_usage_once: all checks passed" and leaves nothing behind:
-- everything runs in one transaction that is rolled back, including the
-- in-transaction stand-ins for log_ai_usage (so no wallet / plan state is
-- touched and no pricing rows are needed). A failed check raises and aborts.

begin;

-- A throwaway auth user for the claim's foreign key. It needs an email and a
-- full_name: the on_auth_user_created trigger (handle_new_user, migration 092)
-- names the user's workspace from them, and workspace.name is NOT NULL — a bare
-- (id) insert aborts the script here. The workspace / member / contact rows
-- the trigger creates are rolled back with everything else.
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-000000000278', 't278@example.invalid', '{"full_name":"t278"}'::jsonb);

-- Stand-in for log_ai_usage (same signature as migration 199): records each
-- bill in a temp table. Replaced in-transaction, rolled back at the end.
create temp table t278_bills (user_id uuid, feature text, input_tokens integer) on commit drop;

create or replace function public.log_ai_usage(
  p_user_id uuid, p_provider text, p_model text, p_feature text,
  p_input_tokens integer, p_output_tokens integer, p_duration_ms integer default null,
  p_edge_function text default null, p_metadata jsonb default null,
  p_cost_usd numeric default null, p_audio_seconds integer default 0
)
returns table (log_id uuid, cost_usd numeric, plan_portion_usd numeric, overage_usd numeric, new_balance_usd numeric)
language plpgsql as $f$
begin
  if p_feature = 't278_raise' then
    raise exception 't278: simulated log_ai_usage failure';
  end if;
  insert into t278_bills values (p_user_id, p_feature, p_input_tokens);
  return query select gen_random_uuid(), 0.01::numeric, 0.01::numeric, 0::numeric, 0::numeric;
end;
$f$;

do $t$
declare
  u constant uuid := '00000000-0000-4000-8000-000000000278';
  r record;
  n integer;
begin
  -- 1. First call bills and claims.
  select * into r from public.log_ai_usage_once('t278:k1', u, 'deepseek', 'deepseek-v4-flash', 'ai_chat', 10, 2);
  if r.duplicate is distinct from false or r.log_id is null then
    raise exception 'check 1 failed: first call must bill (duplicate=false, a log id), got duplicate=% log_id=%', r.duplicate, r.log_id;
  end if;

  -- 2. Same key again: nothing billed, duplicate=true.
  select * into r from public.log_ai_usage_once('t278:k1', u, 'deepseek', 'deepseek-v4-flash', 'ai_chat', 99, 9);
  if r.duplicate is distinct from true or r.log_id is not null then
    raise exception 'check 2 failed: a replayed key must bill nothing, got duplicate=% log_id=%', r.duplicate, r.log_id;
  end if;
  select count(*) into n from t278_bills where feature = 'ai_chat';
  if n <> 1 then raise exception 'check 2 failed: expected 1 bill for t278:k1, found %', n; end if;
  select count(*) into n from public.ai_usage_idempotency where idempotency_key = 't278:k1';
  if n <> 1 then raise exception 'check 2 failed: expected 1 claim for t278:k1, found %', n; end if;

  -- 3. A bill that RAISES leaves no claim (the claim rolled back with it) ...
  begin
    perform public.log_ai_usage_once('t278:k2', u, 'deepseek', 'deepseek-v4-flash', 't278_raise', 10, 2);
    raise exception 'check 3 failed: the raising bill did not raise';
  exception when others then
    if sqlerrm not like 't278: simulated%' then raise; end if;
  end;
  select count(*) into n from public.ai_usage_idempotency where idempotency_key = 't278:k2';
  if n <> 0 then raise exception 'check 3 failed: a failed bill left % claim(s) behind', n; end if;

  -- ... so a retry under the same key bills.
  select * into r from public.log_ai_usage_once('t278:k2', u, 'deepseek', 'deepseek-v4-flash', 'ai_chat_retry', 10, 2);
  if r.duplicate is distinct from false then
    raise exception 'check 3 failed: the retry after a failed bill must bill, got duplicate=%', r.duplicate;
  end if;

  -- 4. An empty key is refused.
  begin
    perform public.log_ai_usage_once('', u, 'deepseek', 'deepseek-v4-flash', 'ai_chat', 1, 1);
    raise exception 'check 4 failed: an empty key was accepted';
  exception when others then
    if sqlerrm not like '%p_idempotency_key is required%' then raise; end if;
  end;

  -- 5. Client roles cannot execute it; the outbox is service-role only.
  if has_function_privilege('authenticated', 'public.log_ai_usage_once(text, uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer)', 'execute')
     or has_function_privilege('anon', 'public.log_ai_usage_once(text, uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer)', 'execute') then
    raise exception 'check 5 failed: a client role can execute log_ai_usage_once';
  end if;
  if has_table_privilege('authenticated', 'public.chat_usage_outbox', 'select')
     or has_table_privilege('anon', 'public.chat_usage_outbox', 'insert') then
    raise exception 'check 5 failed: a client role can read or write chat_usage_outbox';
  end if;

  raise notice '278 log_ai_usage_once: all checks passed';
end;
$t$;

rollback;
