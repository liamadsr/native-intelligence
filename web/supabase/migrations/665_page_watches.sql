-- ============================================================
-- 665: loops that watch a public web page
-- ============================================================
-- One new loop trigger, firing only for its owner (src/lib/flows/types.ts):
--
--   page_changed    a public web page the owner names changed in a way they
--                   asked to hear about. A scheduled job (the page watch
--                   pass, src/lib/flows/page-watch/tick.ts) reads the page
--                   every 15 minutes with no model call, compares its lines
--                   of text with the last read, and only when lines are new
--                   asks the small classifier whether they matter. Which
--                   page and what to look for live in trigger_config
--                   (jsonb, no check); the clock is flow.next_run_at, as a
--                   schedule's is.
--
--   1. flow_trigger_type_check   widened from 662's list with page_changed,
--                                keeping every earlier value. Added without
--                                a scan, then validated on its own, so the
--                                table is never held for the check of its
--                                rows.
--   2. flow_page_watch           one row per watching loop: the last three
--                                good reads' fingerprints (the hashes of
--                                their lines, never the text: an array of up
--                                to three arrays of hashes, newest first, a
--                                line in any of them is not news), when it
--                                was read and changed, and how many reads in
--                                a row failed (eight
--                                switch the loop off). judge_failures counts
--                                the reads in a row whose new lines the
--                                classifier could not judge (the pass tells
--                                the first time, then holds the lines and
--                                asks again, so a change is never lost).
--   3. flow_page_change          a change that mattered: the page's new lines
--                                (at most 40, each at most 300 characters,
--                                as the page wrote them: a stranger's text),
--                                read back by the loop's run through the id
--                                the `flow/page.changed` event carries. Kept
--                                30 days: the pass deletes older ones, a
--                                bounded number at a time (the created_at
--                                index serves that).
--
-- Both tables are the service role's alone: RLS on with no policy, nothing
-- granted to anon or authenticated. A person reads a change only through
-- their own loop's run. Both go with their loop (on delete cascade).
--
-- Re-runnable: the constraint is dropped if it exists and created again, the
-- tables, columns, checks and indexes are created only when missing.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. flow_trigger_type_check
-- ------------------------------------------------------------

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created', 'record_created', 'contact_created', 'page_changed')) not valid;
alter table public.flow validate constraint flow_trigger_type_check;

-- ------------------------------------------------------------
-- 2. flow_page_watch
-- ------------------------------------------------------------

create table if not exists public.flow_page_watch (
  flow_id uuid primary key references public.flow(id) on delete cascade,
  workspace_id uuid not null,
  url text not null,
  fingerprints jsonb not null default '[]'::jsonb,
  line_count int null,
  checked_at timestamptz null,
  changed_at timestamptz null,
  failures int not null default 0,
  judge_failures int not null default 0,
  last_error text null,
  created_at timestamptz not null default now()
);

alter table public.flow_page_watch add column if not exists judge_failures int not null default 0;

comment on table public.flow_page_watch is
  'A page_changed loop''s last read of its page (665): the hashes of its lines, never the text. Service role only.';
comment on column public.flow_page_watch.fingerprints is
  'The last three good reads, newest first: a JSON array of up to three arrays of line hashes (src/lib/flows/page-watch/diff.ts readSets). Empty: the next read is a baseline.';
comment on column public.flow_page_watch.failures is
  'Reads in a row that failed; at eight the loop is switched off and its owner told why.';
comment on column public.flow_page_watch.judge_failures is
  'Reads in a row whose new lines the classifier could not judge: the first is told, the next are held and asked again.';
comment on column public.flow_page_watch.last_error is
  'Why the last read failed, in plain words written by the server (never text from the page).';

alter table public.flow_page_watch drop constraint if exists flow_page_watch_fingerprints_array;
alter table public.flow_page_watch
  add constraint flow_page_watch_fingerprints_array check (jsonb_typeof(fingerprints) = 'array');
alter table public.flow_page_watch drop constraint if exists flow_page_watch_url_length;
alter table public.flow_page_watch
  add constraint flow_page_watch_url_length check (char_length(url) between 1 and 2048);
alter table public.flow_page_watch drop constraint if exists flow_page_watch_last_error_length;
alter table public.flow_page_watch
  add constraint flow_page_watch_last_error_length check (last_error is null or char_length(last_error) <= 300);

-- ------------------------------------------------------------
-- 3. flow_page_change
-- ------------------------------------------------------------

create table if not exists public.flow_page_change (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flow(id) on delete cascade,
  workspace_id uuid not null,
  url text not null,
  added_lines jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.flow_page_change is
  'A change on a watched page that mattered (665): the page''s new lines, a stranger''s text, read by the loop''s run. Service role only.';
comment on column public.flow_page_change.added_lines is
  'The lines new since the last read, as the page wrote them: a JSON array of at most 40 strings.';

alter table public.flow_page_change drop constraint if exists flow_page_change_lines_array;
alter table public.flow_page_change
  add constraint flow_page_change_lines_array check (jsonb_typeof(added_lines) = 'array' and jsonb_array_length(added_lines) between 1 and 40);
alter table public.flow_page_change drop constraint if exists flow_page_change_url_length;
alter table public.flow_page_change
  add constraint flow_page_change_url_length check (char_length(url) between 1 and 2048);

create index if not exists flow_page_change_flow_created_idx on public.flow_page_change (flow_id, created_at desc);
create index if not exists flow_page_change_created_idx on public.flow_page_change (created_at);

-- ------------------------------------------------------------
-- Access: the service role's alone.
-- ------------------------------------------------------------

alter table public.flow_page_watch enable row level security;
alter table public.flow_page_change enable row level security;
revoke all on table public.flow_page_watch from anon, authenticated;
revoke all on table public.flow_page_change from anon, authenticated;
grant all on table public.flow_page_watch to service_role;
grant all on table public.flow_page_change to service_role;

notify pgrst, 'reload schema';
