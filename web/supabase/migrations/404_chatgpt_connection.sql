-- Migration 404: ChatGPT connections, the free tier's link to a person's own
-- ChatGPT plan (docs/plans/chatgpt-free-tier.md, phase 1).
--
-- "Continue with ChatGPT" runs Dial8's own OAuth flow against auth.openai.com
-- (src/lib/chatgpt/*), not Supabase's custom provider: plan usage needs
-- `resource` on the code exchange, which a generic OIDC client can't send
-- (tested 2026-10-20: invalid_grant without it). One consent grants identity
-- and plan usage; this table keeps what that consent produced, one row per
-- person:
--   issuer, subject   the verified OpenAI identity (OpenAI subjects are
--                     public, so one subject is one ChatGPT account across
--                     clients); a returning sign-in finds its person here
--   client_id         the OAuth client the tokens were issued to (refresh and
--                     revocation must use the same one)
--   *_enc             the access and refresh tokens, AES-256-GCM encrypted by
--                     the app (src/lib/crypto/credentials.ts,
--                     CREDENTIAL_ENCRYPTION_KEY); a database dump alone
--                     reveals nothing
--   plan_enabled      the grant included chatgpt.tokens.use.direct, so AI may
--                     run on the person's plan
--   status            active | exhausted (the plan ran out or stopped working:
--                     AI stops, phase 4) | revoked (signed out or disconnected)
--   refresh_lease_until  a short lease so only one server refreshes at a time:
--                     OpenAI rotates refresh tokens, and two refreshes racing
--                     with the same token can end the session
--
-- No client access at all: RLS on, no policies, grants revoked. Only the
-- server (service role) reads or writes it.
--
-- chatgpt_user_id_by_email(email): the auth user with that email, for linking
-- a first ChatGPT sign-in to an existing account (the ID token's email is
-- verified). Service role only.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- BEFORE the app ships: the ChatGPT callback writes this table.
--
-- Safe to run twice.

SET LOCAL lock_timeout = '5s';

create table if not exists public.chatgpt_connection (
  user_id uuid primary key references auth.users(id) on delete cascade,
  issuer text not null,
  subject text not null,
  client_id text not null,
  email text,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz not null,
  scopes text[] not null default '{}',
  plan_enabled boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'exhausted', 'revoked')),
  exhausted_at timestamptz,
  last_error text,
  refresh_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chatgpt_connection_identity_key unique (issuer, subject)
);

alter table public.chatgpt_connection enable row level security;
revoke all on table public.chatgpt_connection from anon, authenticated;

create or replace function public.chatgpt_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- Confirmed emails only: anyone can sign up with a password under an
  -- address they don't own and never confirm it, and linking a ChatGPT
  -- sign-in to that account would leave their password working on it.
  select u.id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
    and u.email_confirmed_at is not null
  order by u.created_at
  limit 1
$$;

revoke all on function public.chatgpt_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.chatgpt_user_id_by_email(text) to service_role;
