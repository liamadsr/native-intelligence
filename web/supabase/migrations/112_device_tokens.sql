-- Device tokens: long-lived, named, revocable API credentials for hardware
-- devices (e.g. the XIAO ESP32S3 capture device) and other headless clients
-- that can't run the interactive OAuth/cookie login flow.
--
-- Design mirrors mcp_oauth_token (migration 065): we store only a SHA-256
-- HASH of the opaque token, never the token itself. The plaintext token is
-- shown to the user exactly once at creation time. Tokens are server-managed
-- via the service-role client only, so there is intentionally NO RLS here
-- (same as mcp_oauth_token / mcp_oauth_client).
--
-- Unlike mcp_oauth_token these are not OAuth — there's no client registration,
-- no refresh token, no PKCE. A device token is a single bearer secret of the
-- form `d8d_<base64url>` that resolves directly to a user + workspace.

create table device_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Workspace this token is scoped to. NOTE: migration 114 renames this to
  -- active_workspace_id and switches the model from "pinned" to a mutable
  -- active slot (any workspace the owner belongs to, like mcp_oauth_token).
  -- Cleared to null (token falls back to oldest workspace) if the workspace
  -- is deleted.
  workspace_id uuid references workspace(id) on delete set null,
  -- Human label shown in settings, e.g. "XIAO on my desk".
  name text not null,
  -- SHA-256 hex of the full plaintext token. Unique so a hash collision or a
  -- duplicate insert can't create two rows for one secret.
  token_hash text not null unique,
  -- First few chars of the plaintext (e.g. "d8d_a1b2c3") shown in the UI so
  -- the user can tell tokens apart without us storing the secret.
  token_prefix text not null,
  -- Null = never expires. Set to now()+interval to issue a time-boxed token.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index idx_device_token_user on device_token(user_id);
create index idx_device_token_hash on device_token(token_hash);

-- No RLS: managed exclusively by server-side service-role code, never read or
-- written directly by end users through the anon/auth Supabase client.
