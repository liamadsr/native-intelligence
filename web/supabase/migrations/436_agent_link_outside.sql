-- ============================================================
-- 436: Agent links with Dial8 users outside your workspace (phase E of
-- agent-to-agent, 435; decisions 3 and 5 in
-- /mnt/project-files/agent-links/contracts.md).
--
--   agent_link_user_for_email(email)  the confirmed Dial8 user who signs in
--                                     with an address, else null. Service
--                                     role only: the app calls it for a link
--                                     request by email and never says back
--                                     whether it found anyone (decision 3).
--   hook_require_work_email           also lets a personal address sign up
--                                     when a link request is waiting for it
--                                     (the email that request sent asks them
--                                     to make an account), as a workspace
--                                     invite already does. Security definer
--                                     as before, so it reads agent_link past
--                                     its RLS: one predicate, nothing else.
--
-- The admin's switch for outside links is workspace.settings
-- .outside_agent_links (435's note): no column here.
--
-- Applied by hand, from this file, to DEV first, then PROD, before the code
-- that reads it. Additive (one new function, one function replaced with a
-- superset of 242's). Idempotent. No backslashes anywhere in this file (one
-- MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── Email to user, for the service role only ───────────────────────────────

create or replace function public.agent_link_user_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
    and u.email_confirmed_at is not null
    and u.deleted_at is null
  order by u.created_at
  limit 1
$$;

comment on function public.agent_link_user_for_email(text) is
  'The confirmed Dial8 user signing in with this email, else null (436). Service role only: an agent link request by email never reveals whether anyone matched.';

revoke execute on function public.agent_link_user_for_email(text) from public, anon, authenticated;
grant execute on function public.agent_link_user_for_email(text) to service_role;

-- ── Sign-up gate: a waiting link request lets a personal address in ────────

create or replace function public.hook_require_work_email(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email  text;
  v_domain text;
begin
  v_email := lower(trim(coalesce(event -> 'user' ->> 'email', '')));

  if v_email = '' then
    return '{}'::jsonb;
  end if;

  v_domain := split_part(v_email, '@', 2);

  if not public.is_free_email_domain(v_domain) then
    return '{}'::jsonb;
  end if;

  -- Personal domain, but a workspace invited this address: let them in.
  if exists (
    select 1 from public.invite i
    where lower(i.email) = v_email
      and i.accepted_at is null
      and i.expires_at > now()
  ) then
    return '{}'::jsonb;
  end if;

  -- ...or Dial8 itself invited them from the admin console.
  if exists (
    select 1 from public.signup_invite s
    where s.email = v_email
      and s.used_at is null
      and s.expires_at > now()
  ) then
    return '{}'::jsonb;
  end if;

  -- ...or someone asked to link agents with this address (436).
  if exists (
    select 1 from public.agent_link l
    where l.target_email = v_email
      and l.target_user_id is null
      and l.state = 'requested'
      and (l.expires_at is null or l.expires_at > now())
  ) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Dial8 requires a business email to sign up. Personal addresses like Gmail or Yahoo aren''t accepted.'
    )
  );
end;
$$;

comment on function public.hook_require_work_email(jsonb) is
  'Supabase Auth before-user-created hook: refuses new accounts on free-mail domains unless a pending workspace invite, an admin signup invite or a waiting agent link request (436) names that email. Existing users are untouched (hook only runs on creation).';

grant execute on function public.hook_require_work_email(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_require_work_email(jsonb) from authenticated, anon, public;
