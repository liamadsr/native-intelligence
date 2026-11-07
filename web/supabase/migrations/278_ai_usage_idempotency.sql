-- Migration 278: ai_usage_idempotency + log_ai_usage_once — bill a usage row
-- EXACTLY ONCE when its producer can deliver the same bill more than once.
--
-- WHY: eve chat turns are now metered SERVER-SIDE. The chat-agent's usage-meter
-- hook (agents/chat-agent/hooks/usage-meter.ts) posts each finished turn's summed
-- step usage to POST /api/internal/chat/usage, which calls logUsage. eve hooks
-- are AT-LEAST-ONCE (an interrupted workflow step re-runs and re-fires them),
-- and the hook re-sends a report whose POST failed at a later turn's end, so the
-- same turn can arrive twice. log_ai_usage has no dedup of its own.
--
-- WHY A WRAPPER RPC (not a claim row + a second call): the claim and the bill
-- must commit or roll back TOGETHER. With a separate claim insert followed by
-- log_ai_usage, a function killed (or an RPC that failed) between the two left
-- the claim behind with no bill, and every retry then read "already billed" —
-- the turn was never billed. log_ai_usage_once runs both in ONE transaction: the
-- claim insert (ON CONFLICT DO NOTHING) and then log_ai_usage itself. If
-- log_ai_usage raises, the claim rolls back with it and a retry can bill; if the
-- claim already exists, nothing is billed and `duplicate` is true. Concurrent
-- deliveries of one key serialize on the primary key (the second waits for the
-- first to commit, then sees the conflict).
--
-- The key is the caller's (e.g. `ai_chat:<eveSessionId>:<turnId>`). The durable
-- Inngest retry (billing/usage-log-failed) calls this same RPC with the same key,
-- so a "failed" call that actually committed is never billed twice.
--
-- Service-role only: RLS on the table with no policies; EXECUTE revoked from
-- every client role. created_at is indexed so old claims can be pruned later.
--
-- chat_usage_outbox (below): the durable backstop for a report the hook could
-- not deliver (the session's last turn, an app outage, a 409/401): the eve
-- runtime writes it here under the same key and the Inngest sweeper
-- (src/lib/inngest/chat-usage-outbox.ts) bills it through log_ai_usage_once, so
-- a report the route also billed is a no-op.
--
-- APPLY NOTE: run `notify pgrst, 'reload schema';` in the same apply step.
-- Until PostgREST reloads its schema cache it answers PGRST202 for the new
-- function, logUsage falls back to the UNKEYED log_ai_usage (auth.ts
-- MISSING_FUNCTION_CODES), writes no claim, and a later keyed re-send of the
-- same turn bills it a second time. The reload closes that window.

create table if not exists public.ai_usage_idempotency (
  idempotency_key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_idempotency_created_at_idx
  on public.ai_usage_idempotency (created_at);

alter table public.ai_usage_idempotency enable row level security;

comment on table public.ai_usage_idempotency is
  'Once-only claims for usage rows from at-least-once producers (eve chat turns via /api/internal/chat/usage), written by log_ai_usage_once in the same transaction as the bill. Service role only.';

create or replace function public.log_ai_usage_once(
  p_idempotency_key text,
  p_user_id uuid, p_provider text, p_model text, p_feature text,
  p_input_tokens integer, p_output_tokens integer, p_duration_ms integer default null,
  p_edge_function text default null, p_metadata jsonb default null,
  p_cost_usd numeric default null, p_audio_seconds integer default 0
)
returns table (
  log_id uuid, cost_usd numeric, plan_portion_usd numeric, overage_usd numeric,
  new_balance_usd numeric, duplicate boolean
)
language plpgsql security definer set search_path = public, pg_temp as $function$
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'log_ai_usage_once: p_idempotency_key is required';
  end if;

  insert into public.ai_usage_idempotency (idempotency_key, user_id, feature)
  values (p_idempotency_key, p_user_id, p_feature)
  on conflict (idempotency_key) do nothing;

  if not found then
    -- Already billed under this key: bill nothing.
    return query select null::uuid, null::numeric, null::numeric, null::numeric, null::numeric, true;
    return;
  end if;

  -- Same transaction: a raise inside log_ai_usage rolls the claim back too.
  return query
    select l.log_id, l.cost_usd, l.plan_portion_usd, l.overage_usd, l.new_balance_usd, false
    from public.log_ai_usage(
      p_user_id, p_provider, p_model, p_feature, p_input_tokens, p_output_tokens,
      p_duration_ms, p_edge_function, p_metadata, p_cost_usd, p_audio_seconds
    ) l;
end;
$function$;

revoke execute on function public.log_ai_usage_once(text, uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.log_ai_usage_once(text, uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer)
  to service_role;

comment on function public.log_ai_usage_once(text, uuid, text, text, text, integer, integer, integer, text, jsonb, numeric, integer) is
  'log_ai_usage behind a once-only idempotency key claimed in the same transaction. duplicate=true (and nothing billed) when the key was already claimed. Service role only.';

-- ── chat_usage_outbox ──────────────────────────────────────────────────────────
-- A chat usage report (agents/chat-agent/lib/turn-usage.ts TurnUsageReport)
-- the chat-agent's usage meter could not deliver to /api/internal/chat/usage,
-- keyed on the SAME idempotency key the route bills under. Written by the eve
-- runtime (service role), drained by the Inngest sweeper, which resolves the
-- payer itself (verified token, else the session owner) — never from the row.
create table if not exists public.chat_usage_outbox (
  idempotency_key text primary key,
  session_id text not null,
  turn_id text not null,
  report jsonb not null,
  -- The session's chat-run token at report time (HMAC re-verified by the sweeper).
  run_token text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists chat_usage_outbox_created_at_idx
  on public.chat_usage_outbox (created_at);

alter table public.chat_usage_outbox enable row level security;
revoke all on table public.chat_usage_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_usage_outbox to service_role;

comment on table public.chat_usage_outbox is
  'Undelivered eve chat usage reports awaiting the server-side sweep (src/lib/inngest/chat-usage-outbox.ts), keyed on the ai_usage_idempotency key. Service role only.';

notify pgrst, 'reload schema';
