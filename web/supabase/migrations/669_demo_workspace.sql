-- ============================================================
-- 669: demo workspaces
-- ============================================================
-- A workspace an admin flags as a demo: made-up data that invited outsiders
-- may look around in, without a seat of their own, at a bounded cost, with
-- nothing real connected to it.
--
--   demo_workspace               the flag, one row per demo workspace, with
--                                its monthly AI cap and this month's shared
--                                spend. RLS on, no policies: only the service
--                                role (and psql) reads or writes it. NOT a
--                                column on workspace: an owner may update
--                                their own workspace row (013).
--   is_demo_workspace(ws)        true for a flagged workspace. Members and the
--                                service role.
--   my_demo_seat_workspace()     the demo workspace the caller sits in as a
--                                member or guest, else null: what the app's
--                                trial wall reads (src/lib/billing/access).
--   check_ai_usage_limit         468's body plus ONE branch: a person with no
--                                override, staff exemption, live subscription
--                                or ChatGPT plan, who is a member or guest of
--                                a demo workspace, is allowed while the shared
--                                spend is under the cap ('demo_workspace'),
--                                refused once it is not
--                                ('demo_cost_limit_exceeded').
--   demo_workspace_meter_usage   after insert on ai_usage_logs: such a
--                                person's cost is added to the demo
--                                workspace's ledger. A ledger, not a sum over
--                                the members' logs, so removing a visitor does
--                                not give the month's spend back.
--   refuse_in_demo_workspace     before insert/update on the tables that link
--                                something real to a workspace: a connected
--                                mail or calendar account, an MCP server, a
--                                Slack workspace, a shared email, a Stripe
--                                account, a business phone number.
--
-- Owners and admins of a demo workspace get nothing from it: they run it, and
-- hold their own seat. Flagging and unflagging is a row here, by an admin:
--   insert into public.demo_workspace (workspace_id) values ('<workspace id>');
--   delete from public.demo_workspace where workspace_id = '<workspace id>';
--
-- Additive, re-runnable, one transaction. Apply before the code that reads it.

begin;

set local lock_timeout = '5s';

-- ── The flag and its ledger ────────────────────────────────────────────────

create table if not exists public.demo_workspace (
  workspace_id  uuid primary key references public.workspace(id) on delete cascade,
  ai_cap_usd    numeric not null default 25 check (ai_cap_usd >= 0),
  spend_month   date not null default (date_trunc('month', now()))::date,
  ai_spend_usd  numeric not null default 0,
  last_reset_at timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.demo_workspace is
  'Workspaces flagged as demos (669): made-up data, members and guests need no seat, AI spend shared under ai_cap_usd per month, nothing real may be connected. Service role only.';

alter table public.demo_workspace enable row level security;
revoke all on table public.demo_workspace from public, anon, authenticated;
grant all on table public.demo_workspace to service_role;

create or replace function public.is_demo_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.demo_workspace d where d.workspace_id = p_workspace_id)
$$;

revoke execute on function public.is_demo_workspace(uuid) from public, anon;
grant execute on function public.is_demo_workspace(uuid) to authenticated, service_role;

-- The demo workspace a person sits in as a visitor (member or guest), else
-- null. The oldest flag wins when there are several.
create or replace function public.demo_seat_workspace(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.workspace_id
  from public.demo_workspace d
  join public.member m on m.workspace_id = d.workspace_id
  where m.user_id = p_user_id and m.role in ('member', 'guest')
  order by d.created_at
  limit 1
$$;

revoke execute on function public.demo_seat_workspace(uuid) from public, anon, authenticated;
grant execute on function public.demo_seat_workspace(uuid) to service_role;

create or replace function public.my_demo_seat_workspace()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select public.demo_seat_workspace(auth.uid())
$$;

revoke execute on function public.my_demo_seat_workspace() from public, anon;
grant execute on function public.my_demo_seat_workspace() to authenticated, service_role;

-- ── The usage gate: 468's body plus the demo branch ────────────────────────
-- KEEP IN STEP with ADMIN_EMAILS (src/lib/__tests__/admin-emails-sql.test.ts
-- checks the newest definition, which is now this one).

CREATE OR REPLACE FUNCTION public.check_ai_usage_limit(p_user_id uuid, p_chatgpt_plan boolean)
 RETURNS TABLE(allowed boolean, reason text, plan_name text, cost_used numeric, cost_limit numeric, tokens_used integer, token_limit integer, is_paid_plan boolean, usage_reset_date timestamp with time zone, credit_balance_usd numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $$
DECLARE
    v_plan_def ai_plan_definitions;
    v_user_plan ai_user_plans;
    v_today_requests INT;
    v_is_paid boolean;
    v_credit_balance NUMERIC := 0;
    v_from_subscription boolean := false;
    v_override text;
    v_free_until timestamptz;
    v_sub_period_end timestamptz;
    v_cancelling_stale boolean := false;
    v_new_reset timestamptz;
    v_chatgpt_status text;
    v_demo_ws uuid;
    v_demo_cap numeric;
    v_demo_spend numeric;
BEGIN
    SELECT * INTO v_user_plan
    FROM ai_user_plans
    WHERE ai_user_plans.user_id = p_user_id AND ai_user_plans.is_active = true
    FOR UPDATE;

    IF v_user_plan.user_id IS NOT NULL AND v_user_plan.admin_override = true THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    -- Dial8 staff: subscriber plan regardless of subscriptions rows.
    -- The admins by address, never a domain: the same people as ADMIN_EMAILS
    -- in src/lib/admin-emails.ts (keep the two in step; migration 468).
    IF v_plan_def IS NULL AND EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND lower(btrim(u.email)) IN ('liam@dial8.ai')
    ) THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
    END IF;

    IF v_plan_def IS NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
              AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '3 days')
        ) INTO v_from_subscription;
        IF v_from_subscription THEN
            SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE purchase_action = 'subscription' LIMIT 1;
        END IF;
    END IF;

    -- ChatGPT free tier (migration 408): no override, not staff, no live
    -- subscription, but a ChatGPT connection with the plan grant. Allowed only
    -- for a caller that runs AI on the person's own ChatGPT plan
    -- (p_chatgpt_plan); no Dial8 cost or token caps apply, nothing is paid.
    -- Out of plan credits ('exhausted') is allowed too, named: OpenAI refuses
    -- the call itself while the plan is spent, and a try costs Dial8 nothing.
    -- A revoked connection falls through to the default plan
    -- (subscription_required).
    IF v_plan_def IS NULL THEN
        SELECT c.status INTO v_chatgpt_status
        FROM public.chatgpt_connection c
        WHERE c.user_id = p_user_id AND c.plan_enabled;
        IF v_chatgpt_status IN ('active', 'exhausted') THEN
            SELECT COALESCE(c.balance_usd, 0) INTO v_credit_balance
            FROM ai_user_credits c WHERE c.user_id = p_user_id;
            RETURN QUERY SELECT p_chatgpt_plan,
                CASE
                    WHEN NOT p_chatgpt_plan THEN 'chatgpt_plan_unsupported'
                    WHEN v_chatgpt_status = 'exhausted' THEN 'chatgpt_plan_exhausted'
                    ELSE 'chatgpt_plan'
                END::TEXT,
                'ChatGPT plan'::TEXT, 0::NUMERIC, NULL::NUMERIC, 0::INT, NULL::INT, false,
                NULL::timestamptz, COALESCE(v_credit_balance, 0);
            RETURN;
        END IF;
    END IF;

    -- Demo workspace seat (migration 669): no override, not staff, no live
    -- subscription, no ChatGPT plan, but a member or guest of a workspace an
    -- admin flagged as a demo (public.demo_workspace). Allowed while that
    -- workspace's shared spend this month is under its cap; every such
    -- person's usage is added to the one ledger (demo_workspace_meter_usage).
    -- No seat is granted: leave the demo workspace and this branch is gone.
    IF v_plan_def IS NULL THEN
        SELECT d.workspace_id, d.ai_cap_usd,
               CASE WHEN d.spend_month = date_trunc('month', now())::date THEN d.ai_spend_usd ELSE 0 END
        INTO v_demo_ws, v_demo_cap, v_demo_spend
        FROM public.demo_workspace d
        JOIN public.member m ON m.workspace_id = d.workspace_id
        WHERE m.user_id = p_user_id AND m.role IN ('member', 'guest')
        ORDER BY d.created_at
        LIMIT 1;
        IF v_demo_ws IS NOT NULL THEN
            SELECT COALESCE(c.balance_usd, 0) INTO v_credit_balance
            FROM ai_user_credits c WHERE c.user_id = p_user_id;
            RETURN QUERY SELECT v_demo_spend < v_demo_cap,
                CASE WHEN v_demo_spend < v_demo_cap THEN 'demo_workspace' ELSE 'demo_cost_limit_exceeded' END::TEXT,
                'Demo workspace'::TEXT, v_demo_spend, v_demo_cap, 0::INT, NULL::INT, false,
                (date_trunc('month', now()) + interval '1 month')::timestamptz, COALESCE(v_credit_balance, 0);
            RETURN;
        END IF;
    END IF;

    IF v_plan_def IS NULL AND v_user_plan.user_id IS NOT NULL THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;
    END IF;

    IF v_plan_def IS NULL THEN
        SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE is_default = true LIMIT 1;
    END IF;

    SELECT COALESCE(c.balance_usd, 0) INTO v_credit_balance
    FROM ai_user_credits c WHERE c.user_id = p_user_id;
    v_credit_balance := COALESCE(v_credit_balance, 0);

    IF v_plan_def IS NULL THEN
        RETURN QUERY SELECT true, 'no_plan_configured'::TEXT, 'none'::TEXT,
            0::NUMERIC, 0::NUMERIC, 0::INT, 0::INT, false, NULL::timestamptz, v_credit_balance;
        RETURN;
    END IF;

    v_is_paid := COALESCE(v_plan_def.is_default, false) = false;

    SELECT max(s.current_period_end) INTO v_sub_period_end
    FROM subscriptions s
    WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
      AND s.current_period_end > now();

    SELECT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.user_id = p_user_id AND s.status IN ('active','trialing')
          AND s.cancel_at_period_end = true
          AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()
    ) INTO v_cancelling_stale;

    IF v_user_plan.user_id IS NOT NULL
       AND NOT COALESCE(v_plan_def.is_default, false)
       AND (
         (v_user_plan.usage_reset_date <= now() AND NOT v_cancelling_stale)
         OR (v_sub_period_end IS NOT NULL AND v_user_plan.usage_reset_date IS DISTINCT FROM v_sub_period_end)
       ) THEN
        v_new_reset := COALESCE(v_sub_period_end, date_trunc('month', now()) + interval '1 month');
        UPDATE ai_user_plans SET
            current_period_cost_usd = 0, current_period_tokens = 0, current_period_requests = 0,
            usage_reset_date = v_new_reset, updated_at = now()
        WHERE ai_user_plans.user_id = p_user_id;
        v_user_plan.current_period_cost_usd := 0;
        v_user_plan.current_period_tokens := 0;
        v_user_plan.current_period_requests := 0;
        v_user_plan.usage_reset_date := v_new_reset;
    END IF;

    IF COALESCE(v_plan_def.is_default, false) AND v_credit_balance <= 0 THEN
        SELECT (u.raw_user_meta_data->>'trial_end_override') INTO v_override
        FROM auth.users u WHERE u.id = p_user_id;
        v_free_until := NULL;
        IF v_override IS NOT NULL THEN
            BEGIN
                v_free_until := v_override::timestamptz;
            EXCEPTION WHEN OTHERS THEN
                v_free_until := NULL;
            END;
        END IF;
        IF v_free_until IS NULL OR v_free_until <= now() THEN
            RETURN QUERY SELECT false, 'subscription_required'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
    END IF;

    IF v_plan_def.monthly_cost_limit_usd IS NOT NULL AND
       COALESCE(v_user_plan.current_period_cost_usd, 0) >= v_plan_def.monthly_cost_limit_usd THEN
        IF v_credit_balance > 0 THEN
            RETURN QUERY SELECT true, 'using_credits'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
        RETURN QUERY SELECT false, 'cost_limit_exceeded'::TEXT, v_plan_def.display_name,
            COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
            COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
            v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
        RETURN;
    END IF;

    IF v_plan_def.monthly_token_limit IS NOT NULL AND
       COALESCE(v_user_plan.current_period_tokens, 0) >= v_plan_def.monthly_token_limit THEN
        IF v_credit_balance > 0 THEN
            RETURN QUERY SELECT true, 'using_credits'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
        RETURN QUERY SELECT false, 'token_limit_exceeded'::TEXT, v_plan_def.display_name,
            COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
            COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
            v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
        RETURN;
    END IF;

    IF v_plan_def.max_requests_per_day IS NOT NULL THEN
        SELECT COUNT(*)::INT INTO v_today_requests
        FROM ai_usage_logs
        WHERE ai_usage_logs.user_id = p_user_id
          AND ai_usage_logs.created_at >= date_trunc('day', now());
        IF v_today_requests >= v_plan_def.max_requests_per_day THEN
            RETURN QUERY SELECT false, 'daily_request_limit_exceeded'::TEXT, v_plan_def.display_name,
                COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
                COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
                v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
            RETURN;
        END IF;
    END IF;

    RETURN QUERY SELECT true, 'within_limits'::TEXT, v_plan_def.display_name,
        COALESCE(v_user_plan.current_period_cost_usd, 0::NUMERIC), v_plan_def.monthly_cost_limit_usd,
        COALESCE(v_user_plan.current_period_tokens, 0), v_plan_def.monthly_token_limit,
        v_is_paid, v_user_plan.usage_reset_date, v_credit_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.check_ai_usage_limit(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_ai_usage_limit(uuid, boolean) TO service_role;

-- ── The ledger: a visitor's cost goes on the demo workspace ────────────────
-- The same people the gate's demo branch lets in: a member or guest of a demo
-- workspace with no admin override and no live subscription. (Staff and
-- ChatGPT-plan people are not excluded by name: staff run a demo as owner or
-- admin, and a plan step is logged at zero cost.) Never fails the insert it
-- rides on: an error here is a warning, and the usage row still lands.

create or replace function public.demo_workspace_meter_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_month date := (date_trunc('month', now()))::date;
begin
  if coalesce(new.estimated_cost_usd, 0) <= 0 then
    return new;
  end if;
  begin
    v_ws := public.demo_seat_workspace(new.user_id);
    if v_ws is null then
      return new;
    end if;
    if exists (
      select 1 from public.ai_user_plans p
      where p.user_id = new.user_id and p.is_active = true and p.admin_override = true
    ) or exists (
      select 1 from public.subscriptions s
      where s.user_id = new.user_id and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now() - interval '3 days')
    ) then
      return new;
    end if;
    update public.demo_workspace d
    set ai_spend_usd = case when d.spend_month = v_month then d.ai_spend_usd else 0 end + new.estimated_cost_usd,
        spend_month = v_month
    where d.workspace_id = v_ws;
  exception when others then
    raise warning 'demo_workspace_meter_usage: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke execute on function public.demo_workspace_meter_usage() from public, anon, authenticated;

drop trigger if exists demo_workspace_meter_usage on public.ai_usage_logs;
create trigger demo_workspace_meter_usage
  after insert on public.ai_usage_logs
  for each row execute function public.demo_workspace_meter_usage();

-- ── Nothing real is linked to a demo workspace ─────────────────────────────

create or replace function public.refuse_in_demo_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is not null and public.is_demo_workspace(new.workspace_id) then
    raise exception 'demo_workspace: % cannot be connected to or shared into a demo workspace', tg_table_name
      using errcode = 'P0001', hint = 'DEMO_WORKSPACE';
  end if;
  return new;
end;
$$;

revoke execute on function public.refuse_in_demo_workspace() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'connected_account_workspace',
    'connected_mcp_server',
    'slack_installation',
    'email_share',
    'stripe_connect_account',
    'business_phone_number'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists refuse_in_demo_workspace on public.%I', t);
      execute format(
        'create trigger refuse_in_demo_workspace before insert or update of workspace_id on public.%I '
        'for each row execute function public.refuse_in_demo_workspace()', t);
    end if;
  end loop;
end $$;

-- Flagging a workspace that already has something real linked is refused:
-- unlink first, so the flag never makes a leak look safe.
create or replace function public.demo_workspace_must_be_clean()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.connected_account_workspace x where x.workspace_id = new.workspace_id)
     or exists (select 1 from public.connected_mcp_server x where x.workspace_id = new.workspace_id)
     or exists (select 1 from public.slack_installation x where x.workspace_id = new.workspace_id) then
    raise exception 'demo_workspace: this workspace has a connected account, MCP server or Slack workspace; unlink them before flagging it as a demo';
  end if;
  return new;
end;
$$;

revoke execute on function public.demo_workspace_must_be_clean() from public, anon, authenticated;

drop trigger if exists demo_workspace_must_be_clean on public.demo_workspace;
create trigger demo_workspace_must_be_clean
  before insert on public.demo_workspace
  for each row execute function public.demo_workspace_must_be_clean();

commit;

-- Verify (read-only):
--   select to_regclass('public.demo_workspace') is not null;                                  -> true
--   select position('demo_cost_limit_exceeded' in pg_get_functiondef('public.check_ai_usage_limit(uuid, boolean)'::regprocedure)) > 0;  -> true
--   select tgrelid::regclass from pg_trigger where tgname = 'refuse_in_demo_workspace' order by 1;   -> the six tables
--   select proacl from pg_proc where oid = 'public.check_ai_usage_limit(uuid, boolean)'::regprocedure;
--     -> {postgres=X/postgres,service_role=X/postgres}
