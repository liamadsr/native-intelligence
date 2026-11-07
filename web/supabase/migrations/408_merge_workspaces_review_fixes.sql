-- 408: merge workspaces — the engine review's fixes (docs/plans/merge-workspaces.md,
-- "Status"; a line-by-line Opus review of 402 on 2026-10-21, before the first PROD merge).
--
-- Two rules changed data without saying so, and the assertion could not see it:
--
--   * A folded contact lost every active sequence enrollment. 402 set the
--     source email aside and called merge_contacts, whose exit rule
--     ("another active enrollment in this workspace with the survivor's
--     email") then matched the row itself, and the merge counted none of
--     them. Now the enrollments re-point to the survivor before
--     merge_contacts runs; one that collides with an active destination
--     enrollment for the same person is ended, and counted, by
--     _wsmerge_singletons — what the preflight's sequence_enrollments_exited
--     has counted all along.
--   * Folding two labels narrowed a universal one. NULL scopes means "visible
--     everywhere" (081); the union treated it as none. A universal side now
--     keeps the union universal.
--
-- The review's third finding, a folded team's projects losing their team,
-- does not apply: 018 added projects.team_id and 019 dropped it again. The
-- update stays behind a column check for a database that still has it.
--
-- And the guard the plan promised: _wsmerge_assert_no_refs() walks the
-- foreign keys onto a table before a step deletes source rows from it and
-- refuses (P0008, rolled back) if anything still points at them that the step
-- did not translate or mean to drop. Every such key on DEV is translated
-- today; the guard is for the next table that adds one.
--
-- Every patched step below is 402's text with the fix inserted; nothing else
-- about the rules moves. Verified by the rolled-back synthetic end-to-end on
-- DEV (scripts/merge-workspaces/e2e_body.sql, which fails on both rules
-- against 402 alone), then applied to DEV and run again.


-- The guard the plan promised: before a step deletes source rows (a folded
-- member, team, label, teammate, company, seeded loop, default project or
-- thread copy), nothing may still point at them through a foreign key the
-- step did not translate — such a column would cascade or go NULL in silence.
-- Data-driven: it walks
-- pg_constraint for every single-column FK onto the table and counts the
-- rows that reference the ids about to go, skipping the children a step
-- deletes on purpose (p_except). A hit is P0008, the merge rolls back, and
-- the message names the column to handle.
CREATE OR REPLACE FUNCTION public._wsmerge_assert_no_refs(p_table text, p_ids uuid[], p_except text[] DEFAULT '{}')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n bigint; v_hits text;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN; END IF;
  FOR r IN
    SELECT cl.relname AS child, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = ('public.' || quote_ident(p_table))::regclass
      AND array_length(c.conkey, 1) = 1
      AND ns.nspname = 'public'
      AND NOT (cl.relname = ANY (p_except))
    ORDER BY cl.relname, a.attname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = ANY($1)', r.child, r.col) INTO n USING p_ids;
    IF n > 0 THEN
      v_hits := concat_ws(', ', v_hits, r.child || '.' || r.col || '=' || n);
    END IF;
  END LOOP;
  IF v_hits IS NOT NULL THEN
    RAISE EXCEPTION 'rows still reference % rows the merge is about to delete: %', p_table, v_hits USING ERRCODE = 'P0008';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_members(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_folded int := 0; v_moved int := 0; v_invites_moved int := 0; v_invites_dropped int := 0;
BEGIN
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

CREATE OR REPLACE FUNCTION public._wsmerge_labels(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j record; v_folded int := 0; v_moved int := 0;
BEGIN
  FOR j IN SELECT * FROM (VALUES
      ('action_label', 'action_id'), ('capture_label', 'capture_id'), ('project_label', 'project_id'),
      ('initiative_label', 'initiative_id'), ('email_thread_label', 'thread_id')) AS v(junction, col)
  LOOP
    EXECUTE format($q$
      UPDATE public.%1$I x SET label_id = m.dst
      FROM pg_temp._wsmerge_labels m
      WHERE x.label_id = m.src
        AND NOT EXISTS (SELECT 1 FROM public.%1$I y WHERE y.%2$I = x.%2$I AND y.label_id = m.dst)
    $q$, j.junction, j.col);
    EXECUTE format($q$
      DELETE FROM public.%1$I x USING pg_temp._wsmerge_labels m WHERE x.label_id = m.src
    $q$, j.junction);
  END LOOP;

  UPDATE public.label d
  -- NULL scopes = visible everywhere (081): a universal side keeps the union universal (408)
  SET scopes = CASE WHEN d.scopes IS NULL OR s.scopes IS NULL THEN NULL
                    ELSE (SELECT array_agg(DISTINCT e) FROM unnest(d.scopes || s.scopes) e) END,
      group_name = COALESCE(d.group_name, s.group_name)
  FROM pg_temp._wsmerge_labels m
  JOIN public.label s ON s.id = m.src
  WHERE d.id = m.dst;

  PERFORM public._wsmerge_assert_no_refs('label', (SELECT array_agg(src) FROM pg_temp._wsmerge_labels), '{}');
  DELETE FROM public.label l USING pg_temp._wsmerge_labels m WHERE l.id = m.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;
  UPDATE public.label SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('labels_folded', v_folded, 'labels_moved', v_moved);
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_contacts(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; v_folded int := 0; v_moved int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp._wsmerge_contacts LOOP
    -- shares and voice trust the destination contact already has
    DELETE FROM public.contact_share s
    WHERE s.contact_id = r.src
      AND EXISTS (SELECT 1 FROM public.contact_share d WHERE d.contact_id = r.dst
                  AND d.shared_with_member_id IS NOT DISTINCT FROM s.shared_with_member_id
                  AND d.shared_with_team_id IS NOT DISTINCT FROM s.shared_with_team_id);
    -- (PROD's voice_contact_trust has no model column: the destination's trust stands)
    DELETE FROM public.voice_contact_trust v
    WHERE v.contact_id = r.src AND EXISTS (SELECT 1 FROM public.voice_contact_trust d WHERE d.contact_id = r.dst);
    UPDATE public.voice_contact_trust SET contact_id = r.dst, workspace_id = p_dest WHERE contact_id = r.src;

    IF to_regclass('public.deal_contact') IS NOT NULL THEN
      EXECUTE 'INSERT INTO public.deal_contact (deal_id, contact_id, role, created_at)
               SELECT deal_id, $2, role, created_at FROM public.deal_contact WHERE contact_id = $1
               ON CONFLICT DO NOTHING' USING r.src, r.dst;
      EXECUTE 'DELETE FROM public.deal_contact WHERE contact_id = $1' USING r.src;
    END IF;

    -- sequence enrollments (408) re-point to the surviving contact here, before merge_contacts, whose
    -- exit rule would otherwise match the row itself (same workspace, same email) and end them all.
    -- One that collides with an active destination enrollment for the same person is ended (and
    -- counted) by _wsmerge_singletons, which now sees the surviving contact — what the preflight counts
    UPDATE public.sequence_enrollment SET contact_id = r.dst WHERE contact_id = r.src;

    UPDATE public.contact
    SET workspace_id = p_dest,
        secondary_emails = (SELECT array_agg(DISTINCT e) FROM unnest(COALESCE(secondary_emails, '{}'::text[]) || ARRAY[email]) e WHERE e IS NOT NULL AND e <> ''),
        email = NULL
    WHERE id = r.src;

    PERFORM public.merge_contacts(r.dst, r.src, 'workspace_merge', NULL,
                                  jsonb_build_array('same email in merged workspaces'), 'workspace_merge');

    UPDATE public.actions SET assignee_contact_id = r.dst WHERE assignee_contact_id = r.src;
    UPDATE public.proposed_change SET assignee_contact_id = r.dst WHERE assignee_contact_id = r.src;
    UPDATE public.contact SET merged_into_contact_id = r.dst WHERE merged_into_contact_id = r.src AND id <> r.src;
    PERFORM public._wsmerge_repoint_entity('contact', r.src, r.dst);
    v_folded := v_folded + 1;
  END LOOP;

  UPDATE public.contact SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('contacts_folded', v_folded, 'contacts_moved', v_moved);
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_teams_finish(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE tm record; v_base int; v_cycles int := 0; v_cycles_demoted int := 0; v_deleted int := 0; n int;
BEGIN
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

    IF to_regclass('public.deal') IS NOT NULL THEN
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

    PERFORM public._wsmerge_assert_no_refs('team', ARRAY[tm.src], ARRAY['workflow_state']);
    DELETE FROM public.team WHERE id = tm.src;
    v_deleted := v_deleted + 1;
  END LOOP;

  RETURN jsonb_build_object('folded_teams_deleted', v_deleted, 'cycles_refiled', v_cycles);
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_system_teammates(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_name text; v_folded int := 0; v_threads_demoted int := 0;
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;

  UPDATE public.chat_conversations c
  SET ai_team_member_id = NULL, title = COALESCE(NULLIF(c.title, ''), 'Chat') || ' · ' || v_src_name
  FROM pg_temp._wsmerge_teammates t
  WHERE c.ai_team_member_id = t.src
    AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.user_id = c.user_id AND d.ai_team_member_id = t.dst);
  GET DIAGNOSTICS v_threads_demoted = ROW_COUNT;

  UPDATE public.chat_conversations c SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE c.ai_team_member_id = t.src;
  UPDATE public.chat_conversations c SET agent_teammate_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE c.agent_teammate_id = t.src;
  UPDATE public.agent_memory m SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE m.ai_team_member_id = t.src;
  UPDATE public.flow f SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE f.ai_team_member_id = t.src;
  UPDATE public.tracked_job j SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE j.ai_team_member_id = t.src;
  UPDATE public.agent_run r SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE r.ai_team_member_id = t.src;
  UPDATE public.bot_relay b SET teammate_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE b.teammate_id = t.src;
  UPDATE public.actions a SET assignee_ai_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE a.assignee_ai_member_id = t.src;

  INSERT INTO public.ai_team_member_skill (ai_team_member_id, skill_recipe_id, sort_order)
  SELECT t.dst, s.skill_recipe_id, s.sort_order
  FROM public.ai_team_member_skill s JOIN pg_temp._wsmerge_teammates t ON t.src = s.ai_team_member_id
  ON CONFLICT DO NOTHING;
  DELETE FROM public.ai_team_member_skill s USING pg_temp._wsmerge_teammates t WHERE s.ai_team_member_id = t.src;

  PERFORM public._wsmerge_assert_no_refs('ai_team_member', (SELECT array_agg(src) FROM pg_temp._wsmerge_teammates), '{}');
  DELETE FROM public.ai_team_member a USING pg_temp._wsmerge_teammates t WHERE a.id = t.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  RETURN jsonb_build_object('system_teammates_folded', v_folded, 'teammate_threads_demoted', v_threads_demoted);
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_companies(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; v_folded int := 0; v_moved int := 0; v_demoted int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp._wsmerge_companies LOOP
    UPDATE public.contact SET company_id = r.dst WHERE company_id = r.src;
    IF to_regclass('public.deal') IS NOT NULL THEN
      EXECUTE 'UPDATE public.deal SET company_id = $2 WHERE company_id = $1' USING r.src, r.dst;
    END IF;
    UPDATE public.prospect_list SET source_company_id = r.dst WHERE source_company_id = r.src;
    UPDATE public.prospect_list_entry SET company_id = r.dst WHERE company_id = r.src;
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

  RETURN jsonb_build_object('companies_folded', v_folded, 'companies_moved', v_moved, 'workspace_company_demoted', v_demoted);
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_agents_flows(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_recipes_reslugged int := 0; v_recipes int := 0; v_teammates int := 0; v_seeded_dropped int := 0; v_flows int := 0;
BEGIN
  UPDATE public.recipe s
  SET slug = s.slug || '-' || left(replace(s.id::text, '-', ''), 6)
  WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.recipe d WHERE d.workspace_id = p_dest AND d.slug = s.slug);
  GET DIAGNOSTICS v_recipes_reslugged = ROW_COUNT;
  UPDATE public.recipe SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_recipes = ROW_COUNT;

  UPDATE public.ai_team_member a
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = a.team_id), a.team_id)
  WHERE a.workspace_id = p_source;
  GET DIAGNOSTICS v_teammates = ROW_COUNT;

  UPDATE public.flow_run fr SET flow_id = m.dst FROM pg_temp._wsmerge_flows m WHERE fr.flow_id = m.src;
  UPDATE public.flow_run_state s SET flow_id = m.dst, workspace_id = p_dest FROM pg_temp._wsmerge_flows m WHERE s.flow_id = m.src;
  UPDATE public.agent_run r SET flow_id = m.dst FROM pg_temp._wsmerge_flows m WHERE r.flow_id = m.src;
  UPDATE public.lens_finding l SET flow_id = m.dst FROM pg_temp._wsmerge_flows m WHERE l.flow_id = m.src;
  PERFORM public._wsmerge_assert_no_refs('flow', (SELECT array_agg(src) FROM pg_temp._wsmerge_flows), '{}');
  DELETE FROM public.flow f USING pg_temp._wsmerge_flows m WHERE f.id = m.src;
  GET DIAGNOSTICS v_seeded_dropped = ROW_COUNT;

  UPDATE public.flow f
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = f.team_id), f.team_id),
      ai_team_member_id = COALESCE((SELECT t.dst FROM pg_temp._wsmerge_teammates t WHERE t.src = f.ai_team_member_id), f.ai_team_member_id),
      trigger_config = public._wsmerge_rewrite_json(f.trigger_config),
      actions = public._wsmerge_rewrite_json(f.actions)
  WHERE f.workspace_id = p_source;
  GET DIAGNOSTICS v_flows = ROW_COUNT;

  RETURN jsonb_build_object('recipes_moved', v_recipes, 'recipes_reslugged', v_recipes_reslugged, 'teammates_moved', v_teammates,
                            'seeded_flows_dropped', v_seeded_dropped, 'flows_moved', v_flows);
END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_default_projects(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_mail(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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
$$;

-- like 402's helpers, the guard is reached only through the entry points (the replaced steps keep their grants)
REVOKE EXECUTE ON FUNCTION public._wsmerge_assert_no_refs(text, uuid[], text[]) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
