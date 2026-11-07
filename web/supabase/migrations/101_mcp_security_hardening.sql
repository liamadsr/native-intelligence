-- Address Supabase advisor findings on the MCP tables introduced in
-- migrations 098 and 100.
--
-- 1. Pin search_path on touch_connected_mcp_server_updated_at to prevent
--    search-path injection (advisor: function_search_path_mutable).
-- 2. Make external_mcp_oauth_state explicitly service-role-only so the
--    "RLS enabled, no policy" advisor info isn't a footgun — revoke all
--    privileges from anon and authenticated. The table is only touched
--    by server-side code using the service role.

create or replace function public.touch_connected_mcp_server_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on table public.external_mcp_oauth_state from anon, authenticated;
