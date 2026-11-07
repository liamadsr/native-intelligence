-- In-flight OAuth state for external MCP server connections.
--
-- When the user clicks "Connect Atlassian", the backend:
--   1. Discovers the remote auth server (RFC 9728 + 8414).
--   2. Performs dynamic client registration (RFC 7591) to get a client_id.
--   3. Generates a PKCE code_verifier and an opaque state string.
--   4. Persists this row keyed by state.
--   5. Returns the authorize URL to the client which opens it in a popup.
--   6. On callback we look up by state, exchange code for tokens using
--      code_verifier and registered client_id, then drop this row.
--
-- Rows live for at most 10 minutes (enforced at lookup time). Cron cleans
-- up the rest.

create table external_mcp_oauth_state (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references workspace(id) on delete set null,

  display_name text not null,
  server_url text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http', 'sse')),

  -- Discovered or supplied during start. Saved here so the callback can
  -- complete the token exchange without re-doing discovery.
  authorization_endpoint text not null,
  token_endpoint text not null,
  registration_endpoint text,           -- null if pre-registered client
  client_id text not null,
  client_secret text,                   -- only set for confidential clients
  scopes text[] not null default '{}',
  redirect_uri text not null,

  -- PKCE code_verifier. Stored here briefly (10-minute TTL); not encrypted
  -- because anyone who can read this row already has the state value, and
  -- the verifier alone is useless without the auth_code from the provider.
  code_verifier text not null,

  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_external_mcp_oauth_state_user on external_mcp_oauth_state(user_id);
create index idx_external_mcp_oauth_state_expires on external_mcp_oauth_state(expires_at);

-- Service-role only; this is in-flight auth scaffolding, never user-readable.
alter table external_mcp_oauth_state enable row level security;

comment on table external_mcp_oauth_state is
  'Short-lived state for in-flight external MCP OAuth authorization-code flows.';
