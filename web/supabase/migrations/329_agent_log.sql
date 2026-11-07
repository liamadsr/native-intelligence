-- Migration 329: the agent's log, one dated line per thing that happened
-- (docs/plans/always-on-agent.md §3 "Memory in tiers", the Log tier; A2b).
--
-- The main chat agent forgets what happened between conversations: a work run
-- that finished overnight, a draft waiting on review, a meeting that was
-- processed. The log is the short, dated record it reads at the start of a
-- conversation (the `log` turn-context section, src/lib/log/log-section.ts):
-- one line per event, written from templates by the server, never by a model.
--
-- What lands:
--   agent_log      one row per line, for exactly one (workspace, user): the
--                  workspace walls hold (decision 2), and a line is never
--                  fanned out to anyone else.
--     id           a bigint identity: the order lines were written in. The
--                  chat sends only lines past the last id it sent (the cursor
--                  on the section's tag), so the log is append-only in the
--                  prompt and never breaks the cached prefix.
--     user_id      auth.users, not member: a departed member's log survives
--                  their removal, like their personal area lines (320), and
--                  comes back into view if they rejoin.
--     at           when the thing happened (not when the line was written).
--     kind         work_started | work_waiting | work_finished | work_failed |
--                  work_canceled | capture_processed | chat_checkpoint.
--     area         the area it belongs to (registry.ts AREA_KEYS), or null.
--     line         the text, 1–200 characters, from a template
--                  (src/lib/log/agent-log.ts).
--     ref_type/id  what the line is about ('work_item' + tracked_job.id,
--                  'capture' + captures.id).
--     dedupe_key   unique per (workspace, user): a retried writer, a replayed
--                  event or a re-run backfill writes nothing twice.
--
-- Who may do what: a person reads only their own lines, and only while a
-- member of that workspace. Nobody writes from a client: the service role
-- (the recorder, the capture consumer, the capture pass) is the only writer.
--
-- Backfill: the last 30 days, from tracked_job (its owner member → user) and
-- processed captures (their owner, captures.user_id; private ones too, since
-- the line is the owner's alone). The dedupe keys are the ones the live
-- writers use, so a re-run, or a run after live lines landed, adds nothing.
-- It leaves out what the live writers leave out (agent-log.ts
-- workEventLogged): quiet rows, delegated children, the housekeeping kinds,
-- the email-drafts pass but for drafts made or a failure, and archived or
-- demo captures.
--
-- Idempotent: create if not exists, drop policy if exists, on conflict do nothing.

SET LOCAL lock_timeout = '5s';

create table if not exists public.agent_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (
    kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint')
  ),
  area text,
  line text not null check (char_length(btrim(line)) between 1 and 200 and char_length(line) <= 200),
  ref_type text,
  ref_id text,
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 300),
  created_at timestamptz not null default now()
);

comment on table public.agent_log is
  'The agent''s log (329): one dated, templated line per thing that happened (work started, waiting, finished, failed or canceled; a meeting processed; a chat checkpoint), for one user in one workspace. Server-written only.';

-- One line per event per person and workspace.
create unique index if not exists agent_log_dedupe_idx
  on public.agent_log (workspace_id, user_id, dedupe_key);

-- The chat's read: one person's newest lines in one workspace.
create index if not exists agent_log_recent_idx
  on public.agent_log (workspace_id, user_id, at desc);

alter table public.agent_log enable row level security;

drop policy if exists "agent_log_select" on public.agent_log;
create policy "agent_log_select"
  on public.agent_log for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- No insert, update or delete policy: only the service role writes.
-- Only reads for a person (the policy above); Supabase's default grants
-- (truncate, trigger, references…) go, and come back on no re-run.
revoke all on table public.agent_log from anon, authenticated;
grant select on table public.agent_log to authenticated;

-- ── Backfill: the last 30 days ──────────────────────────────────────────────
-- The same templates as src/lib/log/agent-log.ts: control and format
-- characters and whitespace (the JS Unicode classes Cc and Cf, and JS
-- whitespace, listed code point by code point so no locale decides) collapse to one space, angle brackets
-- become ‹ ›, a title is clipped to 80 characters and a summary to 90 (with
-- an ellipsis).

-- The character class those characters make, built from code point ranges
-- with chr() so the file holds no escape sequence a transport could decode
-- (each range is lo, hi in decimal; the comment names it in hex). None of
-- them is a character a bracket expression treats specially.
create or replace function pg_temp.agent_log_space_class()
returns text
language sql
immutable
as $$
  select '[' || string_agg(chr(lo) || case when hi > lo then '-' || chr(hi) else '' end, '' order by lo) || ']+'
  from (values
    (1, 32),  -- U+0001 to U+0020
    (127, 160),  -- U+007F to U+00A0
    (173, 173),  -- U+00AD
    (1536, 1541),  -- U+0600 to U+0605
    (1564, 1564),  -- U+061C
    (1757, 1757),  -- U+06DD
    (1807, 1807),  -- U+070F
    (2192, 2193),  -- U+0890 to U+0891
    (2274, 2274),  -- U+08E2
    (5760, 5760),  -- U+1680
    (6158, 6158),  -- U+180E
    (8192, 8207),  -- U+2000 to U+200F
    (8232, 8239),  -- U+2028 to U+202F
    (8287, 8292),  -- U+205F to U+2064
    (8294, 8303),  -- U+2066 to U+206F
    (12288, 12288),  -- U+3000
    (65279, 65279),  -- U+FEFF
    (65529, 65531),  -- U+FFF9 to U+FFFB
    (69821, 69821),  -- U+110BD
    (69837, 69837),  -- U+110CD
    (78896, 78911),  -- U+13430 to U+1343F
    (113824, 113827),  -- U+1BCA0 to U+1BCA3
    (119155, 119162),  -- U+1D173 to U+1D17A
    (917505, 917505),  -- U+E0001
    (917536, 917631)  -- U+E0020 to U+E007F
  ) as r(lo, hi)
$$;

create or replace function pg_temp.agent_log_clip(t text, n int)
returns text
language sql
immutable
as $$
  select case
    when s = '' then null
    when char_length(s) > n then rtrim(left(s, n - 1)) || '…'
    else s
  end
  from (
    select btrim(regexp_replace(
      translate(coalesce(t, ''), '<>', '‹›'),
      pg_temp.agent_log_space_class(),
      ' ',
      'g'
    )) as s
  ) x
$$;

with jobs as (
  select
    tj.id,
    tj.workspace_id,
    m.user_id,
    tj.kind,
    tj.status,
    -- Only a registered area (registry.ts AREA_KEYS), as appendLogLine keeps.
    case
      when tj.area in ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library')
        then tj.area
    end as area,
    coalesce(pg_temp.agent_log_clip(tj.title, 80), 'Untitled work') as title,
    pg_temp.agent_log_clip(tj.result_summary, 90) as summary,
    case when jsonb_typeof(tj.deliverables) = 'array' then jsonb_array_length(tj.deliverables) else 0 end as delivered,
    -- Written already settled (startWork with a terminal status): its start
    -- and finish are the insert's one instant, at its creation. A row that
    -- sat queued and finished without running shares the two stamps too, but
    -- later than its creation, and keeps its Started (it was logged at insert).
    (tj.started_at is not null and tj.finished_at is not null and tj.started_at = tj.finished_at
      and tj.started_at <= tj.created_at + interval '2 seconds') as one_shot,
    -- Written already waiting on review: every finish into review stamps
    -- finished_at, and no settle clears it.
    (tj.finished_at is null and (tj.status = 'needs_review' or tj.reviewed_at is not null)) as born_waiting,
    tj.created_at,
    tj.finished_at,
    tj.reviewed_at,
    tj.last_beat_at,
    tj.progress ->> 'review' as review
  from public.tracked_job tj
  join public.member m on m.id = tj.member_id and m.workspace_id = tj.workspace_id
  where m.user_id is not null
    and exists (select 1 from auth.users u where u.id = m.user_id)
    and tj.status <> 'skipped'
    -- What the person would want their agent to know, not housekeeping
    -- (agent-log.ts workEventLogged, LOG_HOUSEKEEPING_KINDS).
    and coalesce(tj.source ->> 'quiet', '') <> 'true'
    and tj.parent_id is null
    and coalesce(tj.depth, 0) = 0
    and tj.kind not in ('crm_enrichment', 'triage_reconcile', 'extraction', 'proposal_age_out')
    and greatest(tj.created_at, tj.finished_at, tj.reviewed_at, tj.last_beat_at) >= now() - interval '30 days'
),
lines as (
  -- Started: a row written live (queued or running). Not a one-shot or a row
  -- written already waiting (the recorder logs only where it landed), and
  -- not the email-drafts pass (its drafts are the news).
  select workspace_id, user_id, created_at as at, 'work_started' as kind, area,
         'Started: ' || title as line, id::text as ref_id, 'work:' || id || ':started' as dedupe_key
  from jobs
  where not one_shot and not born_waiting and kind <> 'email_drafts'
  union all
  -- Waiting on an answer now: the move stamped last_beat_at, which a parked
  -- row keeps, so the key matches the live writer's.
  select workspace_id, user_id, last_beat_at, 'work_waiting', area,
         'Waiting on you: ' || title || ' (it has a question)', id::text,
         'work:' || id || ':needs_input:' || floor(extract(epoch from last_beat_at) * 1000)::bigint
  from jobs
  where status = 'needs_input' and last_beat_at is not null
  union all
  -- Waiting on review now, or reviewed since.
  select workspace_id, user_id, coalesce(finished_at, last_beat_at), 'work_waiting', area,
         'Ready for your review: ' || title || coalesce(' — ' || summary, ''), id::text,
         'work:' || id || ':needs_review'
  from jobs
  where (status = 'needs_review' or reviewed_at is not null) and coalesce(finished_at, last_beat_at) is not null
  union all
  -- How a review ended: reviewed, dismissed, expired unreviewed (the reaper,
  -- past the review TTL), or done on the deliverable's own surface.
  select workspace_id, user_id, reviewed_at,
         case when review in ('dismissed', 'expired') then 'work_canceled' else 'work_finished' end, area,
         case
           when review = 'dismissed' then 'Dismissed: ' || title
           when review = 'reviewed' then 'Reviewed: ' || title
           when review = 'expired' then 'Expired unreviewed: ' || title
           else 'Done: ' || title || ' (acted on)'
         end,
         id::text, 'work:' || id || ':settled'
  from jobs
  where reviewed_at is not null
  union all
  -- Finished: the email-drafts pass only when it drafted something.
  select workspace_id, user_id, finished_at, 'work_finished', area,
         'Finished: ' || title || coalesce(' — ' || summary, ''), id::text, 'work:' || id || ':done'
  from jobs
  where status = 'done' and reviewed_at is null and finished_at is not null
    and (kind <> 'email_drafts' or delivered > 0)
  union all
  select workspace_id, user_id, finished_at, 'work_failed', area,
         'Failed: ' || title, id::text, 'work:' || id || ':failed'
  from jobs
  where status = 'failed' and finished_at is not null
  union all
  select workspace_id, user_id, finished_at, 'work_canceled', area,
         'Canceled: ' || title, id::text, 'work:' || id || ':canceled'
  from jobs
  where status = 'canceled' and finished_at is not null
)
insert into public.agent_log (workspace_id, user_id, at, kind, area, line, ref_type, ref_id, dedupe_key)
select workspace_id, user_id, at, kind, area, left(line, 200), 'work_item', ref_id, dedupe_key
from lines
where at >= now() - interval '30 days'
order by at, dedupe_key
on conflict (workspace_id, user_id, dedupe_key) do nothing;

-- Meetings processed: the owner only, private captures included (the line is
-- theirs alone). Archived and demo captures are left out, as the live consumer
-- (src/lib/inngest/agent-log-capture.ts) leaves them out.
insert into public.agent_log (workspace_id, user_id, at, kind, area, line, ref_type, ref_id, dedupe_key)
select
  c.workspace_id,
  c.user_id,
  c.batch_processed_at,
  'capture_processed',
  'captures',
  left('Meeting processed: ' || coalesce(pg_temp.agent_log_clip(c.title, 80), 'Untitled meeting'), 200),
  'capture',
  c.id::text,
  'capture:' || c.id || ':processed'
from public.captures c
where c.user_id is not null
  and exists (select 1 from auth.users u where u.id = c.user_id)
  and c.batch_processed_at is not null
  and c.batch_processed_at >= now() - interval '30 days'
  and coalesce(c.status, '') <> 'archived'
  and coalesce(c.metadata ->> 'demo', '') <> 'true'
order by c.batch_processed_at, c.id
on conflict (workspace_id, user_id, dedupe_key) do nothing;

drop function if exists pg_temp.agent_log_clip(text, int);
drop function if exists pg_temp.agent_log_space_class();
