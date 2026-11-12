-- 592: what the SEO area spends on search data.
--
-- Keyword research, rank checks, domain and backlink lookups and AI answer
-- checks are bought per call from a data provider (DataForSEO; the site
-- audit of 590 is our own crawl and costs nothing). This is the ledger of
-- those calls, and what the workspace's monthly ceiling is counted from
-- (src/lib/seo/spend.ts):
--
--   seo_spend              one paid call: which part of the SEO area made it,
--                          which provider endpoint, what the provider said it
--                          cost (USD), and the estimate it was let through on.
--   seo_spend_since(...)   a workspace's total since a moment (the month's
--                          start), for the ceiling check before every call.
--
-- Money is the provider's own number, written after the call; the estimate is
-- only what the gate used. No per-workspace unique index (a workspace merge,
-- 402, re-stamps workspace_id and must never meet a uniqueness here).
--
-- RLS: workspace members read their own workspace's rows (the SEO pages show
-- the month's spend); only the service role writes. Re-runnable.

SET LOCAL lock_timeout = '5s';

create table if not exists public.seo_spend (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  feature text not null,
  endpoint text not null,
  cost_usd numeric(12, 6) not null,
  estimate_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.seo_spend is
  'One paid search-data call made for a workspace''s SEO area (592): the feature, the provider endpoint and the provider''s own cost in USD. Service role writes.';
comment on column public.seo_spend.user_id is
  'Who asked, when a person did; null for a scheduled check (a rank tracker''s run).';
comment on column public.seo_spend.feature is
  'Which part of the SEO area: keywords, domain, serp, rank_tracking, backlinks, ai_visibility, local_seo, lighthouse.';
comment on column public.seo_spend.cost_usd is
  'What the provider reported for the call, in USD. Zero when it charged nothing.';

alter table public.seo_spend drop constraint if exists seo_spend_cost_not_negative;
alter table public.seo_spend
  add constraint seo_spend_cost_not_negative check (cost_usd >= 0 and estimate_usd >= 0);
alter table public.seo_spend drop constraint if exists seo_spend_feature_known;
alter table public.seo_spend
  add constraint seo_spend_feature_known check (
    feature in ('keywords', 'domain', 'serp', 'rank_tracking', 'backlinks', 'ai_visibility', 'local_seo', 'lighthouse')
  );

create index if not exists seo_spend_workspace_created_idx
  on public.seo_spend (workspace_id, created_at desc);

create or replace function public.seo_spend_since(p_workspace uuid, p_since timestamptz)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(s.cost_usd), 0)
  from public.seo_spend s
  where s.workspace_id = p_workspace and s.created_at >= p_since
$$;

comment on function public.seo_spend_since(uuid, timestamptz) is
  'A workspace''s SEO data spend since a moment, in USD (592).';

revoke all on function public.seo_spend_since(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.seo_spend_since(uuid, timestamptz) to service_role;

alter table public.seo_spend enable row level security;

drop policy if exists seo_spend_select_member on public.seo_spend;
create policy seo_spend_select_member on public.seo_spend
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_spend from anon, authenticated;
grant select on table public.seo_spend to authenticated;
grant all on table public.seo_spend to service_role;
