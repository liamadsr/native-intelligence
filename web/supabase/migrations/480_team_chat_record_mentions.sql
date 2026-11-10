-- ============================================================
-- 480: team chat messages @-mention records (the shared entity layer,
-- phase 2).
-- ============================================================
--   team_chat_message.record_mentions  the records a message @-mentions, as
--                     the words show them: [{ "type", "id", "label" }], at
--                     most 50. Written by the message routes after fencing
--                     each record for the author
--                     (src/lib/entity-links/mentions.ts); the same records
--                     are the message's `mentions` edges in entity_link
--                     (source team_chat_message, relation 'mentions'). The
--                     column is what the page draws a mention with, and it
--                     rides the message's realtime row; the edges are what
--                     a record's "Referenced in" reads. `mentions` stays
--                     member ids, unchanged.
--   team_chat_message_guard  474's, plus: a delete clears record_mentions
--                     too, and a change to them stamps edited_at.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

alter table public.team_chat_message
  add column if not exists record_mentions jsonb not null default '[]'::jsonb;

alter table public.team_chat_message drop constraint if exists team_chat_message_record_mentions;
alter table public.team_chat_message
  add constraint team_chat_message_record_mentions check (
    jsonb_typeof(record_mentions) = 'array' and jsonb_array_length(record_mentions) <= 50
  );

-- 474's guard, with record_mentions beside mentions.
create or replace function public.team_chat_message_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.channel_id is distinct from old.channel_id
     or new.workspace_id is distinct from old.workspace_id
     or new.author_kind is distinct from old.author_kind
     or new.author_member_id is distinct from old.author_member_id
     or new.agent_for_member_id is distinct from old.agent_for_member_id
     or new.agent_name is distinct from old.agent_name
     or new.in_reply_to is distinct from old.in_reply_to
     or new.created_at is distinct from old.created_at then
    raise exception 'team chat: only the words of a message can change' using errcode = '42501';
  end if;
  if old.author_kind = 'agent' and new.deleted_at is null then
    raise exception 'team chat: an agent''s reply can only be deleted' using errcode = '42501';
  end if;
  if new.deleted_at is not null then
    new.body := '';
    new.mentions := '{}';
    new.record_mentions := '[]'::jsonb;
    new.mentions_agent := false;
    new.edited_at := old.edited_at;
  elsif new.body is distinct from old.body
     or new.mentions is distinct from old.mentions
     or new.record_mentions is distinct from old.record_mentions then
    new.edited_at := now();
    new.mentions_agent := old.mentions_agent;
  else
    new.edited_at := old.edited_at;
    new.mentions_agent := old.mentions_agent;
  end if;
  return new;
end;
$$;
