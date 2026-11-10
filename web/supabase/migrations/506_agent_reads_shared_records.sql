-- ============================================================
-- 506: the agent reads what is shared with its person.
-- ============================================================
-- A per-item grant (492) opens another member's private document or
-- capture, a private or team contact, or a company to a member, a team or
-- a channel's readers, and 493 put that arm on every read POLICY. The
-- agent's tools mostly read on a service-role client, where policies don't
-- apply: they restate each rule as a query predicate (src/lib/ai/tools/
-- _shared.ts), and three SECURITY DEFINER functions they call restate it in
-- SQL. Those three never learned about grants, so a record shared with the
-- person stayed invisible to their agent's search and company list (it
-- failed closed). This gives them the grant arm, from one helper:
--
--   entity_grant_ids_for(type, workspace, user)
--        every id of `type` in `workspace` a grant reaches `user` for: as
--        the member, through a team of the workspace they are in, or
--        through a channel of the workspace they can read (474's
--        team_chat_can_read). my_entity_grant_ids (492) for an explicit
--        user and one workspace, most recently granted first. A signed-in
--        caller asks only about themself (any other user: none), so it is no
--        oracle about other people; the service role names the person its
--        tools act for. No user: none. SECURITY DEFINER, pinned search_path.
--        The app's list tools call it too (src/lib/entity-access/grants.ts).
--
--   unified_search, hybrid_search
--        each re-created EXACTLY as on DEV (pg_get_functiondef, 2026-11-10)
--        with one array per kind, read once (no requester: empty), and one
--        more OR arm on each capture and document visibility predicate:
--        `or c.id = any(v_granted_captures)`, `or d.id = any(
--        v_granted_documents)`; unified_search's decision branch gains the
--        capture's arm, as the decision view policy has it (493). The claim
--        arms are untouched: a claim follows claim_visible_to, which keys off
--        its sources' own rules, and grants don't reach claims (as on every
--        claim read). Eval captures stay out (NOT is_eval comes first).
--
--   list_companies_with_stats
--        re-created as on DEV, its HAVING gaining `or c.id = any(v_granted)`:
--        a company shared with the person is listed though none of its
--        contacts is visible to them, as the company policy (493) and
--        company_visible_to read it. A granted contact already counted
--        (contact_visible_to has had the arm since 493).
--
-- ADDITIVE ONLY: an arm is only ever OR-ed on; nothing narrows. No grant on
-- an unattended run (no requester), as before. Reads only: no write path
-- calls these.
--
-- Cost: one helper call per search per kind (an index probe per grantee
-- arm: entity_access_member_idx, _team_idx, _channel_idx) and an
-- `= any(array)` per candidate row, an empty array when nothing is shared.
-- Measured on DEV, see the PR.
--
-- After 492-495 and 500. Idempotent (create or replace). No backslashes
-- anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── Every id of a kind a grant reaches this user for, in one workspace ───────
create or replace function public.entity_grant_ids_for(p_type text, p_workspace uuid, p_user uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id
      from public.member m
     where m.user_id = p_user
       and m.workspace_id = p_workspace
       -- A signed-in caller asks only about themself.
       and (auth.uid() is null or auth.uid() = p_user)
  ),
  my_teams as (
    select tm.team_id
      from public.team_member tm
      join public.team t on t.id = tm.team_id and t.workspace_id = p_workspace
     where tm.member_id in (select id from me)
  ),
  my_channels as (
    select c.id
      from public.team_chat_channel c
     where c.workspace_id = p_workspace
       and exists (select 1 from me)
       and (
         (c.kind = 'channel' and (c.team_id is null or c.team_id in (select team_id from my_teams)))
         or (c.kind = 'dm' and exists (
               select 1 from public.team_chat_member cm
                where cm.channel_id = c.id and cm.member_id in (select id from me)))
       )
  ),
  hits as (
    select g.entity_id, max(g.created_at) as last_at
      from public.entity_access g
     where g.workspace_id = p_workspace
       and g.entity_type = p_type
       and (
         (g.grantee_kind = 'member' and g.grantee_member_id in (select id from me))
         or (g.grantee_kind = 'team' and g.grantee_team_id in (select team_id from my_teams))
         or (g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels))
       )
     group by g.entity_id
  )
  select coalesce(array_agg(h.entity_id order by h.last_at desc), '{}'::uuid[]) from hits h;
$$;

revoke all on function public.entity_grant_ids_for(text, uuid, uuid) from public, anon;
grant execute on function public.entity_grant_ids_for(text, uuid, uuid) to authenticated, service_role;

-- ── unified_search: the agent's find, and the app's search box ───────────────
CREATE OR REPLACE FUNCTION public.unified_search(p_workspace_id uuid, p_query text, p_types text[] DEFAULT ARRAY['action'::text, 'capture'::text, 'document'::text, 'project'::text, 'decision'::text, 'claim'::text], p_limit integer DEFAULT 20, p_requesting_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(result_type text, result_id uuid, title text, subtitle text, icon text, rank real, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $$
DECLARE
  v_tsquery tsquery;
  v_identifier_pattern text;
  v_is_identifier bool;
  v_requester uuid := public._resolve_visibility_requester(p_requesting_user_id);
  v_requester_member uuid;
  v_granted_captures uuid[] := '{}'::uuid[];
  v_granted_documents uuid[] := '{}'::uuid[];
BEGIN
  -- Membership gate (275): enforced whenever the requester is KNOWN — whether
  -- it came from the JWT or from an explicit p_requesting_user_id — not only
  -- when a JWT happens to be present. A sessionless caller that asserts no
  -- requester at all sees workspace-visible rows only, and is trusted to
  -- scope itself (service-role already has the whole database).
  IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
    RETURN;
  END IF;

  -- 369: the requester's member row here, for the private-document rule
  -- (a private document is its creator's alone; no admin override).
  IF v_requester IS NOT NULL THEN
      SELECT m.id INTO v_requester_member
        FROM public.member m
       WHERE m.workspace_id = p_workspace_id AND m.user_id = v_requester
       LIMIT 1;
  END IF;

  -- 506: the records a per-item grant (492) opens to the requester here,
  -- one array each, read once: a shared private capture or document is
  -- found as its own rule's rows are. No requester, no grants.
  IF v_requester IS NOT NULL THEN
    v_granted_captures := public.entity_grant_ids_for('capture', p_workspace_id, v_requester);
    v_granted_documents := public.entity_grant_ids_for('document', p_workspace_id, v_requester);
  END IF;

  v_is_identifier := p_query ~ '^[A-Za-z]+-[0-9]+$';
  v_identifier_pattern := upper(p_query) || '%';

  BEGIN
    v_tsquery := websearch_to_tsquery('english', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := NULL;
  END;

  IF v_tsquery IS NULL AND NOT v_is_identifier THEN
    RETURN;
  END IF;

  RETURN QUERY

  SELECT
    'action'::text AS result_type,
    a.id AS result_id,
    a.title,
    COALESCE(ws.name, '') AS subtitle,
    a.identifier AS icon,
    CASE
      WHEN v_is_identifier AND upper(a.identifier) LIKE v_identifier_pattern THEN 2.0
      WHEN v_tsquery IS NOT NULL THEN ts_rank(a.fts, v_tsquery)
      ELSE 0.0
    END AS rank,
    jsonb_build_object(
      'identifier', a.identifier,
      'status_id', a.status_id,
      'status_name', ws.name,
      'priority', a.priority,
      'assignee_id', a.assignee_id,
      'team_id', a.team_id
    ) AS metadata
  FROM public.actions a
  JOIN public.team t ON t.id = a.team_id
  LEFT JOIN public.workflow_state ws ON ws.id = a.status_id
  WHERE t.workspace_id = p_workspace_id
    AND 'action' = ANY(p_types)
    AND (
      (v_is_identifier AND upper(a.identifier) LIKE v_identifier_pattern)
      OR (v_tsquery IS NOT NULL AND a.fts @@ v_tsquery)
    )

  UNION ALL

  SELECT
    'capture'::text,
    c.id,
    c.title,
    'Capture'::text AS subtitle,
    ''::text AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(c.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'started_at', c.started_at,
      'duration_seconds', c.duration_seconds
    ) AS metadata
  FROM public.captures c
  WHERE c.workspace_id = p_workspace_id
    AND 'capture' = ANY(p_types)
    AND NOT c.is_eval
    AND v_tsquery IS NOT NULL
    AND c.fts @@ v_tsquery
    AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester) OR c.id = ANY(v_granted_captures))

  UNION ALL

  SELECT
    'document'::text,
    d.id,
    d.title,
    'Document' AS subtitle,
    '' AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(d.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'status', d.status,
      'project_id', d.project_id,
      'is_pinned', d.is_pinned
    ) AS metadata
  FROM public.document d
  WHERE d.workspace_id = p_workspace_id
    AND 'document' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND d.fts @@ v_tsquery
    AND (d.visibility = 'workspace' OR (v_requester_member IS NOT NULL AND d.created_by = v_requester_member) OR d.id = ANY(v_granted_documents))

  UNION ALL

  SELECT
    'project'::text,
    p.id,
    p.name AS title,
    COALESCE(p.status::text, 'active') AS subtitle,
    '' AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(p.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'status', p.status,
      'lead_id', p.lead_id
    ) AS metadata
  FROM public.projects p
  WHERE p.workspace_id = p_workspace_id
    AND 'project' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND p.fts @@ v_tsquery

  UNION ALL

  SELECT
    'decision'::text,
    dec.id,
    LEFT(dec.content, 100) AS title,
    'Decision' AS subtitle,
    '' AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(dec.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'capture_id', dec.capture_id,
      'confirmation', dec.confirmation,
      'project_id', dec.project_id
    ) AS metadata
  FROM public.decision dec
  JOIN public.captures c ON c.id = dec.capture_id
  WHERE c.workspace_id = p_workspace_id
    AND 'decision' = ANY(p_types)
    AND NOT c.is_eval
    AND v_tsquery IS NOT NULL
    AND dec.fts @@ v_tsquery
    AND (c.visibility = 'workspace'
         OR (v_requester IS NOT NULL AND c.user_id = v_requester)
         OR dec.confirmation = 'confirmed'
         OR c.id = ANY(v_granted_captures))

  UNION ALL

  SELECT
    'claim'::text,
    cl.id,
    LEFT(cl.text, 100) AS title,
    'Claim' AS subtitle,
    cl.type AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(cl.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'type', cl.type,
      'confirmation', cl.confirmation,
      'status', cl.status,
      'confidence', cl.confidence
    ) AS metadata
  FROM public.claim cl
  WHERE cl.workspace_id = p_workspace_id
    AND 'claim' = ANY(p_types)
    AND cl.status = 'active'
    AND cl.confirmation <> 'dismissed'
    AND v_tsquery IS NOT NULL
    AND cl.fts @@ v_tsquery
    AND public.claim_visible_to(cl.id, v_requester)

  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$;

-- ── hybrid_search: the agent's search ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hybrid_search(p_workspace_id uuid, p_query text, p_embedding text DEFAULT NULL::text, p_types text[] DEFAULT ARRAY['claim'::text, 'capture'::text, 'document'::text], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 20, p_candidate_k integer DEFAULT 40, p_w_fts double precision DEFAULT 1.0, p_w_vec double precision DEFAULT 1.0, p_w_recent double precision DEFAULT 0.5, p_claim_status text DEFAULT 'active'::text, p_requesting_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(result_type text, result_id uuid, title text, score double precision, event_at timestamp with time zone, fts_rank integer, vec_rank integer, recency_rank integer, excerpt text, source_label text, source_type text, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_tsquery   tsquery;
    v_embedding vector(1536) := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding::vector(1536) END;
    v_requester uuid := public._resolve_visibility_requester(p_requesting_user_id);
    v_requester_member uuid;
    v_granted_captures uuid[] := '{}'::uuid[];
    v_granted_documents uuid[] := '{}'::uuid[];
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
        RETURN;
    END IF;

    -- 369: the requester's member row here, for the private-document rule
    -- (a private document is its creator's alone; no admin override).
    IF v_requester IS NOT NULL THEN
        SELECT m.id INTO v_requester_member
          FROM public.member m
         WHERE m.workspace_id = p_workspace_id AND m.user_id = v_requester
         LIMIT 1;
    END IF;

    -- 506: the records a per-item grant (492) opens to the requester here,
    -- one array each, read once: a shared private capture or document is
    -- found as its own rule's rows are. No requester, no grants.
    IF v_requester IS NOT NULL THEN
        v_granted_captures := public.entity_grant_ids_for('capture', p_workspace_id, v_requester);
        v_granted_documents := public.entity_grant_ids_for('document', p_workspace_id, v_requester);
    END IF;

    -- websearch_to_tsquery is forgiving of user phrasing but can still raise on
    -- pathological input — fall back to NULL (no FTS candidates) rather than error.
    BEGIN
        v_tsquery := websearch_to_tsquery('english', p_query);
    EXCEPTION WHEN OTHERS THEN
        v_tsquery := NULL;
    END;

    RETURN QUERY
    WITH
    -- ============ CLAIMS ============
    claim_fts AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.fts, v_tsquery) DESC)::int AS rnk
        FROM public.claim c
        WHERE c.workspace_id = p_workspace_id AND 'claim' = ANY(p_types)
          AND c.status = p_claim_status AND c.confirmation <> 'dismissed'
          AND v_tsquery IS NOT NULL AND c.fts @@ v_tsquery
          AND (p_since IS NULL OR (c.event_at IS NOT NULL AND c.event_at >= p_since))
          AND (p_until IS NULL OR (c.event_at IS NOT NULL AND c.event_at <= p_until))
          AND public.claim_visible_to(c.id, v_requester)
        LIMIT p_candidate_k
    ),
    claim_vec AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY cc.embedding <=> v_embedding)::int AS rnk
        FROM public.claim_chunks cc
        JOIN public.claim c ON c.id = cc.claim_id
        WHERE cc.workspace_id = p_workspace_id AND 'claim' = ANY(p_types) AND v_embedding IS NOT NULL
          AND c.status = p_claim_status AND c.confirmation <> 'dismissed'
          AND (p_since IS NULL OR (c.event_at IS NOT NULL AND c.event_at >= p_since))
          AND (p_until IS NULL OR (c.event_at IS NOT NULL AND c.event_at <= p_until))
          AND public.claim_visible_to(c.id, v_requester)
        ORDER BY cc.embedding <=> v_embedding
        LIMIT p_candidate_k
    ),
    claim_union AS (
        SELECT id FROM claim_fts UNION SELECT id FROM claim_vec
    ),
    claim_recency AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.event_at DESC NULLS LAST)::int AS rnk
        FROM public.claim c JOIN claim_union u ON u.id = c.id
    ),
    claim_scored AS (
        SELECT
            c.id AS result_id,
            LEFT(c.text, 140) AS title,
            p_w_fts    * COALESCE(1.0/(60+cf.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+cv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+cr.rnk), 0) AS score,
            c.event_at,
            cf.rnk AS fts_rank, cv.rnk AS vec_rank, cr.rnk AS recency_rank,
            jsonb_build_object(
                'type', c.type, 'confirmation', c.confirmation,
                'status', c.status, 'confidence', c.confidence
            ) AS metadata
        FROM public.claim c
        JOIN claim_union u ON u.id = c.id
        LEFT JOIN claim_fts cf ON cf.id = c.id
        LEFT JOIN claim_vec cv ON cv.id = c.id
        LEFT JOIN claim_recency cr ON cr.id = c.id
    ),
    -- top ONE claim_source per claim for inline provenance (avoids N+1 get_claim).
    -- Prefer a source that carries an excerpt; break ties by most recent.
    -- A claim can be visible through a non-capture source while ALSO citing a
    -- private capture — skip those sources so the excerpt/label never leaks.
    claim_top_source AS (
        SELECT DISTINCT ON (cs.claim_id)
            cs.claim_id, cs.source_type, cs.source_id, cs.excerpt
        FROM public.claim_source cs
        WHERE cs.claim_id IN (SELECT result_id FROM claim_scored)
          AND CASE cs.source_type
              WHEN 'capture' THEN EXISTS (
                  SELECT 1 FROM public.captures cap2
                  WHERE cap2.id = cs.source_id
                    AND NOT cap2.is_eval
                    AND (cap2.visibility = 'workspace'
                         OR (v_requester IS NOT NULL AND cap2.user_id = v_requester))
              )
              -- attachments inherit their capture parent, same as claim_visible_to
              WHEN 'attachment' THEN EXISTS (
                  SELECT 1 FROM public.attachments att2
                  WHERE att2.id = cs.source_id
                    AND (
                        att2.note_id IS NULL
                        OR EXISTS (
                            SELECT 1 FROM public.captures cap3
                            WHERE cap3.id = att2.note_id
                              AND NOT cap3.is_eval
                              AND (cap3.visibility = 'workspace'
                                   OR (v_requester IS NOT NULL AND cap3.user_id = v_requester))
                        )
                    )
              )
              -- 341: mail is never a source anyone sees.
              WHEN 'email' THEN FALSE
              -- 353: a chat is only its owner's.
              WHEN 'conversation' THEN EXISTS (
                  SELECT 1 FROM public.chat_conversations cc2
                  WHERE cc2.id = cs.source_id
                    AND v_requester IS NOT NULL
                    AND cc2.user_id = v_requester
              )
              -- 369: a private document is its creator's alone.
              WHEN 'document' THEN public.document_visible_to(cs.source_id, v_requester)
              ELSE TRUE
          END
        ORDER BY cs.claim_id, (cs.excerpt IS NOT NULL) DESC, cs.created_at DESC
    ),
    claim_final AS (
        SELECT
            'claim'::text AS result_type,
            cs.result_id,
            cs.title,
            cs.score,
            cs.event_at,
            cs.fts_rank, cs.vec_rank, cs.recency_rank,
            ts.excerpt,
            COALESCE(
                CASE ts.source_type
                    WHEN 'capture'  THEN cap.title
                    WHEN 'document' THEN doc.title
                    ELSE ts.source_type
                END, 'Claim'
            ) AS source_label,
            ts.source_type,
            cs.metadata
        FROM claim_scored cs
        LEFT JOIN claim_top_source ts ON ts.claim_id = cs.result_id
        LEFT JOIN public.captures      cap ON ts.source_type = 'capture'  AND cap.id = ts.source_id
        LEFT JOIN public.document      doc ON ts.source_type = 'document' AND doc.id = ts.source_id
    ),

    -- ============ CAPTURES ============
    capture_fts AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.fts, v_tsquery) DESC)::int AS rnk
        FROM public.captures c
        WHERE c.workspace_id = p_workspace_id AND 'capture' = ANY(p_types)
          AND NOT c.is_eval
          AND v_tsquery IS NOT NULL AND c.fts @@ v_tsquery
          AND (p_since IS NULL OR (c.started_at IS NOT NULL AND c.started_at >= p_since))
          AND (p_until IS NULL OR (c.started_at IS NOT NULL AND c.started_at <= p_until))
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester) OR c.id = ANY(v_granted_captures))
        LIMIT p_candidate_k
    ),
    capture_vec AS (
        SELECT id, MIN(rnk)::int AS rnk FROM (
            SELECT cc.capture_id AS id,
                   ROW_NUMBER() OVER (ORDER BY cc.embedding <=> v_embedding) AS rnk
            FROM public.capture_chunks cc
            JOIN public.captures cap ON cap.id = cc.capture_id
            WHERE cc.workspace_id = p_workspace_id AND 'capture' = ANY(p_types) AND v_embedding IS NOT NULL
              AND NOT cap.is_eval
              AND (p_since IS NULL OR (cap.started_at IS NOT NULL AND cap.started_at >= p_since))
              AND (p_until IS NULL OR (cap.started_at IS NOT NULL AND cap.started_at <= p_until))
              AND (cap.visibility = 'workspace' OR (v_requester IS NOT NULL AND cap.user_id = v_requester) OR cap.id = ANY(v_granted_captures))
            ORDER BY cc.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    capture_union AS (SELECT id FROM capture_fts UNION SELECT id FROM capture_vec),
    capture_recency AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.started_at DESC NULLS LAST)::int AS rnk
        FROM public.captures c JOIN capture_union u ON u.id = c.id
    ),
    capture_final AS (
        SELECT
            'capture'::text AS result_type,
            c.id AS result_id,
            c.title,
            p_w_fts    * COALESCE(1.0/(60+cf.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+cv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+cr.rnk), 0) AS score,
            c.started_at AS event_at,
            cf.rnk AS fts_rank, cv.rnk AS vec_rank, cr.rnk AS recency_rank,
            (SELECT chunk_text FROM public.capture_chunks
             WHERE capture_id = c.id ORDER BY (source = 'summary') DESC, chunk_index ASC LIMIT 1) AS excerpt,
            'Capture'::text AS source_label,
            'capture'::text AS source_type,
            jsonb_build_object(
                'duration_seconds', c.duration_seconds, 'project_id', c.project_id,
                'series_key', c.series_key, 'occurrence_start', c.occurrence_start,
                'calendar_event_id', c.calendar_event_id
            ) AS metadata
        FROM public.captures c
        JOIN capture_union u ON u.id = c.id
        LEFT JOIN capture_fts cf ON cf.id = c.id
        LEFT JOIN capture_vec cv ON cv.id = c.id
        LEFT JOIN capture_recency cr ON cr.id = c.id
        WHERE NOT c.is_eval
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester) OR c.id = ANY(v_granted_captures))
    ),

    -- ============ DOCUMENTS (FTS + vector + recency) ============
    -- 365: documents are found wherever they match. No default window reaches
    -- them (the app passes none for documents); an explicit p_since/p_until
    -- filters by updated_at, the last time the text changed, not by when the
    -- document was created. Archived documents are left out. The excerpt is
    -- the passage that matched (the nearest chunk, else the chunk the query's
    -- words rank best in, else a headline around them), with its section.
    document_fts AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY ts_rank(d.fts, v_tsquery) DESC)::int AS rnk
        FROM public.document d
        WHERE d.workspace_id = p_workspace_id AND 'document' = ANY(p_types)
          AND d.status <> 'archived'
          AND (d.visibility = 'workspace' OR (v_requester_member IS NOT NULL AND d.created_by = v_requester_member) OR d.id = ANY(v_granted_documents))
          AND v_tsquery IS NOT NULL AND d.fts @@ v_tsquery
          AND (p_since IS NULL OR d.updated_at >= p_since)
          AND (p_until IS NULL OR d.updated_at <= p_until)
        LIMIT p_candidate_k
    ),
    document_vec_chunks AS (
        SELECT dc.document_id AS id, dc.id AS chunk_id,
               ROW_NUMBER() OVER (ORDER BY dc.embedding <=> v_embedding) AS rnk
        FROM public.document_chunks dc
        JOIN public.document d ON d.id = dc.document_id
        WHERE dc.workspace_id = p_workspace_id AND d.workspace_id = p_workspace_id
          AND 'document' = ANY(p_types) AND v_embedding IS NOT NULL
          AND d.status <> 'archived'
          AND (d.visibility = 'workspace' OR (v_requester_member IS NOT NULL AND d.created_by = v_requester_member) OR d.id = ANY(v_granted_documents))
          AND (p_since IS NULL OR d.updated_at >= p_since)
          AND (p_until IS NULL OR d.updated_at <= p_until)
        ORDER BY dc.embedding <=> v_embedding
        LIMIT p_candidate_k
    ),
    document_vec AS (
        SELECT DISTINCT ON (id) id, rnk::int AS rnk, chunk_id
        FROM document_vec_chunks
        ORDER BY id, rnk
    ),
    document_union AS (SELECT id FROM document_fts UNION SELECT id FROM document_vec),
    document_recency AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY d.updated_at DESC)::int AS rnk
        FROM public.document d JOIN document_union u ON u.id = d.id
    ),
    document_scored AS (
        SELECT
            d.id AS result_id,
            d.title,
            p_w_fts    * COALESCE(1.0/(60+df.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+dv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+dr.rnk), 0) AS score,
            d.updated_at AS event_at,
            df.rnk AS fts_rank,
            dv.rnk AS vec_rank,
            dr.rnk AS recency_rank,
            dv.chunk_id,
            d.status,
            d.project_id
        FROM public.document d
        JOIN document_union u ON u.id = d.id
        LEFT JOIN document_fts df ON df.id = d.id
        LEFT JOIN document_vec dv ON dv.id = d.id
        LEFT JOIN document_recency dr ON dr.id = d.id
        ORDER BY score DESC
        LIMIT p_limit
    ),
    -- The passage for each document that can still make the list (at most
    -- p_limit of them, so this costs a few chunk reads, not one per candidate).
    document_final AS (
        SELECT
            'document'::text AS result_type,
            ds.result_id,
            ds.title,
            ds.score,
            ds.event_at,
            ds.fts_rank,
            ds.vec_rank,
            ds.recency_rank,
            COALESCE(passage.chunk_text, LEFT(doc.content, 300)) AS excerpt,
            'Document'::text AS source_label,
            'document'::text AS source_type,
            jsonb_build_object('status', ds.status, 'project_id', ds.project_id)
              || CASE WHEN passage.heading IS NOT NULL THEN jsonb_build_object('section', passage.heading) ELSE '{}'::jsonb END
              AS metadata
        FROM document_scored ds
        JOIN public.document doc ON doc.id = ds.result_id
        LEFT JOIN LATERAL (
            SELECT p.chunk_text, p.heading FROM (
                -- The nearest chunk, when the vectors found the document.
                SELECT dc.chunk_text, dc.heading, 0 AS pick
                FROM public.document_chunks dc
                WHERE dc.id = ds.chunk_id AND dc.workspace_id = p_workspace_id
                UNION ALL
                -- Else the chunk the query's words rank best in.
                SELECT b.chunk_text, b.heading, 1 AS pick FROM (
                    SELECT dc.chunk_text, dc.heading
                    FROM public.document_chunks dc
                    WHERE ds.chunk_id IS NULL AND v_tsquery IS NOT NULL
                      AND dc.document_id = ds.result_id AND dc.workspace_id = p_workspace_id
                      AND to_tsvector('english', dc.chunk_text) @@ v_tsquery
                    ORDER BY ts_rank(to_tsvector('english', dc.chunk_text), v_tsquery) DESC, dc.chunk_index
                    LIMIT 1
                ) b
                UNION ALL
                -- Else (a document with no vectors) a headline around the words.
                SELECT ts_headline('english', doc.content, v_tsquery,
                         'StartSel="",StopSel="",MaxFragments=1,MaxWords=45,MinWords=20,FragmentDelimiter=" … "'),
                       NULL::text, 2 AS pick
                WHERE ds.chunk_id IS NULL AND v_tsquery IS NOT NULL AND doc.content IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM public.document_chunks dc2
                       WHERE dc2.document_id = ds.result_id AND dc2.workspace_id = p_workspace_id
                  )
            ) p
            ORDER BY p.pick
            LIMIT 1
        ) passage ON TRUE
    )

    SELECT * FROM claim_final
    UNION ALL SELECT * FROM capture_final
    UNION ALL SELECT * FROM document_final
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

-- ── list_companies_with_stats: the agent's list_companies, the Companies page ───
CREATE OR REPLACE FUNCTION public.list_companies_with_stats(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, domain text, logo_url text, industry text, contact_count bigint, capture_count bigint, last_interaction_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_admin boolean := false;
  v_granted uuid[] := '{}'::uuid[];
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT m.role IN ('owner','admin') INTO v_is_admin
      FROM public.member m
     WHERE m.user_id = p_user_id AND m.workspace_id = p_workspace_id
     LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    -- 506: a company shared with this person (492) is listed though none of
    -- its contacts is visible to them, as the company policy (493) reads it.
    v_granted := public.entity_grant_ids_for('company', p_workspace_id, p_user_id);
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.domain,
    c.logo_url,
    c.industry,
    COUNT(DISTINCT ct.id)          AS contact_count,
    COUNT(DISTINCT cp.capture_id)  AS capture_count,
    MAX(ct.last_interaction_at)    AS last_interaction_at
  FROM public.company c
  LEFT JOIN public.contact ct
    ON ct.company_id = c.id
   AND ct.merged_into_contact_id IS NULL
   AND public.contact_visible_to(ct.id, p_user_id)
  LEFT JOIN public.capture_participant cp
    ON cp.contact_id = ct.id
  WHERE c.workspace_id = p_workspace_id
    AND (p_search IS NULL
         OR c.name   ILIKE '%' || p_search || '%'
         OR c.domain ILIKE '%' || p_search || '%')
  GROUP BY c.id
  HAVING v_is_admin OR COUNT(DISTINCT ct.id) > 0 OR c.id = ANY(v_granted)
  ORDER BY MAX(ct.last_interaction_at) DESC NULLS LAST, c.name ASC
  LIMIT p_limit OFFSET p_offset;
END
$$;

notify pgrst, 'reload schema';
