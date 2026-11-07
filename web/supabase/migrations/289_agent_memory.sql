-- Migration 289: a teammate's memory across runs (plan row 15,
-- docs/plans/agent-orchestration-product.md Part 4).
--
-- A teammate (ai_team_member) now remembers what its earlier runs learned. Two
-- server-side writers and readers, and no eve memory slot (the owner's call: no
-- allowlist change):
--   - at settle, a completed work run with a teammate is summarised on the
--     utility agent into at most three durable entries (a person's preference,
--     a fact about the workspace's people or projects, a lesson about doing
--     this kind of work here) — src/lib/inngest/agent-memory-functions.ts;
--   - at the start of the teammate's next run, its active entries ride in the
--     brief as `memory` — src/lib/work/agent-memory.ts.
--
-- What must not go in (Part 4.3) is kept out by the writer: the summariser sees
-- the task, the run's own summary and its deliverables' labels (never their
-- contents), and its prompt refuses draft or message contents, what was sent,
-- and secrets. Every capture the run read or came from is recorded in
-- source.capture_ids, and recall drops an entry when the recalling run's user
-- cannot see one of them (a private capture's fact never reaches someone the
-- capture is hidden from).
--
-- RLS is on with NO policies: only the service role reads or writes. Unlike
-- work_touch this table is not workspace-readable yet, because a member-facing
-- read would have to repeat the teammate's private-team visibility and the
-- per-capture filter; nothing in the product shows memory to a person yet.
-- The page that does adds that policy.

create table if not exists public.agent_memory (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspace(id) on delete cascade,
  ai_team_member_id uuid not null references public.ai_team_member(id) on delete cascade,
  -- The run that taught it (null once that run is deleted).
  agent_run_id      uuid references public.agent_run(id) on delete set null,
  kind              text not null,
  text              text not null,
  -- { work_item_id, entities: [{ type, id }], capture_ids: [uuid] }
  source            jsonb not null default '{}'::jsonb,
  -- Starts at 1; an entry that restates and replaces an earlier one carries
  -- the earlier salience + 1, so what keeps coming back ranks first.
  salience          integer not null default 1,
  status            text not null default 'active',
  superseded_by     uuid references public.agent_memory(id) on delete set null,
  created_at        timestamptz not null default now(),
  last_recalled_at  timestamptz
);

alter table public.agent_memory drop constraint if exists agent_memory_kind_check;
alter table public.agent_memory add constraint agent_memory_kind_check
  check (kind in ('fact', 'preference', 'lesson'));
alter table public.agent_memory drop constraint if exists agent_memory_text_check;
alter table public.agent_memory add constraint agent_memory_text_check
  check (char_length(text) between 1 and 500);
alter table public.agent_memory drop constraint if exists agent_memory_status_check;
alter table public.agent_memory add constraint agent_memory_status_check
  check (status in ('active', 'superseded', 'retired'));
alter table public.agent_memory drop constraint if exists agent_memory_salience_check;
alter table public.agent_memory add constraint agent_memory_salience_check
  check (salience >= 1);

-- Recall: a teammate's active entries, most reinforced then newest first.
create index if not exists agent_memory_recall_idx
  on public.agent_memory (ai_team_member_id, status, salience desc, created_at desc);
-- The summariser's "already done for this run" check.
create index if not exists agent_memory_run_idx
  on public.agent_memory (agent_run_id) where agent_run_id is not null;

alter table public.agent_memory enable row level security;
-- No policies: service role only (see the header). Nor does any client role
-- hold a grant on it.
revoke all on public.agent_memory from anon, authenticated;

comment on table public.agent_memory is
  'A teammate''s memory across work runs (plan row 15). Written at settle by the summariser, recalled into the next run''s brief. Service role only.';
comment on column public.agent_memory.source is
  '{ work_item_id, entities: [{type, id}], capture_ids: [uuid] }. Recall drops an entry when the run''s user cannot see one of capture_ids.';
