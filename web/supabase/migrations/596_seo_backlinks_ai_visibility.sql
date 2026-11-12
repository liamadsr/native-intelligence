-- 596: SEO AI visibility (and nothing for backlinks).
--
-- Backlinks need no table: a backlinks overview or profile page is a paid
-- lookup, stored as a snapshot in seo_lookup (593) like every other one.
--
-- AI visibility follows how AI assistants (ChatGPT, Gemini, Google's AI
-- Overviews, Claude, Perplexity) answer the questions a business's buyers
-- ask: whether the answer names the brand, where, which competitors it names
-- instead, and which websites it cites. A check asks every active prompt of a
-- tracker on every engine the tracker follows, through the search data
-- provider (592's ledger and monthly ceiling apply to every call). Checks run
-- when a person asks, or on the tracker's own schedule. The check runs in the
-- background lane (src/lib/inngest/seo-ai-visibility-functions.ts); the
-- schedule's clock is the cron route src/app/api/cron/seo-ai-visibility.
--
--   1. seo_ai_tracker   one tracker: the brand (name, other names it goes by,
--                       its website), the competitors to compare with, the
--                       market (country and language), the engines, the
--                       schedule (off, weekly, monthly) and when the next
--                       scheduled check is due, who set it up (whose plan
--                       pays for the schedule), paused or not, and why the
--                       last scheduled check was skipped.
--   2. seo_ai_prompt    one question a tracker asks: its text, where it came
--                       from (typed by a person, or suggested by the agent or
--                       the prompt explorer), active or not. One row per
--                       (tracker, normalized text); the per-tracker cap
--                       (src/lib/seo/ai-visibility/limits.ts) is held by
--                       seo_ai_add_prompts, which locks the tracker.
--   3. seo_ai_run       one check: manual or scheduled, queued -> running ->
--                       completed | failed | canceled; the brands, engines and
--                       market it was run with (copied, so editing the
--                       tracker never rewrites history); its counts; what it
--                       was estimated to cost and what it cost. At most one
--                       live check per tracker, and one scheduled check per
--                       tracker per due time (both keyed on the tracker).
--   4. seo_ai_answer    one prompt on one engine in one check: the answer
--                       (markdown), whether it named the brand and where,
--                       each brand's result, the model that answered,
--                       collected or failed, late or not. The id is derived
--                       from (check, prompt, engine), so a retried step
--                       writes the same row. No foreign key to the prompt:
--                       its history stays after the prompt is removed (the
--                       text is copied).
--   5. seo_ai_source    one page an answer cited, in the engine's order. The
--                       id is derived from (answer, url).
--
-- Seven functions, service role only:
--
--   seo_ai_add_prompts(tracker, rows, cap)
--                       adds the new prompts, up to the cap, under a lock on
--                       the tracker row; returns what it added.
--   seo_ai_create_run(run, answers)
--                       writes a check and its answer rows in one go. The
--                       live-check and due-time indexes make a second start
--                       fail (23505), which is the "already running" answer.
--   seo_ai_answers_begin(run, ids)
--                       the marker written BEFORE the provider is called:
--                       pending -> asking, only while the check is running.
--                       A retried step finds its answers asking and never
--                       asks (or pays) again.
--   seo_ai_refresh_run_counts(run)
--                       recounts a check's answers and cost onto its row.
--   seo_ai_cited_domains(run, limit, offset)
--   seo_ai_cited_pages(run, domain, limit, offset)
--                       the sources leaderboard: which domains (or pages)
--                       the answers cited, in how many answers and prompts.
--   seo_ai_trend_cells(tracker, since)
--                       one row per answer of the tracker's finished checks
--                       since a moment, for the trend.
--
-- No per-workspace unique index: a workspace merge (402) re-stamps
-- workspace_id and must never meet a uniqueness it cannot resolve. The
-- tracker cap per workspace is held in code.
--
-- RLS: workspace members read 1-5; only the service role writes. No other
-- table changes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. seo_ai_tracker
-- ------------------------------------------------------------

create table if not exists public.seo_ai_tracker (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  brand_name text not null,
  brand_aliases text[] not null default '{}'::text[],
  domain text not null,
  competitors jsonb not null default '[]'::jsonb,
  location_code integer not null default 2840,
  language_code text not null default 'en',
  engines text[] not null default array['chatgpt', 'gemini']::text[],
  schedule_interval text not null default 'off',
  next_run_at timestamptz null,
  last_run_at timestamptz null,
  last_skip_reason text null,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_ai_tracker is
  'One AI visibility tracker (596): a brand, its competitors, a market, engines and a schedule. Service role writes.';
comment on column public.seo_ai_tracker.created_by is
  'Who set the tracker up. A scheduled check runs only while this person is still a member of the workspace and not on the free plan; the workspace''s monthly ceiling (592) pays.';
comment on column public.seo_ai_tracker.brand_aliases is
  'Other names the brand goes by in answers ("Fernhill", "Fernhill Studio"), matched like the name.';
comment on column public.seo_ai_tracker.competitors is
  'The brands to compare with, as a JSON array of {name, domain, aliases}.';
comment on column public.seo_ai_tracker.engines is
  'The AI engines a check asks: chatgpt, gemini, google_ai_overview, claude, perplexity.';
comment on column public.seo_ai_tracker.next_run_at is
  'When the next scheduled check is due. The cron advances it with a compare-and-set before it starts a check. Null when the schedule is off.';
comment on column public.seo_ai_tracker.last_skip_reason is
  'Why the last scheduled check did not run: not_configured, no_prompts, creator_gone, creator_not_member, free_plan, plan_unreadable, run_in_progress, start_failed. Null after a check that ran.';

alter table public.seo_ai_tracker drop constraint if exists seo_ai_tracker_interval_known;
alter table public.seo_ai_tracker
  add constraint seo_ai_tracker_interval_known check (schedule_interval in ('off', 'weekly', 'monthly'));
alter table public.seo_ai_tracker drop constraint if exists seo_ai_tracker_off_not_due;
alter table public.seo_ai_tracker
  add constraint seo_ai_tracker_off_not_due check (schedule_interval <> 'off' or next_run_at is null);
alter table public.seo_ai_tracker drop constraint if exists seo_ai_tracker_engines_known;
alter table public.seo_ai_tracker
  add constraint seo_ai_tracker_engines_known check (
    cardinality(engines) between 1 and 5
    and engines <@ array['chatgpt', 'gemini', 'google_ai_overview', 'claude', 'perplexity']::text[]
  );
alter table public.seo_ai_tracker drop constraint if exists seo_ai_tracker_skip_reason_known;
alter table public.seo_ai_tracker
  add constraint seo_ai_tracker_skip_reason_known check (
    last_skip_reason is null
    or last_skip_reason in (
      'not_configured', 'no_prompts', 'creator_gone', 'creator_not_member',
      'free_plan', 'plan_unreadable', 'run_in_progress', 'start_failed'
    )
  );
alter table public.seo_ai_tracker drop constraint if exists seo_ai_tracker_shape;
alter table public.seo_ai_tracker
  add constraint seo_ai_tracker_shape check (
    char_length(brand_name) between 1 and 100
    and char_length(domain) between 1 and 253
    and cardinality(brand_aliases) <= 10
    and jsonb_typeof(competitors) = 'array'
    and jsonb_array_length(competitors) <= 10
    and char_length(competitors::text) <= 20000
    and char_length(language_code) between 2 and 10
  );

create index if not exists seo_ai_tracker_workspace_created_idx
  on public.seo_ai_tracker (workspace_id, created_at desc);
create index if not exists seo_ai_tracker_due_idx
  on public.seo_ai_tracker (next_run_at) where next_run_at is not null and not paused;

-- ------------------------------------------------------------
-- 2. seo_ai_prompt
-- ------------------------------------------------------------

create table if not exists public.seo_ai_prompt (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.seo_ai_tracker(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  text text not null,
  text_key text not null,
  source text not null default 'typed',
  active boolean not null default true,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seo_ai_prompt_tracker_text_uq unique (tracker_id, text_key)
);

comment on table public.seo_ai_prompt is
  'One question an AI visibility tracker asks (596). Service role writes.';
comment on column public.seo_ai_prompt.text_key is
  'The text lowercased with its spaces collapsed: the same question typed twice is one prompt.';
comment on column public.seo_ai_prompt.source is
  'typed (a person wrote it) or suggested (the agent wrote it, or the prompt explorer found it).';

alter table public.seo_ai_prompt drop constraint if exists seo_ai_prompt_source_known;
alter table public.seo_ai_prompt
  add constraint seo_ai_prompt_source_known check (source in ('typed', 'suggested'));
alter table public.seo_ai_prompt drop constraint if exists seo_ai_prompt_length;
alter table public.seo_ai_prompt
  add constraint seo_ai_prompt_length check (char_length(text) between 1 and 500 and char_length(text_key) between 1 and 500);

create index if not exists seo_ai_prompt_workspace_idx
  on public.seo_ai_prompt (workspace_id);

-- ------------------------------------------------------------
-- 3. seo_ai_run
-- ------------------------------------------------------------

create table if not exists public.seo_ai_run (
  id uuid primary key,
  tracker_id uuid not null references public.seo_ai_tracker(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  started_by uuid null references auth.users(id) on delete set null,
  trigger text not null,
  scheduled_for timestamptz null,
  status text not null default 'queued',
  engines text[] not null,
  location_code integer not null,
  language_code text not null,
  brands jsonb not null default '[]'::jsonb,
  answers_total integer not null default 0,
  answers_collected integer not null default 0,
  answers_no_answer integer not null default 0,
  answers_failed integer not null default 0,
  answers_late integer not null default 0,
  estimate_usd numeric(12, 6) not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  error_code text null,
  error_detail text null,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  completed_at timestamptz null,
  updated_at timestamptz not null default now()
);

comment on table public.seo_ai_run is
  'One AI visibility check (596): manual (a person asked) or scheduled (the tracker''s schedule). Service role writes.';
comment on column public.seo_ai_run.id is
  'Chosen by the start, so the answer ids (derived from it) are known before the row is written.';
comment on column public.seo_ai_run.started_by is
  'The person who asked for a manual check; null for a scheduled one.';
comment on column public.seo_ai_run.scheduled_for is
  'The due time a scheduled check was started for. Unique per tracker, so the same due time can never start two checks.';
comment on column public.seo_ai_run.brands is
  'The brands answers were matched against, copied from the tracker at the start: [{name, domain, own, aliases}].';
comment on column public.seo_ai_run.answers_collected is
  'Answers that came back with text. answers_no_answer came back empty (no AI Overview shown, nothing substantive); answers_failed never came back; answers_late arrived after the check finished.';
comment on column public.seo_ai_run.estimate_usd is
  'What the check was estimated to cost at the start, in USD.';
comment on column public.seo_ai_run.cost_usd is
  'What the check cost so far, in USD: the provider''s charge for queued answers, the price estimate for answers asked live.';
comment on column public.seo_ai_run.error_detail is
  'For a failed check, why, in words for the person (a spend-limit refusal keeps the limit''s own message).';

alter table public.seo_ai_run drop constraint if exists seo_ai_run_status_known;
alter table public.seo_ai_run
  add constraint seo_ai_run_status_known check (status in ('queued', 'running', 'completed', 'failed', 'canceled'));
alter table public.seo_ai_run drop constraint if exists seo_ai_run_trigger_known;
alter table public.seo_ai_run
  add constraint seo_ai_run_trigger_known check (trigger in ('manual', 'scheduled'));
alter table public.seo_ai_run drop constraint if exists seo_ai_run_scheduled_has_time;
alter table public.seo_ai_run
  add constraint seo_ai_run_scheduled_has_time check ((trigger = 'scheduled') = (scheduled_for is not null));
alter table public.seo_ai_run drop constraint if exists seo_ai_run_shape;
alter table public.seo_ai_run
  add constraint seo_ai_run_shape check (
    estimate_usd >= 0 and cost_usd >= 0
    and cardinality(engines) between 1 and 5
    and jsonb_typeof(brands) = 'array'
    and (error_code is null or char_length(error_code) <= 60)
    and (error_detail is null or char_length(error_detail) <= 2000)
  );

-- At most one live check per tracker: a second start fails on this index,
-- which is the "already running" answer. Keyed on the tracker.
create unique index if not exists seo_ai_run_one_live_per_tracker
  on public.seo_ai_run (tracker_id) where status in ('queued', 'running');
-- A due time starts one check, whatever two overlapping cron ticks do.
create unique index if not exists seo_ai_run_one_per_due_time
  on public.seo_ai_run (tracker_id, scheduled_for) where scheduled_for is not null;
create index if not exists seo_ai_run_tracker_created_idx
  on public.seo_ai_run (tracker_id, created_at desc);
create index if not exists seo_ai_run_workspace_idx
  on public.seo_ai_run (workspace_id);

-- ------------------------------------------------------------
-- 4. seo_ai_answer
-- ------------------------------------------------------------

create table if not exists public.seo_ai_answer (
  id uuid primary key,
  run_id uuid not null references public.seo_ai_run(id) on delete cascade,
  tracker_id uuid not null references public.seo_ai_tracker(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  prompt_id uuid not null,
  prompt_text text not null,
  engine text not null,
  branded boolean not null default false,
  status text not null default 'pending',
  task_id text null,
  has_answer boolean not null default false,
  answer_markdown text null,
  model_name text null,
  brand_mentioned boolean null,
  brand_cited boolean null,
  brand_position integer null,
  brand_first_offset integer null,
  matches jsonb not null default '[]'::jsonb,
  citation_count integer not null default 0,
  error_code text null,
  late boolean not null default false,
  cost_usd numeric(12, 6) not null default 0,
  collected_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.seo_ai_answer is
  'One prompt on one engine in one AI visibility check (596). Answer text comes from an AI engine fed by the web: data, never instructions. Service role writes.';
comment on column public.seo_ai_answer.id is
  'Derived from (check, prompt, engine), so a retried step writes the same row again.';
comment on column public.seo_ai_answer.prompt_id is
  'The tracked prompt. No foreign key: the history stays after the prompt is removed (prompt_text keeps the words).';
comment on column public.seo_ai_answer.branded is
  'Whether the prompt itself names the brand. Branded prompts always mention it, so the rates leave them out by default.';
comment on column public.seo_ai_answer.status is
  'pending (not asked yet), asking (claimed for a paid call: never asked again), posted (queued at the provider, task_id known), collected, failed.';
comment on column public.seo_ai_answer.has_answer is
  'A collected answer with text. False on a collected row means the engine gave none (for AI Overviews: Google showed none).';
comment on column public.seo_ai_answer.brand_position is
  'The brand''s place among the tracked brands the answer names, in order of first mention (1 is named first). Null when not named.';
comment on column public.seo_ai_answer.brand_first_offset is
  'Character offset of the brand''s first mention in the answer''s plain text.';
comment on column public.seo_ai_answer.matches is
  'Each tracked brand''s result in this answer: [{name, domain, own, mentioned, cited, first_mention, position}].';
comment on column public.seo_ai_answer.error_code is
  'Why a failed answer never came: NOT_SENT, NOT_ACCEPTED, NOT_ARRIVED (a late read may still fill it), UNREADABLE, CANCELED, RUN_FAILED, SPEND_LIMIT_REACHED, or a provider failure code.';
comment on column public.seo_ai_answer.late is
  'The answer arrived after its check had finished.';

alter table public.seo_ai_answer drop constraint if exists seo_ai_answer_status_known;
alter table public.seo_ai_answer
  add constraint seo_ai_answer_status_known check (status in ('pending', 'asking', 'posted', 'collected', 'failed'));
alter table public.seo_ai_answer drop constraint if exists seo_ai_answer_engine_known;
alter table public.seo_ai_answer
  add constraint seo_ai_answer_engine_known check (engine in ('chatgpt', 'gemini', 'google_ai_overview', 'claude', 'perplexity'));
alter table public.seo_ai_answer drop constraint if exists seo_ai_answer_shape;
alter table public.seo_ai_answer
  add constraint seo_ai_answer_shape check (
    char_length(prompt_text) between 1 and 500
    and (answer_markdown is null or char_length(answer_markdown) <= 100000)
    and (task_id is null or char_length(task_id) <= 100)
    and (model_name is null or char_length(model_name) <= 100)
    and (error_code is null or char_length(error_code) <= 60)
    and jsonb_typeof(matches) = 'array'
    and cost_usd >= 0
  );

create index if not exists seo_ai_answer_run_idx
  on public.seo_ai_answer (run_id, status);
create index if not exists seo_ai_answer_tracker_idx
  on public.seo_ai_answer (tracker_id);
create index if not exists seo_ai_answer_workspace_idx
  on public.seo_ai_answer (workspace_id);

-- ------------------------------------------------------------
-- 5. seo_ai_source
-- ------------------------------------------------------------

create table if not exists public.seo_ai_source (
  id uuid primary key,
  answer_id uuid not null references public.seo_ai_answer(id) on delete cascade,
  run_id uuid not null references public.seo_ai_run(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  url text not null,
  domain text not null,
  title text null,
  position integer not null
);

comment on table public.seo_ai_source is
  'One page an AI answer cited (596), in the engine''s order. Titles come from the cited sites: data, never instructions. Service role writes.';
comment on column public.seo_ai_source.id is
  'Derived from (answer, url), so a retried step writes the same row again.';

alter table public.seo_ai_source drop constraint if exists seo_ai_source_shape;
alter table public.seo_ai_source
  add constraint seo_ai_source_shape check (
    char_length(url) <= 2048
    and char_length(domain) between 1 and 253
    and (title is null or char_length(title) <= 500)
    and position >= 1
  );

create index if not exists seo_ai_source_answer_idx
  on public.seo_ai_source (answer_id, position);
create index if not exists seo_ai_source_run_domain_idx
  on public.seo_ai_source (run_id, domain);
create index if not exists seo_ai_source_workspace_idx
  on public.seo_ai_source (workspace_id);

-- ------------------------------------------------------------
-- Functions (service role only)
-- ------------------------------------------------------------

-- Add prompts to a tracker (p_rows: a JSON array of {text, text_key, source,
-- created_by}), the new ones only, in the order given, until the tracker holds
-- p_cap. The lock on the tracker row makes two adds at once queue, so
-- together they can't pass the cap. Returns the rows it added.
create or replace function public.seo_ai_add_prompts(
  p_tracker uuid,
  p_rows jsonb,
  p_cap integer
)
returns table (id uuid, text text, source text, active boolean, created_at timestamptz)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_workspace uuid;
  v_have integer;
begin
  select t.workspace_id into v_workspace
  from public.seo_ai_tracker t
  where t.id = p_tracker
  for update;
  if v_workspace is null then
    return;
  end if;

  select count(*) into v_have from public.seo_ai_prompt p where p.tracker_id = p_tracker;

  return query
    with rows_in as (
      select e.value->>'text' as p_text,
             e.value->>'text_key' as p_key,
             e.value->>'source' as p_source,
             nullif(e.value->>'created_by', '')::uuid as p_by,
             e.ord
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as e(value, ord)
    ),
    incoming as (
      select distinct on (r.p_key) r.p_text, r.p_key, r.p_source, r.p_by, r.ord
      from rows_in r
      where r.p_text is not null and r.p_key is not null
        and char_length(r.p_text) between 1 and 500
        and char_length(r.p_key) between 1 and 500
        and r.p_source in ('typed', 'suggested')
      order by r.p_key, r.ord
    ),
    fresh as (
      select i.*
      from incoming i
      where not exists (
        select 1 from public.seo_ai_prompt e where e.tracker_id = p_tracker and e.text_key = i.p_key
      )
      order by i.ord
      limit greatest(p_cap - v_have, 0)
    )
    insert into public.seo_ai_prompt as pr (tracker_id, workspace_id, text, text_key, source, created_by)
    select p_tracker, v_workspace, f.p_text, f.p_key, f.p_source, f.p_by from fresh f order by f.ord
    on conflict on constraint seo_ai_prompt_tracker_text_uq do nothing
    returning pr.id, pr.text, pr.source, pr.active, pr.created_at;
end;
$$;

comment on function public.seo_ai_add_prompts(uuid, jsonb, integer) is
  'Add new prompts to an AI visibility tracker up to a cap, under a lock on the tracker (596); returns the rows added.';

-- Write a check and its answer rows together (p_run: {id, tracker_id,
-- workspace_id, started_by, trigger, scheduled_for, engines, location_code,
-- language_code, brands, estimate_usd}; p_answers: a JSON array of {id,
-- prompt_id, prompt_text, engine, branded}). A live check of the same
-- tracker, or a check already started for the same due time, makes the
-- insert fail with 23505: the caller's "already running".
create or replace function public.seo_ai_create_run(p_run jsonb, p_answers jsonb)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid := (p_run->>'id')::uuid;
  v_tracker uuid := (p_run->>'tracker_id')::uuid;
  v_workspace uuid := (p_run->>'workspace_id')::uuid;
begin
  insert into public.seo_ai_run (
    id, tracker_id, workspace_id, started_by, trigger, scheduled_for,
    engines, location_code, language_code, brands, answers_total, estimate_usd
  )
  values (
    v_id,
    v_tracker,
    v_workspace,
    nullif(p_run->>'started_by', '')::uuid,
    p_run->>'trigger',
    nullif(p_run->>'scheduled_for', '')::timestamptz,
    array(select jsonb_array_elements_text(coalesce(p_run->'engines', '[]'::jsonb))),
    (p_run->>'location_code')::integer,
    p_run->>'language_code',
    coalesce(p_run->'brands', '[]'::jsonb),
    jsonb_array_length(coalesce(p_answers, '[]'::jsonb)),
    greatest(coalesce((p_run->>'estimate_usd')::numeric, 0), 0)
  );

  insert into public.seo_ai_answer (id, run_id, tracker_id, workspace_id, prompt_id, prompt_text, engine, branded)
  select a.id, v_id, v_tracker, v_workspace, a.prompt_id, left(a.prompt_text, 500), a.engine, coalesce(a.branded, false)
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb))
    as a(id uuid, prompt_id uuid, prompt_text text, engine text, branded boolean);

  return v_id;
end;
$$;

comment on function public.seo_ai_create_run(jsonb, jsonb) is
  'Write an AI visibility check and its answer rows in one go (596); 23505 when the tracker already has a live check or a check for that due time.';

-- The marker written before an answer is asked for: pending -> asking, only
-- while the check is running. Returns the answers this caller may ask for;
-- a retried step gets nothing back for answers its first attempt claimed, so
-- it never asks (and never pays) twice.
create or replace function public.seo_ai_answers_begin(p_run uuid, p_ids uuid[])
returns setof uuid
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.seo_ai_run r where r.id = p_run and r.status = 'running') then
    return;
  end if;
  return query
    update public.seo_ai_answer a
      set status = 'asking', updated_at = now()
    where a.run_id = p_run and a.id = any (coalesce(p_ids, '{}'::uuid[])) and a.status = 'pending'
    returning a.id;
end;
$$;

comment on function public.seo_ai_answers_begin(uuid, uuid[]) is
  'Claim AI visibility answers for a paid call (596): pending -> asking once, only while the check runs.';

-- A check's counts and cost, recounted from its answers and written onto its
-- row. Returns the counts.
create or replace function public.seo_ai_refresh_run_counts(p_run uuid)
returns table (
  answers_total integer,
  answers_collected integer,
  answers_no_answer integer,
  answers_failed integer,
  answers_late integer,
  answers_open integer,
  cost_usd numeric
)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  return query
    with c as (
      select
        count(*)::integer as total,
        (count(*) filter (where a.status = 'collected' and a.has_answer))::integer as collected,
        (count(*) filter (where a.status = 'collected' and not a.has_answer))::integer as no_answer,
        (count(*) filter (where a.status = 'failed'))::integer as failed,
        (count(*) filter (where a.late))::integer as late,
        (count(*) filter (where a.status in ('pending', 'asking', 'posted')))::integer as open,
        coalesce(sum(a.cost_usd), 0)::numeric as cost
      from public.seo_ai_answer a
      where a.run_id = p_run
    ),
    w as (
      update public.seo_ai_run r
        set answers_total = c.total,
            answers_collected = c.collected,
            answers_no_answer = c.no_answer,
            answers_failed = c.failed,
            answers_late = c.late,
            cost_usd = c.cost,
            updated_at = now()
      from c
      where r.id = p_run
      returning r.id
    )
    select c.total, c.collected, c.no_answer, c.failed, c.late, c.open, c.cost from c;
end;
$$;

comment on function public.seo_ai_refresh_run_counts(uuid) is
  'Recount an AI visibility check''s answers and cost onto its row (596).';

-- The sources leaderboard by domain: each cited domain with how many answers
-- and prompts cited it, and per engine. Most-cited first; total_count is the
-- number of domains (for paging).
create or replace function public.seo_ai_cited_domains(p_run uuid, p_limit integer, p_offset integer)
returns table (
  domain text,
  answer_count bigint,
  prompt_count bigint,
  engines jsonb,
  total_count bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with cited as (
    select distinct s.domain, a.id as answer_id, a.prompt_id, a.engine
    from public.seo_ai_source s
    join public.seo_ai_answer a on a.id = s.answer_id
    where s.run_id = p_run and a.status = 'collected' and a.has_answer
  ),
  per_engine as (
    select c.domain, c.engine, count(distinct c.answer_id) as n
    from cited c
    group by c.domain, c.engine
  ),
  grouped as (
    select c.domain,
           count(distinct c.answer_id) as answer_count,
           count(distinct c.prompt_id) as prompt_count
    from cited c
    group by c.domain
  )
  select g.domain, g.answer_count, g.prompt_count,
         coalesce((select jsonb_object_agg(e.engine, e.n) from per_engine e where e.domain = g.domain), '{}'::jsonb),
         count(*) over ()
  from grouped g
  order by g.answer_count desc, g.domain
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.seo_ai_cited_domains(uuid, integer, integer) is
  'The domains an AI visibility check''s answers cited, most-cited first (596).';

-- The same by page, optionally for one domain.
create or replace function public.seo_ai_cited_pages(p_run uuid, p_domain text, p_limit integer, p_offset integer)
returns table (
  url text,
  domain text,
  title text,
  answer_count bigint,
  prompt_count bigint,
  total_count bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with cited as (
    select s.url, s.domain, s.title, a.id as answer_id, a.prompt_id
    from public.seo_ai_source s
    join public.seo_ai_answer a on a.id = s.answer_id
    where s.run_id = p_run and a.status = 'collected' and a.has_answer
      and (p_domain is null or s.domain = p_domain)
  ),
  grouped as (
    select c.url, min(c.domain) as domain, max(c.title) as title,
           count(distinct c.answer_id) as answer_count,
           count(distinct c.prompt_id) as prompt_count
    from cited c
    group by c.url
  )
  select g.url, g.domain, g.title, g.answer_count, g.prompt_count, count(*) over ()
  from grouped g
  order by g.answer_count desc, g.url
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.seo_ai_cited_pages(uuid, text, integer, integer) is
  'The pages an AI visibility check''s answers cited, most-cited first, optionally for one domain (596).';

-- One row per answer of the tracker's finished checks (completed, and
-- answers that arrived late) since a moment, oldest check first: the trend's
-- raw cells. The caller pages through it.
create or replace function public.seo_ai_trend_cells(p_tracker uuid, p_since timestamptz)
returns table (
  run_id uuid,
  run_created_at timestamptz,
  location_code integer,
  language_code text,
  own_domain text,
  prompt_id uuid,
  engine text,
  branded boolean,
  status text,
  has_answer boolean,
  brand_mentioned boolean,
  brand_cited boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.id, r.created_at, r.location_code, r.language_code,
         coalesce(r.brands->0->>'domain', ''),
         a.prompt_id, a.engine, a.branded, a.status, a.has_answer,
         coalesce(a.brand_mentioned, false), coalesce(a.brand_cited, false)
  from public.seo_ai_run r
  join public.seo_ai_answer a on a.run_id = r.id
  where r.tracker_id = p_tracker
    and r.status = 'completed'
    and r.created_at >= p_since
  order by r.created_at, r.id, a.id
$$;

comment on function public.seo_ai_trend_cells(uuid, timestamptz) is
  'One row per answer of an AI visibility tracker''s completed checks since a moment, for the trend (596).';

revoke all on function public.seo_ai_add_prompts(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.seo_ai_create_run(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.seo_ai_answers_begin(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.seo_ai_refresh_run_counts(uuid) from public, anon, authenticated;
revoke all on function public.seo_ai_cited_domains(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.seo_ai_cited_pages(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.seo_ai_trend_cells(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.seo_ai_add_prompts(uuid, jsonb, integer) to service_role;
grant execute on function public.seo_ai_create_run(jsonb, jsonb) to service_role;
grant execute on function public.seo_ai_answers_begin(uuid, uuid[]) to service_role;
grant execute on function public.seo_ai_refresh_run_counts(uuid) to service_role;
grant execute on function public.seo_ai_cited_domains(uuid, integer, integer) to service_role;
grant execute on function public.seo_ai_cited_pages(uuid, text, integer, integer) to service_role;
grant execute on function public.seo_ai_trend_cells(uuid, timestamptz) to service_role;

-- ------------------------------------------------------------
-- RLS: members read their workspace's trackers; the service role writes
-- ------------------------------------------------------------

alter table public.seo_ai_tracker enable row level security;
alter table public.seo_ai_prompt enable row level security;
alter table public.seo_ai_run enable row level security;
alter table public.seo_ai_answer enable row level security;
alter table public.seo_ai_source enable row level security;

drop policy if exists seo_ai_tracker_select_member on public.seo_ai_tracker;
create policy seo_ai_tracker_select_member on public.seo_ai_tracker
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_ai_prompt_select_member on public.seo_ai_prompt;
create policy seo_ai_prompt_select_member on public.seo_ai_prompt
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_ai_run_select_member on public.seo_ai_run;
create policy seo_ai_run_select_member on public.seo_ai_run
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_ai_answer_select_member on public.seo_ai_answer;
create policy seo_ai_answer_select_member on public.seo_ai_answer
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists seo_ai_source_select_member on public.seo_ai_source;
create policy seo_ai_source_select_member on public.seo_ai_source
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.seo_ai_tracker from anon, authenticated;
revoke all on table public.seo_ai_prompt from anon, authenticated;
revoke all on table public.seo_ai_run from anon, authenticated;
revoke all on table public.seo_ai_answer from anon, authenticated;
revoke all on table public.seo_ai_source from anon, authenticated;
grant select on table public.seo_ai_tracker to authenticated;
grant select on table public.seo_ai_prompt to authenticated;
grant select on table public.seo_ai_run to authenticated;
grant select on table public.seo_ai_answer to authenticated;
grant select on table public.seo_ai_source to authenticated;
grant all on table public.seo_ai_tracker to service_role;
grant all on table public.seo_ai_prompt to service_role;
grant all on table public.seo_ai_run to service_role;
grant all on table public.seo_ai_answer to service_role;
grant all on table public.seo_ai_source to service_role;
