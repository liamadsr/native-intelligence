-- ============================================================
-- 306: Members can't make themselves owner
-- ============================================================
-- The member policies from 028 trusted a row's own user too far:
--
--   * member_insert accepted any row whose user_id was the caller's, in any
--     workspace and with any role. Knowing a workspace id was enough to join
--     it, at any rank.
--   * member_update had no WITH CHECK, so its USING (your own row, or any row
--     in a workspace you own or administer) also judged the new row. A member
--     could change their own role. An admin could make anyone owner or demote
--     the owner, and an owner or admin could give a row another user_id or
--     move it into another workspace they also own or administer.
--
-- The app needs none of that. Every writer of public.member (audited
-- 2026-10-07 across the website, its eve agents and scripts, the desktop app
-- and the iOS app):
--
--   Inserts, all trusted:
--     handle_new_user()                    auth.users trigger, SECURITY DEFINER: the signup's owner row
--     POST /api/account/workspace          service role: the creator's owner row
--     POST /api/account/workspace/invites/accept
--                                          service role: the invitee, with the invite's role
--                                          (invite.role is admin, member or guest by its CHECK)
--   Role changes, on the user's session:
--     PATCH /api/account/workspace/members/[id]
--                                          owner or admin; never their own row; admin, member or
--                                          guest; Settings never offers the owner's row
--     POST /api/account/workspace/transfer-owner
--                                          owner only: the target becomes owner, then the owner
--                                          steps down to admin (two statements)
--   Self-updates of non-sensitive columns, on the user's session:
--     onboarding_completed_at and onboarding_progress (the onboarding routes, the
--     home-conversation pointer, and merge_onboarding_progress, which is SECURITY INVOKER)
--   Service-role updates: display_name (profile), onboarding_progress (research route,
--     onboarding-researcher agent), onboarding_completed_at (smoke scripts)
--   Deletes, unchanged here: member_delete, owner only
--
-- The desktop app writes nothing to member and the iOS app only reads it.
-- There are no join requests and no domain auto-join.
--
-- So, from a client (any caller the trigger below does not trust):
--   1. No inserts. Members are added by the server, each path behind its own
--      check: the service role, or the SECURITY DEFINER signup trigger.
--   2. A row's id, user_id and workspace_id never change.
--   3. A role changes only under the app's rules. The owner sets anyone
--      else's role, owner included, which is how ownership is handed over. An
--      admin moves a non-owner among admin, member and guest. Your own role
--      only goes down, and only the owner's, while another owner remains (the
--      second half of a transfer). Nobody raises their own role.
--   4. The new row must still be yours or in a workspace you own or
--      administer, and only the owner may leave a row saying 'owner'.
--
-- Trusted callers skip the trigger: auth.role() is service_role, or there is
-- no request at all (migrations, the auth-side signup trigger, cron), which
-- reads as auth.role() null (checked on DEV). Never auth.uid() is null alone:
-- anon has no uid either.
--
-- Idempotent: drop policy if exists, create or replace, drop trigger if exists.

-- ------------------------------------------------------------
-- 1. Inserts: the server only
-- ------------------------------------------------------------
-- With RLS on and no insert policy, every client insert is refused. The
-- service role bypasses RLS, and so do SECURITY DEFINER functions owned by
-- postgres (handle_new_user, and the AFTER INSERT triggers on member).
drop policy if exists "member_insert" on public.member;
drop policy if exists "Authenticated users can insert members" on public.member;

-- ------------------------------------------------------------
-- 2. Updates: which rows, and what the new row may say
-- ------------------------------------------------------------
drop policy if exists "member_update" on public.member;
drop policy if exists "Users can update own member profile" on public.member;
create policy "member_update"
  on public.member for update
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.get_member_role(workspace_id) in ('owner', 'admin')
  )
  with check (
    (
      user_id = (select auth.uid())
      or public.get_member_role(workspace_id) in ('owner', 'admin')
    )
    and (role <> 'owner' or public.get_member_role(workspace_id) = 'owner')
  );

comment on policy "member_update" on public.member is
  'Your own row, or any row in a workspace you own or administer. The new row must pass the same test, and only the owner may leave a row saying owner. member_guard_update (306) decides identity and role changes.';

-- ------------------------------------------------------------
-- 3. The guard: identity never moves; roles follow the app's rules
-- ------------------------------------------------------------
create or replace function public.member_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_caller_role text;
begin
  -- The server: the service role, or no request at all.
  if coalesce(auth.role(), '') in ('', 'service_role') then
    return new;
  end if;

  -- A member row is one user in one workspace. It never changes hands.
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'A member row cannot move to another user or workspace'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is not distinct from old.role then
    return new;
  end if;

  select m.role into v_caller_role
  from public.member m
  where m.workspace_id = old.workspace_id
    and m.user_id = v_uid;

  if v_uid is null or v_caller_role is null then
    raise exception 'Only the workspace owner or an admin can change a role'
      using errcode = 'insufficient_privilege';
  end if;

  -- Your own row: only the owner steps down, and only while another owner
  -- remains. transfer-owner promotes the new owner first, then demotes itself.
  if old.user_id = v_uid then
    if old.role <> 'owner' then
      raise exception 'You cannot change your own role'
        using errcode = 'insufficient_privilege';
    end if;
    if not exists (
      select 1
      from public.member o
      where o.workspace_id = old.workspace_id
        and o.role = 'owner'
        and o.id <> old.id
    ) then
      raise exception 'A workspace needs an owner: transfer ownership before stepping down'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- The owner sets anyone else's role, owner included.
  if v_caller_role = 'owner' then
    return new;
  end if;

  -- An admin moves a non-owner among admin, member and guest.
  if v_caller_role = 'admin' and old.role <> 'owner' and new.role <> 'owner' then
    return new;
  end if;

  raise exception 'Only the owner can make someone owner or change the owner''s role'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.member_guard_update() is
  'BEFORE UPDATE on member (306). Unless the caller is the service role or has no request context: id, user_id and workspace_id never change; the owner sets other roles (owner included); an admin moves non-owners among admin/member/guest; your own role only goes down, and only an owner''s while another owner remains.';

drop trigger if exists member_guard_update on public.member;
create trigger member_guard_update
  before update on public.member
  for each row execute function public.member_guard_update();

-- A trigger function, never called directly.
revoke execute on function public.member_guard_update() from public, anon, authenticated;
