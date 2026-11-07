-- Mirror of Stripe Billing Credits balance for AI usage top-ups.
--
-- Stripe is the source of truth (Credit Grants API). This table is a fast
-- local cache that check_ai_usage_limit reads on every AI request. Webhooks
-- (billing.credit_grant.created, billing.credit_balance_transaction.created)
-- keep balance_usd in sync.

CREATE TABLE public.ai_user_credits (
  user_id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  -- Available credit balance in USD. Decremented as Stripe meter events
  -- draw down active credit grants. Never goes negative; once 0 the user
  -- must top up or wait for monthly reset.
  balance_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  -- Lifetime total of credits granted (paid + promotional). Useful for
  -- admin reporting and refund decisions.
  lifetime_granted_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  -- Lifetime total drawn down (sum of negative balance transactions).
  lifetime_consumed_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_user_credits_stripe_customer
  ON public.ai_user_credits (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE public.ai_user_credits ENABLE ROW LEVEL SECURITY;

-- Users can read their own credit balance (UI shows it on billing page)
CREATE POLICY "Users read own credit balance"
  ON public.ai_user_credits FOR SELECT
  USING (auth.uid() = user_id);

-- Writes only happen via service role (Stripe webhooks, admin actions)

-- Track the Stripe meter event we fired for each AI usage row, both for
-- idempotency (event_name + identifier dedup window is 24h in Stripe) and
-- for reconciliation/debugging.
ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS stripe_meter_event_id TEXT;
