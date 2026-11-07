-- Migration 335: server-checked approvals (docs/plans/always-on-agent.md §6,
-- A5 slice 3).
--
-- An approval is a tool call the server holds until the person says yes on a
-- card. Today the model asked first and then confirmed itself
-- (mcp_confirm_call ran whatever the model passed). From here:
--   - mcp_confirm_call creates an approval instead of running the call;
--   - once action.review is enforced (ACTION_REVIEW_ENFORCE,
--     src/lib/safety/action-review.ts), a risky call it blocks becomes one.
--     In shadow it only records.
-- On the person's Accept the server re-checks their membership and the
-- tool's ceiling, runs the STORED call once as the person, and posts the
-- result to their home thread. The model can never approve: settle_card,
-- accept_proposal and send_work_answer refuse an approval card.
--
-- What lands:
--   public.tool_approval   one held call: the tool, its input (and a sha256 of
--                          it), where it came from (the door, the conversation
--                          or the loop's run), the action.review decision
--                          behind it, the person-message seq it was raised
--                          at, its status (pending, approved, denied,
--                          expired, or failed: a re-check refused it after
--                          the accept, or its card could not be written),
--                          when it expires, and the result once run.
--                          The owner reads their own; only the server writes
--                          (no insert, update or delete policy).
--   attention_item.kind    gains 'approval' (the card the person answers).
--                          An approval card never carries a proposal, so
--                          accept_proposal cannot reach one.
--
-- Safe to run twice.

create table if not exists public.tool_approval (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Where the call was raised: the main chat (and teammate chats), a loop's
  -- skill run, or a flow run's Dial8 MCP token.
  door text not null check (door in ('chat', 'skill_run', 'mcp')),
  conversation_id uuid,
  -- A loop's run: its skill and its work-ledger row, when it had one.
  skill_id uuid,
  work_item_id uuid,
  tool text not null check (char_length(tool) between 1 and 200),
  side_effect text not null check (side_effect in ('external-write', 'delete', 'automation-write', 'unclassified')),
  input jsonb not null default '{}'::jsonb,
  input_hash text not null,
  -- What the ceiling re-check needs at accept time (agent, surface, teammate, mode).
  context jsonb not null default '{}'::jsonb,
  -- The action.review decision (ai_usage_logs metadata.inference_id), when one was made.
  decision_id text,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'failed')),
  -- The person's message count when the approval was raised (chat only).
  person_message_seq integer,
  card_id uuid references public.attention_item(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  decided_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tool_approval_user_pending_idx
  on public.tool_approval (user_id, created_at desc)
  where status = 'pending';

create index if not exists tool_approval_workspace_pending_idx
  on public.tool_approval (workspace_id)
  where status = 'pending';

-- One pending approval per person, tool and input (the app reuses it).
create index if not exists tool_approval_pending_call_idx
  on public.tool_approval (user_id, tool, input_hash)
  where status = 'pending';

alter table public.tool_approval enable row level security;

drop policy if exists tool_approval_owner_select on public.tool_approval;
create policy tool_approval_owner_select on public.tool_approval
  for select using (user_id = auth.uid());

-- attention_item.kind gains 'approval' (DROP + ADD, the house pattern, as 197).
alter table public.attention_item
  drop constraint if exists attention_item_kind_check;
alter table public.attention_item
  add constraint attention_item_kind_check
  check (kind in ('action_card', 'draft_email', 'question', 'work_proposal', 'approval'));

alter table public.attention_item
  drop constraint if exists attention_item_approval_no_proposal;
alter table public.attention_item
  add constraint attention_item_approval_no_proposal
  check (kind <> 'approval' or proposal_id is null);

comment on table public.tool_approval is
  'A tool call held for the person''s yes on an approval card. Written only by the server (src/lib/safety/approvals.ts), run once, as the person, on accept.';
