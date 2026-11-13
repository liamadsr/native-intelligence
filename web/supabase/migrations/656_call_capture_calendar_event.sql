-- ============================================================
-- 656: A scheduled meeting's call capture, linked to the meeting's calendar
-- event (one recorder per call, phase 2). A person's own capture of a
-- meeting is linked to its calendar event (captures.calendar_event_id and
-- the columns beside it: the from-event and link-event routes), and that
-- link is what the meeting's prep, its title on the capture and the
-- calendar's own "captured" mark read. The call recorder's capture of a
-- meeting link's call had none. Now it gets the same link, from what the
-- database knows for certain, never guessed from a title or a time:
--
--   - the call is a meeting link's (meeting.channel_id is the call's
--     conversation), and the capture's owner is the meeting's host (588's
--     owner rule makes them so whenever the host is still a member);
--   - the event is one the meeting knows it is on (586): the event the link
--     made for itself, or the one the host made in the app's calendar with
--     the link attached ('person'); for a booked meeting (585), its
--     booking's confirmed event (554). Either way on a connected calendar
--     account that is still connected (calendar_account_id not null) and is
--     the owner's own;
--   - the owner has no other open capture of that event (226's one live
--     capture per person per event): theirs, made on their own device,
--     keeps it, and this capture is left unlinked.
--
-- What it writes: calendar_event_id, calendar_provider (the account's
-- provider), scheduled_start and scheduled_end, occurrence_start (the
-- meeting's start, as the from-event route derives it for any event),
-- organizer_email (the host's account: they made the event), and
-- metadata.linked_event_title (the meeting's title). Never over a link the
-- capture already has. One answer per call: 'linked', 'already' (it has
-- one), 'no_meeting', 'not_host', 'no_event', 'taken' (the owner's own
-- capture holds the event) or 'not_a_call'.
--
--   team_call_capture_link_event(capture)  the service role's alone; a
--     definer, search_path pinned. The app calls it when the recorder's
--     session starts (the capture is made then), behind its own switch.
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: one new function the deployed app never calls. No backslashes
-- anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

create or replace function public.team_call_capture_link_event(target_capture uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_call%rowtype;
  m public.meeting%rowtype;
  cap_owner uuid;
  cap_event text;
  cap_workspace uuid;
  host_user uuid;
  ev_id text;
  ev_account uuid;
  ev_start timestamptz;
  ev_end timestamptz;
  acct_provider text;
  acct_email text;
begin
  select t.* into c
    from public.team_call_capture tc
    join public.team_call t on t.id = tc.call_id
   where tc.capture_id = target_capture
   order by tc.created_at desc
   limit 1;
  if not found then
    return 'not_a_call';
  end if;
  select x.user_id, x.calendar_event_id, x.workspace_id into cap_owner, cap_event, cap_workspace
    from public.captures x where x.id = target_capture for update;
  if cap_workspace is null then
    return 'not_a_call';
  end if;
  if cap_event is not null then
    return 'already';
  end if;

  select * into m from public.meeting x where x.channel_id = c.channel_id;
  if not found then
    return 'no_meeting';
  end if;
  select p.user_id into host_user from public.member p where p.id = m.host_member_id and p.workspace_id = c.workspace_id;
  if host_user is null or cap_owner is distinct from host_user then
    return 'not_host';
  end if;

  if m.booking_id is not null then
    select b.calendar_event_id, b.calendar_account_id, b.starts_at, b.ends_at
      into ev_id, ev_account, ev_start, ev_end
      from public.meeting_booking b
     where b.id = m.booking_id and b.state = 'confirmed';
  elsif m.calendar_event_kind in ('meeting', 'person') then
    ev_id := m.calendar_event_id;
    ev_account := m.calendar_account_id;
    ev_start := m.starts_at;
    ev_end := m.ends_at;
  end if;
  if ev_id is null or ev_account is null or ev_start is null or ev_end is null then
    return 'no_event';
  end if;
  select a.provider, a.account_email into acct_provider, acct_email
    from public.connected_account a
   where a.id = ev_account and a.user_id = cap_owner and a.capability = 'calendar';
  if acct_provider is null then
    return 'no_event';
  end if;

  begin
    update public.captures x
       set calendar_event_id = ev_id,
           calendar_provider = acct_provider,
           scheduled_start = ev_start,
           scheduled_end = ev_end,
           occurrence_start = ev_start,
           organizer_email = coalesce(x.organizer_email, acct_email),
           metadata = coalesce(x.metadata, '{}'::jsonb) || jsonb_build_object('linked_event_title', m.title)
     where x.id = target_capture;
  exception when unique_violation then
    return 'taken';
  end;
  return 'linked';
end;
$$;

revoke all on function public.team_call_capture_link_event(uuid) from public, anon, authenticated;
grant execute on function public.team_call_capture_link_event(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
