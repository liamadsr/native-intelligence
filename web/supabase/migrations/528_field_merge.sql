-- ============================================================
-- 528: a workspace merge carries person and relation values (Tables, phase 2).
-- ============================================================
-- A merge (402, 408) folds the source's members, contacts and companies into
-- the destination's matches, and folds a source custom field into the
-- destination's field of the same key (473, 520). With 523's types two
-- things follow:
--
--   1. Fields of the same key and different types (or relations to
--      different targets) are both kept: before anything moves,
--      _wsmerge_custom_fields_begin gives the source's a key of its own
--      (key_2, key_3, ...) and moves its records' values to that key. Only
--      a field of the same type and target folds. Called first thing in
--      _wsmerge_members, which the merge runs before any record moves.
--   2. A person value naming a folded member, and a relation value naming a
--      folded contact or company, names the record it folded into, in both
--      workspaces' records (_wsmerge_custom_field_ids, the maps of 402's
--      _wsmerge_build_maps), and the field_link edges to a folded record
--      point at the one it folded into. Called at the end of
--      _wsmerge_deals, once members, contacts and companies are folded and
--      before the generic re-stamp.
-- 524's triggers skip during a merge (dial8.workspace_merge): this is what
-- they would have done.
--
-- _wsmerge_members and _wsmerge_deals are 520's with only the two calls
-- (and the fold's type condition) added.
--
-- After 402, 408, 520, 523, 524. Idempotent. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- 1. Same key, another type: the source's field takes a key of its own.
create or replace function public._wsmerge_custom_fields_begin(p_source uuid, p_dest uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  f record;
  v_key text;
  v_n int;
  v_tbl text;
begin
  for f in
    select s.id, s.entity_type, s.key
      from public.custom_field_definition s
      join public.custom_field_definition d
        on d.workspace_id = p_dest and d.entity_type = s.entity_type and d.key = s.key and d.table_id is null
     where s.workspace_id = p_source
       and s.table_id is null
       and (d.field_type <> s.field_type or (d.config -> 'target') is distinct from (s.config -> 'target'))
  loop
    v_n := 2;
    loop
      v_key := left(f.key, 40 - length('_' || v_n)) || '_' || v_n;
      exit when not exists (
        select 1 from public.custom_field_definition x
         where x.workspace_id in (p_source, p_dest) and x.entity_type = f.entity_type and x.key = v_key and x.table_id is null);
      v_n := v_n + 1;
    end loop;
    update public.custom_field_definition set key = v_key where id = f.id;
    v_tbl := public._custom_field_table(f.entity_type);
    if v_tbl is not null then
      execute format(
        'update public.%I set custom_fields = (custom_fields - $1) || jsonb_build_object($2, custom_fields -> $1) '
        || 'where workspace_id = $3 and custom_fields ? $1', v_tbl)
        using f.key, v_key, p_source;
    end if;
  end loop;
end;
$$;

revoke all on function public._wsmerge_custom_fields_begin(uuid, uuid) from public, anon, authenticated;

-- 2. People and linked records named in values follow the folds.
create or replace function public._wsmerge_custom_field_ids(p_source uuid, p_dest uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d record;
  v_tbl text;
  v_map text;
  v_rows text;
  n int := 0;
  k int;
begin
  for d in
    select f.entity_type, f.key, f.field_type, f.table_id, f.config -> 'target' ->> 'kind' as target
      from public.custom_field_definition f
     where f.workspace_id in (p_source, p_dest)
       and (f.field_type = 'person' or (f.field_type = 'relation' and (f.config -> 'target' ->> 'kind') in ('contact', 'company')))
  loop
    v_tbl := public._custom_field_table(d.entity_type);
    v_map := case when d.field_type = 'person' then '_wsmerge_members' when d.target = 'contact' then '_wsmerge_contacts' else '_wsmerge_companies' end;
    if v_tbl is null or to_regclass('pg_temp.' || v_map) is null then
      continue;
    end if;
    -- A table's column holds its values on that table's rows only.
    v_rows := 't.workspace_id in ($2, $3)' || case when d.table_id is not null then ' and t.table_id = $4' else '' end;
    if d.field_type = 'person' then
      execute format(
        'update public.%I t set custom_fields = jsonb_set(t.custom_fields, array[$1], to_jsonb(m.dst::text)) '
        || 'from pg_temp.%I m where ' || v_rows || ' and lower(t.custom_fields ->> $1) = m.src::text', v_tbl, v_map)
        using d.key, p_source, p_dest, d.table_id;
    else
      execute format(
        'update public.%I t set custom_fields = jsonb_set(t.custom_fields, array[$1], ('
        || 'select jsonb_agg(y.v order by y.i) from ('
        || '  select distinct on (z.v) z.v, z.i from ('
        || '    select coalesce(m.dst::text, lower(x.v)) as v, x.i'
        || '      from jsonb_array_elements_text(t.custom_fields -> $1) with ordinality x(v, i)'
        || '      left join pg_temp.%I m on m.src::text = lower(x.v)) z'
        || '   order by z.v, z.i) y)) '
        || 'where ' || v_rows || ' and jsonb_typeof(t.custom_fields -> $1) = ''array'' '
        || 'and exists (select 1 from jsonb_array_elements_text(t.custom_fields -> $1) x join pg_temp.%I m on m.src::text = lower(x))',
        v_tbl, v_map, v_map)
        using d.key, p_source, p_dest, d.table_id;
    end if;
    get diagnostics k = row_count;
    n := n + k;
  end loop;

  -- The edges to a folded contact or company: to the one it folded into.
  if to_regclass('pg_temp._wsmerge_contacts') is not null then
    delete from public.entity_link l
     using pg_temp._wsmerge_contacts m
     where l.relation = 'field_link' and l.target_type = 'contact' and l.target_id = m.src
       and l.workspace_id in (p_source, p_dest)
       and exists (select 1 from public.entity_link y
                    where y.workspace_id = l.workspace_id and y.source_type = l.source_type and y.source_id = l.source_id
                      and y.relation = 'field_link' and y.target_type = 'contact' and y.target_id = m.dst);
    update public.entity_link l set target_id = m.dst
      from pg_temp._wsmerge_contacts m
     where l.relation = 'field_link' and l.target_type = 'contact' and l.target_id = m.src and l.workspace_id in (p_source, p_dest);
  end if;
  if to_regclass('pg_temp._wsmerge_companies') is not null then
    delete from public.entity_link l
     using pg_temp._wsmerge_companies m
     where l.relation = 'field_link' and l.target_type = 'company' and l.target_id = m.src
       and l.workspace_id in (p_source, p_dest)
       and exists (select 1 from public.entity_link y
                    where y.workspace_id = l.workspace_id and y.source_type = l.source_type and y.source_id = l.source_id
                      and y.relation = 'field_link' and y.target_type = 'company' and y.target_id = m.dst);
    update public.entity_link l set target_id = m.dst
      from pg_temp._wsmerge_companies m
     where l.relation = 'field_link' and l.target_type = 'company' and l.target_id = m.src and l.workspace_id in (p_source, p_dest);
  end if;
  return jsonb_build_object('custom_field_ids_rewritten', n);
end;
$$;

revoke all on function public._wsmerge_custom_field_ids(uuid, uuid) from public, anon, authenticated;

-- _wsmerge_deals, from 520_data_tables.sql: the fold's type condition, and the ids.
CREATE OR REPLACE FUNCTION public._wsmerge_deals(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p record;
  s record;
  v_dst_pipeline uuid;
  v_dst_stage uuid;
  v_pos int;
  n_deals int := 0;
  n_fields int := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp._wsmerge_deal_stages;
  CREATE TEMP TABLE _wsmerge_deal_stages (src uuid PRIMARY KEY, dst uuid NOT NULL, dst_pipeline uuid NOT NULL) ON COMMIT DROP;

  FOR p IN SELECT * FROM public.deal_pipeline WHERE workspace_id = p_source ORDER BY is_default DESC, position LOOP
    SELECT d.id INTO v_dst_pipeline FROM public.deal_pipeline d
      WHERE d.workspace_id = p_dest AND ((p.is_default AND d.is_default) OR lower(d.name) = lower(p.name))
      ORDER BY (p.is_default AND d.is_default) DESC, d.position
      LIMIT 1;
    IF v_dst_pipeline IS NULL THEN
      -- No counterpart: the pipeline moves whole, and stays the default only
      -- where the destination has none.
      UPDATE public.deal_pipeline
         SET workspace_id = p_dest,
             is_default = p.is_default AND NOT EXISTS (SELECT 1 FROM public.deal_pipeline d WHERE d.workspace_id = p_dest AND d.is_default)
       WHERE id = p.id;
      UPDATE public.deal_stage SET workspace_id = p_dest WHERE pipeline_id = p.id;
      INSERT INTO pg_temp._wsmerge_deal_stages SELECT id, id, p.id FROM public.deal_stage WHERE pipeline_id = p.id;
    ELSE
      FOR s IN SELECT * FROM public.deal_stage WHERE pipeline_id = p.id ORDER BY position LOOP
        SELECT d.id INTO v_dst_stage FROM public.deal_stage d
          WHERE d.pipeline_id = v_dst_pipeline AND lower(d.name) = lower(s.name)
          LIMIT 1;
        IF v_dst_stage IS NULL THEN
          SELECT coalesce(max(position), -1) + 1 INTO v_pos FROM public.deal_stage WHERE pipeline_id = v_dst_pipeline;
          UPDATE public.deal_stage SET workspace_id = p_dest, pipeline_id = v_dst_pipeline, position = v_pos WHERE id = s.id;
          v_dst_stage := s.id;
        END IF;
        INSERT INTO pg_temp._wsmerge_deal_stages VALUES (s.id, v_dst_stage, v_dst_pipeline);
      END LOOP;
    END IF;
  END LOOP;

  -- Contacts the merge folded into the destination's (_wsmerge_contacts):
  -- the deal follows them to the surviving contact.
  IF to_regclass('pg_temp._wsmerge_contacts') IS NOT NULL THEN
    UPDATE public.deal d
       SET contact_ids = (SELECT array_agg(DISTINCT coalesce(m.dst, c)) FROM unnest(d.contact_ids) c
                            LEFT JOIN pg_temp._wsmerge_contacts m ON m.src = c)
     WHERE d.workspace_id = p_source
       AND d.contact_ids && (SELECT coalesce(array_agg(src), '{}') FROM pg_temp._wsmerge_contacts);
  END IF;

  UPDATE public.deal d
     SET workspace_id = p_dest, stage_id = m.dst, pipeline_id = m.dst_pipeline
    FROM pg_temp._wsmerge_deal_stages m
   WHERE d.workspace_id = p_source AND d.stage_id = m.src;
  GET DIAGNOSTICS n_deals = ROW_COUNT;
  -- What is left in the source (folded pipelines and their emptied stages) goes.
  DELETE FROM public.deal_pipeline WHERE workspace_id = p_source;

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
  RETURN jsonb_build_object('deals_moved', n_deals, 'custom_fields_folded', n_fields)
      || public._wsmerge_custom_field_ids(p_source, p_dest);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_deals(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- _wsmerge_members, from 520_data_tables.sql: the begin call.
CREATE OR REPLACE FUNCTION public._wsmerge_members(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_folded int := 0; v_moved int := 0; v_invites_moved int := 0; v_invites_dropped int := 0;
BEGIN
  -- Before anything moves: a source field that shares a key with a
  -- destination field of another type keeps its own, suffixed key (528).
  PERFORM public._wsmerge_custom_fields_begin(p_source, p_dest);

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
  IF to_regclass('public.slack_user_link') IS NOT NULL THEN
    EXECUTE 'UPDATE public.slack_user_link t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src';
  END IF;
  -- Tables (520) and grants (492): one person's member row in each
  -- workspace, so a grant or an ownership never needs a duplicate dropped.
  UPDATE public.data_table t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.entity_access t SET grantee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.grantee_member_id = x.src;
  UPDATE public.entity_access t SET granted_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.granted_by = x.src;

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
                            'invites_moved', v_invites_moved, 'invites_dropped', v_invites_dropped);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_members(uuid, uuid) FROM PUBLIC, anon, authenticated;

notify pgrst, 'reload schema';
