-- ============================================================
-- 680: a company's email, shared with the team (OFF by default).
-- ============================================================
-- Mail is not stored (the index keeps ids, flags and addresses; the subject
-- and body are read live from the owner's mailbox on each open). This
-- migration adds WHO MAY SEE WHICH THREAD POINTERS, and nothing of the mail.
--
-- The rule, all of it enforced here (company_team_email_threads is the one
-- way to list another person's threads; email_thread_index stays own-only
-- under RLS, as before):
--   1. The company's "Share email with the team" switch is on
--      (company.share_email_with_team, default false).
--   2. The thread's owner has agreed, for THIS company
--      (company_email_consent: per member, per company, opt-in, revocable at
--      any time; turning the switch on agrees for no one).
--   3. The owner is still a member of the company's workspace.
--   4. The owner has not made the thread private
--      (email_thread_team_private: one thread, every company).
--   5. The reader can see the company (company_visible_to, with or without
--      grants as the caller asks) and is a member of its workspace who is not
--      a guest: members agreed to share with the TEAM, so a guest reaches no
--      team mail, even with the company shared to them by a grant.
--   6. The thread is with someone at the company who is NOT a teammate: an
--      address of one of its people the READER can see, or an address at the
--      company's domain. Workspace members' own addresses (their sign-in
--      emails, and contacts that are a member) never count, on either side,
--      so an internal thread never rides on a company; the workspace's own
--      company (is_workspace_company) can't be switched on at all.
--   7. Not a draft, not spam, not trash; the mailbox is still connected
--      (account_id set).
-- A signed-in caller asks only about themself (auth.uid() = p_user_id); the
-- service role (the agent's tools, MCP) passes the requester explicitly and
-- gets exactly the same fence. No requester: nothing.
--
-- Redefines nothing. Additive. Idempotent. No backslashes.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ── The company's switch ────────────────────────────────────────────────────

alter table public.company add column if not exists share_email_with_team boolean not null default false;
alter table public.company add column if not exists share_email_changed_by_member_id uuid references public.member(id) on delete set null;
alter table public.company add column if not exists share_email_changed_at timestamptz;

comment on column public.company.share_email_with_team is
  'Share email with the team (680): off by default. On, a member''s threads with this company are listed to whoever can see the company ONLY if that member agreed (company_email_consent). Off, nothing is listed.';

-- ── Consent: per member, per company ────────────────────────────────────────

create table if not exists public.company_email_consent (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists company_email_consent_live_key
  on public.company_email_consent (company_id, user_id)
  where revoked_at is null;
create index if not exists company_email_consent_user_idx
  on public.company_email_consent (user_id, workspace_id)
  where revoked_at is null;

comment on table public.company_email_consent is
  'A member agreed to share their own mail with one company''s page (680). Opt-in, per company; revoked_at ends it at once. Written only through set_company_email_consent / stop_sharing_my_company_email.';

alter table public.company_email_consent enable row level security;
revoke all on table public.company_email_consent from public, anon, authenticated;
grant select on table public.company_email_consent to authenticated;
grant select, insert, update, delete on table public.company_email_consent to service_role;

-- Who shares with a company is shown to whoever can see the company (the
-- company's own row policy decides, the subquery running as the caller), and
-- a member always sees their own.
drop policy if exists company_email_consent_select on public.company_email_consent;
create policy company_email_consent_select on public.company_email_consent
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.company c
       where c.id = company_email_consent.company_id
         and public.is_workspace_member(c.workspace_id)
    )
  );

-- ── A thread its owner keeps private ────────────────────────────────────────

create table if not exists public.email_thread_team_private (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  provider_thread_id text not null check (char_length(provider_thread_id) between 1 and 512),
  thread_index_id uuid references public.email_thread_index(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists email_thread_team_private_key
  on public.email_thread_team_private (owner_user_id, workspace_id, provider_thread_id);

comment on table public.email_thread_team_private is
  'A thread its owner made private (680): never listed on any company page, whatever the consent. Ids only. Only the owner reads or writes their rows.';

alter table public.email_thread_team_private enable row level security;
revoke all on table public.email_thread_team_private from public, anon, authenticated;
grant select on table public.email_thread_team_private to authenticated;
grant select, insert, update, delete on table public.email_thread_team_private to service_role;

drop policy if exists email_thread_team_private_select on public.email_thread_team_private;
create policy email_thread_team_private_select on public.email_thread_team_private
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

-- ── The caller's member row (internal) ──────────────────────────────────────

create or replace function public._company_email_member(p_company_id uuid, p_user_id uuid)
returns table (member_id uuid, workspace_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id, c.workspace_id
    from public.company c
    join public.member m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
   where c.id = p_company_id
   limit 1;
$$;

revoke all on function public._company_email_member(uuid, uuid) from public, anon, authenticated;

-- ── Writes: the switch, my consent, my private threads ──────────────────────

-- The switch: anyone who can see the company. Turning it on shares no one's
-- mail by itself; turning it off hides every thread at once.
create or replace function public.set_company_email_sharing(p_company_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member uuid;
  v_ws uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select x.member_id, x.workspace_id into v_member, v_ws from public._company_email_member(p_company_id, auth.uid()) x;
  if v_member is null or not public.company_visible_to(p_company_id, auth.uid()) then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  -- A guest takes no part in the team's mail.
  if exists (select 1 from public.member m where m.id = v_member and m.role = 'guest') then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  -- The workspace's own company is the team itself: its mail is all internal.
  if coalesce(p_on, false) and exists (select 1 from public.company co where co.id = p_company_id and co.is_workspace_company) then
    raise exception 'the workspace''s own company can''t share email with the team' using errcode = '22023';
  end if;
  update public.company
     set share_email_with_team = coalesce(p_on, false),
         share_email_changed_by_member_id = v_member,
         share_email_changed_at = now()
   where id = p_company_id;
  return coalesce(p_on, false);
end;
$$;

revoke all on function public.set_company_email_sharing(uuid, boolean) from public, anon;
grant execute on function public.set_company_email_sharing(uuid, boolean) to authenticated;

-- My consent for one company: only my own, only on a company I can see.
create or replace function public.set_company_email_consent(p_company_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member uuid;
  v_ws uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select x.member_id, x.workspace_id into v_member, v_ws from public._company_email_member(p_company_id, auth.uid()) x;
  if v_member is null or not public.company_visible_to(p_company_id, auth.uid()) then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  -- A guest's mail is never the team's (stopping always works, below).
  if coalesce(p_on, false) and exists (select 1 from public.member m where m.id = v_member and m.role = 'guest') then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  if coalesce(p_on, false) then
    insert into public.company_email_consent (workspace_id, company_id, user_id)
    values (v_ws, p_company_id, auth.uid())
    on conflict (company_id, user_id) where revoked_at is null do nothing;
    return true;
  end if;
  update public.company_email_consent
     set revoked_at = now()
   where company_id = p_company_id and user_id = auth.uid() and revoked_at is null;
  return false;
end;
$$;

revoke all on function public.set_company_email_consent(uuid, boolean) from public, anon;
grant execute on function public.set_company_email_consent(uuid, boolean) to authenticated;

-- Stop sharing my mail with every company of a workspace, at once.
create or replace function public.stop_sharing_my_company_email(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  update public.company_email_consent
     set revoked_at = now()
   where user_id = auth.uid() and workspace_id = p_workspace_id and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.stop_sharing_my_company_email(uuid) from public, anon;
grant execute on function public.stop_sharing_my_company_email(uuid) to authenticated;

-- Make one of MY threads private (or shareable again). The index row must be mine.
create or replace function public.set_email_thread_team_private(p_thread_index_id uuid, p_private boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t record;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select i.id, i.workspace_id, i.provider_thread_id into t
    from public.email_thread_index i
   where i.id = p_thread_index_id and i.user_id = auth.uid();
  if t.id is null then raise exception 'thread not found' using errcode = 'P0002'; end if;
  if coalesce(p_private, true) then
    insert into public.email_thread_team_private (workspace_id, owner_user_id, provider_thread_id, thread_index_id)
    values (t.workspace_id, auth.uid(), t.provider_thread_id, t.id)
    on conflict (owner_user_id, workspace_id, provider_thread_id) do nothing;
    return true;
  end if;
  delete from public.email_thread_team_private
   where owner_user_id = auth.uid() and workspace_id = t.workspace_id and provider_thread_id = t.provider_thread_id;
  return false;
end;
$$;

revoke all on function public.set_email_thread_team_private(uuid, boolean) from public, anon;
grant execute on function public.set_email_thread_team_private(uuid, boolean) to authenticated;

-- ── Reads ───────────────────────────────────────────────────────────────────

-- The company's sharing, as one reader sees it: the switch, who turned it
-- last, whether the reader agreed, and who shares (members still in the
-- workspace). Null for a reader who can't see the company.
create or replace function public.company_email_sharing_status(p_company_id uuid, p_user_id uuid, p_grants boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_member uuid;
begin
  if p_user_id is null then return null; end if;
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then return null; end if;
  select co.id, co.workspace_id, co.share_email_with_team, co.share_email_changed_by_member_id, co.share_email_changed_at
    into c from public.company co where co.id = p_company_id;
  if c.id is null then return null; end if;
  select m.id into v_member from public.member m where m.workspace_id = c.workspace_id and m.user_id = p_user_id and m.role <> 'guest' limit 1;
  if v_member is null or not public.company_visible_to(p_company_id, p_user_id, coalesce(p_grants, true)) then return null; end if;
  return jsonb_build_object(
    'enabled', c.share_email_with_team,
    'changed_by_member_id', c.share_email_changed_by_member_id,
    'changed_at', c.share_email_changed_at,
    'my_consent', exists (
      select 1 from public.company_email_consent k
       where k.company_id = p_company_id and k.user_id = p_user_id and k.revoked_at is null),
    'sharers', coalesce((
      select jsonb_agg(jsonb_build_object('member_id', m.id, 'display_name', m.display_name, 'since', k.created_at) order by k.created_at)
        from public.company_email_consent k
        join public.member m on m.user_id = k.user_id and m.workspace_id = c.workspace_id and m.role <> 'guest'
       where k.company_id = p_company_id and k.revoked_at is null), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.company_email_sharing_status(uuid, uuid, boolean) from public, anon;
grant execute on function public.company_email_sharing_status(uuid, uuid, boolean) to authenticated, service_role;

-- The threads one reader may see on a company's page, newest first: ids,
-- flags and the team members on each, never mail. p_thread_index_id narrows
-- to one thread (the open and attachment routes ask it before reading live).
create or replace function public.company_team_email_threads(
  p_company_id uuid,
  p_user_id uuid,
  p_grants boolean default true,
  p_limit integer default 50,
  p_thread_index_id uuid default null
)
returns table (
  thread_index_id uuid,
  owner_user_id uuid,
  owner_member_id uuid,
  account_id uuid,
  provider text,
  provider_thread_id text,
  provider_message_id text,
  folder text,
  last_message_at timestamptz,
  from_email text,
  message_count integer,
  has_attachments boolean,
  team_member_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_member uuid;
  v_emails text[];
  v_team text[];
  v_domain text;
begin
  -- 5. A reader, asking about themself (the service role names them).
  if p_user_id is null then return; end if;
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then return; end if;
  select co.id, co.workspace_id, co.domain, co.share_email_with_team, co.is_workspace_company into c from public.company co where co.id = p_company_id;
  if c.id is null then return; end if;
  -- 1. The switch (never on the workspace's own company).
  if c.share_email_with_team is not true or c.is_workspace_company then return; end if;
  -- 5. Not a guest.
  select m.id into v_member from public.member m where m.workspace_id = c.workspace_id and m.user_id = p_user_id and m.role <> 'guest' limit 1;
  if v_member is null then return; end if;
  if not public.company_visible_to(p_company_id, p_user_id, coalesce(p_grants, true)) then return; end if;

  -- 6. Teammates: every member's sign-in address, and every address of a
  -- contact that is a member. These never make a thread "with the company".
  select coalesce(array_agg(distinct a), '{}'::text[]) into v_team
    from (
      select lower(u.email) as a
        from public.member m join auth.users u on u.id = m.user_id
       where m.workspace_id = c.workspace_id and u.email is not null
      union
      select lower(e)
        from public.contact ct
        cross join lateral unnest(array[ct.email] || coalesce(ct.secondary_emails, '{}'::text[])) e
       where ct.workspace_id = c.workspace_id and ct.member_id is not null and e is not null and btrim(e) <> ''
    ) x;
  -- Who is "at the company": the people at it the READER can see (not
  -- teammates), and its domain.
  select coalesce(array_agg(distinct lower(e)), '{}'::text[]) into v_emails
    from public.contact ct
    cross join lateral unnest(array[ct.email] || coalesce(ct.secondary_emails, '{}'::text[])) e
   where ct.company_id = p_company_id
     and ct.workspace_id = c.workspace_id
     and ct.merged_into_contact_id is null
     and ct.member_id is null
     and e is not null and btrim(e) <> ''
     and lower(e) <> all (v_team)
     and public.contact_visible_to(ct.id, p_user_id, coalesce(p_grants, true));
  -- A personal-mail domain (gmail.com and the like, 232's list) names no company.
  v_domain := nullif(lower(btrim(c.domain)), '');
  if v_domain is not null and public.is_personal_email_domain(v_domain) then v_domain := null; end if;

  return query
  with sharers as (
    -- 2 and 3. Agreed for this company, and still a member of its workspace.
    select k.user_id, m.id as member_id
      from public.company_email_consent k
      join public.member m on m.user_id = k.user_id and m.workspace_id = c.workspace_id and m.role <> 'guest'
     where k.company_id = p_company_id and k.revoked_at is null
  ),
  team as (
    select m.id as member_id, lower(u.email) as email
      from public.member m
      join auth.users u on u.id = m.user_id
     where m.workspace_id = c.workspace_id and u.email is not null
  )
  select t.id, t.user_id, s.member_id, t.account_id, t.provider, t.provider_thread_id, t.provider_message_id,
         t.folder, t.last_message_at, t.from_email, t.message_count, coalesce(t.has_attachments, false),
         array(
           select distinct tm.member_id from team tm
            where tm.email = any (select lower(p) from unnest(coalesce(t.participant_emails, '{}'::text[])) p)
               or tm.member_id = s.member_id
         )
    from public.email_thread_index t
    join sharers s on s.user_id = t.user_id
   where t.workspace_id = c.workspace_id
     and (p_thread_index_id is null or t.id = p_thread_index_id)
     -- 7.
     and t.account_id is not null
     and coalesce(t.is_draft, false) = false
     and coalesce(t.folder, 'inbox') not in ('spam', 'trash', 'drafts')
     -- 4.
     and not exists (
       select 1 from public.email_thread_team_private x
        where x.owner_user_id = t.user_id and x.workspace_id = t.workspace_id and x.provider_thread_id = t.provider_thread_id)
     -- 6. A participant who is not a teammate is at the company.
     and exists (
       select 1 from unnest(coalesce(t.participant_emails, '{}'::text[])) p0
        cross join lateral (select lower(btrim(p0)) as p) q
        where q.p <> all (v_team)
          and (q.p = any (v_emails)
               or (v_domain is not null and (split_part(q.p, '@', 2) = v_domain
                   or right(split_part(q.p, '@', 2), char_length(v_domain) + 1) = '.' || v_domain)))
     )
   order by t.last_message_at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$;

revoke all on function public.company_team_email_threads(uuid, uuid, boolean, integer, uuid) from public, anon;
grant execute on function public.company_team_email_threads(uuid, uuid, boolean, integer, uuid) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
