-- ============================================================
-- 412: Slack as a customer connection, part 1 (install + link).
--
-- docs/plans/slack-connect.md §4 pieces 1 and 2. A customer adds OUR Dial8
-- Slack app to THEIR Slack workspace (one Vercel Connect installation per
-- Slack team), and each person links their own Slack account to their Dial8
-- account. This migration only ADDS tables. Nothing here touches an existing
-- row.
--
--   slack_installation   one Slack team, bound to exactly one Dial8
--                        workspace. Bound when an admin of that workspace
--                        DMs the bot a link code (src/lib/slack/link.ts):
--                        Slack verified the sender, Dial8 verified the code.
--   slack_user_link      a Slack user in a team, linked to one Dial8 user.
--                        Made only by a link code the person made in Dial8
--                        and sent from that Slack account. Never by an
--                        email match alone (that would grant the person's
--                        full agent from Slack: caller.ts 'person').
--   slack_link_code      a short-lived one-time code (hash only), made in
--                        Settings > Integrations > Slack.
--   slack_event          Slack's event_id, for dedupe (Slack retries an
--                        event it got no answer to within 3 s).
--   slack_link_attempt   a wrong code from a Slack user: past a few an hour
--                        (per user, and per team), codes from them are not
--                        even tried, so a code can't be guessed.
--
-- Security: the person reads their own link rows and their workspace's
-- installation rows. There are NO client INSERT/UPDATE/DELETE policies:
-- every write goes through an authenticated route or the Slack events route,
-- as the service role (src/lib/slack/store.ts). Codes and events have no
-- client policy at all.
--
-- Workspace merge (402): slack_installation and slack_link_code carry
-- workspace_id, so the generic re-stamp moves them. No uniqueness here
-- includes workspace_id, so the re-stamp can never collide (P0008).
--
-- No backslashes anywhere in this file (one MCP transport decodes escapes).
-- ============================================================

-- ── slack_installation ──────────────────────────────────────────────────────
create table if not exists public.slack_installation (
  -- Slack's team id (T…), the Connect installation's tenant.
  slack_team_id text primary key check (slack_team_id ~ '^T[A-Z0-9]{2,30}$'),
  team_name text not null default '' check (char_length(team_name) <= 200),
  team_domain text not null default '' check (char_length(team_domain) <= 200),
  enterprise_id text check (enterprise_id is null or enterprise_id ~ '^E[A-Z0-9]{2,30}$'),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  installed_by_user_id uuid references auth.users(id) on delete set null,
  -- What getToken takes as installationId for this team.
  connect_installation_id text not null check (char_length(connect_installation_id) between 1 and 200),
  -- The bot's own Slack user id (auth.test), so its own messages are skipped.
  bot_user_id text check (bot_user_id is null or bot_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.slack_installation is
  'Slack (412): one Slack team bound to one Dial8 workspace. Members of the workspace read it; only the service role writes.';

create index if not exists slack_installation_workspace_idx
  on public.slack_installation (workspace_id);

drop trigger if exists slack_installation_updated_at on public.slack_installation;
create trigger slack_installation_updated_at
  before update on public.slack_installation
  for each row execute function public.update_updated_at();

alter table public.slack_installation enable row level security;

drop policy if exists slack_installation_member_select on public.slack_installation;
create policy slack_installation_member_select on public.slack_installation
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ── slack_user_link ─────────────────────────────────────────────────────────
create table if not exists public.slack_user_link (
  slack_team_id text not null references public.slack_installation(slack_team_id) on delete cascade,
  slack_user_id text not null check (slack_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  slack_user_name text not null default '' check (char_length(slack_user_name) <= 200),
  linked_at timestamptz not null default now(),
  primary key (slack_team_id, slack_user_id),
  -- One Slack account per Dial8 person per Slack team.
  constraint slack_user_link_person_uq unique (slack_team_id, user_id)
);

comment on table public.slack_user_link is
  'Slack (412): a Slack user linked to one Dial8 user, made only by a one-time code from Dial8 sent from that Slack account. The person reads their own rows; only the service role writes.';

create index if not exists slack_user_link_user_idx
  on public.slack_user_link (user_id);

alter table public.slack_user_link enable row level security;

drop policy if exists slack_user_link_own_select on public.slack_user_link;
create policy slack_user_link_own_select on public.slack_user_link
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── slack_link_code ─────────────────────────────────────────────────────────
create table if not exists public.slack_link_code (
  id uuid primary key default gen_random_uuid(),
  -- sha256 hex of the normalized code. The code itself is never stored.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint slack_link_code_hash_uq unique (code_hash)
);

comment on table public.slack_link_code is
  'Slack (412): one-time link codes (hash only). Service role only.';

create index if not exists slack_link_code_user_idx
  on public.slack_link_code (user_id, created_at desc);

alter table public.slack_link_code enable row level security;

-- ── slack_event ─────────────────────────────────────────────────────────────
create table if not exists public.slack_event (
  event_id text primary key check (char_length(event_id) between 1 and 100),
  slack_team_id text not null default '' check (char_length(slack_team_id) <= 40),
  received_at timestamptz not null default now()
);

comment on table public.slack_event is
  'Slack (412): event ids seen, for dedupe of Slack retries. Service role only; rows older than two days are purged by the events route.';

create index if not exists slack_event_received_idx
  on public.slack_event (received_at);

alter table public.slack_event enable row level security;

-- ── slack_link_attempt ──────────────────────────────────────────────────────
create table if not exists public.slack_link_attempt (
  id bigint generated always as identity primary key,
  slack_team_id text not null check (char_length(slack_team_id) <= 40),
  slack_user_id text not null check (char_length(slack_user_id) <= 40),
  attempted_at timestamptz not null default now()
);

comment on table public.slack_link_attempt is
  'Slack (412): wrong link codes, per Slack user and team, for the guess cap. Service role only; rows older than two days are purged by the events route.';

create index if not exists slack_link_attempt_user_idx
  on public.slack_link_attempt (slack_team_id, slack_user_id, attempted_at desc);

create index if not exists slack_link_attempt_team_idx
  on public.slack_link_attempt (slack_team_id, attempted_at desc);

alter table public.slack_link_attempt enable row level security;
