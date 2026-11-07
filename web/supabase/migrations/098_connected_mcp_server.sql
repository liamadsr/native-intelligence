-- External MCP server connections.
--
-- Lets a user connect to third-party MCP servers (Atlassian, Linear, custom, etc.)
-- so the live agent and chat assistant can discover and propose actions in those
-- systems alongside Dial8-internal entities.
--
-- This is the inverse of mcp_oauth_token (migration 065) — that table lets
-- external MCP clients connect TO Dial8. This table lets Dial8 connect TO
-- external MCP servers.
--
-- Credentials are stored encrypted at rest. The application encrypts/decrypts
-- with CREDENTIAL_ENCRYPTION_KEY using aes-256-gcm — Postgres only ever sees
-- the ciphertext.

create table connected_mcp_server (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Nullable for now: connections are user-scoped. Reserved for a future
  -- workspace-shared mode without requiring a follow-up migration.
  workspace_id uuid references workspace(id) on delete cascade,

  display_name text not null,
  server_url text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http', 'sse')),

  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'oauth2')),
  -- aes-256-gcm ciphertext (base64). Application-level encryption — never
  -- store plaintext bearer tokens or OAuth tokens here.
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  -- For oauth2: discovered authorization-server metadata (RFC 8414),
  -- registered client_id, redirect URIs, scopes granted, etc.
  oauth_metadata jsonb,

  is_enabled boolean not null default true,
  -- Tool names the user has explicitly turned off for this server. The tools
  -- still exist on the remote, we just don't expose them to the agent. Empty
  -- array = all tools enabled. We deny-list rather than allow-list so newly
  -- added remote tools become available by default.
  disabled_tools text[] not null default '{}',
  -- Tool names that require human approval before the agent can call them.
  -- When the agent attempts one of these, we surface a confirm step in the UI
  -- rather than executing immediately. Empty array = no approval gate.
  require_approval_tools text[] not null default '{}',

  -- Snapshot of the server's tools/list response. Refreshed on connect and
  -- on demand. Lets the UI render quickly and lets the live agent inject
  -- tool schemas into its prompt without an extra round trip.
  tools_cache jsonb,
  tools_cache_refreshed_at timestamptz,

  last_health_check_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_connected_mcp_server_user on connected_mcp_server(user_id);
create index idx_connected_mcp_server_workspace on connected_mcp_server(workspace_id)
  where workspace_id is not null;

-- Same display_name should not appear twice for one user.
create unique index idx_connected_mcp_server_user_name
  on connected_mcp_server(user_id, lower(display_name));

-- Touch updated_at on row update.
create or replace function touch_connected_mcp_server_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_connected_mcp_server_updated_at
  before update on connected_mcp_server
  for each row execute function touch_connected_mcp_server_updated_at();

-- RLS: a user can read/write only their own rows.
alter table connected_mcp_server enable row level security;

create policy "users read own mcp servers"
  on connected_mcp_server for select
  using (auth.uid() = user_id);

create policy "users insert own mcp servers"
  on connected_mcp_server for insert
  with check (auth.uid() = user_id);

create policy "users update own mcp servers"
  on connected_mcp_server for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own mcp servers"
  on connected_mcp_server for delete
  using (auth.uid() = user_id);

comment on table connected_mcp_server is
  'External MCP servers a user has connected. Tokens stored encrypted via aes-256-gcm.';
