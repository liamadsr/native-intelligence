-- Migration 290: live_directive, what the user asked to go into a live meeting's record
-- (docs/plans/live-agent-messaging.md, step L1).
--
-- During a call the user can tell the note-taker what to record ("note that
-- Dana owns the budget"). Until now that only reached the live turns as the
-- chat's user tail: the last ten typed lines, re-read on every window, with no
-- addressee and nothing to say they were used. A directive is narrower:
--
--   - It is addressed to whichever turn writes the record: the paired notes
--     turn, the single live turn when the live agent is not assist-only, or the
--     end-of-meeting batch pass. The assist-only copilot never receives one.
--   - It is delivered once. The route injects the pending directives into that
--     turn's context and marks them consumed when the turn completes; a turn
--     that fails leaves them for the next one.
--   - The batch pass expires whatever is still pending once it has run, so a
--     directive never waits on a meeting that is over.
--
-- The rows drive the chat's acknowledgement ("Sending", then "Noted"), so the
-- author can read their own rows and the table is in the realtime publication.
-- Writes are service-role only: the writers (L2) check capture ownership
-- before they insert, and consumption is server work.

create table if not exists public.live_directive (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  capture_id uuid not null references public.captures(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  -- Who wrote it: the user's own typed '@notes', the chat's talk-back agent
  -- passing on what the user asked, or the paired copilot passing on what it
  -- heard the user ask.
  source text not null default 'user',
  text text not null,
  status text not null default 'pending',
  consumed_at timestamptz,
  -- The eve session of the turn that recorded it.
  consumed_session text,
  created_at timestamptz not null default now(),
  constraint live_directive_source_check check (source in ('user', 'talk_back', 'copilot')),
  constraint live_directive_text_check check (char_length(text) between 1 and 500),
  constraint live_directive_status_check check (status in ('pending', 'consumed', 'expired')),
  constraint live_directive_consumed_check check ((status = 'consumed') = (consumed_at is not null))
);

-- The route's read: a capture's pending directives by their author, oldest first.
create index if not exists live_directive_pending_idx
  on public.live_directive (capture_id, created_by, created_at)
  where status = 'pending';

alter table public.live_directive enable row level security;

-- The author reads their own directives (the chat_messages pattern); nobody
-- else does. There are no client write policies.
drop policy if exists live_directive_select_own on public.live_directive;
create policy live_directive_select_own on public.live_directive
  for select to authenticated
  using (auth.uid() = created_by);

revoke all on public.live_directive from anon, authenticated;
grant select on public.live_directive to authenticated;

-- postgres_changes for the acknowledgement: the author's client sees a row
-- appear and turn consumed. Full replica identity so an UPDATE carries the row
-- through the SELECT policy.
alter table public.live_directive replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.live_directive;
exception
  when duplicate_object then null;
end $$;
