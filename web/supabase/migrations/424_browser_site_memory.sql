-- ============================================================
-- 424: Browser site memory (docs/plans/cloud-browser.md, C4). Numbered 424
-- after main's 423; renumber at merge if another branch lands one first.
--
-- What the agent's cloud browser has learned about a site, per person:
-- - needs_home: the site turns the cloud's own address away (an "Access
--   Denied", a challenge page), so the browser only goes there through the
--   person's Mac. With the Mac away, a task for it ends "needs your Mac"
--   instead of failing at the site. Set by the relay when it meets such a page
--   on the cloud exit; the agent never solves a CAPTCHA.
-- - never_automate: the site forbids AI agents (its own page says so); the
--   agent never uses it. A small seed ships in code (Amazon), so the table only
--   holds what a person's browser learned.
-- - signed_in_at: when the person last signed in there through the live view.
--
-- Per person, not per workspace: whether a site refuses cloud browsers is the
-- same for every workspace, and a table without workspace_id is never
-- re-stamped by a workspace merge (_wsmerge_generic_restamp, 402/421). The
-- person reads their own rows; only the service role writes. No backfill.
--
-- Not applied by the builder: Liam applies it (DEV, then PROD) before the
-- deploy that ships C4, whose relay routes read it.
-- ============================================================

create table if not exists public.browser_site_memory (
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null check (char_length(site) between 1 and 253),
  needs_home boolean not null default false,
  never_automate boolean not null default false,
  signed_in_at timestamptz,
  -- What set it last (e.g. 'access_denied', 'challenge', 'agent_ban'), for the person's own list.
  reason text check (reason is null or char_length(reason) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, site)
);

comment on table public.browser_site_memory is
  'Browser site memory (424): per person, sites the agent''s cloud browser reaches only through their Mac (needs_home) or never uses (never_automate). The person reads their own rows; only the service role writes.';

drop trigger if exists browser_site_memory_updated_at on public.browser_site_memory;
create trigger browser_site_memory_updated_at
  before update on public.browser_site_memory
  for each row execute function public.update_updated_at();

alter table public.browser_site_memory enable row level security;

drop policy if exists browser_site_memory_own_select on public.browser_site_memory;
create policy browser_site_memory_own_select on public.browser_site_memory
  for select to authenticated
  using ((select auth.uid()) = user_id);
