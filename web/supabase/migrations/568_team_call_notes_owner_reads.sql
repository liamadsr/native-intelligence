-- ============================================================
-- 568: A call's notes follow their conversation in every read that names
-- its owner (calls plan, phase 6). 566's restrictive policy fences reads
-- under RLS; these four functions are SECURITY DEFINER and read captures with
-- an owner arm of their own (`c.user_id = requester`), so an owner who left
-- the conversation (taken off the channel's team, out of the DM, or the
-- channel deleted) still read their call's notes through them: search, the
-- knowledge graph's claims, the agent's tools.
-- ============================================================
--   team_call_notes_open_to(channel, workspace, user)  a call's notes
--                     (captures.notes_channel_id) are open to this user: no
--                     notes channel (any other capture), or the user's member
--                     in that workspace may read the channel now (556's
--                     team_chat_member_can_read: a deleted channel reads as
--                     no one's).
--   Redefined, each from its CURRENT body with only the owner arm changed
--   (`X.user_id = requester` becomes `(X.user_id = requester AND
--   public.team_call_notes_open_to(X.notes_channel_id, X.workspace_id,
--   requester))`, for every captures alias):
--     capture_visible_to(uuid, uuid)   from 223_capture_visibility.sql
--     claim_visible_to(uuid, uuid)     from 369_document_visibility.sql
--     unified_search(...)              from 506_agent_reads_shared_records.sql
--     hybrid_search(...)               from 506_agent_reads_shared_records.sql
--   team_call_notes_refresh_owners(channels)  captures.notes_owner_out (566)
--                     recomputed for those channels' notes; triggers on
--                     team_member, team_chat_member, team_chat_channel and
--                     member keep it true as membership changes. The agent's
--                     tools (src/lib/ai/tools/_shared.ts) read it.
--   WARNING: a later migration that redefines any of these four must carry
--   the same condition on its owner arm, or call notes leak to an owner who
--   left their conversation.
--
-- Additive (one new function; four bodies replaced with the same signatures,
-- so their grants stay). Safe on a live database: the new arm only narrows
-- rows whose captures.notes_channel_id is set, and only 566's call notes set
-- it. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

create or replace function public.team_call_notes_open_to(p_channel uuid, p_workspace uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_channel is null
      or (p_user is not null and exists (
            select 1 from public.member m
             where m.user_id = p_user
               and m.workspace_id = p_workspace
               and public.team_chat_member_can_read(p_channel, m.id)
          ));
$$;

revoke all on function public.team_call_notes_open_to(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.team_call_notes_open_to(uuid, uuid, uuid) to service_role;

-- captures.notes_owner_out (566), kept true to the conversation's membership: recomputed for the
-- notes of these channels (only rows whose answer changed are written). 566's guard lets this
-- write through (team_call_notes.refresh), whoever's change set it off.
create or replace function public.team_call_notes_refresh_owners(p_channels uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer := 0;
begin
  if coalesce(cardinality(p_channels), 0) = 0 then
    return 0;
  end if;
  perform set_config('team_call_notes.refresh', 'on', true);
  update public.captures c
     set notes_owner_out = not public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, c.user_id)
   where c.notes_channel_id = any (p_channels)
     and c.notes_owner_out is distinct from (not public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, c.user_id));
  get diagnostics n = row_count;
  perform set_config('team_call_notes.refresh', 'off', true);
  return n;
end;
$$;

revoke all on function public.team_call_notes_refresh_owners(uuid[]) from public, anon, authenticated;
grant execute on function public.team_call_notes_refresh_owners(uuid[]) to service_role;

-- Whatever changes who may read a conversation changes who may read its notes: a team's members,
-- a DM's members, a channel's team or its deletion, a member leaving or joining the workspace.
create or replace function public.team_call_notes_owner_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  chans uuid[];
begin
  if tg_table_name = 'team_member' then
    select coalesce(array_agg(c.id), '{}') into chans from public.team_chat_channel c
     where c.team_id = coalesce(new.team_id, old.team_id);
  elsif tg_table_name = 'team_chat_member' then
    chans := array[coalesce(new.channel_id, old.channel_id)];
  elsif tg_table_name = 'team_chat_channel' then
    chans := array[coalesce(new.id, old.id)];
  elsif tg_table_name = 'member' then
    select coalesce(array_agg(distinct x.notes_channel_id), '{}') into chans from public.captures x
     where x.user_id = coalesce(new.user_id, old.user_id)
       and x.workspace_id = coalesce(new.workspace_id, old.workspace_id)
       and x.notes_channel_id is not null;
  end if;
  perform public.team_call_notes_refresh_owners(chans);
  return null;
end;
$$;

revoke all on function public.team_call_notes_owner_sync() from public, anon, authenticated;

drop trigger if exists team_call_notes_owner_sync on public.team_member;
create trigger team_call_notes_owner_sync after insert or delete on public.team_member
  for each row execute function public.team_call_notes_owner_sync();
drop trigger if exists team_call_notes_owner_sync on public.team_chat_member;
create trigger team_call_notes_owner_sync after insert or delete on public.team_chat_member
  for each row execute function public.team_call_notes_owner_sync();
drop trigger if exists team_call_notes_owner_sync on public.team_chat_channel;
create trigger team_call_notes_owner_sync after update of team_id, kind or delete on public.team_chat_channel
  for each row execute function public.team_call_notes_owner_sync();
drop trigger if exists team_call_notes_owner_sync on public.member;
create trigger team_call_notes_owner_sync after insert or delete on public.member
  for each row execute function public.team_call_notes_owner_sync();


-- ── capture_visible_to: 223_capture_visibility.sql's body, the owner arm only changed (1 place) ──

CREATE OR REPLACE FUNCTION public.capture_visible_to(
  p_capture_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = p_capture_id
      AND (c.visibility = 'workspace'
           OR (p_user_id IS NOT NULL AND (c.user_id = p_user_id AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, p_user_id))))
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- ── claim_visible_to: 369_document_visibility.sql's body, the owner arm only changed (2 places) ──

CREATE OR REPLACE FUNCTION public.claim_visible_to(
  p_claim_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT
    -- 341: a claim learned from mail is visible to no one.
    NOT EXISTS (
      SELECT 1 FROM public.claim_source cs
      WHERE cs.claim_id = p_claim_id
        AND cs.source_type = 'email'
    )
    AND (
      NOT EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = p_claim_id)
      OR EXISTS (
        SELECT 1 FROM public.claim_source cs
        WHERE cs.claim_id = p_claim_id
          AND CASE cs.source_type
            WHEN 'capture' THEN EXISTS (
              SELECT 1 FROM public.captures c
              WHERE c.id = cs.source_id
                AND NOT c.is_eval
                AND (c.visibility = 'workspace'
                     OR (p_user_id IS NOT NULL AND (c.user_id = p_user_id AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, p_user_id))))
            )
            WHEN 'attachment' THEN EXISTS (
              SELECT 1 FROM public.attachments a
              WHERE a.id = cs.source_id
                AND (
                  a.note_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM public.captures c
                    WHERE c.id = a.note_id
                      AND NOT c.is_eval
                      AND (c.visibility = 'workspace'
                           OR (p_user_id IS NOT NULL AND (c.user_id = p_user_id AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, p_user_id))))
                  )
                )
            )
            -- 353: a chat is only its owner's.
            WHEN 'conversation' THEN EXISTS (
              SELECT 1 FROM public.chat_conversations cc
              WHERE cc.id = cs.source_id
                AND p_user_id IS NOT NULL
                AND cc.user_id = p_user_id
            )
            WHEN 'email' THEN FALSE
            -- 369: a private document is its creator's alone.
            WHEN 'document' THEN public.document_visible_to(cs.source_id, p_user_id)
            ELSE TRUE
          END
      )
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- ── unified_search: 506_agent_reads_shared_records.sql's body, the owner arm only changed (2 places) ──

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
    AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND (c.user_id = v_requester AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, v_requester))) OR c.id = ANY(v_granted_captures))

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
         OR (v_requester IS NOT NULL AND (c.user_id = v_requester AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, v_requester)))
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

-- ── hybrid_search: 506_agent_reads_shared_records.sql's body, the owner arm only changed (5 places) ──

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
                         OR (v_requester IS NOT NULL AND (cap2.user_id = v_requester AND public.team_call_notes_open_to(cap2.notes_channel_id, cap2.workspace_id, v_requester))))
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
                                   OR (v_requester IS NOT NULL AND (cap3.user_id = v_requester AND public.team_call_notes_open_to(cap3.notes_channel_id, cap3.workspace_id, v_requester))))
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
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND (c.user_id = v_requester AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, v_requester))) OR c.id = ANY(v_granted_captures))
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
              AND (cap.visibility = 'workspace' OR (v_requester IS NOT NULL AND (cap.user_id = v_requester AND public.team_call_notes_open_to(cap.notes_channel_id, cap.workspace_id, v_requester))) OR cap.id = ANY(v_granted_captures))
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
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND (c.user_id = v_requester AND public.team_call_notes_open_to(c.notes_channel_id, c.workspace_id, v_requester))) OR c.id = ANY(v_granted_captures))
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

notify pgrst, 'reload schema';

commit;
