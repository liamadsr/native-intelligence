-- ============================================================
-- 668: the call's notes say when they are not being written
-- ============================================================
-- With the call recorder on, a call's notes are its words as the recorder
-- hears them (587-588) and the live agent's summary of them (655). Until now
-- the people in the call read "Notes are on" whatever happened behind it:
-- Deepgram refusing the key, its sockets failing, or words that never came
-- back while people spoke. The recorder now says, with its heartbeat, whether
-- each session's notes are being written (recorder/src/health.ts), and the
-- sweeper says so of a session whose recorder went quiet; the members in the
-- call read it on the row they already follow over Realtime (655's
-- team_call_live_notes, read only by who may read the capture: never a
-- meeting guest).
--
--   team_call_live_notes.feed_state     null while the notes are written;
--                                       else why not: 'down' (the speech
--                                       service does not answer), 'refused'
--                                       (it refuses the key), 'no_credit',
--                                       'no_words' (people speak, no words
--                                       come back), 'lost' (the recorder
--                                       went quiet).
--   team_call_live_notes.feed_state_at  when it last changed.
--
--   capture_feed_health_stamp(producer, sessions[], states[]) → one row per
--     session it could stamp, and whether the row changed (the route logs
--     only a change). A producer stamps only its own sessions, and a failure
--     only while the session is live; 'ok' (or null) clears. With a null
--     producer (the sweeper, service role) any session. The row is made when
--     the first failure comes (its state 'idle': the live agent's own state
--     is untouched), and a stamp equal to what is there writes nothing, so
--     no Realtime message goes out for a heartbeat that says the same.
--
-- Two nullable columns (no rewrite), one function. Re-runnable. Service role
-- only, as the rest of 655's writes.

-- One transaction: all of it or none, and SET LOCAL's lock_timeout holds for every statement in it.
begin;

SET LOCAL lock_timeout = '5s';

alter table public.team_call_live_notes add column if not exists feed_state text null;
alter table public.team_call_live_notes add column if not exists feed_state_at timestamptz null;

alter table public.team_call_live_notes drop constraint if exists team_call_live_notes_feed_state;
alter table public.team_call_live_notes
  add constraint team_call_live_notes_feed_state check (feed_state is null or feed_state in ('down', 'refused', 'no_credit', 'no_words', 'lost')) not valid;
alter table public.team_call_live_notes validate constraint team_call_live_notes_feed_state;

comment on column public.team_call_live_notes.feed_state is
  'Why the call''s words are not being written now (668): down, refused, no_credit, no_words, lost; null while they are.';
comment on column public.team_call_live_notes.feed_state_at is
  'When feed_state last changed (668).';

create or replace function public.capture_feed_health_stamp(p_producer_id text, p_sessions uuid[], p_states text[])
returns table (o_session uuid, o_capture uuid, o_changed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i integer;
  st text;
  s record;
  n integer;
begin
  for i in 1 .. least(coalesce(array_length(p_sessions, 1), 0), 200) loop
    st := nullif(nullif(trim(coalesce(p_states[i], '')), ''), 'ok');
    if st is not null and st not in ('down', 'refused', 'no_credit', 'no_words', 'lost') then
      continue;
    end if;
    select f.id, f.capture_id, f.producer_id, f.status into s
      from public.capture_feed_session f
     where f.id = p_sessions[i];
    if not found then
      continue;
    end if;
    if p_producer_id is not null then
      if s.producer_id is distinct from p_producer_id then
        continue;
      end if;
      -- A failure is told only of a session still being fed; a clear always.
      if st is not null and s.status <> 'live' then
        continue;
      end if;
    end if;
    if st is null then
      update public.team_call_live_notes t
         set feed_state = null, feed_state_at = now(), updated_at = now()
       where t.capture_id = s.capture_id and t.feed_state is not null;
    else
      insert into public.team_call_live_notes as t (capture_id, workspace_id, summary, feed_state, feed_state_at, updated_at)
      select x.id, x.workspace_id, coalesce(x.ai_summary, ''), st, now(), now()
        from public.captures x
       where x.id = s.capture_id
      on conflict (capture_id) do update
         set feed_state = excluded.feed_state, feed_state_at = excluded.feed_state_at, updated_at = excluded.updated_at
       where t.feed_state is distinct from excluded.feed_state;
    end if;
    get diagnostics n = row_count;
    o_session := s.id;
    o_capture := s.capture_id;
    o_changed := n > 0;
    return next;
  end loop;
end;
$$;

revoke all on function public.capture_feed_health_stamp(text, uuid[], text[]) from public, anon, authenticated;
grant execute on function public.capture_feed_health_stamp(text, uuid[], text[]) to service_role;

notify pgrst, 'reload schema';

commit;
