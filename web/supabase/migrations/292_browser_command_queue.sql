-- In-app browser: the agent → desktop command queue.
--
-- A server-side agent tool (running in-process or in eve's Nitro runtime) cannot
-- reach the user's running desktop app directly, so a browser tool call is
-- ENQUEUED here; the desktop drains it, runs it against the native WKWebView tab,
-- and settles the row with the result. This is modeled directly on
-- local_run_queue (migration 164, GEN-147): per-user RLS, service-role-only
-- mutation through guarded routes, an atomic CAS claim, TTL + lease + a reaper,
-- and a private broadcast doorbell so the online desktop drains instantly.
--
-- Unlike local_run_queue this carries a request/result pair (the browser
-- command and its outcome) and the target ORIGIN, which the desktop enforces
-- against the agent's per-site allowlist (a guardrail: the agent may only act on
-- granted origins).

create table public.browser_command_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  agent_id uuid references public.recipe(id) on delete set null,
  session_id text,                 -- the chat/agent run this command belongs to
  tab_id text,                     -- target browser tab (null = active tab)
  command text not null,           -- 'navigate' | 'click' | 'type' | 'read_page' | 'get_text' | 'screenshot' | 'go_back' | ...
  request jsonb not null default '{}'::jsonb,  -- command args (url, ref, text, options)
  target_origin text,              -- the origin this command acts on, for the allowlist guardrail
  requires_approval boolean not null default false, -- sensitive action gated by a human OK on the device
  status text not null default 'waiting_for_device'
    check (status in (
      'waiting_for_device',  -- enqueued, no device has claimed it yet
      'claimed',             -- a device won the claim; about to run
      'running',             -- executing against the native tab (lease renewed)
      'completed',           -- settled OK; result set
      'failed',              -- settled with an error, or reaped past MAX_ATTEMPTS
      'denied',              -- blocked by the allowlist or a declined approval
      'expired'              -- enqueue TTL lapsed before any device claimed it
    )),
  result jsonb,                    -- the command's outcome (snapshot text, click result, screenshot ref, error)
  error_message text,
  claimed_by_device_id text,
  expires_at timestamptz not null,          -- enqueue TTL (unclaimed → expired)
  lease_expires_at timestamptz,             -- claim lease (reaper reclaims a dead device)
  attempt_count int not null default 0,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);

-- Drain: the desktop reads its own user's open commands, oldest first.
create index browser_command_queue_drain_idx
  on public.browser_command_queue (user_id, status, created_at)
  where status in ('waiting_for_device', 'claimed', 'running');

-- Reaper: find expired-unclaimed and lease-expired rows cheaply.
create index browser_command_queue_expiry_idx
  on public.browser_command_queue (expires_at)
  where status = 'waiting_for_device';
create index browser_command_queue_lease_idx
  on public.browser_command_queue (lease_expires_at)
  where status in ('claimed', 'running');

alter table public.browser_command_queue enable row level security;

-- Per-user RLS (local_run_queue model): a device session reads ONLY its own
-- user's commands. Client gets SELECT ONLY — enqueue, claim, and settle all go
-- through authenticated ROUTES that run guarded conditional UPDATEs server-side
-- (service role) with server-derived status transitions. A raw client UPDATE
-- could not express the atomic claim safely, and letting a client write results
-- would let a compromised page forge a command's outcome.
create policy browser_command_queue_own_select on public.browser_command_queue
  for select to authenticated
  using (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE to authenticated: the server tool enqueues
-- (service role), and only the authenticated routes (service role) mutate.

comment on table public.browser_command_queue is
  'Agent → desktop in-app browser command queue. Enqueued by server-side browser tools, drained/settled by the user''s desktop app. Per-user RLS; all mutation via service-role routes. Modeled on local_run_queue (mig 164).';

-- ── Private broadcast doorbell ──────────────────────────────────────────────
-- The enqueue route sends a broadcast on `browser-cmd:<userId>` (service role)
-- so the user's online device drains instantly; a poll is the correctness
-- backstop (the doorbell is fire-and-drop). A PRIVATE channel gates SUBSCRIBE
-- via this realtime.messages policy: the userId in the topic must equal
-- auth.uid(), so a client can never subscribe to another user's doorbell.
-- SELECT-only (no INSERT to authenticated) so a page can never inject a fake
-- drain doorbell. Prefix-guarded so it never widens any other private channel
-- (mirrors local_run_queue's policy, migration 164).
drop policy if exists "browser_cmd_owner_can_subscribe" on realtime.messages;
create policy "browser_cmd_owner_can_subscribe"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() like 'browser-cmd:%'
  and nullif(split_part(realtime.topic(), ':', 2), '')::uuid = auth.uid()
);
