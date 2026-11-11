-- ============================================================
-- 559: Team chat's typing line: who may hear and say "X is typing" in a
-- channel, over a PRIVATE Realtime broadcast topic per channel
-- (`team-chat-typing:<channel id>`; no table, nothing stored).
-- ============================================================
--   team_chat_typing_channel  the channel a topic is for, or null for any
--                     other topic (compared as text before the cast, so a
--                     malformed topic never raises inside a policy).
--   realtime.messages policies (these topics only, broadcast only):
--     hear  whoever may read the channel (team_chat_can_read).
--     say   whoever may post in it (team_chat_can_post).
--
-- A private channel is checked when it is joined, so a member who leaves the
-- channel (a team, a DM) stops hearing it on their next join. The topic
-- name (a channel id) is no secret on its own: without these policies any
-- holder of the anon key could listen in.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create or replace function public.team_chat_typing_channel(topic text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when topic ~ '^team-chat-typing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(topic, ':', 2)::uuid
  end;
$$;

revoke all on function public.team_chat_typing_channel(text) from public, anon;
grant execute on function public.team_chat_typing_channel(text) to authenticated;

drop policy if exists "team_chat_typing_hear" on realtime.messages;
create policy "team_chat_typing_hear" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() like 'team-chat-typing:%'
    and realtime.messages.extension = 'broadcast'
    and public.team_chat_can_read(public.team_chat_typing_channel(realtime.topic()))
  );

drop policy if exists "team_chat_typing_say" on realtime.messages;
create policy "team_chat_typing_say" on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() like 'team-chat-typing:%'
    and realtime.messages.extension = 'broadcast'
    and public.team_chat_can_post(public.team_chat_typing_channel(realtime.topic()))
  );

notify pgrst, 'reload schema';
