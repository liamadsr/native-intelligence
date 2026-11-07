-- Migration 349: the evals flywheel's candidates (docs/plans/always-on-agent.md
-- section 8, Liam 2026-10-16: "every bad turn, a thumbs-down, a draft you
-- rewrote heavily or a failed loop becomes a test case").
--
-- One row per signal that an agent turn went wrong (or, for a thumbs-up,
-- right), for one person in one workspace:
--   thumbs_down / thumbs_up  the person rated an assistant message in chat;
--   repeated_failure         a chat turn hit the repeat-failure breaker;
--   input_invalid            a chat turn's tool call was refused as invalid;
--   draft_rewrite            the person rewrote an agent draft heavily before
--                            sending it (a similarity score and pointers only,
--                            never the mail text: Dial8 stores no mail);
--   loop_failed              a background job (a loop, a routine, a helper)
--                            failed.
-- Dial8's team reviews them (/admin/evals) and promotes the useful ones into
-- a chat skill eval case (case_draft); promoted cases are exported into the
-- repository's case files, where the static test checks them in every build
-- and the live runner replays them.
--
-- Server-written only (the feedback route and the sweep use the service
-- role). The person can read their own rows. Evidence is templated and
-- clipped: the request, the reply's opening, the tool path with clipped
-- inputs and error codes. The sweep deletes dismissed rows after 30 days and
-- unreviewed ones after 90.
--
-- Idempotent.

create table if not exists public.eval_candidate (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  polarity text not null default 'bad',
  ref_type text null,
  ref_id text null,
  conversation_id uuid null,
  skill_slugs text[] not null default '{}',
  tools text[] not null default '{}',
  reason text null,
  evidence jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'new',
  case_draft jsonb null,
  reviewed_by uuid null,
  reviewed_at timestamptz null,
  exported_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.eval_candidate is
  'Evals flywheel (349): one row per signal that an agent turn went wrong (or right, for a thumbs-up). Reviewed by Dial8 staff and promoted into chat skill eval cases. Server-written only.';
comment on column public.eval_candidate.evidence is
  'Templated, clipped evidence: the request, the reply opening, the tool path (clipped inputs, error codes); for a draft rewrite only a similarity score and pointers, never mail text.';
comment on column public.eval_candidate.case_draft is
  'The chat skill eval case (SkillEvalCase JSON) a reviewer promoted it into.';

alter table public.eval_candidate drop constraint if exists eval_candidate_source_check;
alter table public.eval_candidate
  add constraint eval_candidate_source_check check (source in ('thumbs_down', 'thumbs_up', 'repeated_failure', 'input_invalid', 'draft_rewrite', 'loop_failed'));

alter table public.eval_candidate drop constraint if exists eval_candidate_polarity_check;
alter table public.eval_candidate
  add constraint eval_candidate_polarity_check check (polarity in ('bad', 'good'));

alter table public.eval_candidate drop constraint if exists eval_candidate_status_check;
alter table public.eval_candidate
  add constraint eval_candidate_status_check check (status in ('new', 'promoted', 'dismissed', 'exported'));

alter table public.eval_candidate drop constraint if exists eval_candidate_ref_check;
alter table public.eval_candidate
  add constraint eval_candidate_ref_check check ((ref_type is null or char_length(ref_type) <= 40) and (ref_id is null or char_length(ref_id) <= 300));

alter table public.eval_candidate drop constraint if exists eval_candidate_reason_check;
alter table public.eval_candidate
  add constraint eval_candidate_reason_check check (reason is null or char_length(reason) <= 500);

alter table public.eval_candidate drop constraint if exists eval_candidate_evidence_check;
alter table public.eval_candidate
  add constraint eval_candidate_evidence_check check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 16000);

alter table public.eval_candidate drop constraint if exists eval_candidate_case_draft_check;
alter table public.eval_candidate
  add constraint eval_candidate_case_draft_check check (case_draft is null or (jsonb_typeof(case_draft) = 'object' and octet_length(case_draft::text) <= 8000));

alter table public.eval_candidate drop constraint if exists eval_candidate_dedupe_key_check;
alter table public.eval_candidate
  add constraint eval_candidate_dedupe_key_check check (char_length(dedupe_key) between 1 and 300);

alter table public.eval_candidate drop constraint if exists eval_candidate_lists_check;
alter table public.eval_candidate
  add constraint eval_candidate_lists_check check (cardinality(skill_slugs) <= 20 and cardinality(tools) <= 40);

-- One row per signal per person and workspace (a rating changes in place).
create unique index if not exists eval_candidate_dedupe_idx
  on public.eval_candidate (workspace_id, user_id, dedupe_key);

-- The review queue, newest first.
create index if not exists eval_candidate_status_idx
  on public.eval_candidate (status, created_at desc);

-- One person's ratings in one conversation (the chat reads them back).
create index if not exists eval_candidate_conversation_idx
  on public.eval_candidate (conversation_id, user_id)
  where conversation_id is not null;

alter table public.eval_candidate enable row level security;

drop policy if exists "eval_candidate_select_own" on public.eval_candidate;
create policy "eval_candidate_select_own"
  on public.eval_candidate for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- No insert, update or delete policy: only the service role writes.
revoke all on table public.eval_candidate from anon, authenticated;
grant select on table public.eval_candidate to authenticated;
grant all on table public.eval_candidate to service_role;
