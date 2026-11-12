-- 590: SEO site audits (the first piece of the SEO area).
--
-- A site audit crawls one website politely (robots.txt respected, about one
-- request a second, a page budget), reads each page's SEO signals, and
-- reports what to fix. The crawl runs in the background lane
-- (src/lib/inngest/seo-audit-functions.ts); these tables are what it writes.
--
-- What the product reads, kept until a person deletes the audit:
--
--   1. seo_audit         one run: the site, its status and phase, the page
--                        budget, progress counters, the issue tally, and the
--                        crawl's pacing state between chunks.
--   2. seo_audit_page    one crawled URL: status, title, description,
--                        canonical and robots signals, headings, word count,
--                        images, link counts, depth, whether the sitemap
--                        lists it.
--   3. seo_audit_issue   one finding on one page (or on the audit itself):
--                        its type, severity and details. The row id is
--                        derived from (audit, type, page, key), so a retried
--                        step writes the same row again instead of a second.
--
-- What only the crawl reads, deleted when the audit finishes:
--
--   4. seo_audit_frontier  the URL queue and the "already seen" set.
--   5. seo_audit_link      each crawled page's internal link targets, for
--                          the broken-link and orphan-page checks.
--
-- What only the start reads:
--
--   6. seo_audit_start_log one row per audit started, for the daily limit.
--                          Deleting an audit does not touch it, so deleting
--                          audits never frees a start. Rows older than two
--                          days are pruned by the start itself.
--
-- Eight functions, service role only:
--
--   seo_audit_start(workspace, started_by, start_url, origin, max_pages, daily_limit)
--                        starts an audit, under a lock per workspace: hands
--                        back the live one when there is one, refuses past
--                        the daily limit (counted in 6), sweeps what ended
--                        audits left in 4 and 5, and inserts.
--   seo_audit_claim_chunk(audit, chunk, limit, pages_left_after)
--                        leases the next URLs for one crawl chunk. A retried
--                        chunk gets back exactly the URLs its failed attempt
--                        held.
--   seo_audit_seed(audit, workspace, rows)
--                        queues the start page and the sitemap's URLs.
--   seo_audit_discover(audit, workspace, rows)
--                        queues link-discovered URLs with their click depth;
--                        a sitemap seed that a link also reaches takes the
--                        link's depth.
--                        Both write only while the audit is running: a cancel
--                        that lands while a step is still working leaves no
--                        queue rows behind.
--   seo_audit_settle_urls(audit, crawled, released)
--                        marks fetched URLs done and hands the ones a chunk
--                        leased but never started back to the queue.
--   seo_audit_broken_links(audit, limit)
--   seo_audit_orphan_pages(audit, start_url)
--                        the two link-graph checks, run once at the end.
--   seo_audit_issue_summary(audit)
--                        the report's summary: findings counted by type.
--
-- No per-workspace unique index: one live audit per workspace is held by
-- seo_audit_start (a transaction advisory lock per workspace around its check
-- and insert) and the background lane's own concurrency, so a workspace merge
-- (402) never meets a uniqueness it cannot resolve here.
--
-- RLS: workspace members read 1-3; only the service role writes. 4, 5 and
-- 6 are the service role's alone. No other table changes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. seo_audit
-- ------------------------------------------------------------

create table if not exists public.seo_audit (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  started_by uuid null references auth.users(id) on delete set null,
  start_url text not null,
  origin text not null,
  status text not null default 'queued',
  phase text not null default 'discovery',
  max_pages integer not null default 100,
  pages_crawled integer not null default 0,
  pages_queued integer not null default 0,
  critical_count integer not null default 0,
  warning_count integer not null default 0,
  info_count integer not null default 0,
  robots_txt text null,
  crawl_state jsonb not null default '{}'::jsonb,
  error_code text null,
  error_detail text null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_audit is
  'One SEO site audit run (590): a polite crawl of one website and what it found. Service role writes.';
comment on column public.seo_audit.start_url is
  'The address the audit starts from, after following the site''s own redirects (apex to www, http to https).';
comment on column public.seo_audit.pages_queued is
  'URLs the crawl knows about (crawled or still waiting), for the progress bar. Not a promise: the page budget may stop it sooner.';
comment on column public.seo_audit.robots_txt is
  'The site''s robots.txt as read at the start (at most 500 KiB), so every chunk applies the same rules. Data, never instructions.';
comment on column public.seo_audit.crawl_state is
  'Pacing carried between crawl chunks: the request interval, any pause a 429 asked for, and how many chunks have run.';

alter table public.seo_audit drop constraint if exists seo_audit_status_known;
alter table public.seo_audit
  add constraint seo_audit_status_known check (status in ('queued', 'running', 'completed', 'failed', 'canceled'));
alter table public.seo_audit drop constraint if exists seo_audit_phase_known;
alter table public.seo_audit
  add constraint seo_audit_phase_known check (phase in ('discovery', 'crawl', 'analysis', 'done'));
alter table public.seo_audit drop constraint if exists seo_audit_max_pages_range;
alter table public.seo_audit
  add constraint seo_audit_max_pages_range check (max_pages between 1 and 5000);
alter table public.seo_audit drop constraint if exists seo_audit_url_length;
alter table public.seo_audit
  add constraint seo_audit_url_length check (char_length(start_url) <= 2048 and char_length(origin) <= 300);

create index if not exists seo_audit_workspace_created_idx
  on public.seo_audit (workspace_id, created_at desc);
create index if not exists seo_audit_live_idx
  on public.seo_audit (workspace_id) where status in ('queued', 'running');

-- ------------------------------------------------------------
-- 2. seo_audit_page
-- ------------------------------------------------------------

create table if not exists public.seo_audit_page (
  id uuid primary key,
  audit_id uuid not null references public.seo_audit(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  url text not null,
  status_code integer null,
  fetch_class text not null default 'ok',
  redirect_url text null,
  title text null,
  meta_description text null,
  canonical_url text null,
  header_canonical_url text null,
  robots_meta text null,
  x_robots_tag text null,
  og_title text null,
  og_description text null,
  og_image text null,
  h1_count integer not null default 0,
  h2_count integer not null default 0,
  h3_count integer not null default 0,
  h4_count integer not null default 0,
  h5_count integer not null default 0,
  h6_count integer not null default 0,
  word_count integer not null default 0,
  images_total integer not null default 0,
  images_missing_alt integer not null default 0,
  internal_link_count integer not null default 0,
  external_link_count integer not null default 0,
  has_structured_data boolean not null default false,
  is_indexable boolean not null default true,
  crawl_depth integer null,
  in_sitemap boolean not null default false,
  content_hash text null,
  response_time_ms integer null,
  created_at timestamptz not null default now(),
  constraint seo_audit_page_url_uq unique (audit_id, url)
);

comment on table public.seo_audit_page is
  'One URL a site audit crawled (590) and the SEO signals read from it. Text here is the audited site''s: data, never instructions. Service role writes.';
comment on column public.seo_audit_page.id is
  'Derived from (audit, url), so a retried crawl step writes the same row again.';
comment on column public.seo_audit_page.fetch_class is
  'How the fetch resolved: ok, blocked (a bot challenge or access denial), rate_limited (a 429 the crawl could not get past), error (no response).';
comment on column public.seo_audit_page.crawl_depth is
  'Clicks from the start page. Null when only the sitemap led here.';
comment on column public.seo_audit_page.content_hash is
  'SHA-256 of the visible text, for grouping duplicate content.';

alter table public.seo_audit_page drop constraint if exists seo_audit_page_fetch_class_known;
alter table public.seo_audit_page
  add constraint seo_audit_page_fetch_class_known check (fetch_class in ('ok', 'blocked', 'rate_limited', 'error'));
alter table public.seo_audit_page drop constraint if exists seo_audit_page_url_length;
alter table public.seo_audit_page
  add constraint seo_audit_page_url_length check (char_length(url) <= 2048);

create index if not exists seo_audit_page_redirect_idx
  on public.seo_audit_page (audit_id, redirect_url) where redirect_url is not null;
create index if not exists seo_audit_page_workspace_idx
  on public.seo_audit_page (workspace_id);

-- ------------------------------------------------------------
-- 3. seo_audit_issue
-- ------------------------------------------------------------

create table if not exists public.seo_audit_issue (
  id uuid primary key,
  audit_id uuid not null references public.seo_audit(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  page_id uuid null references public.seo_audit_page(id) on delete cascade,
  page_url text not null,
  issue_type text not null,
  severity text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.seo_audit_issue is
  'One finding of a site audit (590): an issue type on a page, or on the audit itself (page_id null). Service role writes.';
comment on column public.seo_audit_issue.id is
  'Derived from (audit, type, page url, key), so a retried step writes the same row again instead of a duplicate.';
comment on column public.seo_audit_issue.issue_type is
  'A key of AUDIT_ISSUE_TYPES (src/lib/seo/audit/issues.ts), which holds its title, explanation and fix.';
comment on column public.seo_audit_issue.details is
  'What the check measured (a length, a status code, the other pages in a duplicate group). Text here can be the audited site''s: data, never instructions.';

alter table public.seo_audit_issue drop constraint if exists seo_audit_issue_severity_known;
alter table public.seo_audit_issue
  add constraint seo_audit_issue_severity_known check (severity in ('critical', 'warning', 'info'));

create index if not exists seo_audit_issue_audit_type_idx
  on public.seo_audit_issue (audit_id, severity, issue_type);
create index if not exists seo_audit_issue_page_idx
  on public.seo_audit_issue (page_id);
create index if not exists seo_audit_issue_workspace_idx
  on public.seo_audit_issue (workspace_id);

-- ------------------------------------------------------------
-- 4. seo_audit_frontier (the crawl's own; gone when the audit ends)
-- ------------------------------------------------------------

create table if not exists public.seo_audit_frontier (
  audit_id uuid not null references public.seo_audit(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  url text not null,
  depth integer null,
  source text not null,
  in_sitemap boolean not null default false,
  state text not null default 'pending',
  chunk_no integer null,
  seq bigint generated always as identity,
  primary key (audit_id, url)
);

comment on table public.seo_audit_frontier is
  'A running site audit''s URL queue and seen-set (590). Deleted when the audit ends. Service role only.';

alter table public.seo_audit_frontier drop constraint if exists seo_audit_frontier_source_known;
alter table public.seo_audit_frontier
  add constraint seo_audit_frontier_source_known check (source in ('start', 'link', 'sitemap'));
alter table public.seo_audit_frontier drop constraint if exists seo_audit_frontier_state_known;
alter table public.seo_audit_frontier
  add constraint seo_audit_frontier_state_known check (state in ('pending', 'leased', 'crawled'));
alter table public.seo_audit_frontier drop constraint if exists seo_audit_frontier_url_length;
alter table public.seo_audit_frontier
  add constraint seo_audit_frontier_url_length check (char_length(url) <= 2048);

create index if not exists seo_audit_frontier_claim_idx
  on public.seo_audit_frontier (audit_id, state, seq);
create index if not exists seo_audit_frontier_chunk_idx
  on public.seo_audit_frontier (audit_id, chunk_no) where chunk_no is not null;
create index if not exists seo_audit_frontier_workspace_idx
  on public.seo_audit_frontier (workspace_id);

-- ------------------------------------------------------------
-- 5. seo_audit_link (the crawl's own; gone when the audit ends)
-- ------------------------------------------------------------

create table if not exists public.seo_audit_link (
  audit_id uuid not null references public.seo_audit(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  page_id uuid not null,
  url text not null,
  targets jsonb not null default '[]'::jsonb,
  primary key (audit_id, page_id)
);

comment on table public.seo_audit_link is
  'One crawled page''s internal link targets, as a JSON array of URLs (590). Read once by the broken-link and orphan-page checks, then deleted. Service role only.';

create index if not exists seo_audit_link_workspace_idx
  on public.seo_audit_link (workspace_id);

-- ------------------------------------------------------------
-- 6. seo_audit_start_log (the start's own; outlives deleted audits)
-- ------------------------------------------------------------

create table if not exists public.seo_audit_start_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  started_at timestamptz not null default now()
);

comment on table public.seo_audit_start_log is
  'One row per site audit started (590), counted for the daily start limit. Kept apart from seo_audit so deleting audits never frees a start; rows older than two days are pruned by seo_audit_start. Service role only.';

create index if not exists seo_audit_start_log_workspace_idx
  on public.seo_audit_start_log (workspace_id, started_at);

-- ------------------------------------------------------------
-- Functions (service role only)
-- ------------------------------------------------------------

-- Start an audit. A per-workspace transaction advisory lock makes the check
-- and the insert one step: two starts at once can't both find no live audit.
-- Outcomes:
--   live     an audit of this workspace is queued or running: its id, nothing written.
--   limit    p_daily_limit starts in the last 24 hours, as seo_audit_start_log
--            counts them (deleted audits included): no audit written.
--   started  the new audit's id, and a start-log row. Before the insert, what
--            ended audits of this workspace left behind is swept: queue and
--            link rows a step wrote after its audit was canceled, and their
--            saved robots.txt.
-- Either of the last two first prunes this workspace's start-log rows older
-- than 48 hours.
create or replace function public.seo_audit_start(
  p_workspace uuid,
  p_started_by uuid,
  p_start_url text,
  p_origin text,
  p_max_pages integer,
  p_daily_limit integer
)
returns table (outcome text, audit_id uuid)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_started integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('seo_audit_start:' || p_workspace::text, 0));

  select a.id into v_id
  from public.seo_audit a
  where a.workspace_id = p_workspace and a.status in ('queued', 'running')
  order by a.created_at desc
  limit 1;
  if v_id is not null then
    return query select 'live'::text, v_id;
    return;
  end if;

  delete from public.seo_audit_start_log s
  where s.workspace_id = p_workspace and s.started_at < now() - interval '48 hours';
  select count(*) into v_started
  from public.seo_audit_start_log s
  where s.workspace_id = p_workspace and s.started_at > now() - interval '24 hours';
  if v_started >= greatest(p_daily_limit, 0) then
    return query select 'limit'::text, null::uuid;
    return;
  end if;

  delete from public.seo_audit_frontier f
  using public.seo_audit a
  where f.workspace_id = p_workspace
    and a.id = f.audit_id
    and a.status not in ('queued', 'running');
  delete from public.seo_audit_link l
  using public.seo_audit a
  where l.workspace_id = p_workspace
    and a.id = l.audit_id
    and a.status not in ('queued', 'running');
  update public.seo_audit a
    set robots_txt = null
  where a.workspace_id = p_workspace
    and a.status not in ('queued', 'running')
    and a.robots_txt is not null;

  insert into public.seo_audit_start_log (workspace_id) values (p_workspace);
  insert into public.seo_audit (workspace_id, started_by, start_url, origin, max_pages)
  values (p_workspace, p_started_by, p_start_url, p_origin, p_max_pages)
  returning id into v_id;
  return query select 'started'::text, v_id;
end;
$$;

comment on function public.seo_audit_start(uuid, uuid, text, text, integer, integer) is
  'Start a site audit (590): one live audit per workspace and a daily limit, under a per-workspace lock; sweeps what ended audits left behind.';

-- Queue the start page and the sitemap's URLs (p_rows: a JSON array of
-- {"url", "depth", "source", "in_sitemap"}). A URL already queued keeps its
-- row. Writes only while the audit is running: the row lock taken on the
-- audit means a cancel either lands first (nothing is written) or waits for
-- this to commit (and its cleanup then removes what was written). Returns
-- how many rows were new.
create or replace function public.seo_audit_seed(
  p_audit uuid,
  p_workspace uuid,
  p_rows jsonb
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  added integer;
begin
  perform 1 from public.seo_audit a
  where a.id = p_audit and a.workspace_id = p_workspace and a.status = 'running'
  for share;
  if not found then
    return 0;
  end if;

  with entries as (
    select e.value->>'url' as url,
      (e.value->>'depth')::integer as depth,
      e.value->>'source' as source,
      coalesce((e.value->>'in_sitemap')::boolean, false) as in_sitemap,
      e.ord
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as e(value, ord)
  ),
  incoming as (
    -- The first entry for a URL wins, as an insert of the batch in order would.
    select distinct on (n.url) n.url, n.depth, n.source, n.in_sitemap
    from entries n
    where n.url is not null and char_length(n.url) <= 2048
    order by n.url, n.ord
  ),
  written as (
    insert into public.seo_audit_frontier (audit_id, workspace_id, url, depth, source, in_sitemap)
    select p_audit, p_workspace, i.url, i.depth, i.source, i.in_sitemap from incoming i
    on conflict (audit_id, url) do nothing
    returning 1
  )
  select count(*) into added from written;
  return coalesce(added, 0);
end;
$$;

comment on function public.seo_audit_seed(uuid, uuid, jsonb) is
  'Queue a running site audit''s start page and sitemap URLs (590); returns how many were new.';

-- The next URLs for crawl chunk p_chunk, in the order to fetch them. Pages a
-- link reached go first, oldest first, because only a link gives a page its
-- click depth; pages only the sitemap lists follow. On a site whose links
-- keep leading to unlisted pages (tag archives, filters) that order alone
-- would spend the whole budget before the crawl got back to the sitemap, so
-- a page the sitemap does not list is claimed only while the budget left
-- after this chunk (p_pages_left_after) still covers every sitemap page
-- waiting. The start page (depth 0) is crawled either way.
--
-- Chunks of one audit run strictly one after another, so a row still leased
-- under an EARLIER chunk number is one that chunk lost (it ended without
-- saving or releasing it): this chunk may take it over.
create or replace function public.seo_audit_claim_chunk(
  p_audit uuid,
  p_chunk integer,
  p_limit integer,
  p_pages_left_after integer
)
returns table (url text, depth integer, in_sitemap boolean)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- A retried chunk: hand back what its failed attempt still holds, and
  -- claim nothing new under a chunk number that already ran.
  if exists (
    select 1 from public.seo_audit_frontier f
    where f.audit_id = p_audit and f.chunk_no = p_chunk
  ) then
    return query
      select f.url, f.depth, f.in_sitemap
      from public.seo_audit_frontier f
      where f.audit_id = p_audit and f.chunk_no = p_chunk and f.state = 'leased'
      order by case f.source when 'sitemap' then 1 else 0 end, f.seq;
    return;
  end if;

  return query
    with waiting_sitemap as (
      select count(*) as n
      from public.seo_audit_frontier s
      where s.audit_id = p_audit
        and s.in_sitemap
        and (s.state = 'pending' or (s.state = 'leased' and s.chunk_no < p_chunk))
    ),
    picked as (
      select f.url
      from public.seo_audit_frontier f, waiting_sitemap w
      where f.audit_id = p_audit
        and (f.state = 'pending' or (f.state = 'leased' and f.chunk_no < p_chunk))
        and (f.in_sitemap or f.depth = 0 or w.n <= greatest(p_pages_left_after, 0))
      order by case f.source when 'sitemap' then 1 else 0 end, f.seq
      limit greatest(p_limit, 0)
      for update of f skip locked
    ),
    claimed as (
      update public.seo_audit_frontier f
        set state = 'leased', chunk_no = p_chunk
      from picked
      where f.audit_id = p_audit and f.url = picked.url
      returning f.url, f.depth, f.in_sitemap, f.source, f.seq
    )
    -- UPDATE ... RETURNING promises no order: sort again, so the caller
    -- fetches in claim order even when it stops part-way.
    select c.url, c.depth, c.in_sitemap
    from claimed c
    order by case c.source when 'sitemap' then 1 else 0 end, c.seq;
end;
$$;

comment on function public.seo_audit_claim_chunk(uuid, integer, integer, integer) is
  'Lease the next URLs of a site audit for one crawl chunk (590); a retried chunk gets back the URLs it still holds.';

-- Queue link-discovered URLs, each with the click depth it was found at
-- (p_rows: a JSON array of {"url": "...", "depth": 2 | null}). A URL already
-- seen keeps its row (the crawl's dedup), except that a row not crawled yet
-- with no click depth, almost always a sitemap seed, takes the link's depth
-- and the link queue's priority while keeping its in-sitemap flag. Writes
-- only while the audit is running (the same row lock as seo_audit_seed).
-- Returns how many rows were new.
create or replace function public.seo_audit_discover(
  p_audit uuid,
  p_workspace uuid,
  p_rows jsonb
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  added integer;
begin
  perform 1 from public.seo_audit a
  where a.id = p_audit and a.workspace_id = p_workspace and a.status = 'running'
  for share;
  if not found then
    return 0;
  end if;

  with incoming as (
    select distinct on (r.url) r.url, r.depth
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(url text, depth integer)
    where r.url is not null and char_length(r.url) <= 2048
    order by r.url, r.depth nulls last
  ),
  written as (
    insert into public.seo_audit_frontier (audit_id, workspace_id, url, depth, source, in_sitemap)
    select p_audit, p_workspace, i.url, i.depth, 'link', false from incoming i
    on conflict (audit_id, url) do update
      set source = 'link', depth = excluded.depth
      where public.seo_audit_frontier.state <> 'crawled'
        and public.seo_audit_frontier.depth is null
        and excluded.depth is not null
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into added from written;
  return coalesce(added, 0);
end;
$$;

comment on function public.seo_audit_discover(uuid, uuid, jsonb) is
  'Queue link-discovered URLs for a site audit (590); returns how many were new.';

-- A crawl batch settles its URLs: the ones it fetched are done, the ones it
-- leased but could not start (the chunk ran out of time, or the site asked
-- for a pause) go back to the queue for a later chunk.
create or replace function public.seo_audit_settle_urls(
  p_audit uuid,
  p_crawled text[],
  p_released text[]
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(array_length(p_crawled, 1), 0) > 0 then
    update public.seo_audit_frontier f
      set state = 'crawled'
    where f.audit_id = p_audit and f.url = any (p_crawled);
  end if;
  if coalesce(array_length(p_released, 1), 0) > 0 then
    update public.seo_audit_frontier f
      set state = 'pending', chunk_no = null
    where f.audit_id = p_audit and f.url = any (p_released) and f.state = 'leased';
  end if;
end;
$$;

comment on function public.seo_audit_settle_urls(uuid, text[], text[]) is
  'Mark a site audit''s URLs crawled, and hand leased-but-unfetched ones back to the queue (590).';

-- Every internal link whose target the crawl fetched and saw fail.
create or replace function public.seo_audit_broken_links(p_audit uuid, p_limit integer)
returns table (source_page_id uuid, source_url text, target_url text, target_status integer)
language sql
stable
set search_path = public, pg_temp
as $$
  select l.page_id, l.url, t.value, p.status_code
  from public.seo_audit_link l
  cross join lateral jsonb_array_elements_text(l.targets) as t(value)
  join public.seo_audit_page p on p.audit_id = l.audit_id and p.url = t.value
  where l.audit_id = p_audit
    and p.status_code >= 400
    and p.fetch_class = 'ok'
  order by l.page_id, t.value
  limit greatest(p_limit, 0)
$$;

comment on function public.seo_audit_broken_links(uuid, integer) is
  'Internal links of a site audit whose target answered 4xx or 5xx (590).';

-- Pages nothing links to. The inbound set is built once and anti-joined; a
-- page linking to itself does not rescue it, and neither the start page nor
-- the target of a redirect counts as an orphan.
create or replace function public.seo_audit_orphan_pages(p_audit uuid, p_start_url text)
returns table (page_id uuid, url text)
language sql
stable
set search_path = public, pg_temp
as $$
  with inbound as (
    select distinct t.value as target_url
    from public.seo_audit_link l
    cross join lateral jsonb_array_elements_text(l.targets) as t(value)
    where l.audit_id = p_audit and t.value <> l.url
  )
  select p.id, p.url
  from public.seo_audit_page p
  left join inbound i on i.target_url = p.url
  where p.audit_id = p_audit
    and p.url <> p_start_url
    and p.fetch_class = 'ok'
    and p.status_code >= 200 and p.status_code < 300
    and i.target_url is null
    and not exists (
      select 1 from public.seo_audit_page r
      where r.audit_id = p_audit and r.redirect_url = p.url
    )
$$;

comment on function public.seo_audit_orphan_pages(uuid, text) is
  'Pages of a site audit that no other crawled page links to (590).';

-- The report's summary: how many findings of each type an audit has, and on
-- how many different pages.
create or replace function public.seo_audit_issue_summary(p_audit uuid)
returns table (issue_type text, severity text, issue_count bigint, page_count bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select i.issue_type, i.severity, count(*) as issue_count, count(distinct i.page_url) as page_count
  from public.seo_audit_issue i
  where i.audit_id = p_audit
  group by i.issue_type, i.severity
$$;

comment on function public.seo_audit_issue_summary(uuid) is
  'A site audit''s findings counted by type (590).';

revoke all on function public.seo_audit_start(uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.seo_audit_claim_chunk(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.seo_audit_seed(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.seo_audit_discover(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.seo_audit_settle_urls(uuid, text[], text[]) from public, anon, authenticated;
revoke all on function public.seo_audit_broken_links(uuid, integer) from public, anon, authenticated;
revoke all on function public.seo_audit_orphan_pages(uuid, text) from public, anon, authenticated;
revoke all on function public.seo_audit_issue_summary(uuid) from public, anon, authenticated;
grant execute on function public.seo_audit_start(uuid, uuid, text, text, integer, integer) to service_role;
grant execute on function public.seo_audit_claim_chunk(uuid, integer, integer, integer) to service_role;
grant execute on function public.seo_audit_seed(uuid, uuid, jsonb) to service_role;
grant execute on function public.seo_audit_discover(uuid, uuid, jsonb) to service_role;
grant execute on function public.seo_audit_settle_urls(uuid, text[], text[]) to service_role;
grant execute on function public.seo_audit_broken_links(uuid, integer) to service_role;
grant execute on function public.seo_audit_orphan_pages(uuid, text) to service_role;
grant execute on function public.seo_audit_issue_summary(uuid) to service_role;

-- ------------------------------------------------------------
-- RLS: members read their workspace's audits; the service role writes
-- ------------------------------------------------------------

alter table public.seo_audit enable row level security;
alter table public.seo_audit_page enable row level security;
alter table public.seo_audit_issue enable row level security;
alter table public.seo_audit_frontier enable row level security;
alter table public.seo_audit_link enable row level security;
alter table public.seo_audit_start_log enable row level security;

drop policy if exists seo_audit_select_member on public.seo_audit;
create policy seo_audit_select_member on public.seo_audit
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_audit_page_select_member on public.seo_audit_page;
create policy seo_audit_page_select_member on public.seo_audit_page
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_audit_issue_select_member on public.seo_audit_issue;
create policy seo_audit_issue_select_member on public.seo_audit_issue
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_audit from anon, authenticated;
revoke all on table public.seo_audit_page from anon, authenticated;
revoke all on table public.seo_audit_issue from anon, authenticated;
revoke all on table public.seo_audit_frontier from anon, authenticated;
revoke all on table public.seo_audit_link from anon, authenticated;
revoke all on table public.seo_audit_start_log from anon, authenticated;
grant select on table public.seo_audit to authenticated;
grant select on table public.seo_audit_page to authenticated;
grant select on table public.seo_audit_issue to authenticated;
grant all on table public.seo_audit to service_role;
grant all on table public.seo_audit_page to service_role;
grant all on table public.seo_audit_issue to service_role;
grant all on table public.seo_audit_frontier to service_role;
grant all on table public.seo_audit_link to service_role;
grant all on table public.seo_audit_start_log to service_role;
