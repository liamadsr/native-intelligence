-- ============================================================
-- 707: a workspace merge runs again on today's schema.
-- ============================================================
-- merge_workspace (402, revised in 408, 420, 520, 528) stopped on every
-- merge, and the tables added since would have stopped it next:
--
--   1. _wsmerge_members (528) re-pointed slack_user_link.member_id. 412's
--      table has no member_id: a Slack person is keyed by their user id, so
--      there is nothing to re-point. Error 42703 on every merge. The line is
--      gone.
--   2. Every workspace has the default company stages (679): the generic
--      re-stamp met company_stage_name_key on every merge. Stages now fold by
--      name in _wsmerge_companies: the source's companies take the
--      destination's stage of the same name, the source's other stages move
--      across after the destination's (in their own order), and the
--      duplicates go. A view filtering or grouping by a source stage names
--      the destination's. (No pipeline names a company stage: a pipeline's
--      stages are its Stage column's options, which _wsmerge_deals folds.)
--   3. Members who are in both workspaces folded while rows added since 528
--      still named them, so the merge's own check (_wsmerge_assert_no_refs)
--      refused: team chat, calls and meetings (474 to 572), the capture
--      feed, shares of conversations and mail threads, spreadsheets,
--      canvases and the drive, a company's owner and email switch. They
--      follow the member now; a person's place that the destination member
--      already has (a channel, a thread, a reaction, a call, a share) stays
--      the destination's.
--   4. Team chat: a direct message's key is its people's member ids, so it
--      is re-keyed with the members they fold into, and folds into the
--      destination's direct message between the same two people; a channel
--      named like a destination channel is suffixed with the source's name;
--      a folded team's channels and grants follow it.
--   5. Rows that fold with something since 528: a folded company's import
--      history, email consent and comments; a folded thread copy's shares
--      and private mark; a folded default project's website and canvases; a
--      folded pipeline's forms (they were deleted with it); a folded team's
--      states named in mail and kept-change undo records.
--   6. One per person or workspace, which the re-stamp met: a vocabulary
--      word, a day's auto-archive (joined, so its undo still works), a
--      private thread, a booking profile (the source's links move onto the
--      destination's, slugs suffixed where taken), a turned-off customer
--      booking page.
--   7. Spreadsheets (675) and drive folders (690) could not move at all:
--      their write triggers put workspace_id back. They take the merge's
--      exemption (section 5).
--   8. What the merge cannot settle itself is refused before anything moves
--      (P0008), naming it: a business phone number, a connected website, a
--      live website form key or a live customer booking page on both sides,
--      the same customer texting both, a customer booking at the same time,
--      a quote with the same outside id.
--
-- Restates, each from its newest definition on main, with only the changes
-- above:
--   _wsmerge_members           528_field_merge.sql
--   _wsmerge_companies         408_merge_workspaces_review_fixes.sql
--   _wsmerge_teams_finish      473_deals_pipelines_custom_fields.sql
--   _wsmerge_mail              408_merge_workspaces_review_fixes.sql
--   _wsmerge_default_projects  408_merge_workspaces_review_fixes.sql
--   _wsmerge_deals             549_retire_deals.sql
--   _wsmerge_generic_restamp   645_workspace_join.sql
--   spreadsheet_before_write   675_spreadsheets.sql (section 5)
--   drive_folder_before_write  690_drive_folders.sql (section 5)
-- New: _wsmerge_front_door_check, _wsmerge_team_chat,
-- _wsmerge_fold_chat_channel, _wsmerge_one_per_owner (internal: no grant to
-- anon or authenticated, like every _wsmerge_ function). merge_workspace,
-- the preflight, _wsmerge_labels (700 restates it), every policy and every
-- other guard are unchanged.
--
-- A failed merge before this changed nothing: merge_workspace is one
-- function call, so one transaction (the route's RPC, or the job runner's
-- own transaction, 417), and its error rolled every step back.
--
-- Has its own begin and commit. Idempotent (create or replace only).
-- No backslashes.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ── 1. What the merge cannot settle on its own: refused before anything moves ──
-- One live of each per workspace, owned by the business outside this
-- database (a phone number at the carrier, a site's repository, a key in a
-- site's form, a customer's booking page). The owner turns one side off
-- first. Raised from _wsmerge_members, the first step that moves rows; the
-- merge is one transaction, so nothing has changed when it refuses.
create or replace function public._wsmerge_front_door_check(p_source uuid, p_dest uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_hits text;
begin
  if exists (select 1 from public.business_phone_number s where s.workspace_id = p_source and s.state = 'active')
     and exists (select 1 from public.business_phone_number d where d.workspace_id = p_dest and d.state = 'active') then
    v_hits := concat_ws('; ', v_hits, 'both have a business phone number (release one)');
  end if;
  if exists (select 1 from public.website_site s where s.workspace_id = p_source and s.state <> 'disconnected')
     and exists (select 1 from public.website_site d where d.workspace_id = p_dest and d.state <> 'disconnected') then
    v_hits := concat_ws('; ', v_hits, 'both have a connected website (disconnect one)');
  end if;
  if exists (select 1 from public.quote_intake_key s where s.workspace_id = p_source and s.revoked_at is null)
     and exists (select 1 from public.quote_intake_key d where d.workspace_id = p_dest and d.revoked_at is null) then
    v_hits := concat_ws('; ', v_hits, 'both have a live website form key (revoke one)');
  end if;
  -- the source's job page, turned off, simply goes (_wsmerge_one_per_owner)
  if exists (select 1 from public.booking_link s where s.workspace_id = p_source and s.purpose = 'job' and s.active)
     and exists (select 1 from public.booking_link d where d.workspace_id = p_dest and d.purpose = 'job') then
    v_hits := concat_ws('; ', v_hits, 'both have a customer booking page (turn off the merged-in workspace''s)');
  end if;
  if exists (select 1 from public.agent_guest s join public.agent_guest d
               on d.workspace_id = p_dest and d.phone_e164 = s.phone_e164 and d.preset = 'customer' and d.state <> 'removed'
             where s.workspace_id = p_source and s.preset = 'customer' and s.state <> 'removed') then
    v_hits := concat_ws('; ', v_hits, 'the same customer is a texting guest in both');
  end if;
  if exists (select 1 from public.customer_booking s join public.customer_booking d
               on d.workspace_id = p_dest and d.starts_at = s.starts_at and d.state in ('requested', 'confirmed')
             where s.workspace_id = p_source and s.state in ('requested', 'confirmed')) then
    v_hits := concat_ws('; ', v_hits, 'both have a customer booking at the same time');
  end if;
  if exists (select 1 from public.customer_quote s join public.customer_quote d
               on d.workspace_id = p_dest and d.external_id = s.external_id
             where s.workspace_id = p_source and s.external_id is not null) then
    v_hits := concat_ws('; ', v_hits, 'both have a quote with the same outside id');
  end if;
  if v_hits is not null then
    raise exception 'the merge cannot combine these: %', v_hits using errcode = 'P0008';
  end if;
end;
$$;

revoke execute on function public._wsmerge_front_door_check(uuid, uuid) from public, anon, authenticated;

-- ── 2. Team chat (474, 572): direct messages and channel names ─────────────
-- Called from _wsmerge_members before any member row folds or moves.
--   * A channel of a folded team belongs to the team it folds into.
--   * A direct message's key is its people's sorted member ids. Its key is
--     re-written with the members it folds into; when the destination already
--     has a direct message between the same people, the source's folds into
--     it (its messages, threads, calls and shares move; a person's place in
--     it keeps the later read mark), so the pair keeps one conversation.
--   * A channel named like a live destination channel keeps its own,
--     suffixed with the source workspace's name.
create or replace function public._wsmerge_fold_chat_channel(p_src uuid, p_dst uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r record;
begin
  -- one place per person (key channel, member): the later read mark stays
  update public.team_chat_member d
     set last_read_at = greatest(d.last_read_at, s.last_read_at)
    from public.team_chat_member s
   where s.channel_id = p_src and d.channel_id = p_dst and d.member_id = s.member_id;
  update public.team_chat_member s set channel_id = p_dst
   where s.channel_id = p_src
     and not exists (select 1 from public.team_chat_member d where d.channel_id = p_dst and d.member_id = s.member_id);
  delete from public.team_chat_member where channel_id = p_src;

  -- one agent thread per person (key channel, user)
  update public.team_chat_agent_thread s set channel_id = p_dst
   where s.channel_id = p_src
     and not exists (select 1 from public.team_chat_agent_thread d where d.channel_id = p_dst and d.user_id = s.user_id);
  delete from public.team_chat_agent_thread where channel_id = p_src;

  -- everything else that names the channel follows it
  for r in
    select cl.relname as child, a.attname as col
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = 'public.team_chat_channel'::regclass
       and array_length(c.conkey, 1) = 1 and ns.nspname = 'public'
       and cl.relname not in ('team_chat_member', 'team_chat_agent_thread')
     order by cl.relname, a.attname
  loop
    execute format('update public.%I set %I = $1 where %I = $2', r.child, r.col, r.col) using p_dst, p_src;
  end loop;

  update public.team_chat_channel d
     set last_message_at = greatest(d.last_message_at, s.last_message_at)
    from public.team_chat_channel s
   where d.id = p_dst and s.id = p_src;

  perform public._wsmerge_assert_no_refs('team_chat_channel', array[p_src], '{}');
  delete from public.team_chat_channel where id = p_src;
end;
$$;

revoke execute on function public._wsmerge_fold_chat_channel(uuid, uuid) from public, anon, authenticated;

create or replace function public._wsmerge_team_chat(p_source uuid, p_dest uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record; v_key text; v_dst uuid; v_name text; v_suffix text;
  v_src_name text := (select name from public.workspace where id = p_source);
  v_dms_folded int := 0; v_dms_rekeyed int := 0; v_renamed int := 0; v_refiled int := 0;
begin
  update public.team_chat_channel c set team_id = t.dst
    from pg_temp._wsmerge_teams t
   where c.team_id = t.src and t.mode = 'fold' and t.dst <> t.src;
  get diagnostics v_refiled = row_count;

  for r in
    select c.id, c.dm_key,
           (select array_agg(coalesce(m.dst::text, k) order by coalesce(m.dst::text, k))
              from unnest(string_to_array(c.dm_key, ':')) k
              left join pg_temp._wsmerge_members m on m.src::text = k) as ids
      from public.team_chat_channel c
     where c.workspace_id = p_source and c.kind = 'dm'
  loop
    -- 474's key: one id for a note to self, else the two ids, lower first
    v_key := case when cardinality(r.ids) = 1 or r.ids[1] = r.ids[2] then r.ids[1]
                  when r.ids[1] < r.ids[2] then r.ids[1] || ':' || r.ids[2]
                  else r.ids[2] || ':' || r.ids[1] end;
    select d.id into v_dst from public.team_chat_channel d
     where d.workspace_id = p_dest and d.kind = 'dm' and d.dm_key = v_key;
    if v_dst is not null then
      perform public._wsmerge_fold_chat_channel(r.id, v_dst);
      v_dms_folded := v_dms_folded + 1;
    elsif v_key is distinct from r.dm_key then
      update public.team_chat_channel set dm_key = v_key where id = r.id;
      v_dms_rekeyed := v_dms_rekeyed + 1;
    end if;
  end loop;

  v_suffix := ' (' || left(btrim(v_src_name), 40) || ')';
  for r in
    select s.id, s.name from public.team_chat_channel s
     where s.workspace_id = p_source and s.kind = 'channel' and s.archived_at is null
       and exists (select 1 from public.team_chat_channel d
                    where d.workspace_id = p_dest and d.kind = 'channel' and d.archived_at is null
                      and lower(d.name) = lower(s.name))
  loop
    v_name := left(r.name, 80 - char_length(v_suffix)) || v_suffix;
    if exists (select 1 from public.team_chat_channel d
                where d.workspace_id in (p_source, p_dest) and d.kind = 'channel' and d.archived_at is null
                  and lower(d.name) = lower(v_name)) then
      v_name := left(r.name, 80 - char_length(v_suffix) - 7) || v_suffix || ' ' || left(replace(r.id::text, '-', ''), 6);
    end if;
    update public.team_chat_channel set name = v_name where id = r.id;
    v_renamed := v_renamed + 1;
  end loop;

  return jsonb_build_object('chat_dms_folded', v_dms_folded, 'chat_dms_rekeyed', v_dms_rekeyed,
                            'chat_channels_renamed', v_renamed, 'chat_channels_refiled', v_refiled);
end;
$$;

revoke execute on function public._wsmerge_team_chat(uuid, uuid) from public, anon, authenticated;

-- ── 3. One-per-person and one-per-workspace rows since 417 ─────────────────
-- Called by _wsmerge_generic_restamp just before its loop, which would stop
-- on each of these.
create or replace function public._wsmerge_one_per_owner(p_source uuid, p_dest uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record; v_dst uuid; v_slug text; n int;
  v_terms int := 0; v_archives int := 0; v_private int := 0; v_profiles int := 0; v_links_reslugged int := 0; v_job int := 0;
begin
  -- a person's word in both vocabularies (430): the destination's stands
  delete from public.vocabulary_term s
   where s.workspace_id = p_source
     and exists (select 1 from public.vocabulary_term d
                  where d.workspace_id = p_dest
                    and coalesce(d.user_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(s.user_id, '00000000-0000-0000-0000-000000000000'::uuid)
                    and lower(btrim(d.term)) = lower(btrim(s.term)));
  get diagnostics v_terms = row_count;

  -- a person's auto-archive of one day in both (446): one record, both days'
  -- threads in it, so an undo still restores them all
  update public.email_auto_archive d
     set thread_ids = (select coalesce(array_agg(distinct e), '{}') from unnest(coalesce(d.thread_ids, '{}') || coalesce(s.thread_ids, '{}')) e),
         archived_ids = (select coalesce(array_agg(distinct e), '{}') from unnest(coalesce(d.archived_ids, '{}') || coalesce(s.archived_ids, '{}')) e),
         senders = (select coalesce(array_agg(distinct e), '{}') from unnest(coalesce(d.senders, '{}') || coalesce(s.senders, '{}')) e),
         cutoff_at = greatest(d.cutoff_at, s.cutoff_at),
         updated_at = now()
    from public.email_auto_archive s
   where s.workspace_id = p_source and d.workspace_id = p_dest
     and d.user_id = s.user_id and d.local_date = s.local_date;
  delete from public.email_auto_archive s
   where s.workspace_id = p_source
     and exists (select 1 from public.email_auto_archive d
                  where d.workspace_id = p_dest and d.user_id = s.user_id and d.local_date = s.local_date);
  get diagnostics v_archives = row_count;

  -- a thread its owner made private in both (680): it stays private
  delete from public.email_thread_team_private s
   where s.workspace_id = p_source
     and exists (select 1 from public.email_thread_team_private d
                  where d.workspace_id = p_dest and d.owner_user_id = s.owner_user_id
                    and d.provider_thread_id = s.provider_thread_id);
  get diagnostics v_private = row_count;

  -- booking pages (581): one profile per person, and one for the workspace.
  -- The destination's stands; the source's links move onto it (a slug the
  -- destination's profile already has gets a suffix), and the source's
  -- profile goes.
  for r in
    select s.id as src, d.id as dst
      from public.booking_profile s
      join public.booking_profile d
        on d.workspace_id = p_dest and d.user_id is not distinct from s.user_id
     where s.workspace_id = p_source
  loop
    for v_slug in select l.slug from public.booking_link l where l.profile_id = r.src loop
      if exists (select 1 from public.booking_link x where x.profile_id = r.dst and x.slug = v_slug) then
        n := 2;
        while exists (select 1 from public.booking_link x
                       where x.profile_id in (r.src, r.dst) and x.slug = left(v_slug, 45) || '-' || n) loop
          n := n + 1;
        end loop;
        update public.booking_link set slug = left(v_slug, 45) || '-' || n where profile_id = r.src and slug = v_slug;
        v_links_reslugged := v_links_reslugged + 1;
      end if;
    end loop;
    update public.booking_link set profile_id = r.dst where profile_id = r.src;
    delete from public.booking_profile where id = r.src;
    v_profiles := v_profiles + 1;
  end loop;

  -- the source's customer booking page, turned off (a live one on both sides
  -- is refused by _wsmerge_front_door_check): its bookings stay, unlinked
  delete from public.booking_link s
   where s.workspace_id = p_source and s.purpose = 'job'
     and exists (select 1 from public.booking_link d where d.workspace_id = p_dest and d.purpose = 'job');
  get diagnostics v_job = row_count;

  return jsonb_build_object('vocabulary_dropped', v_terms, 'auto_archive_days_joined', v_archives,
                            'private_threads_dropped', v_private, 'booking_profiles_folded', v_profiles,
                            'booking_links_reslugged', v_links_reslugged, 'job_booking_pages_dropped', v_job);
end;
$$;

revoke execute on function public._wsmerge_one_per_owner(uuid, uuid) from public, anon, authenticated;

-- ── 4. The restated steps ───────────────────────────────────────────────────

-- _wsmerge_members (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_members(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chat jsonb;
  v_folded int := 0; v_moved int := 0; v_invites_moved int := 0; v_invites_dropped int := 0;
BEGIN
  -- Before anything moves: a source field that shares a key with a
  -- destination field of another type keeps its own, suffixed key (528).
  PERFORM public._wsmerge_custom_fields_begin(p_source, p_dest);

  -- What the merge cannot settle (707): refused before anything moves.
  PERFORM public._wsmerge_front_door_check(p_source, p_dest);
  -- Team chat (707): direct messages re-keyed or folded, channel names kept
  -- apart, while every member row is still where it was.
  v_chat := public._wsmerge_team_chat(p_source, p_dest);

  UPDATE public.member d
  SET role = CASE WHEN d.role = 'owner' THEN 'owner'
                  WHEN s.role = 'owner' THEN 'admin'
                  WHEN public._wsmerge_role_rank(s.role) > public._wsmerge_role_rank(d.role) THEN s.role
                  ELSE d.role END,
      avatar_url = COALESCE(d.avatar_url, s.avatar_url),
      time_zone = COALESCE(d.time_zone, s.time_zone),
      onboarding_completed_at = COALESCE(d.onboarding_completed_at, s.onboarding_completed_at)
  FROM pg_temp._wsmerge_members x
  JOIN public.member s ON s.id = x.src
  WHERE d.id = x.dst;

  -- plain pointers
  UPDATE public.actions t SET assignee_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.assignee_id = x.src;
  UPDATE public.campaign t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.capture_participant t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.claim t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.claim t SET subject_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.subject_member_id = x.src;
  UPDATE public.comment t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.contact t SET created_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by_member_id = x.src;
  UPDATE public.contact t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  IF to_regclass('public.deal') IS NOT NULL THEN
    EXECUTE 'UPDATE public.deal t SET owner_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_id = x.src';
  END IF;
  UPDATE public.decision t SET decided_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.decided_by = x.src;
  UPDATE public.document t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.document t SET last_edited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.last_edited_by = x.src;
  UPDATE public.document_revision t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.document_section_check t SET verified_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.verified_by = x.src;
  UPDATE public.entity_link t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.initiative t SET owner_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_id = x.src;
  UPDATE public.invite t SET invited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.invited_by = x.src;
  UPDATE public.lens_finding t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.notification t SET actor_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.actor_id = x.src;
  UPDATE public.notification t SET recipient_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.recipient_id = x.src;
  UPDATE public.projects t SET lead_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.lead_id = x.src;
  UPDATE public.proposed_change t SET applied_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.applied_by = x.src;
  UPDATE public.proposed_change t SET assignee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.assignee_member_id = x.src;
  UPDATE public.share t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.tool_approval t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.tracked_job t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.attention_item t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.contact_share t SET shared_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.shared_by_member_id = x.src;
  -- (707: slack_user_link is keyed by the person's user id (412), not a
  -- member: nothing to re-point. 528's line here named a member_id it never
  -- had, and stopped every merge.)
  -- Tables (520) and grants (492): one person's member row in each
  -- workspace, so a grant or an ownership never needs a duplicate dropped.
  UPDATE public.data_table t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.entity_access t SET grantee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.grantee_member_id = x.src;
  UPDATE public.entity_access t SET granted_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.granted_by = x.src;

  -- Since 528 (707): team chat and calls (474, 564, 566), meetings (572),
  -- the capture feed (587), shares (646, 673, 678), spreadsheets, canvases
  -- and the drive (674 to 690), a company's email switch (680).
  UPDATE public.team_chat_channel t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.team_chat_message t SET author_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_member_id = x.src;
  UPDATE public.team_chat_message t SET agent_for_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.agent_for_member_id = x.src;
  UPDATE public.team_call t SET started_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.started_by = x.src;
  UPDATE public.team_call t SET recording_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.recording_by = x.src;
  UPDATE public.team_call t SET notes_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.notes_by = x.src;
  UPDATE public.team_call_ring t SET caller_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.caller_member_id = x.src;
  UPDATE public.team_call_egress t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.meeting t SET host_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.host_member_id = x.src;
  UPDATE public.meeting t SET revoked_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.revoked_by = x.src;
  UPDATE public.meeting_guest t SET decided_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.decided_by = x.src;
  UPDATE public.capture_feed_speaker t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.email_share t SET shared_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.shared_by_member_id = x.src;
  UPDATE public.spreadsheet t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.spreadsheet t SET last_edited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.last_edited_by = x.src;
  UPDATE public.spreadsheet_revision t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.spreadsheet_comment t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.spreadsheet_comment t SET resolved_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.resolved_by = x.src;
  UPDATE public.canvas t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.canvas_comment t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.canvas_comment t SET resolved_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.resolved_by = x.src;
  UPDATE public.drive_folder t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.drive_folder_item t SET added_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.added_by = x.src;
  UPDATE public.company t SET share_email_changed_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.share_email_changed_by_member_id = x.src;
  -- A company's owner (679) must be a member of the company's own workspace
  -- (company_crm_fields_guard): the source's companies are still in the
  -- source here, so the owner is set aside and given back by
  -- _wsmerge_companies once they have moved.
  DROP TABLE IF EXISTS pg_temp._wsmerge_company_owner;
  CREATE TABLE pg_temp._wsmerge_company_owner (company_id uuid PRIMARY KEY, member_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_company_owner
  SELECT c.id, x.dst FROM public.company c JOIN pg_temp._wsmerge_members x ON x.src = c.owner_member_id;
  UPDATE public.company c SET owner_member_id = NULL FROM pg_temp._wsmerge_company_owner o WHERE c.id = o.company_id;

  -- junctions unique on the member: translate where free, drop the duplicate
  UPDATE public.team_member t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_member y WHERE y.team_id = t.team_id AND y.member_id = x.dst);
  DELETE FROM public.team_member t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.action_assignee t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.action_assignee y WHERE y.action_id = t.action_id AND y.member_id = x.dst);
  DELETE FROM public.action_assignee t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.contact_share t SET shared_with_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.shared_with_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.contact_share y WHERE y.contact_id = t.contact_id AND y.shared_with_member_id = x.dst);
  DELETE FROM public.contact_share t USING pg_temp._wsmerge_members x WHERE t.shared_with_member_id = x.src;

  UPDATE public.knowledge_package_share t SET shared_with_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.shared_with_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.knowledge_package_share y WHERE y.package_id = t.package_id AND y.shared_with_member_id = x.dst);
  DELETE FROM public.knowledge_package_share t USING pg_temp._wsmerge_members x WHERE t.shared_with_member_id = x.src;

  UPDATE public.document_draft t SET author_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.author_id = x.src AND NOT EXISTS (SELECT 1 FROM public.document_draft y WHERE y.document_id = t.document_id AND y.author_id = x.dst);
  DELETE FROM public.document_draft t USING pg_temp._wsmerge_members x WHERE t.author_id = x.src;

  -- Since 528 (707): a person's place in a channel, a thread, a reaction, a
  -- call, a share. Where the destination member already has the same one,
  -- theirs stays (in a channel or a thread, with the later read mark).
  UPDATE public.team_chat_member d SET last_read_at = greatest(d.last_read_at, s.last_read_at)
  FROM public.team_chat_member s JOIN pg_temp._wsmerge_members x ON x.src = s.member_id
  WHERE d.channel_id = s.channel_id AND d.member_id = x.dst;
  UPDATE public.team_chat_member t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_chat_member y WHERE y.channel_id = t.channel_id AND y.member_id = x.dst);
  DELETE FROM public.team_chat_member t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.team_chat_thread_member d SET last_read_at = greatest(d.last_read_at, s.last_read_at)
  FROM public.team_chat_thread_member s JOIN pg_temp._wsmerge_members x ON x.src = s.member_id
  WHERE d.root_id = s.root_id AND d.member_id = x.dst;
  UPDATE public.team_chat_thread_member t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_chat_thread_member y WHERE y.root_id = t.root_id AND y.member_id = x.dst);
  DELETE FROM public.team_chat_thread_member t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.team_chat_reaction t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_chat_reaction y WHERE y.message_id = t.message_id AND y.member_id = x.dst AND y.emoji = t.emoji);
  DELETE FROM public.team_chat_reaction t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.team_call_participant t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_call_participant y WHERE y.call_id = t.call_id AND y.member_id = x.dst);
  DELETE FROM public.team_call_participant t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.team_call_ring t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT (t.state IN ('ringing', 'busy') AND EXISTS (
    SELECT 1 FROM public.team_call_ring y WHERE y.call_id = t.call_id AND y.member_id = x.dst AND y.state IN ('ringing', 'busy')));
  DELETE FROM public.team_call_ring t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.conversation_share t SET grantee_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.grantee_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.conversation_share y WHERE y.conversation_id = t.conversation_id AND y.grantee_member_id = x.dst);
  DELETE FROM public.conversation_share t USING pg_temp._wsmerge_members x WHERE t.grantee_member_id = x.src;

  UPDATE public.email_thread_share t SET grantee_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.grantee_member_id = x.src AND NOT (t.revoked_at IS NULL AND EXISTS (
    SELECT 1 FROM public.email_thread_share y WHERE y.owner_user_id = t.owner_user_id AND y.provider_thread_id = t.provider_thread_id
      AND y.grantee_member_id = x.dst AND y.revoked_at IS NULL));
  DELETE FROM public.email_thread_share t USING pg_temp._wsmerge_members x WHERE t.grantee_member_id = x.src;

  -- nothing may still point at a folded row (408)
  PERFORM public._wsmerge_assert_no_refs('member', (SELECT array_agg(src) FROM pg_temp._wsmerge_members), '{}');

  -- the folded rows go: nothing of theirs is left for the departure triggers
  DELETE FROM public.member m USING pg_temp._wsmerge_members x WHERE m.id = x.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  UPDATE public.member
  SET workspace_id = p_dest, role = CASE WHEN role = 'owner' THEN 'admin' ELSE role END
  WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.invite i
  WHERE i.workspace_id = p_source AND (
    i.accepted_at IS NOT NULL OR i.expires_at <= now()
    OR EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
               WHERE dm.workspace_id = p_dest AND lower(u.email) = lower(i.email))
    OR EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_dest AND di.accepted_at IS NULL
               AND di.expires_at > now() AND lower(di.email) = lower(i.email)));
  GET DIAGNOSTICS v_invites_dropped = ROW_COUNT;
  UPDATE public.invite SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_invites_moved = ROW_COUNT;

  RETURN jsonb_build_object('members_folded', v_folded, 'members_moved', v_moved,
                            'invites_moved', v_invites_moved, 'invites_dropped', v_invites_dropped) || v_chat;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_members(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_companies (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_companies(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_folded int := 0; v_moved int := 0; v_demoted int := 0;
        v_stages_folded int := 0; v_stages_moved int := 0; v_base int;
BEGIN
  -- Company stages (679, 707). Every workspace is given Lead, Demo, Customer
  -- and Churned, so two of them always share names: a source stage folds
  -- into the destination's stage of the same name (case and spaces aside),
  -- any other one moves across after the destination's, in its own order.
  -- The map joins the merge's id map, so a saved view that filters or groups
  -- by a source stage names the destination's (_wsmerge_views).
  DROP TABLE IF EXISTS pg_temp._wsmerge_company_stages;
  CREATE TABLE pg_temp._wsmerge_company_stages (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_company_stages
  SELECT s.id, d.id FROM public.company_stage s
  JOIN public.company_stage d ON d.workspace_id = p_dest AND lower(btrim(d.name)) = lower(btrim(s.name))
  WHERE s.workspace_id = p_source;
  INSERT INTO pg_temp._wsmerge_ids SELECT src, dst FROM pg_temp._wsmerge_company_stages;

  -- A company's stage must be one of its own workspace's (company_crm_fields_guard):
  -- set aside here, given back below once the companies are in the destination.
  DROP TABLE IF EXISTS pg_temp._wsmerge_company_stage_of;
  CREATE TABLE pg_temp._wsmerge_company_stage_of (company_id uuid PRIMARY KEY, stage_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_company_stage_of
  SELECT c.id, m.dst FROM public.company c JOIN pg_temp._wsmerge_company_stages m ON m.src = c.stage_id
  WHERE c.workspace_id = p_source;
  UPDATE public.company c SET stage_id = NULL FROM pg_temp._wsmerge_company_stage_of o WHERE c.id = o.company_id;

  SELECT COALESCE(max(position), -1) + 1 INTO v_base FROM public.company_stage WHERE workspace_id = p_dest;
  UPDATE public.company_stage s SET workspace_id = p_dest, position = v_base + x.rn - 1, updated_at = now()
  FROM (SELECT id, row_number() OVER (ORDER BY position, created_at, id) AS rn
          FROM public.company_stage
         WHERE workspace_id = p_source AND id NOT IN (SELECT src FROM pg_temp._wsmerge_company_stages)) x
  WHERE s.id = x.id;
  GET DIAGNOSTICS v_stages_moved = ROW_COUNT;

  FOR r IN SELECT * FROM pg_temp._wsmerge_companies LOOP
    UPDATE public.contact SET company_id = r.dst WHERE company_id = r.src;
    IF to_regclass('public.deal') IS NOT NULL THEN
      EXECUTE 'UPDATE public.deal SET company_id = $2 WHERE company_id = $1' USING r.src, r.dst;
    END IF;
    UPDATE public.prospect_list SET source_company_id = r.dst WHERE source_company_id = r.src;
    UPDATE public.prospect_list_entry SET company_id = r.dst WHERE company_id = r.src;
    -- since 528 (707): import history (588), a person's consent to share mail
    -- with the company (680, one live per person), comments on it (679)
    UPDATE public.contact_import_item SET company_id = r.dst WHERE company_id = r.src;
    UPDATE public.contact_import_item SET created_company_id = r.dst WHERE created_company_id = r.src;
    DELETE FROM public.company_email_consent s
    WHERE s.company_id = r.src AND s.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM public.company_email_consent d WHERE d.company_id = r.dst AND d.user_id = s.user_id AND d.revoked_at IS NULL);
    UPDATE public.company_email_consent SET company_id = r.dst, workspace_id = p_dest WHERE company_id = r.src;
    UPDATE public.comment SET commentable_id = r.dst WHERE commentable_type::text = 'company' AND commentable_id = r.src;
    PERFORM public._wsmerge_repoint_entity('company', r.src, r.dst);

    UPDATE public.company d
    SET website = COALESCE(d.website, s.website),
        industry = COALESCE(d.industry, s.industry),
        description = COALESCE(d.description, s.description),
        logo_url = COALESCE(d.logo_url, s.logo_url),
        employee_count_range = COALESCE(d.employee_count_range, s.employee_count_range),
        annual_revenue_range = COALESCE(d.annual_revenue_range, s.annual_revenue_range),
        address = COALESCE(d.address, s.address), city = COALESCE(d.city, s.city),
        state = COALESCE(d.state, s.state), country = COALESCE(d.country, s.country),
        phone = COALESCE(d.phone, s.phone), contact_email = COALESCE(d.contact_email, s.contact_email),
        tags = (SELECT array_agg(DISTINCT e) FROM unnest(COALESCE(d.tags, '{}'::text[]) || COALESCE(s.tags, '{}'::text[])) e),
        metadata = COALESCE(s.metadata, '{}'::jsonb) || COALESCE(d.metadata, '{}'::jsonb),
        prospect_list_ids = (SELECT COALESCE(array_agg(DISTINCT e), '{}'::uuid[]) FROM unnest(COALESCE(d.prospect_list_ids, '{}'::uuid[]) || COALESCE(s.prospect_list_ids, '{}'::uuid[])) e),
        enrichment_status = COALESCE(d.enrichment_status, s.enrichment_status),
        enriched_at = GREATEST(d.enriched_at, s.enriched_at),
        -- 679: the destination's stage, owner and revenue stand; where it has none, the source's
        stage_id = COALESCE(d.stage_id, (SELECT o.stage_id FROM pg_temp._wsmerge_company_stage_of o WHERE o.company_id = s.id)),
        owner_member_id = COALESCE(d.owner_member_id, (SELECT o.member_id FROM pg_temp._wsmerge_company_owner o WHERE o.company_id = s.id),
                                   (SELECT m.id FROM public.member m WHERE m.id = s.owner_member_id AND m.workspace_id = p_dest)),
        revenue = COALESCE(d.revenue, s.revenue),
        updated_at = now()
    FROM public.company s
    WHERE d.id = r.dst AND s.id = r.src;

    PERFORM public._wsmerge_assert_no_refs('company', ARRAY[r.src], '{}');
    DELETE FROM public.company WHERE id = r.src;
    v_folded := v_folded + 1;
  END LOOP;

  UPDATE public.company s SET is_workspace_company = false
  WHERE s.workspace_id = p_source AND s.is_workspace_company
    AND EXISTS (SELECT 1 FROM public.company d WHERE d.workspace_id = p_dest AND d.is_workspace_company);
  GET DIAGNOSTICS v_demoted = ROW_COUNT;

  UPDATE public.company SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- 707: stages and owners set aside above, now that the companies are here
  UPDATE public.company c SET stage_id = o.stage_id
  FROM pg_temp._wsmerge_company_stage_of o WHERE c.id = o.company_id AND c.stage_id IS NULL;
  UPDATE public.company c SET owner_member_id = o.member_id
  FROM pg_temp._wsmerge_company_owner o WHERE c.id = o.company_id AND c.owner_member_id IS NULL;
  PERFORM public._wsmerge_assert_no_refs('company_stage', (SELECT array_agg(src) FROM pg_temp._wsmerge_company_stages), '{}');
  DELETE FROM public.company_stage s USING pg_temp._wsmerge_company_stages m WHERE s.id = m.src;
  GET DIAGNOSTICS v_stages_folded = ROW_COUNT;

  RETURN jsonb_build_object('companies_folded', v_folded, 'companies_moved', v_moved, 'workspace_company_demoted', v_demoted,
                            'company_stages_folded', v_stages_folded, 'company_stages_moved', v_stages_moved);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_companies(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_teams_finish (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_teams_finish(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE tm record; v_base int; v_cycles int := 0; v_cycles_demoted int := 0; v_deleted int := 0; n int;
BEGIN
  -- since 528 (707): what a mail's or a kept change's undo restores (450,
  -- 539) names the state its folded team's state maps to, before those
  -- states go with their team
  UPDATE public.action_mail_done t SET done_status_id = s.dst FROM pg_temp._wsmerge_states s WHERE t.done_status_id = s.src AND s.dst IS NOT NULL;
  UPDATE public.action_mail_done t SET prior_status_id = s.dst FROM pg_temp._wsmerge_states s WHERE t.prior_status_id = s.src AND s.dst IS NOT NULL;
  UPDATE public.kept_change t SET done_status_id = s.dst FROM pg_temp._wsmerge_states s WHERE t.done_status_id = s.src AND s.dst IS NOT NULL;
  UPDATE public.kept_change t SET prior_status_id = s.dst FROM pg_temp._wsmerge_states s WHERE t.prior_status_id = s.src AND s.dst IS NOT NULL;

  FOR tm IN SELECT * FROM pg_temp._wsmerge_teams WHERE mode = 'fold' ORDER BY ord LOOP
    SELECT COALESCE(max(number), 0) INTO v_base FROM public.cycle WHERE team_id = tm.dst;

    UPDATE public.cycle c
    SET team_id = tm.dst,
        number = v_base + x.rn,
        status = CASE WHEN c.status = 'active' AND EXISTS (SELECT 1 FROM public.cycle d WHERE d.team_id = tm.dst AND d.status = 'active')
                      THEN 'upcoming'::public.cycle_status ELSE c.status END
    FROM (SELECT id, row_number() OVER (ORDER BY number, created_at, id) AS rn FROM public.cycle WHERE team_id = tm.src) x
    WHERE c.id = x.id;
    GET DIAGNOSTICS n = ROW_COUNT; v_cycles := v_cycles + n;

    UPDATE public.team_member t SET team_id = tm.dst
    WHERE t.team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.team_member d WHERE d.team_id = tm.dst AND d.member_id = t.member_id);
    DELETE FROM public.team_member WHERE team_id = tm.src;

    UPDATE public.contact_share s SET shared_with_team_id = tm.dst
    WHERE s.shared_with_team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.contact_share d WHERE d.contact_id = s.contact_id AND d.shared_with_team_id = tm.dst);
    DELETE FROM public.contact_share WHERE shared_with_team_id = tm.src;

    UPDATE public.knowledge_package_share s SET shared_with_team_id = tm.dst
    WHERE s.shared_with_team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.knowledge_package_share d WHERE d.package_id = s.package_id AND d.shared_with_team_id = tm.dst);
    DELETE FROM public.knowledge_package_share WHERE shared_with_team_id = tm.src;

    IF to_regclass('public.deal') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'deal' AND column_name = 'team_id') THEN
      EXECUTE 'UPDATE public.deal d
               SET team_id = $2,
                   status_id = COALESCE((SELECT s.dst FROM pg_temp._wsmerge_states s WHERE s.src = d.status_id), d.status_id)
               WHERE d.team_id = $1' USING tm.src, tm.dst;
    END IF;

    -- projects scoped to the folded team follow it (408): migration 018 added projects.team_id
    -- (ON DELETE SET NULL) and 019 dropped it again, so this runs only on a database that still has it
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'team_id') THEN
      EXECUTE 'UPDATE public.projects SET team_id = $2 WHERE team_id = $1' USING tm.src, tm.dst;
    END IF;

    -- since 528 (707): grants to the team (492). A grant the destination team
    -- already holds on the same record stays the destination's.
    UPDATE public.entity_access s SET grantee_team_id = tm.dst
    WHERE s.grantee_team_id = tm.src AND NOT EXISTS (
      SELECT 1 FROM public.entity_access d WHERE d.entity_type = s.entity_type AND d.entity_id = s.entity_id AND d.grantee_team_id = tm.dst);
    DELETE FROM public.entity_access WHERE grantee_team_id = tm.src;

    PERFORM public._wsmerge_assert_no_refs('team', ARRAY[tm.src], ARRAY['workflow_state']);
    DELETE FROM public.team WHERE id = tm.src;
    v_deleted := v_deleted + 1;
  END LOOP;

  RETURN jsonb_build_object('folded_teams_deleted', v_deleted, 'cycles_refiled', v_cycles);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_teams_finish(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_mail (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_mail(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_accounts uuid[]; a uuid; v_rehomed int := 0; v_links_deduped int := 0; v_links_moved int := 0;
        v_copies_folded int := 0; v_copies_moved int := 0; v_reviews_dropped int := 0;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x.account_id), '{}'::uuid[]) INTO v_accounts
  FROM (SELECT j.account_id FROM public.connected_account_workspace j WHERE j.workspace_id = p_source
        UNION SELECT c.id FROM public.connected_account c WHERE c.workspace_id = p_source) x;

  UPDATE public.connected_account SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_rehomed = ROW_COUNT;

  DELETE FROM public.connected_account_workspace s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.connected_account_workspace d WHERE d.workspace_id = p_dest AND d.account_id = s.account_id);
  GET DIAGNOSTICS v_links_deduped = ROW_COUNT;
  UPDATE public.connected_account_workspace SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_links_moved = ROW_COUNT;

  DROP TABLE IF EXISTS pg_temp._wsmerge_threads;
  CREATE TEMP TABLE _wsmerge_threads ON COMMIT DROP AS
    SELECT s.id AS sid, d.id AS did
    FROM public.email_thread_index s
    JOIN public.email_thread_index d
      ON d.workspace_id = p_dest
     AND COALESCE(d.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND d.provider_thread_id = s.provider_thread_id
    WHERE s.workspace_id = p_source;

  UPDATE public.email_thread_index d
  SET linked_contact_id = COALESCE(d.linked_contact_id, s.linked_contact_id),
      linked_capture_id = COALESCE(d.linked_capture_id, s.linked_capture_id),
      linked_action_id = COALESCE(d.linked_action_id, s.linked_action_id),
      linked_project_id = COALESCE(d.linked_project_id, s.linked_project_id),
      is_starred = COALESCE(d.is_starred, false) OR COALESCE(s.is_starred, false),
      needs_reply = COALESCE(d.needs_reply, s.needs_reply),
      trust = COALESCE(d.trust, s.trust)
  FROM pg_temp._wsmerge_threads t
  JOIN public.email_thread_index s ON s.id = t.sid
  WHERE d.id = t.did;

  INSERT INTO public.email_thread_label (thread_id, label_id, created_at)
  SELECT t.did, l.label_id, l.created_at
  FROM public.email_thread_label l JOIN pg_temp._wsmerge_threads t ON t.sid = l.thread_id
  ON CONFLICT DO NOTHING;
  UPDATE public.email_draft e SET email_thread_id = t.did FROM pg_temp._wsmerge_threads t WHERE e.email_thread_id = t.sid;
  -- since 528 (707): shares of the thread (646, 673) and its private mark
  -- (680) name the copy it folds into; a private mark the destination
  -- already has for it stays the destination's
  UPDATE public.email_share e SET thread_index_id = t.did FROM pg_temp._wsmerge_threads t WHERE e.thread_index_id = t.sid;
  UPDATE public.email_share_link e SET thread_index_id = t.did FROM pg_temp._wsmerge_threads t WHERE e.thread_index_id = t.sid;
  UPDATE public.email_thread_share e SET thread_index_id = t.did FROM pg_temp._wsmerge_threads t WHERE e.thread_index_id = t.sid;
  UPDATE public.email_thread_team_private e SET thread_index_id = t.did FROM pg_temp._wsmerge_threads t WHERE e.thread_index_id = t.sid;
  -- the copy's labels were unioned onto the destination copy above; they go with it
  PERFORM public._wsmerge_assert_no_refs('email_thread_index', (SELECT array_agg(sid) FROM pg_temp._wsmerge_threads), ARRAY['email_thread_label']);
  DELETE FROM public.email_thread_index s USING pg_temp._wsmerge_threads t WHERE s.id = t.sid;
  GET DIAGNOSTICS v_copies_folded = ROW_COUNT;

  UPDATE public.email_thread_index SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_copies_moved = ROW_COUNT;

  DELETE FROM public.mail_review_activity s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.mail_review_activity d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id);
  GET DIAGNOSTICS v_reviews_dropped = ROW_COUNT;

  -- sync and sending state follow (unique on the account, so nothing collides)
  UPDATE public.email_sync_state SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.crm_sync_state SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.task_sync_state SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.email_draft SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.email_hold SET workspace_id = p_dest WHERE workspace_id = p_source;

  FOREACH a IN ARRAY v_accounts LOOP
    PERFORM public.reconcile_email_thread_copies(a);
  END LOOP;

  RETURN jsonb_build_object('accounts_rehomed', v_rehomed, 'account_links_deduped', v_links_deduped, 'account_links_moved', v_links_moved,
                            'thread_copies_folded', v_copies_folded, 'thread_copies_moved', v_copies_moved,
                            'mail_reviews_dropped', v_reviews_dropped, 'accounts_reconciled', cardinality(v_accounts));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_mail(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_default_projects (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_default_projects(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_folded int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp._wsmerge_projects LOOP
    UPDATE public.actions SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.milestone SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.document SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.document_chunks SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.captures SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.capture_chunks SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.capture_references SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.attachments SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.attachment_chunks SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.proposed_change SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.decision SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.projects SET parent_project_id = r.dst WHERE parent_project_id = r.src;
    UPDATE public.email_thread_index SET linked_project_id = r.dst WHERE linked_project_id = r.src;
    -- since 528 (707): a website (463) and a canvas (676) in the default project
    UPDATE public.website_site SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.canvas SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.claim SET project_ids = (SELECT COALESCE(array_agg(DISTINCT e), '{}'::uuid[]) FROM unnest(array_replace(project_ids, r.src, r.dst)) e)
    WHERE project_ids @> ARRAY[r.src];
    INSERT INTO public.project_label (project_id, label_id, created_at)
    SELECT r.dst, label_id, created_at FROM public.project_label WHERE project_id = r.src
    ON CONFLICT DO NOTHING;
    DELETE FROM public.project_label WHERE project_id = r.src;
    DELETE FROM public.knowledge_brief WHERE scope_type = 'project' AND scope_id = r.src;
    DELETE FROM public.anchor_embedding WHERE entity_type = 'project' AND entity_id = r.src;
    DELETE FROM public.view WHERE scope_type = 'project' AND scope_id = r.src;
    PERFORM public._wsmerge_repoint_entity('project', r.src, r.dst);
    PERFORM public._wsmerge_assert_no_refs('projects', ARRAY[r.src], '{}');
    DELETE FROM public.projects WHERE id = r.src;
    v_folded := v_folded + 1;
  END LOOP;
  RETURN jsonb_build_object('default_projects_folded', v_folded);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_default_projects(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_deals (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_deals(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  p record;
  c record;
  dc record;
  v_dst uuid;
  v_had boolean;
  v_key text;
  v_n int;
  v_pos int;
  v_offset numeric;
  v_rows int;
  n_pipelines int := 0;
  n_rows int := 0;
  n_fields int := 0;
BEGIN
  FOR p IN SELECT * FROM public.data_table WHERE workspace_id = p_source AND table_kind = 'pipeline' ORDER BY is_default DESC, position LOOP
    SELECT d.id INTO v_dst FROM public.data_table d
      WHERE d.workspace_id = p_dest AND d.table_kind = 'pipeline' AND ((p.is_default AND d.is_default) OR lower(d.name) = lower(p.name))
      ORDER BY (p.is_default AND d.is_default) DESC, (d.archived_at IS NULL) DESC, d.position
      LIMIT 1;
    IF v_dst IS NULL THEN
      -- No counterpart: it moves whole (the generic re-stamp), and stays the
      -- default only where the destination has none.
      IF p.is_default AND EXISTS (SELECT 1 FROM public.data_table d WHERE d.workspace_id = p_dest AND d.is_default) THEN
        UPDATE public.data_table SET is_default = false WHERE id = p.id;
      END IF;
      CONTINUE;
    END IF;

    -- The stages the destination lacks join its Stage column, with their
    -- outcomes (50 options at most).
    UPDATE public.custom_field_definition d
       SET options = d.options || coalesce((
             SELECT array_agg(u.o ORDER BY u.i) FROM (
               SELECT o, i FROM unnest(s.options) WITH ORDINALITY x(o, i)
                WHERE NOT (o = ANY (d.options)) ORDER BY i LIMIT greatest(0, 50 - cardinality(d.options))) u), '{}'),
           config = jsonb_set(d.config, '{outcomes}', coalesce(d.config -> 'outcomes', '{}'::jsonb) || coalesce((
             SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(coalesce(s.config -> 'outcomes', '{}'::jsonb)) e
              WHERE NOT (e.key = ANY (d.options))), '{}'::jsonb))
      FROM public.custom_field_definition s
     WHERE d.table_id = v_dst AND d.key = 'stage' AND s.table_id = p.id AND s.key = 'stage';

    -- The other columns: one of the same key, type and target folds (a
    -- select's options join); any other moves across, under a key of its
    -- own when the destination has its key.
    FOR c IN SELECT * FROM public.custom_field_definition WHERE table_id = p.id AND key <> 'stage' ORDER BY position LOOP
      SELECT * INTO dc FROM public.custom_field_definition WHERE table_id = v_dst AND key = c.key;
      v_had := FOUND;
      IF v_had AND dc.field_type = c.field_type AND (dc.config -> 'target') IS NOT DISTINCT FROM (c.config -> 'target') THEN
        IF c.field_type IN ('select', 'multi_select') THEN
          UPDATE public.custom_field_definition
             SET options = options || coalesce((
                   SELECT array_agg(u.o ORDER BY u.i) FROM (
                     SELECT o, i FROM unnest(c.options) WITH ORDINALITY x(o, i)
                      WHERE NOT (o = ANY (dc.options)) ORDER BY i LIMIT greatest(0, 50 - cardinality(dc.options))) u), '{}')
           WHERE id = dc.id;
        END IF;
        CONTINUE;
      END IF;
      v_key := c.key;
      IF v_had THEN
        v_n := 2;
        LOOP
          v_key := left(c.key, 40 - length('_' || v_n)) || '_' || v_n;
          EXIT WHEN NOT EXISTS (SELECT 1 FROM public.custom_field_definition x WHERE x.table_id IN (p.id, v_dst) AND x.key = v_key);
          v_n := v_n + 1;
        END LOOP;
        UPDATE public.data_row
           SET custom_fields = (custom_fields - c.key) || jsonb_build_object(v_key, custom_fields -> c.key)
         WHERE table_id = p.id AND custom_fields ? c.key;
      END IF;
      SELECT coalesce(max(x.position) + 1, 0) INTO v_pos FROM public.custom_field_definition x WHERE x.table_id = v_dst;
      UPDATE public.custom_field_definition
         SET table_id = v_dst, workspace_id = p_dest, key = v_key, position = v_pos, system = false
       WHERE id = c.id;
    END LOOP;

    -- Its rows go after the destination's, its views show the destination,
    -- its edges name it; then it goes, and its columns and change log with it.
    SELECT coalesce(max(r.position), 0) INTO v_offset FROM public.data_row r WHERE r.table_id = v_dst;
    UPDATE public.data_row SET table_id = v_dst, workspace_id = p_dest, position = position + v_offset WHERE table_id = p.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    n_rows := n_rows + v_rows;
    UPDATE public.view SET scope_id = v_dst WHERE scope_type = 'data_table' AND scope_id = p.id;
    DELETE FROM public.entity_link l
     WHERE l.target_type = 'data_table' AND l.target_id = p.id
       AND EXISTS (SELECT 1 FROM public.entity_link x
                    WHERE x.workspace_id IN (p_source, p_dest) AND x.source_type = l.source_type AND x.source_id = l.source_id
                      AND x.target_type = 'data_table' AND x.target_id = v_dst AND x.relation = l.relation);
    UPDATE public.entity_link SET target_id = v_dst WHERE target_type = 'data_table' AND target_id = p.id;
    DELETE FROM public.entity_access WHERE entity_type = 'data_table' AND entity_id = p.id;
    -- 707: a form that adds to the pipeline (data_form) adds to the one it
    -- folds into, instead of going with it
    UPDATE public.data_form SET table_id = v_dst WHERE table_id = p.id;
    DELETE FROM public.data_table WHERE id = p.id;
    n_pipelines := n_pipelines + 1;
  END LOOP;

  -- A table's columns are its own (keys are per table): they move with the
  -- generic re-stamp, never fold. A field folds only into one of the same
  -- type and target (528: _wsmerge_custom_fields_begin gave the others a
  -- key of their own before anything moved).
  DELETE FROM public.custom_field_definition f
   WHERE f.workspace_id = p_source
     AND f.table_id IS NULL
     AND EXISTS (SELECT 1 FROM public.custom_field_definition d
                  WHERE d.workspace_id = p_dest AND d.entity_type = f.entity_type AND d.key = f.key AND d.table_id IS NULL
                    AND d.field_type = f.field_type
                    AND (d.config -> 'target') IS NOT DISTINCT FROM (f.config -> 'target'));
  GET DIAGNOSTICS n_fields = ROW_COUNT;

  -- People and linked records named in values follow the folds (528).
  RETURN jsonb_build_object('pipelines_folded', n_pipelines, 'deal_rows_moved', n_rows, 'custom_fields_folded', n_fields)
      || public._wsmerge_custom_field_ids(p_source, p_dest);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_deals(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_generic_restamp (newest before: see the header)
CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp(p_source uuid, p_dest uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; n int; v_out jsonb := '{}'::jsonb;
BEGIN
  -- Joining (645): the source's link, listed domains and switches end with
  -- it. They are never handed to the destination, which keeps its own.
  DELETE FROM public.workspace_join_link WHERE workspace_id = p_source;
  DELETE FROM public.workspace_join_domain WHERE workspace_id = p_source;
  DELETE FROM public.workspace_join_settings WHERE workspace_id = p_source;
  -- Deals first (473): pipelines and stages fold by name, so a deal is never
  -- re-stamped while its stage is still the other workspace's.
  v_out := v_out || public._wsmerge_deals(p_source, p_dest);
  -- One per person or per workspace (707): vocabulary, a day's auto-archive,
  -- a private thread, booking pages. Settled here, or the loop stops on them.
  v_out := v_out || public._wsmerge_one_per_owner(p_source, p_dest);
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge', 'cloud_browser')
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET workspace_id = $1 WHERE workspace_id = $2', r.table_name) USING p_dest, p_source;
      GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'merge cannot re-stamp %: a uniqueness this merge does not resolve (%)', r.table_name, SQLERRM
        USING ERRCODE = 'P0008';
    END;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object(r.table_name, n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_generic_restamp(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── 5. Two guards that kept a row in its workspace, also during a merge ─────
-- spreadsheet_before_write (675_spreadsheets.sql) and drive_folder_before_write
-- (690_drive_folders.sql) quietly put workspace_id back on every update, so the
-- generic re-stamp left the source's spreadsheets and folders behind and the
-- merge's last check refused ("merge left rows under the source workspace").
-- Restated with one change each: during a merge (_wsmerge_active, 402, the
-- same exemption the other guards have) the workspace may change. Nothing
-- else in them changes.

CREATE OR REPLACE FUNCTION public.spreadsheet_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'UPDATE' then
    new.revision := old.revision;
    if new.workbook is distinct from old.workbook
       or new.extras is distinct from old.extras
       or new.title is distinct from old.title then
      new.revision := old.revision + 1;
    end if;
    -- a workspace merge (402) moves it with everything else (707); otherwise
    -- it stays in its workspace
    if not public._wsmerge_active() then
      new.workspace_id := old.workspace_id;
    end if;
    new.created_at := old.created_at;
    if current_user in ('authenticated', 'anon') then
      if new.created_by is distinct from old.created_by then
        raise exception 'Who made a spreadsheet cannot be changed.' using errcode = '42501';
      end if;
      if new.visibility is distinct from old.visibility
         and old.created_by is distinct from public.current_member_id(old.workspace_id) then
        raise exception 'Only the person who made a spreadsheet changes who sees it.' using errcode = '42501';
      end if;
      new.last_edited_by := public.current_member_id(old.workspace_id);
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.drive_folder_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_parent_ws uuid;
  v_at uuid;
  v_depth integer := 0;
begin
  if tg_op = 'UPDATE' then
    -- a workspace merge (402) moves it with everything else (707); otherwise
    -- it stays in its workspace
    if not public._wsmerge_active() then
      new.workspace_id := old.workspace_id;
    end if;
    new.created_at := old.created_at;
    if current_user in ('authenticated', 'anon') and new.created_by is distinct from old.created_by then
      raise exception 'Who made a folder cannot be changed.' using errcode = '42501';
    end if;
  elsif current_user in ('authenticated', 'anon') then
    if new.created_by is distinct from public.current_member_id(new.workspace_id) or new.created_by is null then
      raise exception 'A folder is made as oneself.' using errcode = '42501';
    end if;
  end if;

  new.name := btrim(new.name);

  if new.parent_id is not null
     and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    select f.workspace_id into v_parent_ws from public.drive_folder f where f.id = new.parent_id;
    if v_parent_ws is null or v_parent_ws <> new.workspace_id then
      raise exception 'A folder sits in a folder of its own workspace.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
      -- Walk up from the new parent: meeting this folder would make a loop.
      v_at := new.parent_id;
      while v_at is not null loop
        if v_at = new.id then
          raise exception 'A folder cannot sit inside itself.' using errcode = '23514';
        end if;
        v_depth := v_depth + 1;
        if v_depth > 64 then
          raise exception 'Folders nest at most 64 deep.' using errcode = '23514';
        end if;
        select f.parent_id into v_at from public.drive_folder f where f.id = v_at;
      end loop;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

notify pgrst, 'reload schema';

commit;
