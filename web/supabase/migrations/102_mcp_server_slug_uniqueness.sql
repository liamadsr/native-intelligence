-- Two display names that differ only in non-word characters slug to the
-- same namespaced tool prefix (e.g. "Atlassian Cloud" and "Atlassian-Cloud"
-- both → "atlassian_cloud"). The live-agent's propose_mcp_call resolves
-- back from namespaced tool name to server_id by linear search; with
-- collisions the first match wins non-deterministically.
--
-- Mirror the slugify() in src/lib/mcp-client/adapter.ts as a STABLE SQL
-- function, expose it as a generated column, and add a unique index on
-- (user_id, slug). Server creation rejects duplicates at the DB layer.

create or replace function public.mcp_server_slug(name text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- 1. lowercase
  -- 2. replace runs of non-[a-z0-9] with '_'
  -- 3. trim leading/trailing '_'
  -- 4. cap at 32 chars
  select substring(
    regexp_replace(
      regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]+', '_', 'g'),
      '^_+|_+$', '', 'g'
    ),
    1, 32
  );
$$;

alter table public.connected_mcp_server
  add column slug text generated always as (public.mcp_server_slug(display_name)) stored;

-- Replace the old (user_id, lower(display_name)) uniqueness with one on
-- (user_id, slug). The slug index subsumes the display-name one because
-- two names with the same slug would now collide before they reach the
-- looser display-name check.
drop index if exists idx_connected_mcp_server_user_name;
create unique index idx_connected_mcp_server_user_slug
  on public.connected_mcp_server(user_id, slug);

comment on column public.connected_mcp_server.slug is
  'Generated slug used for namespaced tool names (mcp__<slug>__<tool>). Must be unique per user.';
