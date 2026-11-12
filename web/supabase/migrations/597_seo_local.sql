-- 597: SEO local search (a business's Google Business Profile and where it
-- shows on Google Maps across a town).
--
-- A workspace follows a few Google places (its own business, its branches).
-- For each it can read the Google Business Profile, its reviews, its posts
-- and its questions and answers; those reads are bought from the search data
-- provider (592's ledger and monthly ceiling apply to every call) and kept as
-- snapshots in seo_lookup (593), not in tables of their own. A rank grid is a
-- square of points around the business (3x3, 5x5 or 7x7, a radius in km) and
-- a few keywords; a scan searches Google Maps at every point for every
-- keyword and records where the business shows. A scan only ever starts
-- because a person asked: there is no schedule. It runs in the background
-- lane (src/lib/inngest/seo-local-functions.ts).
--
--   1. seo_local_business     one tracked Google place: its name, cid and
--                             place id, address, coordinate, categories,
--                             phone, website, and its rating and review count
--                             as of the last read, its country and language,
--                             who added it. The same place twice in a
--                             workspace is refused in code.
--   2. seo_local_grid         one rank grid of a business: its keywords, its
--                             centre, radius and size, the device and
--                             language it searches with.
--   3. seo_local_scan         one scan of a grid: queued -> running ->
--                             completed | failed | canceled. It keeps the
--                             grid as it was searched (keywords, centre,
--                             radius, size, zoom) and the business it looked
--                             for, so a later change to either leaves the
--                             scan readable. Its counts, the summary numbers
--                             once done, what it was estimated to cost and
--                             what its searches cost, and why it failed. At
--                             most one live scan per grid (a unique index
--                             keyed on the grid, never on the workspace).
--   4. seo_local_scan_post    one keyword's paid post of a scan (one search
--                             per grid point): the marker written BEFORE the
--                             provider is called, then the provider's task
--                             ids and the cost. A retried step that finds its
--                             marker never posts (and never pays) again.
--   5. seo_local_scan_point   one grid point for one keyword of a scan: its
--                             coordinate, the queued search's task id, and
--                             once read the business's position in the map
--                             results there (null: not among them), how many
--                             businesses were listed and the first few
--                             (jsonb). The id is derived from (scan, keyword,
--                             row, column), so a retried step writes the same
--                             row. A point whose search never came back ends
--                             'not_collected'.
--
-- Three functions, service role only:
--
--   seo_local_post_begin(scan, key)
--                             the paid post's marker: 'go' once, then
--                             'posted' (with the task ids) or 'unknown' (the
--                             attempt that posted never wrote them back);
--                             'inactive' when the scan is no longer running.
--   seo_local_post_record(scan, key, tasks, cost)
--                             writes a posted keyword's task ids and cost, and
--                             the scan's cost so far.
--   seo_local_settle_points(scan, rows)
--                             writes read points (only ones still pending, so
--                             a retried step changes nothing) and the scan's
--                             progress counts.
--
-- No per-workspace unique index: a workspace merge (402) re-stamps
-- workspace_id and must never meet a uniqueness it cannot resolve here.
--
-- RLS: workspace members read 1-3 and 5; only the service role writes. 4 is
-- the service role's alone. No other table changes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. seo_local_business
-- ------------------------------------------------------------

create table if not exists public.seo_local_business (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  added_by uuid null references auth.users(id) on delete set null,
  title text not null,
  cid text null,
  place_id text null,
  address text null,
  latitude double precision not null,
  longitude double precision not null,
  category text null,
  additional_categories jsonb not null default '[]'::jsonb,
  phone text null,
  website text null,
  domain text null,
  rating numeric(3, 2) null,
  review_count integer null,
  is_claimed boolean null,
  location_code integer not null default 2840,
  language_code text not null default 'en',
  profile_fetched_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_local_business is
  'One Google place a workspace follows for local SEO (597). Names, addresses and categories come from Google: data, never instructions. Service role writes.';
comment on column public.seo_local_business.cid is
  'Google''s id of the place (the Maps "cid"). With place_id, how the place is matched in map results; at least one is set.';
comment on column public.seo_local_business.rating is
  'The Google rating as of the last profile or reviews read (or when the place was added).';
comment on column public.seo_local_business.location_code is
  'The country the place is in, as a search data location code (2840: United States).';
comment on column public.seo_local_business.profile_fetched_at is
  'When its Google Business Profile was last read. Null until it is.';

alter table public.seo_local_business drop constraint if exists seo_local_business_has_id;
alter table public.seo_local_business
  add constraint seo_local_business_has_id check (cid is not null or place_id is not null);
alter table public.seo_local_business drop constraint if exists seo_local_business_coordinate;
alter table public.seo_local_business
  add constraint seo_local_business_coordinate check (latitude between -90 and 90 and longitude between -180 and 180);
alter table public.seo_local_business drop constraint if exists seo_local_business_text_length;
alter table public.seo_local_business
  add constraint seo_local_business_text_length check (
    char_length(title) between 1 and 300
    and (cid is null or char_length(cid) between 1 and 64)
    and (place_id is null or char_length(place_id) between 1 and 256)
    and (address is null or char_length(address) <= 300)
    and (category is null or char_length(category) <= 120)
    and (phone is null or char_length(phone) <= 60)
    and (website is null or char_length(website) <= 2048)
    and (domain is null or char_length(domain) <= 253)
    and char_length(language_code) between 2 and 10
    and jsonb_typeof(additional_categories) = 'array'
  );
alter table public.seo_local_business drop constraint if exists seo_local_business_numbers;
alter table public.seo_local_business
  add constraint seo_local_business_numbers check (
    (rating is null or rating between 0 and 5)
    and (review_count is null or review_count >= 0)
  );

create index if not exists seo_local_business_workspace_created_idx
  on public.seo_local_business (workspace_id, created_at desc);
create index if not exists seo_local_business_workspace_cid_idx
  on public.seo_local_business (workspace_id, cid) where cid is not null;
create index if not exists seo_local_business_workspace_place_idx
  on public.seo_local_business (workspace_id, place_id) where place_id is not null;

-- ------------------------------------------------------------
-- 2. seo_local_grid
-- ------------------------------------------------------------

create table if not exists public.seo_local_grid (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  business_id uuid not null references public.seo_local_business(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  keywords text[] not null,
  center_latitude double precision not null,
  center_longitude double precision not null,
  radius_km numeric(6, 3) not null,
  size smallint not null default 5,
  device text not null default 'mobile',
  language_code text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_local_grid is
  'One rank grid of a tracked place (597): keywords searched on Google Maps at every point of a square around a centre. Service role writes.';
comment on column public.seo_local_grid.radius_km is
  'Kilometres from the centre to the grid''s edge. The spacing between points is twice this over (size - 1).';
comment on column public.seo_local_grid.size is
  'Points across the grid: 3, 5 or 7 (9, 25 or 49 searches per keyword).';

alter table public.seo_local_grid drop constraint if exists seo_local_grid_shape;
alter table public.seo_local_grid
  add constraint seo_local_grid_shape check (
    size in (3, 5, 7)
    and radius_km > 0 and radius_km <= 50
    and center_latitude between -85 and 85
    and center_longitude between -180 and 180
    and device in ('mobile', 'desktop')
    and char_length(language_code) between 2 and 10
    and cardinality(keywords) between 1 and 10
  );

create index if not exists seo_local_grid_business_idx
  on public.seo_local_grid (business_id, created_at);
create index if not exists seo_local_grid_workspace_idx
  on public.seo_local_grid (workspace_id);

-- ------------------------------------------------------------
-- 3. seo_local_scan
-- ------------------------------------------------------------

create table if not exists public.seo_local_scan (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  grid_id uuid not null references public.seo_local_grid(id) on delete cascade,
  business_id uuid not null references public.seo_local_business(id) on delete cascade,
  started_by uuid null references auth.users(id) on delete set null,
  status text not null default 'queued',
  keywords text[] not null,
  size smallint not null,
  radius_km numeric(6, 3) not null,
  spacing_km numeric(6, 3) not null,
  center_latitude double precision not null,
  center_longitude double precision not null,
  zoom smallint not null,
  device text not null,
  language_code text not null,
  target_title text not null,
  target_cid text null,
  target_place_id text null,
  points_total integer not null default 0,
  points_collected integer not null default 0,
  points_found integer not null default 0,
  top3 integer null,
  top10 integer null,
  average_position numeric(5, 1) null,
  estimate_usd numeric(12, 6) not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  error_code text null,
  error_detail text null,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  completed_at timestamptz null,
  updated_at timestamptz not null default now()
);

comment on table public.seo_local_scan is
  'One scan of a local rank grid (597): a person asked for it. Keeps the grid and the place as they were searched. Service role writes.';
comment on column public.seo_local_scan.started_by is
  'The person who asked for the scan; its searches are metered in their name against the workspace''s monthly ceiling.';
comment on column public.seo_local_scan.points_total is
  'Searches the scan makes: keywords times grid points.';
comment on column public.seo_local_scan.points_collected is
  'Searches that came back. The rest end not collected.';
comment on column public.seo_local_scan.top3 is
  'Points (over every keyword) where the place was in the top 3, written when the scan completes. Null before.';
comment on column public.seo_local_scan.estimate_usd is
  'What the scan''s searches cost by the price list, in USD, when it was started.';
comment on column public.seo_local_scan.cost_usd is
  'What the searches the provider accepted cost by the price list, in USD (the sum of its seo_local_scan_post rows). The spend ledger (592) holds the exact charge.';
comment on column public.seo_local_scan.error_detail is
  'For a failed scan, why, in words for the person.';

alter table public.seo_local_scan drop constraint if exists seo_local_scan_status_known;
alter table public.seo_local_scan
  add constraint seo_local_scan_status_known check (status in ('queued', 'running', 'completed', 'failed', 'canceled'));
alter table public.seo_local_scan drop constraint if exists seo_local_scan_shape;
alter table public.seo_local_scan
  add constraint seo_local_scan_shape check (
    size in (3, 5, 7)
    and device in ('mobile', 'desktop')
    and zoom between 1 and 21
    and cardinality(keywords) between 1 and 10
    and char_length(target_title) between 1 and 300
    and (target_cid is null or char_length(target_cid) <= 64)
    and (target_place_id is null or char_length(target_place_id) <= 256)
    and points_total >= 0 and points_collected >= 0 and points_found >= 0
    and estimate_usd >= 0 and cost_usd >= 0
  );
alter table public.seo_local_scan drop constraint if exists seo_local_scan_error_length;
alter table public.seo_local_scan
  add constraint seo_local_scan_error_length check (
    (error_code is null or char_length(error_code) <= 60)
    and (error_detail is null or char_length(error_detail) <= 2000)
  );

-- At most one live scan per grid: a second start fails on this index, which
-- is the "already running" answer. Keyed on the grid.
create unique index if not exists seo_local_scan_one_live_per_grid
  on public.seo_local_scan (grid_id) where status in ('queued', 'running');
create index if not exists seo_local_scan_grid_created_idx
  on public.seo_local_scan (grid_id, created_at desc);
create index if not exists seo_local_scan_business_idx
  on public.seo_local_scan (business_id);
create index if not exists seo_local_scan_workspace_idx
  on public.seo_local_scan (workspace_id);

-- ------------------------------------------------------------
-- 4. seo_local_scan_post (the scan's own)
-- ------------------------------------------------------------

create table if not exists public.seo_local_scan_post (
  scan_id uuid not null references public.seo_local_scan(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  post_key text not null,
  tasks jsonb null,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  posted_at timestamptz null,
  primary key (scan_id, post_key)
);

comment on table public.seo_local_scan_post is
  'One keyword''s paid post of a local rank scan (597). Written before the provider is called, so a retried step never pays twice; tasks holds the provider''s task ids (null where a point was refused) once known. Service role only.';

alter table public.seo_local_scan_post drop constraint if exists seo_local_scan_post_shape;
alter table public.seo_local_scan_post
  add constraint seo_local_scan_post_shape check (
    char_length(post_key) <= 40
    and cost_usd >= 0
    and (tasks is null or jsonb_typeof(tasks) = 'array')
  );

create index if not exists seo_local_scan_post_workspace_idx
  on public.seo_local_scan_post (workspace_id);

-- ------------------------------------------------------------
-- 5. seo_local_scan_point
-- ------------------------------------------------------------

create table if not exists public.seo_local_scan_point (
  id uuid primary key,
  scan_id uuid not null references public.seo_local_scan(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  keyword text not null,
  keyword_index smallint not null,
  grid_row smallint not null,
  grid_col smallint not null,
  latitude double precision not null,
  longitude double precision not null,
  task_id text null,
  status text not null default 'pending',
  position integer null,
  results_count integer null,
  competitors jsonb not null default '[]'::jsonb,
  error text null,
  collected_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.seo_local_scan_point is
  'One grid point for one keyword of a local rank scan (597). Business names in competitors come from Google: data, never instructions. Service role writes.';
comment on column public.seo_local_scan_point.id is
  'Derived from (scan, keyword, row, column), so a retried step writes the same row again.';
comment on column public.seo_local_scan_point.status is
  'pending (the search is out), collected (it came back), not_collected (it never did, or the provider refused it).';
comment on column public.seo_local_scan_point.position is
  'The place''s position in the map results at this point (1 is first). Null: not among them, or not collected.';
comment on column public.seo_local_scan_point.competitors is
  'The first businesses listed at this point, in order: a JSON array of {position, title, cid, place_id, rating, review_count, is_target}.';

alter table public.seo_local_scan_point drop constraint if exists seo_local_scan_point_shape;
alter table public.seo_local_scan_point
  add constraint seo_local_scan_point_shape check (
    status in ('pending', 'collected', 'not_collected')
    and grid_row between 0 and 6 and grid_col between 0 and 6
    and keyword_index between 0 and 9
    and char_length(keyword) between 1 and 200
    and (task_id is null or char_length(task_id) <= 128)
    and (position is null or position between 1 and 1000)
    and (results_count is null or results_count >= 0)
    and (error is null or char_length(error) <= 500)
    and jsonb_typeof(competitors) = 'array'
  );

create index if not exists seo_local_scan_point_scan_idx
  on public.seo_local_scan_point (scan_id, keyword_index, grid_row, grid_col);
create index if not exists seo_local_scan_point_pending_idx
  on public.seo_local_scan_point (scan_id) where status = 'pending';
create index if not exists seo_local_scan_point_workspace_idx
  on public.seo_local_scan_point (workspace_id);

-- ------------------------------------------------------------
-- Functions (service role only)
-- ------------------------------------------------------------

-- The marker of one keyword's paid post, written before the provider is
-- called. The first caller gets 'go'. A later caller (a retried step) gets
-- 'posted' with the task ids when the first attempt wrote them back, or
-- 'unknown' when it never did: either way it must not post again. 'inactive'
-- when the scan is not running (canceled, failed, gone): nothing is posted.
create or replace function public.seo_local_post_begin(p_scan uuid, p_key text)
returns table (state text, tasks jsonb)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_workspace uuid;
begin
  select s.status, s.workspace_id into v_status, v_workspace
  from public.seo_local_scan s
  where s.id = p_scan;
  if v_status is distinct from 'running' then
    return query select 'inactive'::text, null::jsonb;
    return;
  end if;

  insert into public.seo_local_scan_post (scan_id, workspace_id, post_key)
  values (p_scan, v_workspace, p_key)
  on conflict (scan_id, post_key) do nothing;
  if found then
    return query select 'go'::text, null::jsonb;
    return;
  end if;

  return query
    select case when p.tasks is null then 'unknown' else 'posted' end, p.tasks
    from public.seo_local_scan_post p
    where p.scan_id = p_scan and p.post_key = p_key;
end;
$$;

comment on function public.seo_local_post_begin(uuid, text) is
  'Claim one keyword''s paid post of a local rank scan before posting it (597): go once, never again.';

-- A posted keyword's task ids and cost, and the scan's cost so far.
create or replace function public.seo_local_post_record(
  p_scan uuid,
  p_key text,
  p_tasks jsonb,
  p_cost numeric
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.seo_local_scan_post p
    set tasks = coalesce(p_tasks, '[]'::jsonb), cost_usd = greatest(coalesce(p_cost, 0), 0), posted_at = now()
  where p.scan_id = p_scan and p.post_key = p_key;

  update public.seo_local_scan s
    set cost_usd = coalesce((select sum(p.cost_usd) from public.seo_local_scan_post p where p.scan_id = p_scan), 0),
        updated_at = now()
  where s.id = p_scan;
end;
$$;

comment on function public.seo_local_post_record(uuid, text, jsonb, numeric) is
  'Write a posted local rank scan keyword''s task ids and cost, and the scan''s cost so far (597).';

-- Read points of a scan (p_rows: a JSON array of {id, status, position,
-- results_count, competitors, error}). Only a point still pending changes, so
-- a retried step writes nothing twice. Then the scan's progress counts.
-- Returns the points written.
create or replace function public.seo_local_settle_points(p_scan uuid, p_rows jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  written integer;
begin
  update public.seo_local_scan_point pt
    set status = r.status,
        position = case when r.status = 'collected' then r.position else null end,
        results_count = case when r.status = 'collected' then r.results_count else null end,
        competitors = case when r.status = 'collected' then coalesce(r.competitors, '[]'::jsonb) else '[]'::jsonb end,
        error = left(r.error, 500),
        collected_at = now()
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
    as r(id uuid, status text, position integer, results_count integer, competitors jsonb, error text)
  where pt.id = r.id
    and pt.scan_id = p_scan
    and pt.status = 'pending'
    and r.status in ('collected', 'not_collected');
  get diagnostics written = row_count;

  update public.seo_local_scan s
    set points_collected = (select count(*) from public.seo_local_scan_point p where p.scan_id = p_scan and p.status = 'collected'),
        points_found = (select count(*) from public.seo_local_scan_point p where p.scan_id = p_scan and p.status = 'collected' and p.position is not null),
        updated_at = now()
  where s.id = p_scan;
  return written;
end;
$$;

comment on function public.seo_local_settle_points(uuid, jsonb) is
  'Write a local rank scan''s read points, pending ones only, and its progress counts (597).';

revoke all on function public.seo_local_post_begin(uuid, text) from public, anon, authenticated;
revoke all on function public.seo_local_post_record(uuid, text, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.seo_local_settle_points(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.seo_local_post_begin(uuid, text) to service_role;
grant execute on function public.seo_local_post_record(uuid, text, jsonb, numeric) to service_role;
grant execute on function public.seo_local_settle_points(uuid, jsonb) to service_role;

-- ------------------------------------------------------------
-- RLS: members read their workspace's local SEO; the service role writes
-- ------------------------------------------------------------

alter table public.seo_local_business enable row level security;
alter table public.seo_local_grid enable row level security;
alter table public.seo_local_scan enable row level security;
alter table public.seo_local_scan_post enable row level security;
alter table public.seo_local_scan_point enable row level security;

drop policy if exists seo_local_business_select_member on public.seo_local_business;
create policy seo_local_business_select_member on public.seo_local_business
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_local_grid_select_member on public.seo_local_grid;
create policy seo_local_grid_select_member on public.seo_local_grid
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_local_scan_select_member on public.seo_local_scan;
create policy seo_local_scan_select_member on public.seo_local_scan
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_local_scan_point_select_member on public.seo_local_scan_point;
create policy seo_local_scan_point_select_member on public.seo_local_scan_point
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_local_business from anon, authenticated;
revoke all on table public.seo_local_grid from anon, authenticated;
revoke all on table public.seo_local_scan from anon, authenticated;
revoke all on table public.seo_local_scan_post from anon, authenticated;
revoke all on table public.seo_local_scan_point from anon, authenticated;
grant select on table public.seo_local_business to authenticated;
grant select on table public.seo_local_grid to authenticated;
grant select on table public.seo_local_scan to authenticated;
grant select on table public.seo_local_scan_point to authenticated;
grant all on table public.seo_local_business to service_role;
grant all on table public.seo_local_grid to service_role;
grant all on table public.seo_local_scan to service_role;
grant all on table public.seo_local_scan_post to service_role;
grant all on table public.seo_local_scan_point to service_role;
