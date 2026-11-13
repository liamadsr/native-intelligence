-- ============================================================
-- 644: Getting a team into a workspace
-- ============================================================
-- Three ways in besides the emailed invite, all OFF until an owner or admin
-- switches them on (src/lib/workspace-join/):
--
--   1. Auto-join by email domain. A workspace claims one domain, always the
--      verified address's domain of the owner or admin who switched it on
--      (never a typed one, never a public mail provider). At sign-in, a
--      person whose VERIFIED address is on that domain becomes a member.
--   2. A shareable invite link, /join/<token>: one per workspace, reusable,
--      switched on and off and reset (a new token kills the old one).
--   3. "Members can invite people": members send email invites too, as
--      member or guest only.
--
-- Both tables are the server's alone: RLS on, no policies, everything
-- revoked from anon and authenticated, nothing granted back. The link's
-- token must not be readable by every member (the workspace row is), and a
-- client must not be able to claim a domain by writing the column itself:
-- the domain has to come from the server, which derives it from the
-- caller's verified address. The app reads and writes both with the service
-- role behind a role check (src/app/api/account/workspace/join/).
--
-- member.joined_via records how each person came in ('invite', 'link',
-- 'domain'; null for owners and everyone before this). Only the server
-- writes it: member inserts are server-only already (306), and a trigger
-- refuses a client update that changes it.
--
-- A workspace merge must not hand the source's link or domain claim to the
-- destination (that would let the source's link, or its domain, into the
-- merged workspace without anyone switching it on there), and the generic
-- re-stamp would otherwise collide on these one-row-per-workspace keys. So
-- _wsmerge_generic_restamp is restated from its newest definition (473),
-- unchanged except that it first deletes the source's two rows.
--
-- Re-runnable: create ... if not exists, add column if not exists, create or
-- replace, drop ... if exists before create; revoke and grant repeat
-- harmlessly. Takes its locks with a timeout.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The switches
-- ------------------------------------------------------------
-- One row per workspace once anyone changes a switch; no row reads as all
-- off. auto_join_domain is the claimed domain while auto-join is on, null
-- while it is off (switching off frees the domain for another workspace).
-- It is stored lowercased (the CHECK), so the unique index below is on the
-- lowercased domain and the sign-in lookup (`= $1`) uses it.
create table if not exists public.workspace_join_settings (
  workspace_id uuid primary key references public.workspace (id) on delete cascade,
  members_can_invite boolean not null default false,
  auto_join_domain text,
  -- auth.users id of who last changed a switch; a bare uuid, like 242's
  -- invited_by, so deleting that account does not touch the row.
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_join_settings_domain_check check (
    auto_join_domain is null
    or (
      auto_join_domain = lower(btrim(auto_join_domain))
      and char_length(auto_join_domain) between 3 and 253
      and auto_join_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    )
  )
);

-- A domain is claimed by one workspace at a time.
create unique index if not exists workspace_join_settings_domain_key
  on public.workspace_join_settings (auto_join_domain)
  where auto_join_domain is not null;

alter table public.workspace_join_settings enable row level security;
revoke all on table public.workspace_join_settings from anon, authenticated;
grant all on table public.workspace_join_settings to service_role;

comment on table public.workspace_join_settings is
  'How people may join a workspace besides an emailed invite: members_can_invite, and the auto-join domain (null = off). Service role only (644); the app derives the domain from the verified address of the owner or admin who switched it on.';

-- ------------------------------------------------------------
-- 2. The shareable link
-- ------------------------------------------------------------
-- One row per workspace once the link is first switched on. The token is
-- made by the app with a CSPRNG (32 bytes, base64url: 43 characters); the
-- CHECK holds it to url-safe characters and at least 22 of them (128 bits).
-- Reset replaces the token; switching off keeps it, and the join route
-- refuses a link that is off.
create table if not exists public.workspace_join_link (
  workspace_id uuid primary key references public.workspace (id) on delete cascade,
  token text not null,
  enabled boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_join_link_token_check check (token ~ '^[A-Za-z0-9_-]{22,128}$')
);

create unique index if not exists workspace_join_link_token_key
  on public.workspace_join_link (token);

alter table public.workspace_join_link enable row level security;
revoke all on table public.workspace_join_link from anon, authenticated;
grant all on table public.workspace_join_link to service_role;

comment on table public.workspace_join_link is
  'A workspace''s reusable invite link (/join/<token>). Service role only (644): the token is read through an API route that checks the caller''s role, never from the workspace row.';

-- ------------------------------------------------------------
-- 3. How each member joined
-- ------------------------------------------------------------
alter table public.member
  add column if not exists joined_via text
    constraint member_joined_via_check check (joined_via is null or joined_via in ('invite', 'link', 'domain'));

comment on column public.member.joined_via is
  'How this person joined: invite, link or domain (644). Null for owners and for everyone who joined before 644. Written by the server only.';

-- The server (service role, or no request at all) writes it; a client's
-- update that changes it is refused. Fires only when the column is named in
-- the update, so the onboarding and profile self-updates never reach it.
create or replace function public.member_guard_joined_via()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') in ('', 'service_role') then
    return new;
  end if;
  if new.joined_via is distinct from old.joined_via then
    raise exception 'How a member joined is recorded by the server'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.member_guard_joined_via() is
  'BEFORE UPDATE OF joined_via on member (644). Unless the caller is the service role or has no request context, joined_via never changes.';

drop trigger if exists member_guard_joined_via on public.member;
create trigger member_guard_joined_via
  before update of joined_via on public.member
  for each row execute function public.member_guard_joined_via();

-- A trigger function, never called directly.
revoke execute on function public.member_guard_joined_via() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. A workspace merge drops the source's link and domain claim
-- ------------------------------------------------------------
-- Restated in full from 473, with only the two deletes added.
CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n int; v_out jsonb := '{}'::jsonb;
BEGIN
  -- Joining (644): the source's link and domain claim end with it. They are
  -- never handed to the destination, which keeps its own switches.
  DELETE FROM public.workspace_join_link WHERE workspace_id = p_source;
  DELETE FROM public.workspace_join_settings WHERE workspace_id = p_source;
  -- Deals first (473): pipelines and stages fold by name, so a deal is never
  -- re-stamped while its stage is still the other workspace's.
  v_out := v_out || public._wsmerge_deals(p_source, p_dest);
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge', 'cloud_browser')
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET workspace_id = $1 WHERE workspace_id = $2', r.table_name) USING p_dest, p_source;
      GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'merge cannot re-stamp %: a uniqueness this merge does not resolve (%)', r.table_name, SQLERRM
        USING ERRCODE = 'P0008';
    END;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object(r.table_name, n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_generic_restamp(uuid, uuid) FROM PUBLIC, anon, authenticated;
