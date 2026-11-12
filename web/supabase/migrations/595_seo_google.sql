-- 595: the SEO area reads Google Search Console and Google Analytics.
--
-- A person connects Google Search Console and Google Analytics as two new
-- connections of their own (src/lib/oauth/config.ts: capabilities
-- 'search_console' and 'analytics', read-only scopes, each its own consent
-- so no existing Google connection needs a new one). The SEO area is the
-- workspace's, so the workspace remembers which site and which property it
-- reads, and through whose connection (src/lib/seo/google/source.ts):
--
--   1. checks widened      connected_account and user_oauth_tokens take
--                          capability 'search_console' and 'analytics'. Every
--                          value the migrations before this one allow stays
--                          (462 is the last that set these checks).
--   2. seo_google_source   per workspace: the Search Console site
--                          (sc_site_url: 'sc-domain:example.com' or a URL
--                          prefix such as 'https://www.example.com/') and the
--                          Google Analytics property (ga4_property_id:
--                          'properties/123', its name, time zone and
--                          currency), each with the connected_account it is
--                          read through and the member who chose it. Every
--                          member reads the same data through that one
--                          connection; when it is removed (the account id is
--                          set null) a read asks that member, or anyone with
--                          their own access, to choose again.
--
-- No per-workspace unique index (a workspace merge, 402, re-stamps
-- workspace_id and must never meet a uniqueness it cannot resolve): one row
-- per workspace is kept by the code, which updates the newest row and
-- deletes any others. Nothing from Google's reports is stored here: every
-- read asks Google, which costs nothing.
--
-- RLS: workspace members read their workspace's row; only the service role
-- writes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. checks widened
-- ------------------------------------------------------------

alter table public.connected_account drop constraint if exists connected_account_capability_check;
alter table public.connected_account
  add constraint connected_account_capability_check check (capability in ('calendar', 'email', 'github', 'crm', 'tasks', 'contacts', 'search_console', 'analytics'));

-- The token row of a Search Console or Google Analytics connection (src/lib/oauth/complete-connect.ts).
alter table public.user_oauth_tokens drop constraint if exists user_oauth_tokens_capability_check;
alter table public.user_oauth_tokens
  add constraint user_oauth_tokens_capability_check check (capability in ('calendar', 'email', 'both', 'github', 'crm', 'tasks', 'contacts', 'search_console', 'analytics'));

-- ------------------------------------------------------------
-- 2. seo_google_source
-- ------------------------------------------------------------

create table if not exists public.seo_google_source (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  sc_site_url text null,
  sc_account_id uuid null references public.connected_account(id) on delete set null,
  sc_chosen_by uuid null references auth.users(id) on delete set null,
  sc_chosen_at timestamptz null,
  ga4_property_id text null,
  ga4_property_name text null,
  ga4_time_zone text null,
  ga4_currency_code text null,
  ga4_account_id uuid null references public.connected_account(id) on delete set null,
  ga4_chosen_by uuid null references auth.users(id) on delete set null,
  ga4_chosen_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_google_source is
  'Which Search Console site and Google Analytics property a workspace''s SEO area reads, and through whose connection (595). One row per workspace, kept by the code. Service role writes.';
comment on column public.seo_google_source.sc_site_url is
  'The Search Console property exactly as Google names it: ''sc-domain:example.com'' or a URL prefix such as ''https://www.example.com/''.';
comment on column public.seo_google_source.sc_account_id is
  'The Search Console connection (connected_account) every member''s reads go through: the chooser''s own. Null once it is removed.';
comment on column public.seo_google_source.ga4_property_id is
  'The Google Analytics 4 property as Google names it, ''properties/<number>''.';
comment on column public.seo_google_source.ga4_time_zone is
  'The property''s reporting time zone (IANA), read from Google when it was chosen: report dates are in it.';
comment on column public.seo_google_source.ga4_account_id is
  'The Google Analytics connection (connected_account) every member''s reads go through: the chooser''s own. Null once it is removed.';

alter table public.seo_google_source drop constraint if exists seo_google_source_site_shape;
alter table public.seo_google_source
  add constraint seo_google_source_site_shape check (
    sc_site_url is null
    or (char_length(sc_site_url) <= 2048 and (sc_site_url like 'sc-domain:%' or sc_site_url like 'https://%' or sc_site_url like 'http://%'))
  );
alter table public.seo_google_source drop constraint if exists seo_google_source_property_shape;
alter table public.seo_google_source
  add constraint seo_google_source_property_shape check (
    ga4_property_id is null or ga4_property_id ~ '^properties/[0-9]{1,20}$'
  );
alter table public.seo_google_source drop constraint if exists seo_google_source_text_length;
alter table public.seo_google_source
  add constraint seo_google_source_text_length check (
    (ga4_property_name is null or char_length(ga4_property_name) <= 300)
    and (ga4_time_zone is null or char_length(ga4_time_zone) <= 64)
    and (ga4_currency_code is null or char_length(ga4_currency_code) <= 8)
  );

create index if not exists seo_google_source_workspace_idx
  on public.seo_google_source (workspace_id, updated_at desc);
-- A removed connection's rows, found when it goes (the foreign keys' own lookups).
create index if not exists seo_google_source_sc_account_idx
  on public.seo_google_source (sc_account_id) where sc_account_id is not null;
create index if not exists seo_google_source_ga4_account_idx
  on public.seo_google_source (ga4_account_id) where ga4_account_id is not null;

alter table public.seo_google_source enable row level security;

drop policy if exists seo_google_source_select_member on public.seo_google_source;
create policy seo_google_source_select_member on public.seo_google_source
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_google_source from anon, authenticated;
grant select on table public.seo_google_source to authenticated;
grant all on table public.seo_google_source to service_role;
