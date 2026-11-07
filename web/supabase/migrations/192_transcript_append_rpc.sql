-- ====================================================================
-- 192: append_capture_transcript RPC (atomic, size-safe compare-and-swap)
-- ====================================================================
--
-- Why this exists
-- ---------------
-- The live-recording delta-append route did its compare-and-swap by predicating
-- the UPDATE on the FULL stored transcript text:
--     .update({ transcript: stored + append }).eq('transcript', stored)
-- supabase-js encodes that `.eq` filter into the PostgREST URL query string
-- (`transcript=eq.<the entire transcript>`). Once the transcript grows past the
-- proxy's URL/header limit (~20 KB hit it on a real 57-min call), the REQUEST
-- ITSELF becomes un-servable — every append 500s forever, regardless of delta
-- size. On prod this turned into a ~70-min silent outage (492 failed appends).
--
-- This function performs the exact same read-modify-write CAS, but INSIDE one
-- atomic SQL UPDATE. The comparison happens in Postgres (WHERE transcript IS NOT
-- DISTINCT FROM p_base) — the full text never travels in a URL — so it's immune
-- to transcript size. Semantics are preserved byte-for-byte:
--
--   * base-length mismatch (client's view diverged)  → status 'base_mismatch'
--   * capture ended / transcript locked              → status 'locked'
--   * CAS lost (a concurrent writer changed the text  → status 'conflict'
--     between the caller's read and this write)
--   * applied                                         → status 'applied'
--
--   Every non-'applied' status also returns server_length (the true current
--   length) so the caller re-syncs exactly as before. This is the product's most
--   data-loss-sensitive path, so the guard is UNCHANGED in behavior — only the
--   transport moved out of the URL.
--
-- The CAS predicate is the transcript VALUE (via IS NOT DISTINCT FROM, which
-- treats NULL = NULL as a match — the empty-transcript case the JS route handled
-- with `.is('transcript', null)`). Because the compare is server-side it stays
-- correct against the other two transcript writers (the full-text PATCH on stop
-- and the pagehide beacon): if either lands mid-flight, the stored text no longer
-- equals p_base and this UPDATE matches zero rows → 'conflict', never a clobber.
--
-- SECURITY INVOKER + explicit workspace scope: the WHERE clause pins
-- workspace_id, and RLS on `captures` still applies, so it's safe to expose to
-- authenticated users. The DB lock triggers (lock_transcript_on_end /
-- prevent_transcript_edit) remain the final backstop and will raise if a lock
-- lands in the write window; the caller maps that to the same terminal signal.
--
-- Idempotent: drop+recreate. Non-destructive to data.

drop function if exists public.append_capture_transcript(uuid, uuid, text, integer);

create function public.append_capture_transcript(
  p_capture_id uuid,
  p_workspace_id uuid,
  p_append text,
  p_base_length integer
)
returns table (status text, server_length integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_stored text;
  v_ended timestamptz;
  v_locked boolean;
  v_len integer;
  v_updated_id uuid;
begin
  -- Load current state (workspace-scoped). No row → caller maps to 404.
  select transcript, ended_at, is_transcript_locked
    into v_stored, v_ended, v_locked
  from captures
  where id = p_capture_id and workspace_id = p_workspace_id;

  if not found then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  -- Terminal: capture ended / transcript locked. No append can ever succeed.
  if v_ended is not null or v_locked then
    return query select 'locked'::text, coalesce(char_length(v_stored), 0);
    return;
  end if;

  v_len := coalesce(char_length(v_stored), 0);

  -- Base-length mismatch: the caller's view of the server transcript diverged.
  -- Refuse and hand back the true length so the caller falls back / re-seeds.
  if v_len <> p_base_length then
    return query select 'base_mismatch'::text, v_len;
    return;
  end if;

  -- Atomic compare-and-swap: apply the append ONLY if the stored transcript is
  -- STILL exactly what we just read. IS NOT DISTINCT FROM matches NULL=NULL too,
  -- covering the empty-transcript case. A racing full-text PATCH / beacon that
  -- landed in this window changes the value → zero rows updated → 'conflict'.
  update captures
  set transcript = coalesce(v_stored, '') || p_append
  where id = p_capture_id
    and workspace_id = p_workspace_id
    and transcript is not distinct from v_stored
  returning id into v_updated_id;

  if v_updated_id is null then
    -- CAS lost. Re-read the true length for the caller to re-sync against.
    select coalesce(char_length(transcript), 0) into v_len
    from captures
    where id = p_capture_id and workspace_id = p_workspace_id;
    return query select 'conflict'::text, v_len;
    return;
  end if;

  return query select 'applied'::text, v_len + char_length(p_append);
end;
$$;

grant execute on function public.append_capture_transcript(uuid, uuid, text, integer) to authenticated;
