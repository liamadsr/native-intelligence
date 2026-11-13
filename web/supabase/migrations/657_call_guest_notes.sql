-- ============================================================
-- 657: What a meeting guest may read of the call's notes while they are in
-- it (one recorder per call, phase 2). Everyone in a call sees its notes as
-- they fill in: members read the capture itself (its summary and
-- transcript, fenced to the conversation by 566). A guest has no account
-- and no database session, and the capture's summary is written by an
-- agent that also reads the workspace (its people, earlier meetings,
-- documents), so a guest is never shown it. A guest is shown only the
-- call's own words: the lines the call recorder heard, from when the guest
-- was first let into this call, each with the speaker's label as the call
-- shows it.
--
--   team_call_guest_notes(guest, token digest, max lines) → jsonb
--     { allowed, lines: [{ at, speaker, text }] }, newest max_lines at most
--     (500 at most), in the order they were said. allowed is true only
--     while the guest is let in (574's state 'admitted') to the meeting's
--     live call, by the link they came in on (its token's hash, as 574's
--     poll checks it), the meeting not revoked, notes on and the capture
--     still open. A guest who left, was removed or declined, a call that
--     ended, a capture closed by hand, another meeting's link: allowed
--     false and no lines. Nothing here outlives the call: once it ends the
--     guest reads nothing.
--
-- The service role's alone (the guest's route checks the guest's signed
-- cookie first, as every guest route does); a definer, search_path pinned.
-- Read only. Additive. Idempotent. Safe on a live database with the deployed
-- app running: one new function the deployed app never calls. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

create or replace function public.team_call_guest_notes(target_guest uuid, token_digest text, max_lines integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  g public.meeting_guest%rowtype;
  m public.meeting%rowtype;
  live public.team_call%rowtype;
  since timestamptz;
  out_lines jsonb;
begin
  select x.* into g
    from public.meeting_guest x
    join public.meeting y on y.id = x.meeting_id
   where x.id = target_guest and y.token_hash = token_digest;
  if not found or g.state <> 'admitted' or g.call_id is null then
    return jsonb_build_object('allowed', false, 'lines', '[]'::jsonb);
  end if;
  select * into m from public.meeting x where x.id = g.meeting_id;
  if m.revoked_at is not null then
    return jsonb_build_object('allowed', false, 'lines', '[]'::jsonb);
  end if;
  select * into live from public.team_call t
   where t.id = g.call_id and t.channel_id = g.channel_id and t.status = 'live';
  if not found or not live.notes or live.capture_id is null or public.capture_feed_capture_closed(live.capture_id) then
    return jsonb_build_object('allowed', false, 'lines', '[]'::jsonb);
  end if;

  -- From when they were first let into this call: nothing said before they were there.
  since := coalesce(g.first_joined_at, g.decided_at, g.requested_at);
  select coalesce(jsonb_agg(jsonb_build_object('at', l.said_at, 'speaker', l.label, 'text', l.text) order by l.said_at, l.key), '[]'::jsonb)
    into out_lines
    from (
      select s.said_at, s.key, coalesce(sp.label, 'Someone') as label, s.text
        from public.capture_feed_segment s
        left join public.capture_feed_speaker sp on sp.capture_id = s.capture_id and sp.speaker_key = s.speaker_key
       where s.capture_id = live.capture_id and s.said_at >= since
       order by s.said_at desc, s.key desc
       limit greatest(1, least(coalesce(max_lines, 200), 500))
    ) l;
  return jsonb_build_object('allowed', true, 'lines', out_lines);
end;
$$;

revoke all on function public.team_call_guest_notes(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.team_call_guest_notes(uuid, text, integer) to service_role;

notify pgrst, 'reload schema';

commit;
