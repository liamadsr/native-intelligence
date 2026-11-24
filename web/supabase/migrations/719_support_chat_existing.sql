-- ============================================================
-- 719: Support chat for existing accounts (docs/plans/support-chat.md,
-- "Existing accounts"). 715 starts a support conversation for every account
-- made since it ran (starts_from); an account from before got one only from
-- an admin's start, one at a time. Now, while the owner's switch is on (it is,
-- by default), every account that has none and never deleted one gets it the
-- next time it uses the app: the app asks once per browser session
-- (support_chat_start_if_due, from the dashboard), so conversations start as
-- people come back, never in one burst. The welcome notifies nobody but the
-- customer (715: it is written in the database, no notification), so our
-- staff get no flood either.
-- ============================================================
--   support_chat_settings.existing_accounts  the owner's switch (Admin >
--                     Support Chat, "Existing accounts get one too"). On:
--                     every account is due. Off: 715's rule, accounts made
--                     since starts_from only.
--   support_chat_settings.welcome_existing_template  the welcome for an
--                     account made before starts_from ("you can now reach our
--                     team directly here"), the same placeholders as 715's;
--                     empty: they get the new-account welcome.
--
-- Two functions are restated from their newest text (715), each with one
-- change, and nothing else in them changes (their grants are restated too):
--   support_chat_start(uuid, boolean)    the welcome's words: the existing
--                     accounts' template for an account made before
--                     starts_from, when there is one. Everything else (one per
--                     account, staff and deleted ones refused, the name never
--                     from an address, the mention) is 715's.
--   support_chat_start_if_due(uuid)      due when made since starts_from
--                     (715) OR while the switch is on.
-- Staff stay out (support_chat_start refuses them, as before). There are no
-- agent or bot accounts among auth.users in this product: an agent is never a
-- sign-in.
--
-- How to apply: one transaction (begin ... commit below), so plain
--   psql -v ON_ERROR_STOP=1 < 719_support_chat_existing.sql
-- is atomic; a failure rolls all of it back. Apply it after 715 and BEFORE
-- the code that uses it. Applied with the old code running: nothing new
-- happens until the new code asks (the old code asks start_if_due only from
-- the team chat list, so an account from before that opens team chat gets
-- its conversation then, with the existing accounts' welcome: the same thing
-- the new code does, sooner). Rolled back to the old code after: the columns
-- stay, unread by it. To turn existing accounts off before rolling out, set
-- the switch on the admin page, or
--   update public.support_chat_settings set existing_accounts = false;
--
-- Additive. Idempotent. Safe on a live database: two nullable or defaulted
-- columns on a one-row table, under lock_timeout. Both functions are definers
-- with search_path pinned, the service role's alone. No backslashes anywhere
-- in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

alter table public.support_chat_settings
  add column if not exists existing_accounts boolean not null default true,
  add column if not exists welcome_existing_template text;

alter table public.support_chat_settings drop constraint if exists support_chat_settings_existing_template;
alter table public.support_chat_settings
  add constraint support_chat_settings_existing_template
  check (welcome_existing_template is null or char_length(welcome_existing_template) <= 2000);

comment on column public.support_chat_settings.existing_accounts is
  'Support chat (719): accounts made before starts_from get a support conversation too, the next time they use the app (support_chat_start_if_due). The owner''s switch; on by default.';
comment on column public.support_chat_settings.welcome_existing_template is
  'Support chat (719): the welcome for an account made before starts_from ({name}, {first_name} as welcome_template). Empty: they get welcome_template.';

update public.support_chat_settings
   set welcome_existing_template = 'Hi {name}, you can now reach our team directly here. Ask us anything, and tell us about bugs or ideas any time.'
 where id and welcome_existing_template is null;

-- From 715, with one change: the existing accounts' welcome for an account made before starts_from.
create or replace function public.support_chat_start(p_user uuid, p_fresh boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me record;
  sender public.support_staff%rowtype;
  template text;
  person text;
  titled text;
  address text;
  ch uuid;
  body text;
begin
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'no_account');
  end if;
  select c.id into ch from public.team_chat_channel c where c.kind = 'support' and c.support_user_id = p_user;
  if ch is not null then
    return jsonb_build_object('started', false, 'channel_id', ch, 'reason', 'exists');
  end if;
  if exists (select 1 from public.support_staff s where s.user_id = p_user) then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'staff');
  end if;
  if exists (select 1 from public.support_chat_deleted d where d.user_id = p_user) then
    if not coalesce(p_fresh, false) then
      return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'deleted');
    end if;
    delete from public.support_chat_deleted where user_id = p_user;
  end if;
  select m.id, m.workspace_id, m.display_name into me
    from public.member m
   where m.user_id = p_user
   order by m.created_at, m.id
   limit 1;
  if me.id is null then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'no_workspace');
  end if;
  -- 719: an account made before support chat began here gets the welcome for people who have been
  -- here a while, when there is one.
  select case
           when u.created_at < st.starts_from and nullif(btrim(st.welcome_existing_template), '') is not null then st.welcome_existing_template
           else st.welcome_template
         end
    into template
    from public.support_chat_settings st, auth.users u
   where st.id and u.id = p_user;
  select s.* into sender
    from public.support_chat_settings st
    join public.support_staff s on s.user_id = st.sender_user_id
   where st.id;
  if sender.user_id is null then
    select s.* into sender from public.support_staff s order by s.added_at, s.user_id limit 1;
  end if;
  if sender.user_id is null then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'no_staff');
  end if;
  person := coalesce(nullif(btrim(me.display_name), ''), 'there');
  -- The name never comes from their address: a member name that is only its first part (the
  -- sign-up's default) leaves the name plain.
  select lower(split_part(u.email, '@', 1)) into address from auth.users u where u.id = p_user;
  titled := case
    when nullif(btrim(me.display_name), '') is null or lower(btrim(me.display_name)) = address then 'Native Intelligence Support'
    else left('Native Intelligence Support x ' || left(btrim(me.display_name), 50), 80)
  end;

  insert into public.team_chat_channel (workspace_id, kind, name, support_user_id)
  values (me.workspace_id, 'support', titled, p_user)
  on conflict (support_user_id) where kind = 'support' do nothing
  returning id into ch;
  if ch is null then
    -- Raced with another start: theirs stands.
    select c.id into ch from public.team_chat_channel c where c.kind = 'support' and c.support_user_id = p_user;
    return jsonb_build_object('started', false, 'channel_id', ch, 'reason', 'exists');
  end if;

  -- Read up to just before the welcome, so it counts as unread for them.
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at, joined_at)
  values (ch, me.id, me.workspace_id, now() - interval '1 second', now())
  on conflict (channel_id, member_id) do nothing;

  body := public.support_chat_welcome_words(coalesce(template, 'Hi {name}, welcome to Native Intelligence!'), person);
  if char_length(body) = 0 then
    body := 'Welcome to Native Intelligence!';
  end if;
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, support_user_id, support_name, support_avatar_url, body, mentions)
  values (ch, me.workspace_id, 'support', sender.user_id, sender.display_name, sender.avatar_url, body,
          case when position(('@' || person) in body) > 0 then array[me.id] else '{}'::uuid[] end);
  return jsonb_build_object('started', true, 'channel_id', ch, 'reason', 'started');
end;
$$;

revoke all on function public.support_chat_start(uuid, boolean) from public, anon, authenticated;
grant execute on function public.support_chat_start(uuid, boolean) to service_role;

-- From 715, with one change: due while the owner's switch is on, as well as for accounts made since.
create or replace function public.support_chat_start_if_due(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from auth.users u, public.support_chat_settings st
     where u.id = p_user and st.id and (u.created_at >= st.starts_from or st.existing_accounts)
  ) then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'before');
  end if;
  return public.support_chat_start(p_user, false);
end;
$$;

revoke all on function public.support_chat_start_if_due(uuid) from public, anon, authenticated;
grant execute on function public.support_chat_start_if_due(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
