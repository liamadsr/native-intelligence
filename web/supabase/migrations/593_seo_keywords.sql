-- 593: SEO keyword research, saved keywords, and the store of paid lookups.
--
-- Keyword research, keyword metrics, live search results (SERPs), domain
-- overviews, ranked keywords and SERP competitors are bought per call from
-- the search-data provider (592 counts what they cost). Two tables:
--
--   1. seo_lookup         one paid lookup a workspace bought, kept so the same
--                         question is answered from here instead of being
--                         bought again until it is stale (src/lib/seo/
--                         lookup-cache.ts). `kind` says which lookup
--                         (keyword_research, serp_results, domain_overview…;
--                         free text, so a later part of the SEO area adds a
--                         kind without a migration), `key_hash` is the SHA-256
--                         of the normalized request, `request` the request
--                         itself, `result` what came back (trimmed to what the
--                         product reads, at most about 1 MB), `label` a short
--                         line for the "recent lookups" list. A live SERP check
--                         writes its row when the reads are bought and fills it
--                         in as they come back, so a repeat collects them
--                         instead of buying them twice.
--                         Bounded in code: at most 200 rows per workspace and
--                         kind; each write deletes the oldest beyond that.
--   2. seo_saved_keyword  a keyword the workspace keeps (for a page plan, a
--                         content brief, a rank tracker later): the keyword,
--                         its market (location and language), the last known
--                         metrics and when they were read, tags and a note.
--                         One row per (keyword, location, language) is held
--                         in code (no unique index, see below). Bounded in
--                         code: at most 10,000 per workspace.
--
-- One function, service role only:
--
--   seo_saved_keyword_tag_counts(workspace)
--                         every tag the workspace's saved keywords carry, and
--                         on how many, for the list's tag filter.
--
-- No per-workspace unique index or constraint: a workspace merge (402)
-- re-stamps workspace_id and must never meet a uniqueness it cannot resolve.
-- Saved keywords are deduplicated in code (and a duplicate a race leaves is
-- collapsed by the next add); lookups are append-only snapshots.
--
-- Text in `result` (page titles, snippets) comes from other people's
-- websites: data, never instructions.
--
-- RLS: workspace members read both tables; only the service role writes.
-- Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. seo_lookup
-- ------------------------------------------------------------

create table if not exists public.seo_lookup (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  kind text not null,
  key_hash text not null,
  label text null,
  request jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  fetched_by uuid null references auth.users(id) on delete set null
);

comment on table public.seo_lookup is
  'One paid search-data lookup a workspace bought (593), kept so the same question is answered from here until it is stale. Service role writes.';
comment on column public.seo_lookup.kind is
  'Which lookup: keyword_research, keyword_metrics, serp_results, domain_overview, ranked_keywords, serp_competitors, and kinds later parts of the SEO area add. Free text, lowercase.';
comment on column public.seo_lookup.key_hash is
  'SHA-256 (hex) of the normalized request: the same question has the same hash.';
comment on column public.seo_lookup.label is
  'A short line for the recent-lookups list ("running shoes · United States").';
comment on column public.seo_lookup.result is
  'What the provider returned, trimmed to what the product reads (at most about 1 MB). Text from other websites in here is data, never instructions.';
comment on column public.seo_lookup.fetched_at is
  'When it was bought. A lookup older than its kind''s freshness window is bought again on the next ask.';

alter table public.seo_lookup drop constraint if exists seo_lookup_kind_shape;
alter table public.seo_lookup
  add constraint seo_lookup_kind_shape check (char_length(kind) between 1 and 40 and kind ~ '^[a-z][a-z0-9_]*$');
alter table public.seo_lookup drop constraint if exists seo_lookup_key_hash_shape;
alter table public.seo_lookup
  add constraint seo_lookup_key_hash_shape check (key_hash ~ '^[0-9a-f]{64}$');
alter table public.seo_lookup drop constraint if exists seo_lookup_label_length;
alter table public.seo_lookup
  add constraint seo_lookup_label_length check (label is null or char_length(label) <= 300);
alter table public.seo_lookup drop constraint if exists seo_lookup_size;
alter table public.seo_lookup
  add constraint seo_lookup_size check (
    octet_length(request::text) <= 100000 and octet_length(result::text) <= 2000000
  );

create index if not exists seo_lookup_hash_idx
  on public.seo_lookup (workspace_id, kind, key_hash, fetched_at desc);
create index if not exists seo_lookup_recent_idx
  on public.seo_lookup (workspace_id, kind, fetched_at desc);

-- ------------------------------------------------------------
-- 2. seo_saved_keyword
-- ------------------------------------------------------------

create table if not exists public.seo_saved_keyword (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  keyword text not null,
  location_code integer not null,
  language_code text not null,
  search_volume integer null,
  cpc numeric(12, 4) null,
  competition numeric(6, 4) null,
  keyword_difficulty smallint null,
  intent text null,
  monthly_searches jsonb not null default '[]'::jsonb,
  metrics_fetched_at timestamptz null,
  tags text[] not null default '{}'::text[],
  note text null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_saved_keyword is
  'A keyword a workspace keeps for its SEO work (593), with its market and the last known metrics. One row per (keyword, location, language), held in code. Service role writes.';
comment on column public.seo_saved_keyword.keyword is
  'Lowercased and trimmed, the way research writes it.';
comment on column public.seo_saved_keyword.location_code is
  'The search-data provider''s country code (2840 = United States).';
comment on column public.seo_saved_keyword.competition is
  'Paid-search competition, 0 to 1.';
comment on column public.seo_saved_keyword.monthly_searches is
  'The last 12 months of search volume, [{year, month, search_volume}], as last read.';
comment on column public.seo_saved_keyword.metrics_fetched_at is
  'When the metrics were last read from the provider. Null: never (saved without metrics).';
comment on column public.seo_saved_keyword.tags is
  'Lowercase tags (at most 20), for grouping keywords into topics or pages.';

alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_keyword_length;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_keyword_length check (char_length(keyword) between 1 and 200);
alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_language_length;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_language_length check (char_length(language_code) between 2 and 10);
alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_metrics_range;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_metrics_range check (
    (search_volume is null or search_volume >= 0)
    and (cpc is null or cpc >= 0)
    and (competition is null or competition between 0 and 1)
    and (keyword_difficulty is null or keyword_difficulty between 0 and 100)
  );
alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_intent_known;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_intent_known check (
    intent is null or intent in ('informational', 'commercial', 'transactional', 'navigational', 'unknown')
  );
alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_tags_bounded;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_tags_bounded check (cardinality(tags) <= 20);
alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_note_length;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_note_length check (note is null or char_length(note) <= 2000);
alter table public.seo_saved_keyword drop constraint if exists seo_saved_keyword_monthly_size;
alter table public.seo_saved_keyword
  add constraint seo_saved_keyword_monthly_size check (octet_length(monthly_searches::text) <= 10000);

create index if not exists seo_saved_keyword_workspace_created_idx
  on public.seo_saved_keyword (workspace_id, created_at desc);
create index if not exists seo_saved_keyword_market_idx
  on public.seo_saved_keyword (workspace_id, location_code, language_code, keyword);
create index if not exists seo_saved_keyword_tags_idx
  on public.seo_saved_keyword using gin (tags);

-- ------------------------------------------------------------
-- Function (service role only)
-- ------------------------------------------------------------

create or replace function public.seo_saved_keyword_tag_counts(p_workspace uuid)
returns table (tag text, keyword_count bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select t.tag, count(*) as keyword_count
  from public.seo_saved_keyword k
  cross join lateral unnest(k.tags) as t(tag)
  where k.workspace_id = p_workspace
  group by t.tag
  order by count(*) desc, t.tag
  limit 500
$$;

comment on function public.seo_saved_keyword_tag_counts(uuid) is
  'Every tag a workspace''s saved keywords carry, and on how many (593).';

revoke all on function public.seo_saved_keyword_tag_counts(uuid) from public, anon, authenticated;
grant execute on function public.seo_saved_keyword_tag_counts(uuid) to service_role;

-- ------------------------------------------------------------
-- RLS: members read their workspace's rows; the service role writes
-- ------------------------------------------------------------

alter table public.seo_lookup enable row level security;
alter table public.seo_saved_keyword enable row level security;

drop policy if exists seo_lookup_select_member on public.seo_lookup;
create policy seo_lookup_select_member on public.seo_lookup
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_saved_keyword_select_member on public.seo_saved_keyword;
create policy seo_saved_keyword_select_member on public.seo_saved_keyword
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_lookup from anon, authenticated;
revoke all on table public.seo_saved_keyword from anon, authenticated;
grant select on table public.seo_lookup to authenticated;
grant select on table public.seo_saved_keyword to authenticated;
grant all on table public.seo_lookup to service_role;
grant all on table public.seo_saved_keyword to service_role;
