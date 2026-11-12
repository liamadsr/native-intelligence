-- 594: SEO rank tracking.
--
-- A rank tracker follows where one site shows up on Google for a list of
-- keywords, in one market (a country, or a city inside it, and a language),
-- on desktop, mobile or both, down to a chosen depth of results. A check
-- buys the results pages from the search data provider (592's ledger and
-- monthly ceiling apply to every call), reads each keyword's page several
-- times, and keeps the best position it saw. Checks run when a person asks,
-- or on the tracker's own schedule. The check runs in the background lane
-- (src/lib/inngest/seo-rank-functions.ts); the schedule's clock is the cron
-- route src/app/api/cron/seo-rank-checks.
--
--   1. seo_rank_tracker    one tracker: the site, the market, the devices, the
--                          depth, the schedule (off, daily, weekly, monthly,
--                          with an optional time of day and its time zone),
--                          when the next scheduled check is due, who set it
--                          up (whose plan pays for the schedule), paused or
--                          not, and why the last scheduled check was skipped.
--   2. seo_rank_keyword    one keyword a tracker follows, pinned or not. One
--                          row per (tracker, keyword); the per-tracker cap
--                          (src/lib/seo/rank/limits.ts) is held by
--                          seo_rank_add_keywords, which locks the tracker.
--   3. seo_rank_run        one check: manual or scheduled, queued -> running
--                          -> completed | failed | canceled, its counts, what
--                          it was estimated to cost at most and what it
--                          really cost, and why it failed. At most one live
--                          check per tracker, and at most one scheduled check
--                          per tracker per due time (both unique indexes are
--                          keyed on the tracker, never on the workspace).
--   4. seo_rank_run_post   one paid batch of a check (up to 100 searches): the
--                          marker written BEFORE the provider is called, then
--                          the provider's task ids and the cost. A retried
--                          step that finds its marker never posts (and never
--                          pays) again.
--   5. seo_rank_snapshot   one keyword on one device in one check: the best
--                          position the check's reads found (null: not in the
--                          results read), the page that ranks, the kinds of
--                          result on the page. The id is derived from (check,
--                          keyword, device), so a retried step writes the
--                          same row. No foreign key to the keyword: the
--                          history of a keyword stays after it is removed.
--
-- Eight functions, service role only:
--
--   seo_rank_add_keywords(tracker, keywords, cap)
--                          adds the new ones, up to the cap, under a lock on
--                          the tracker row; returns what it added.
--   seo_rank_post_begin(run, key)
--                          the paid batch's marker: 'go' once, then 'posted'
--                          (with the task ids) or 'unknown' (the attempt that
--                          posted never wrote them back); 'inactive' when the
--                          check is no longer running.
--   seo_rank_post_record(run, key, tasks, cost)
--                          writes a posted batch's task ids and cost, and the
--                          check's cost so far.
--   seo_rank_write_snapshots(run, rows)
--                          writes a read's results: a new row as it is, an
--                          existing one only when the new position is better.
--   seo_rank_drop_unconfirmed_misses(run)
--                          a keyword the previous check found that every read
--                          of this one missed reads as "not checked" instead
--                          of "not found" (Google serves scrapers pages that
--                          leave real results out).
--   seo_rank_positions(tracker, device, keyword_ids)
--                          each keyword's latest position from a completed
--                          check and the one before it.
--   seo_rank_keyword_history(tracker, keyword, since)
--   seo_rank_trend(tracker, device, since)
--                          a keyword's series, and the tracker's per-check
--                          totals (found, top 3, top 10, top 100, average).
--
-- No per-workspace unique index: a workspace merge (402) re-stamps
-- workspace_id and must never meet a uniqueness it cannot resolve. A tracker
-- for the same site and market twice is refused in code.
--
-- RLS: workspace members read 1-3 and 5; only the service role writes. 4 is
-- the service role's alone. No other table changes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. seo_rank_tracker
-- ------------------------------------------------------------

create table if not exists public.seo_rank_tracker (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  domain text not null,
  location_code integer not null default 2840,
  language_code text not null default 'en',
  location_name text null,
  devices text not null default 'mobile',
  serp_depth integer not null default 20,
  schedule_interval text not null default 'manual',
  schedule_weekday smallint null,
  schedule_hour smallint null,
  schedule_minute smallint null,
  schedule_time_zone text null,
  next_check_at timestamptz null,
  last_checked_at timestamptz null,
  last_skip_reason text null,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_rank_tracker is
  'One SEO rank tracker (594): a site, a market, devices, a depth and a schedule. Service role writes.';
comment on column public.seo_rank_tracker.created_by is
  'Who set the tracker up. A scheduled check runs only while this person is still a member of the workspace and not on the free plan; the workspace''s monthly ceiling (592) pays.';
comment on column public.seo_rank_tracker.location_name is
  'A canonical Google location name for a city-level tracker ("Austin,Texas,United States"); null tracks the whole country.';
comment on column public.seo_rank_tracker.schedule_time_zone is
  'The time zone the chosen schedule time was given in. next_check_at is fixed in UTC from it and then advances in whole days or weeks.';
comment on column public.seo_rank_tracker.next_check_at is
  'When the next scheduled check is due. The cron advances it with a compare-and-set before it starts a check. Null when the schedule is off.';
comment on column public.seo_rank_tracker.last_skip_reason is
  'Why the last scheduled check did not run: not_configured, no_keywords, creator_gone, creator_not_member, free_plan. Null after a check that ran.';

alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_devices_known;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_devices_known check (devices in ('desktop', 'mobile', 'both'));
alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_depth_range;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_depth_range check (serp_depth between 10 and 100 and serp_depth % 10 = 0);
alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_interval_known;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_interval_known check (schedule_interval in ('manual', 'daily', 'weekly', 'monthly'));
alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_manual_not_due;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_manual_not_due check (schedule_interval <> 'manual' or next_check_at is null);
alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_time_range;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_time_range check (
    (schedule_weekday is null or schedule_weekday between 0 and 6)
    and (schedule_hour is null or schedule_hour between 0 and 23)
    and (schedule_minute is null or schedule_minute between 0 and 59)
  );
alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_skip_reason_known;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_skip_reason_known check (
    last_skip_reason is null
    or last_skip_reason in ('not_configured', 'no_keywords', 'creator_gone', 'creator_not_member', 'free_plan')
  );
alter table public.seo_rank_tracker drop constraint if exists seo_rank_tracker_text_length;
alter table public.seo_rank_tracker
  add constraint seo_rank_tracker_text_length check (
    char_length(domain) between 1 and 253
    and char_length(language_code) between 2 and 10
    and (location_name is null or char_length(location_name) between 1 and 200)
    and (schedule_time_zone is null or char_length(schedule_time_zone) <= 64)
  );

create index if not exists seo_rank_tracker_workspace_created_idx
  on public.seo_rank_tracker (workspace_id, created_at desc);
create index if not exists seo_rank_tracker_due_idx
  on public.seo_rank_tracker (next_check_at) where next_check_at is not null and not paused;

-- ------------------------------------------------------------
-- 2. seo_rank_keyword
-- ------------------------------------------------------------

create table if not exists public.seo_rank_keyword (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.seo_rank_tracker(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  keyword text not null,
  pinned_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint seo_rank_keyword_tracker_keyword_uq unique (tracker_id, keyword)
);

comment on table public.seo_rank_keyword is
  'One keyword a rank tracker follows (594), lowercased in the tracker''s language. Pinned ones list first. Service role writes.';

alter table public.seo_rank_keyword drop constraint if exists seo_rank_keyword_length;
alter table public.seo_rank_keyword
  add constraint seo_rank_keyword_length check (char_length(keyword) between 1 and 200);

create index if not exists seo_rank_keyword_workspace_idx
  on public.seo_rank_keyword (workspace_id);

-- ------------------------------------------------------------
-- 3. seo_rank_run
-- ------------------------------------------------------------

create table if not exists public.seo_rank_run (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.seo_rank_tracker(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  started_by uuid null references auth.users(id) on delete set null,
  trigger text not null,
  scheduled_for timestamptz null,
  status text not null default 'queued',
  keywords_total integer not null default 0,
  keywords_checked integer not null default 0,
  checks_total integer not null default 0,
  checks_collected integer not null default 0,
  estimate_usd numeric(12, 6) not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  error_code text null,
  error_detail text null,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  completed_at timestamptz null,
  updated_at timestamptz not null default now()
);

comment on table public.seo_rank_run is
  'One rank check (594): manual (a person asked) or scheduled (the tracker''s schedule). Service role writes.';
comment on column public.seo_rank_run.started_by is
  'The person who asked for a manual check; null for a scheduled one.';
comment on column public.seo_rank_run.scheduled_for is
  'The due time a scheduled check was started for. Unique per tracker, so the same due time can never start two checks.';
comment on column public.seo_rank_run.checks_total is
  'Keyword and device pairs the check reads (keywords times devices).';
comment on column public.seo_rank_run.checks_collected is
  'Pairs that got a result. The rest are named in error_detail as not checked.';
comment on column public.seo_rank_run.estimate_usd is
  'The most the check could cost (every pair read the maximum number of times), in USD.';
comment on column public.seo_rank_run.cost_usd is
  'What the provider charged for the check''s searches so far, in USD (the sum of its seo_rank_run_post rows).';
comment on column public.seo_rank_run.error_detail is
  'For a failed check, why, in words for the person. For a completed one, which keywords got no result.';

alter table public.seo_rank_run drop constraint if exists seo_rank_run_status_known;
alter table public.seo_rank_run
  add constraint seo_rank_run_status_known check (status in ('queued', 'running', 'completed', 'failed', 'canceled'));
alter table public.seo_rank_run drop constraint if exists seo_rank_run_trigger_known;
alter table public.seo_rank_run
  add constraint seo_rank_run_trigger_known check (trigger in ('manual', 'scheduled'));
alter table public.seo_rank_run drop constraint if exists seo_rank_run_scheduled_has_time;
alter table public.seo_rank_run
  add constraint seo_rank_run_scheduled_has_time check ((trigger = 'scheduled') = (scheduled_for is not null));
alter table public.seo_rank_run drop constraint if exists seo_rank_run_money_not_negative;
alter table public.seo_rank_run
  add constraint seo_rank_run_money_not_negative check (estimate_usd >= 0 and cost_usd >= 0);
alter table public.seo_rank_run drop constraint if exists seo_rank_run_error_length;
alter table public.seo_rank_run
  add constraint seo_rank_run_error_length check (
    (error_code is null or char_length(error_code) <= 60)
    and (error_detail is null or char_length(error_detail) <= 2000)
  );

-- At most one live check per tracker: a second start fails on this index,
-- which is the "already running" answer. Keyed on the tracker.
create unique index if not exists seo_rank_run_one_live_per_tracker
  on public.seo_rank_run (tracker_id) where status in ('queued', 'running');
-- A due time starts one check, whatever two overlapping cron ticks do.
create unique index if not exists seo_rank_run_one_per_due_time
  on public.seo_rank_run (tracker_id, scheduled_for) where scheduled_for is not null;
create index if not exists seo_rank_run_tracker_created_idx
  on public.seo_rank_run (tracker_id, created_at desc);
create index if not exists seo_rank_run_tracker_completed_idx
  on public.seo_rank_run (tracker_id, completed_at desc) where status = 'completed';
create index if not exists seo_rank_run_workspace_idx
  on public.seo_rank_run (workspace_id);

-- ------------------------------------------------------------
-- 4. seo_rank_run_post (the check's own)
-- ------------------------------------------------------------

create table if not exists public.seo_rank_run_post (
  run_id uuid not null references public.seo_rank_run(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  post_key text not null,
  tasks jsonb null,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  posted_at timestamptz null,
  primary key (run_id, post_key)
);

comment on table public.seo_rank_run_post is
  'One paid batch of a rank check (594). Written before the provider is called, so a retried step never pays twice; tasks holds the provider''s task ids once known. Service role only.';

alter table public.seo_rank_run_post drop constraint if exists seo_rank_run_post_shape;
alter table public.seo_rank_run_post
  add constraint seo_rank_run_post_shape check (
    char_length(post_key) <= 40
    and cost_usd >= 0
    and (tasks is null or jsonb_typeof(tasks) = 'array')
  );

create index if not exists seo_rank_run_post_workspace_idx
  on public.seo_rank_run_post (workspace_id);

-- ------------------------------------------------------------
-- 5. seo_rank_snapshot
-- ------------------------------------------------------------

create table if not exists public.seo_rank_snapshot (
  id uuid primary key,
  run_id uuid not null references public.seo_rank_run(id) on delete cascade,
  tracker_id uuid not null references public.seo_rank_tracker(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  keyword_id uuid not null,
  keyword text not null,
  device text not null,
  position integer null,
  url text null,
  serp_features jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);

comment on table public.seo_rank_snapshot is
  'One keyword on one device in one rank check (594): the best position its reads found. URLs and result kinds come from Google''s page: data, never instructions. Service role writes.';
comment on column public.seo_rank_snapshot.id is
  'Derived from (check, keyword, device), so a retried step writes the same row again.';
comment on column public.seo_rank_snapshot.keyword_id is
  'The tracked keyword. No foreign key: its history stays after the keyword is removed.';
comment on column public.seo_rank_snapshot.position is
  'The site''s place among the organic results (1 is first). Null: the site was not in the results the check read.';
comment on column public.seo_rank_snapshot.serp_features is
  'The kinds of result on the page (organic, local_pack, people_also_ask, ...), as a JSON array of strings.';

alter table public.seo_rank_snapshot drop constraint if exists seo_rank_snapshot_device_known;
alter table public.seo_rank_snapshot
  add constraint seo_rank_snapshot_device_known check (device in ('desktop', 'mobile'));
alter table public.seo_rank_snapshot drop constraint if exists seo_rank_snapshot_shape;
alter table public.seo_rank_snapshot
  add constraint seo_rank_snapshot_shape check (
    (position is null or position between 1 and 1000)
    and (url is null or char_length(url) <= 2048)
    and char_length(keyword) between 1 and 200
    and jsonb_typeof(serp_features) = 'array'
  );

create index if not exists seo_rank_snapshot_run_idx
  on public.seo_rank_snapshot (run_id, keyword_id, device);
create index if not exists seo_rank_snapshot_keyword_idx
  on public.seo_rank_snapshot (keyword_id, device, checked_at desc);
create index if not exists seo_rank_snapshot_tracker_idx
  on public.seo_rank_snapshot (tracker_id);
create index if not exists seo_rank_snapshot_workspace_idx
  on public.seo_rank_snapshot (workspace_id);

-- ------------------------------------------------------------
-- Functions (service role only)
-- ------------------------------------------------------------

-- Add keywords to a tracker, the new ones only, in the order given, until the
-- tracker holds p_cap. The lock on the tracker row makes two adds at once
-- queue, so together they can't pass the cap. Returns the rows it added.
create or replace function public.seo_rank_add_keywords(
  p_tracker uuid,
  p_keywords text[],
  p_cap integer
)
returns table (id uuid, keyword text)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_workspace uuid;
  v_have integer;
begin
  select t.workspace_id into v_workspace
  from public.seo_rank_tracker t
  where t.id = p_tracker
  for update;
  if v_workspace is null then
    return;
  end if;

  select count(*) into v_have from public.seo_rank_keyword k where k.tracker_id = p_tracker;

  return query
    with incoming as (
      select distinct on (u.k) u.k, u.ord
      from unnest(coalesce(p_keywords, '{}'::text[])) with ordinality as u(k, ord)
      where u.k is not null and char_length(u.k) between 1 and 200
      order by u.k, u.ord
    ),
    fresh as (
      select i.k, i.ord
      from incoming i
      where not exists (
        select 1 from public.seo_rank_keyword e where e.tracker_id = p_tracker and e.keyword = i.k
      )
      order by i.ord
      limit greatest(p_cap - v_have, 0)
    )
    insert into public.seo_rank_keyword as kw (tracker_id, workspace_id, keyword)
    select p_tracker, v_workspace, f.k from fresh f order by f.ord
    on conflict on constraint seo_rank_keyword_tracker_keyword_uq do nothing
    returning kw.id, kw.keyword;
end;
$$;

comment on function public.seo_rank_add_keywords(uuid, text[], integer) is
  'Add new keywords to a rank tracker up to a cap, under a lock on the tracker (594); returns the rows added.';

-- The marker of one paid batch, written before the provider is called. The
-- first caller gets 'go'. A later caller (a retried step) gets 'posted' with
-- the task ids when the first attempt wrote them back, or 'unknown' when it
-- never did: either way it must not post again. 'inactive' when the check is
-- not running (canceled, failed, gone): nothing is posted.
create or replace function public.seo_rank_post_begin(p_run uuid, p_key text)
returns table (state text, tasks jsonb)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_workspace uuid;
begin
  select r.status, r.workspace_id into v_status, v_workspace
  from public.seo_rank_run r
  where r.id = p_run;
  if v_status is distinct from 'running' then
    return query select 'inactive'::text, null::jsonb;
    return;
  end if;

  insert into public.seo_rank_run_post (run_id, workspace_id, post_key)
  values (p_run, v_workspace, p_key)
  on conflict (run_id, post_key) do nothing;
  if found then
    return query select 'go'::text, null::jsonb;
    return;
  end if;

  return query
    select case when p.tasks is null then 'unknown' else 'posted' end, p.tasks
    from public.seo_rank_run_post p
    where p.run_id = p_run and p.post_key = p_key;
end;
$$;

comment on function public.seo_rank_post_begin(uuid, text) is
  'Claim one paid batch of a rank check before posting it (594): go once, never again.';

-- A posted batch's task ids and cost, and the check's cost so far.
create or replace function public.seo_rank_post_record(
  p_run uuid,
  p_key text,
  p_tasks jsonb,
  p_cost numeric
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.seo_rank_run_post p
    set tasks = coalesce(p_tasks, '[]'::jsonb), cost_usd = greatest(coalesce(p_cost, 0), 0), posted_at = now()
  where p.run_id = p_run and p.post_key = p_key;

  update public.seo_rank_run r
    set cost_usd = coalesce((select sum(p.cost_usd) from public.seo_rank_run_post p where p.run_id = p_run), 0),
        updated_at = now()
  where r.id = p_run;
end;
$$;

comment on function public.seo_rank_post_record(uuid, text, jsonb, numeric) is
  'Write a posted rank check batch''s task ids and cost, and the check''s cost so far (594).';

-- One read's results for a check (p_rows: a JSON array of {id, keyword_id,
-- keyword, device, position, url, serp_features}). A pair with no row yet
-- takes the result as it is, a found position or a miss; a pair that has one
-- changes only for a better position. So a retried step changes nothing, and
-- a later read can only improve a pair. Returns the rows written.
create or replace function public.seo_rank_write_snapshots(p_run uuid, p_rows jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_tracker uuid;
  v_workspace uuid;
  written integer;
begin
  select r.tracker_id, r.workspace_id into v_tracker, v_workspace
  from public.seo_rank_run r
  where r.id = p_run;
  if v_tracker is null then
    return 0;
  end if;

  insert into public.seo_rank_snapshot as s
    (id, run_id, tracker_id, workspace_id, keyword_id, keyword, device, position, url, serp_features)
  select r.id, p_run, v_tracker, v_workspace, r.keyword_id, left(r.keyword, 200), r.device,
         r.position, left(r.url, 2048), coalesce(r.serp_features, '[]'::jsonb)
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
    as r(id uuid, keyword_id uuid, keyword text, device text, "position" integer, url text, serp_features jsonb)
  where r.id is not null and r.keyword_id is not null
  on conflict (id) do update
    set position = excluded.position,
        url = excluded.url,
        serp_features = excluded.serp_features,
        checked_at = now()
    where excluded.position is not null
      and (s.position is null or excluded.position < s.position);
  get diagnostics written = row_count;
  return written;
end;
$$;

comment on function public.seo_rank_write_snapshots(uuid, jsonb) is
  'Write a rank check read''s results (594): new pairs as they are, existing ones only when better.';

-- A pair that every read of this check missed, and that the tracker's
-- previous completed check found on the same device, reads as not checked:
-- its row goes, so the previous position keeps showing. Google serves
-- scrapers pages that leave real results out; a keyword that really dropped
-- shows as not found from the next check on. Returns the rows removed.
create or replace function public.seo_rank_drop_unconfirmed_misses(p_run uuid)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_tracker uuid;
  v_previous uuid;
  removed integer;
begin
  select r.tracker_id into v_tracker from public.seo_rank_run r where r.id = p_run;
  if v_tracker is null then
    return 0;
  end if;
  select r.id into v_previous
  from public.seo_rank_run r
  where r.tracker_id = v_tracker and r.status = 'completed' and r.id <> p_run
  order by r.completed_at desc nulls last
  limit 1;
  if v_previous is null then
    return 0;
  end if;

  delete from public.seo_rank_snapshot s
  where s.run_id = p_run
    and s.position is null
    and exists (
      select 1 from public.seo_rank_snapshot p
      where p.run_id = v_previous
        and p.keyword_id = s.keyword_id
        and p.device = s.device
        and p.position is not null
    );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.seo_rank_drop_unconfirmed_misses(uuid) is
  'Turn a rank check''s unconfirmed misses (found by the previous check) into "not checked" (594).';

-- Each tracked keyword's latest result from a completed check, and the result
-- before it, on each device the tracker checks (or the one asked for). Only
-- the keywords listed when p_keyword_ids is given.
create or replace function public.seo_rank_positions(
  p_tracker uuid,
  p_device text default null,
  p_keyword_ids uuid[] default null
)
returns table (
  keyword_id uuid,
  device text,
  "position" integer,
  url text,
  serp_features jsonb,
  checked_at timestamptz,
  previous_position integer,
  previous_checked_at timestamptz,
  has_current boolean,
  has_previous boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  select k.id, d.device,
         cur.position, cur.url, cur.serp_features, cur.checked_at,
         prev.position, prev.checked_at,
         cur.id is not null, prev.id is not null
  from public.seo_rank_keyword k
  join public.seo_rank_tracker t on t.id = k.tracker_id
  cross join (values ('desktop'), ('mobile')) as d(device)
  left join lateral (
    select s.id, s.position, s.url, s.serp_features, s.checked_at
    from public.seo_rank_snapshot s
    join public.seo_rank_run r on r.id = s.run_id and r.status = 'completed'
    where s.keyword_id = k.id and s.device = d.device
    order by s.checked_at desc
    limit 1
  ) cur on true
  left join lateral (
    select s.id, s.position, s.checked_at
    from public.seo_rank_snapshot s
    join public.seo_rank_run r on r.id = s.run_id and r.status = 'completed'
    where s.keyword_id = k.id and s.device = d.device
    order by s.checked_at desc
    offset 1
    limit 1
  ) prev on true
  where k.tracker_id = p_tracker
    and (t.devices = 'both' or t.devices = d.device)
    and (p_device is null or d.device = p_device)
    and (p_keyword_ids is null or k.id = any (p_keyword_ids))
  -- The keyword list's own order (pinned first, then alphabetical), so a
  -- caller paging through the function pages the way the list does.
  order by k.pinned_at desc nulls last, k.keyword, k.id, d.device
$$;

comment on function public.seo_rank_positions(uuid, text, uuid[]) is
  'Each tracked keyword''s latest rank check result and the one before it (594).';

-- One keyword's results over the tracker's completed checks since a moment,
-- oldest first, each at its check's start time.
create or replace function public.seo_rank_keyword_history(
  p_tracker uuid,
  p_keyword uuid,
  p_since timestamptz
)
returns table (run_id uuid, checked_at timestamptz, device text, "position" integer, url text)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.id, coalesce(r.started_at, r.created_at), s.device, s.position, s.url
  from public.seo_rank_snapshot s
  join public.seo_rank_run r on r.id = s.run_id and r.status = 'completed'
  where s.tracker_id = p_tracker
    and s.keyword_id = p_keyword
    and coalesce(r.started_at, r.created_at) >= p_since
  order by coalesce(r.started_at, r.created_at), s.device
$$;

comment on function public.seo_rank_keyword_history(uuid, uuid, timestamptz) is
  'One tracked keyword''s rank check results since a moment, oldest first (594).';

-- The tracker's totals per completed check on one device, oldest first: how
-- many pairs were checked, found, in the top 3, 10 and 100, and the average
-- position of those found.
create or replace function public.seo_rank_trend(
  p_tracker uuid,
  p_device text,
  p_since timestamptz
)
returns table (
  run_id uuid,
  checked_at timestamptz,
  keywords_total integer,
  checked bigint,
  found bigint,
  top3 bigint,
  top10 bigint,
  top100 bigint,
  average_position numeric
)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.id, coalesce(r.started_at, r.created_at), r.keywords_total,
         count(s.id),
         count(s.position),
         count(s.id) filter (where s.position between 1 and 3),
         count(s.id) filter (where s.position between 1 and 10),
         count(s.id) filter (where s.position between 1 and 100),
         round(avg(s.position)::numeric, 1)
  from public.seo_rank_run r
  left join public.seo_rank_snapshot s on s.run_id = r.id and s.device = p_device
  where r.tracker_id = p_tracker
    and r.status = 'completed'
    and coalesce(r.started_at, r.created_at) >= p_since
  group by r.id
  order by coalesce(r.started_at, r.created_at)
$$;

comment on function public.seo_rank_trend(uuid, text, timestamptz) is
  'A rank tracker''s per-check totals on one device since a moment, oldest first (594).';

revoke all on function public.seo_rank_add_keywords(uuid, text[], integer) from public, anon, authenticated;
revoke all on function public.seo_rank_post_begin(uuid, text) from public, anon, authenticated;
revoke all on function public.seo_rank_post_record(uuid, text, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.seo_rank_write_snapshots(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.seo_rank_drop_unconfirmed_misses(uuid) from public, anon, authenticated;
revoke all on function public.seo_rank_positions(uuid, text, uuid[]) from public, anon, authenticated;
revoke all on function public.seo_rank_keyword_history(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.seo_rank_trend(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.seo_rank_add_keywords(uuid, text[], integer) to service_role;
grant execute on function public.seo_rank_post_begin(uuid, text) to service_role;
grant execute on function public.seo_rank_post_record(uuid, text, jsonb, numeric) to service_role;
grant execute on function public.seo_rank_write_snapshots(uuid, jsonb) to service_role;
grant execute on function public.seo_rank_drop_unconfirmed_misses(uuid) to service_role;
grant execute on function public.seo_rank_positions(uuid, text, uuid[]) to service_role;
grant execute on function public.seo_rank_keyword_history(uuid, uuid, timestamptz) to service_role;
grant execute on function public.seo_rank_trend(uuid, text, timestamptz) to service_role;

-- ------------------------------------------------------------
-- RLS: members read their workspace's trackers; the service role writes
-- ------------------------------------------------------------

alter table public.seo_rank_tracker enable row level security;
alter table public.seo_rank_keyword enable row level security;
alter table public.seo_rank_run enable row level security;
alter table public.seo_rank_run_post enable row level security;
alter table public.seo_rank_snapshot enable row level security;

drop policy if exists seo_rank_tracker_select_member on public.seo_rank_tracker;
create policy seo_rank_tracker_select_member on public.seo_rank_tracker
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_rank_keyword_select_member on public.seo_rank_keyword;
create policy seo_rank_keyword_select_member on public.seo_rank_keyword
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_rank_run_select_member on public.seo_rank_run;
create policy seo_rank_run_select_member on public.seo_rank_run
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_rank_snapshot_select_member on public.seo_rank_snapshot;
create policy seo_rank_snapshot_select_member on public.seo_rank_snapshot
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_rank_tracker from anon, authenticated;
revoke all on table public.seo_rank_keyword from anon, authenticated;
revoke all on table public.seo_rank_run from anon, authenticated;
revoke all on table public.seo_rank_run_post from anon, authenticated;
revoke all on table public.seo_rank_snapshot from anon, authenticated;
grant select on table public.seo_rank_tracker to authenticated;
grant select on table public.seo_rank_keyword to authenticated;
grant select on table public.seo_rank_run to authenticated;
grant select on table public.seo_rank_snapshot to authenticated;
grant all on table public.seo_rank_tracker to service_role;
grant all on table public.seo_rank_keyword to service_role;
grant all on table public.seo_rank_run to service_role;
grant all on table public.seo_rank_run_post to service_role;
grant all on table public.seo_rank_snapshot to service_role;
