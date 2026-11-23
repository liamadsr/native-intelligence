-- ============================================================
-- 695: GitHub Reviews, phase 3 — GitHub's news in the person's notifications.
-- ============================================================
-- docs/plans/github-reviews.md. This file has its own begin/commit.
--
--   notification types  github_review_requested (someone asked for your
--                       review), github_pr_comment (a comment, a review or a
--                       mention on a pull request of yours, or naming you),
--                       github_checks_failed (checks failed on the head of
--                       your pull request). Each targets `github_pr` with no
--                       id: the pull request is in metadata (repo, number,
--                       url), and a click opens it on the Reviews page.
--
--   github_pull_request a pull request's author and head as the webhook last
--                       saw them, so a failing check suite (whose payload
--                       names no author) finds whom to tell, and tells them
--                       once per head commit. The service role's alone: RLS
--                       on, no policies.
--
-- The two CHECK lists are 688's (the latest on main when this was written),
-- plus the new values. A migration after this one that redoes either list
-- must carry these too.
-- ============================================================

begin;

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message',
  'meeting_waiting', 'email_send_failed', 'mentioned', 'record_shared',
  'github_review_requested', 'github_pr_comment', 'github_checks_failed'
])) not valid;
alter table public.notification validate constraint notification_type_check;

alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact', 'company',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message', 'team_chat_channel',
  'canvas', 'spreadsheet',
  'github_pr'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

create table if not exists public.github_pull_request (
  repo_full_name text not null,
  pr_number integer not null,
  author_github_id bigint,
  head_sha text,
  title text,
  url text,
  -- The head commit whose failed checks were last told, so a re-run that fails again on it isn't told twice.
  checks_failed_sha text,
  updated_at timestamptz not null default now(),
  constraint github_pull_request_pkey primary key (repo_full_name, pr_number),
  constraint github_pull_request_repo check (repo_full_name = lower(repo_full_name))
);

create index if not exists github_pull_request_by_head on public.github_pull_request (repo_full_name, head_sha);

alter table public.github_pull_request enable row level security;
revoke all on table public.github_pull_request from anon, authenticated;
grant all on table public.github_pull_request to service_role;

notify pgrst, 'reload schema';

commit;
