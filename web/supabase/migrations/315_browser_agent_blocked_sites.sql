-- In-app browser: the sites the user has blocked the browser agent from.
--
-- The agent may use any site by default. A site listed here is off-limits to
-- it entirely: it can't read the page, screenshot it, act on it or navigate
-- into it, in every one of the user's workspaces. `site` is a lowercase host
-- with no scheme, port or path ("linkedin.com", "mail.google.com"); it covers
-- that host and all of its subdomains (src/lib/browser-agent/blocked-sites.ts).
--
-- Kept on the server, not on the device, because a block list that is lost
-- fails OPEN: a cleared store or a new Mac would silently open every blocked
-- site to the agent again. The desktop command relay is handed the current
-- list with every command it claims and refuses to run without it; the
-- decision route checks each page the agent observes against it too.

create table public.browser_agent_blocked_sites (
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null
    check (char_length(site) between 1 and 253 and site = lower(site) and site !~ '[[:space:]/]'),
  created_at timestamptz not null default now(),
  primary key (user_id, site)
);

alter table public.browser_agent_blocked_sites enable row level security;

-- Each user manages only their own list.
create policy "browser_agent_blocked_sites_select_own"
  on public.browser_agent_blocked_sites for select
  using (auth.uid() = user_id);

create policy "browser_agent_blocked_sites_insert_own"
  on public.browser_agent_blocked_sites for insert
  with check (auth.uid() = user_id);

create policy "browser_agent_blocked_sites_delete_own"
  on public.browser_agent_blocked_sites for delete
  using (auth.uid() = user_id);
