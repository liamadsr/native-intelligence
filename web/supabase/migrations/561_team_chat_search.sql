-- ============================================================
-- 561: Team chat, phase 2: messages are found by the app's search (the `/`
-- palette, src/app/api/account/search/menu-queries.ts).
-- ============================================================
--   team_chat_message_fts_idx  full text over a message's words (English),
--                     for the messages not deleted. Built over every message
--                     already there, so the messages written before this are
--                     found too: the build is the backfill, and there is
--                     nothing to run after it.
--   team_chat_search(ws, q, lim)  the caller's search: messages whose words
--                     match every word typed (each as a word's start, so it
--                     finds as you type), in the channels and DMs the
--                     CALLER may read (team_chat_can_read, inside the
--                     function: a person who may not read a channel never
--                     gets a row of it back, whoever's client asks), never a
--                     deleted one. Best match first, then newest; at most
--                     lim (1 to 25). Each row says where it was said (the
--                     channel's name, or the DM's other person), who wrote
--                     it, and the passage that matched.
--
-- No vectors: messages are short and many, and the embedding pipeline
-- (document_chunks, capture_chunks) embeds a record's text in chunks after
-- it is written; adding a kind to it is its own job. Full text only.
--
-- Additive. Idempotent. Safe on a live database: one new index (the build
-- takes a SHARE lock on team_chat_message, which holds writes back for as
-- long as the build runs: milliseconds at this table's size; lock_timeout
-- makes it fail rather than queue behind a long reader) and one new
-- function. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create index if not exists team_chat_message_fts_idx
  on public.team_chat_message using gin (to_tsvector('english', body))
  where deleted_at is null;

create or replace function public.team_chat_search(ws uuid, q text, lim integer default 8)
returns table (
  id uuid,
  channel_id uuid,
  thread_root_id uuid,
  channel_kind text,
  place text,
  author_kind text,
  author_member_id uuid,
  agent_for_member_id uuid,
  author_name text,
  snippet text,
  created_at timestamptz,
  rank real
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  me uuid := public.current_member_id(ws);
  words text[];
  tsq tsquery;
begin
  if me is null then
    return;
  end if;
  -- The words typed (letters and digits only, so nothing reaches the query's own grammar), each a prefix.
  words := array(
    select w
      from regexp_split_to_table(lower(coalesce(left(q, 200), '')), '[^[:alnum:]]+') w
     where char_length(w) between 1 and 40
     limit 6
  );
  if coalesce(array_length(words, 1), 0) = 0 then
    return;
  end if;
  tsq := to_tsquery('english', array_to_string(array(select w || ':*' from unnest(words) w), ' & '));
  if tsq is null or numnode(tsq) = 0 then
    return;
  end if;
  return query
  with readable as (
    select c.id, c.kind, c.name, c.dm_key
      from public.team_chat_channel c
     where c.workspace_id = ws
       and public.team_chat_can_read(c.id)
  ),
  hits as (
    select x.id, x.channel_id, x.thread_root_id, x.author_kind, x.author_member_id, x.agent_for_member_id,
           x.agent_name, x.body, x.created_at,
           ts_rank(to_tsvector('english', x.body), tsq) as r
      from public.team_chat_message x
      join readable rc on rc.id = x.channel_id
     where x.workspace_id = ws
       and x.deleted_at is null
       and to_tsvector('english', x.body) @@ tsq
     order by r desc, x.created_at desc
     limit greatest(1, least(coalesce(lim, 8), 25))
  )
  select h.id,
         h.channel_id,
         h.thread_root_id,
         rc.kind,
         case
           when rc.kind = 'channel' then '#' || coalesce(rc.name, 'channel')
           when rc.dm_key = me::text then 'Note to self'
           else coalesce((
             select nullif(trim(om.display_name), '')
               from public.member om
              where om.workspace_id = ws
                and om.id <> me
                and om.id::text = any (string_to_array(rc.dm_key, ':'))
              limit 1
           ), 'Direct message')
         end,
         h.author_kind,
         h.author_member_id,
         h.agent_for_member_id,
         case
           when h.author_kind = 'agent' then coalesce(h.agent_name, 'Agent')
           else coalesce(nullif(trim(am.display_name), ''), 'A teammate')
         end,
         ts_headline('english', h.body, tsq, 'MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=1, StartSel="", StopSel=""'),
         h.created_at,
         h.r
    from hits h
    join readable rc on rc.id = h.channel_id
    left join public.member am on am.id = h.author_member_id
   order by h.r desc, h.created_at desc;
end;
$$;

revoke all on function public.team_chat_search(uuid, text, integer) from public, anon;
grant execute on function public.team_chat_search(uuid, text, integer) to authenticated;

notify pgrst, 'reload schema';
