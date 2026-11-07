-- MCP OAuth server tables for MCP clients (Claude Code, Cursor, etc.)
-- Implements OAuth 2.1 with Dynamic Client Registration and PKCE.

-- Registered MCP OAuth clients (via Dynamic Client Registration)
create table mcp_oauth_client (
  client_id text primary key,
  client_secret_hash text,              -- SHA-256 hash if confidential client; null for public clients
  redirect_uris text[] not null,
  client_name text,
  grant_types text[] not null default '{"authorization_code","refresh_token"}',
  token_endpoint_auth_method text not null default 'none',  -- 'none' for public clients
  created_at timestamptz not null default now()
);

-- Authorization codes (short-lived, consumed on token exchange)
create table mcp_auth_code (
  code text primary key,
  client_id text not null references mcp_oauth_client(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);

-- Cleanup expired/consumed codes (can be run by cron)
create index idx_mcp_auth_code_expires on mcp_auth_code(expires_at) where consumed = false;

-- MCP OAuth access + refresh tokens
create table mcp_oauth_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references mcp_oauth_client(client_id) on delete cascade,
  access_token_hash text not null unique,
  refresh_token_hash text unique,
  scopes text[] not null default '{}',
  active_workspace_id uuid references workspace(id) on delete set null,  -- user's active workspace for this session
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index idx_mcp_oauth_token_user on mcp_oauth_token(user_id);
create index idx_mcp_oauth_token_access on mcp_oauth_token(access_token_hash);

-- No RLS on these tables — they're managed by server-side code only
-- (service role client), never accessed directly by end users via Supabase client.
