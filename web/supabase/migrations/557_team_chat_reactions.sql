-- ============================================================
-- 557: Team chat reactions: people react to a message with an emoji, shown
-- under it as chips with counts.
-- ============================================================
--   team_chat_reaction   one row per message, member and emoji (the trio is
--                        the key). `active` false is a reaction taken back:
--                        the row stays (turned off, not deleted), so taking
--                        one back reaches the channel's readers as an UPDATE,
--                        which Realtime filters by the policies, and never as
--                        a DELETE, which Realtime sends every subscriber of
--                        the table, whoever they are (it can't check a
--                        policy on a row that is gone). Written by
--                        team_chat_react only; read by anyone who may read
--                        the channel; live.
--   team_chat_react      turn the caller's reaction on or off (an explicit
--                        state, so a retried call lands the same). Only on a
--                        message they may post beside (team_chat_can_post:
--                        they may read the channel and it isn't archived)
--                        and that isn't deleted; at most 20 emoji per member
--                        per message. Returns the state now.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.team_chat_reaction (
  message_id uuid not null references public.team_chat_message(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  -- One emoji (a few code points at most): never words, markup or spaces.
  emoji text not null check (char_length(emoji) between 1 and 16 and emoji !~ '[[:space:][:cntrl:]<>a-zA-Z]'),
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, member_id, emoji)
);
create index if not exists team_chat_reaction_channel_idx on public.team_chat_reaction (channel_id);
create index if not exists team_chat_reaction_member_idx on public.team_chat_reaction (member_id);

alter table public.team_chat_reaction enable row level security;

drop policy if exists team_chat_reaction_select on public.team_chat_reaction;
create policy team_chat_reaction_select on public.team_chat_reaction
  for select to authenticated using (public.team_chat_can_read(channel_id));

revoke all on table public.team_chat_reaction from anon, authenticated;
grant select on table public.team_chat_reaction to authenticated;

create or replace function public.team_chat_react(msg uuid, reaction text, turn_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch uuid;
  ws uuid;
  gone timestamptz;
  me uuid;
begin
  select m.channel_id, m.workspace_id, m.deleted_at into ch, ws, gone
    from public.team_chat_message m
   where m.id = msg;
  if ch is null or not public.team_chat_can_post(ch) then
    raise exception 'team chat: no such message' using errcode = '42501';
  end if;
  if gone is not null then
    raise exception 'team chat: that message was deleted' using errcode = '22023';
  end if;
  me := public.current_member_id(ws);
  if turn_on then
    if (
      select count(*) from public.team_chat_reaction r
       where r.message_id = msg and r.member_id = me and r.active and r.emoji <> reaction
    ) >= 20 then
      raise exception 'team chat: too many reactions on one message' using errcode = '22023';
    end if;
    insert into public.team_chat_reaction (message_id, member_id, emoji, channel_id, workspace_id, active)
    values (msg, me, reaction, ch, ws, true)
    on conflict (message_id, member_id, emoji) do update
       set active = true, updated_at = now()
     where team_chat_reaction.active = false;
  else
    update public.team_chat_reaction
       set active = false, updated_at = now()
     where message_id = msg and member_id = me and emoji = reaction and active;
  end if;
  return turn_on;
end;
$$;

revoke all on function public.team_chat_react(uuid, text, boolean) from public, anon;
grant execute on function public.team_chat_react(uuid, text, boolean) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_chat_reaction') then
      alter publication supabase_realtime add table public.team_chat_reaction;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
