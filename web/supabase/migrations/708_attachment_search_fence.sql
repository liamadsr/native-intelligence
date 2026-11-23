-- ============================================================
-- 708: semantic search over a file's text reads files as the attachments
-- table does.
-- ============================================================
-- THE LEAK. Two SECURITY DEFINER functions search attachment_chunks and
-- return each hit's file name, a text excerpt and its storage path:
--   hybrid_search_attachments   (275, the newest) - the agents' `find`
--   attachment_rag_search       (223, the newest) - `deep_search`
-- Both fence a file only through its CAPTURE (a.note_id). A file can also
-- belong to a table's row (663: attachments.data_row_id, including a file a
-- stranger sent through a form), and the table's restrictive
-- attachments_row_select (663) hides such a file from anyone who may not
-- read the row's table. The two functions never asked: every file on a
-- PRIVATE table's row came back to any member of the workspace, by name and
-- text, through find, deep_search and the agents. That held for a member
-- with no access to the table, for the service role naming them, and with no
-- requester at all; and for a file the member had uploaded themself to a row
-- of a table that is now private (the restrictive policy beats the uploader's
-- own read). attachment_rag_search's chunk-user keying is no fence: the chunk
-- carries whoever indexed it.
--
-- Files on an action or on a project were NOT a leak by the table's rule:
-- attachments_workspace_select (493) shows a file on no capture to every
-- member, actions_select and projects_select are workspace-wide (028), and
-- projects have no private setting. Search keeps showing them, as the table
-- does. If a private project or a team-only action read ever lands, it
-- belongs in the attachments read policies first, and then in the helper
-- below, which is the one place this family asks.
--
-- Search also showed LESS than the table in two places, now aligned: a file
-- on a private capture shared with the searcher (entity_access, 492) and a
-- searcher's own upload on someone else's private capture (baseline's
-- attachments_user_select) are theirs to read, and are now found.
--
-- THE FIX. One helper, public.attachment_readable_by(attachment_id, user_id),
-- answers what the attachments table's read policies answer for that user
-- (an explicit-user restatement, as 664's entity_visible_to attachment arm and
-- src/lib/attachments/visibility.ts are):
--   restrictive attachments_row_select (663): a file on a table's row only
--     when the user may read that table (520's data_table_visible_to: the
--     workspace's, the owner's, or one a grant reaches, 492/601);
--   AND one of the permissive rules:
--     attachments_user_select (baseline): the user uploaded it;
--     attachments_workspace_select (493): the user is a member of its
--       workspace, and it is on no capture, or on a capture that is the
--       workspace's, the user's own, or one a grant reaches them for
--       (entity_grant_reaches, 492's explicit-user twin of has_entity_grant).
-- Per parent kind: capture - the capture's rule; action, project - every
-- member's; table row - the table's readers only, whoever uploaded it.
--
-- NO REQUESTER (p_user_id null: an unattended run on the service role, whose
-- output the whole workspace reads): only what every member reads, the rule
-- 664's entity_visible_to and visibility.ts already give such a run:
--   capture - only a workspace capture's file;
--   action, project - shown (every member's);
--   table row - never, not even a workspace table's (a row is no one's on such
--     a run). That is narrower than before, where every row's file came back.
-- A signed-in caller may ask the helper only about themself (anything else
-- answers false), so it is no oracle for another person's access.
--
-- Each function is restated from its newest definition on main with only its
-- capture fence replaced by the helper:
--   hybrid_search_attachments from 275_requester_identity_search_rpcs.sql:
--     the helper on v_requester; 252's `NOT c.is_eval` kept beside it (an eval
--     capture's files stay out of search, as before); 275's requester
--     resolution and membership gate unchanged.
--   attachment_rag_search from 223_capture_visibility.sql: the helper on
--     v_user_id; the chunk-user keying, the auth.uid() guard and the project
--     filter unchanged.
-- Signatures unchanged; the REVOKE/GRANT pairs are restated anyway (126, 275).
-- The candidate cut (hybrid's LIMIT p_candidate_k, rag's LIMIT p_limit) is
-- taken after the fence, as before, so a reader's results are the same as
-- before and a non-reader's are the rest.
--
-- src/lib/__tests__/migration-708.test.ts pins this; it fails if a later
-- restatement of either function drops the helper.
-- supabase/tests/708_attachment_search_fence.sql runs it as several people.
--
-- After 663 and 693. No begin/commit of its own (production applies a file
-- with psql --single-transaction). Re-runnable: create or replace throughout,
-- no drop, no signature change. No backslash anywhere in this file. Each
-- statement waits at most 5 s for a lock, and one that waits longer rolls the
-- file back, to be applied again.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- The helper
-- ------------------------------------------------------------
create or replace function public.attachment_readable_by(p_attachment_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- A signed-in caller asks only about themself.
    (auth.uid() is null or p_user_id is not distinct from auth.uid())
    and coalesce((
      select
        -- restrictive attachments_row_select (663): a row's file is its table's
        -- readers' alone; with no requester, no one's.
        (a.data_row_id is null
          or (p_user_id is not null and exists (
                select 1 from public.data_row r
                 where r.id = a.data_row_id
                   and public.data_table_visible_to(r.table_id, p_user_id))))
        and (
          -- attachments_user_select (baseline): the uploader's own.
          (p_user_id is not null and a.user_id = p_user_id)
          -- attachments_workspace_select (493): a member's, through its capture.
          or (
            (p_user_id is null
              or exists (select 1 from public.member m where m.workspace_id = a.workspace_id and m.user_id = p_user_id))
            and (
              a.note_id is null
              or exists (
                select 1 from public.captures c
                 where c.id = a.note_id
                   and (c.visibility = 'workspace'
                        or (p_user_id is not null
                            and (c.user_id = p_user_id
                                 or public.entity_grant_reaches('capture', c.id, c.workspace_id, p_user_id)))))
            )
          )
        )
        from public.attachments a
       where a.id = p_attachment_id
    ), false);
$$;

comment on function public.attachment_readable_by(uuid, uuid) is
  'May p_user_id read this file: the attachments table''s read policies (493, 663, baseline) for an explicit user (708). Null user: only what every member reads (no table row''s file).';

revoke all on function public.attachment_readable_by(uuid, uuid) from public, anon;
grant execute on function public.attachment_readable_by(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- hybrid_search_attachments, from 275_requester_identity_search_rpcs.sql
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hybrid_search_attachments(
    p_workspace_id   UUID,
    p_embedding      TEXT DEFAULT NULL,           -- Gemini 3072-d as '[..]' text; NULL → no results
    p_since          TIMESTAMPTZ DEFAULT NULL,
    p_until          TIMESTAMPTZ DEFAULT NULL,
    p_limit          INTEGER DEFAULT 20,
    p_candidate_k    INTEGER DEFAULT 40,
    p_w_vec          DOUBLE PRECISION DEFAULT 1.0,
    p_w_recent       DOUBLE PRECISION DEFAULT 0.5,
    p_requesting_user_id UUID DEFAULT NULL        -- NULL → auth.uid(); still NULL → workspace-visible files only
)
RETURNS TABLE(
    result_type   TEXT,
    result_id     UUID,
    title         TEXT,
    score         DOUBLE PRECISION,
    event_at      TIMESTAMPTZ,
    fts_rank      INTEGER,
    vec_rank      INTEGER,
    recency_rank  INTEGER,
    excerpt       TEXT,
    source_label  TEXT,
    source_type   TEXT,
    metadata      JSONB
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_embedding halfvec(3072) := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding::halfvec(3072) END;
    v_requester uuid := public._resolve_visibility_requester(p_requesting_user_id);
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
        RETURN;
    END IF;

    IF v_embedding IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH
    -- Best-ranking chunk per attachment (an attachment has many chunks; we fuse
    -- at the attachment level, not the chunk level).
    attachment_vec AS (
        SELECT id, MIN(rnk)::int AS rnk, (ARRAY_AGG(chunk_text ORDER BY rnk))[1] AS excerpt
        FROM (
            SELECT ac.attachment_id AS id, ac.chunk_text,
                   ROW_NUMBER() OVER (ORDER BY ac.embedding <=> v_embedding) AS rnk
            FROM public.attachment_chunks ac
            JOIN public.attachments a ON a.id = ac.attachment_id
            WHERE ac.workspace_id = p_workspace_id AND ac.embedding IS NOT NULL
              AND (p_since IS NULL OR a.created_at >= p_since)
              AND (p_until IS NULL OR a.created_at <= p_until)
              -- 252: an eval capture's files stay out of search.
              AND (
                  a.note_id IS NULL
                  OR EXISTS (SELECT 1 FROM public.captures c WHERE c.id = a.note_id AND NOT c.is_eval)
              )
              -- 708: the attachments table's own read rule, every parent kind.
              AND public.attachment_readable_by(a.id, v_requester)
            ORDER BY ac.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    attachment_recency AS (
        SELECT a.id, ROW_NUMBER() OVER (ORDER BY a.created_at DESC NULLS LAST)::int AS rnk
        FROM public.attachments a JOIN attachment_vec u ON u.id = a.id
    )
    SELECT
        'attachment'::text AS result_type,
        a.id AS result_id,
        a.file_name AS title,
        p_w_vec    * COALESCE(1.0/(60+av.rnk), 0) +
        p_w_recent * COALESCE(1.0/(60+ar.rnk), 0) AS score,
        a.created_at AS event_at,
        NULL::int AS fts_rank,
        av.rnk AS vec_rank,
        ar.rnk AS recency_rank,
        av.excerpt,
        'Attachment'::text AS source_label,
        'attachment'::text AS source_type,
        jsonb_build_object(
            'storage_path', a.storage_path,
            'mime_type', a.mime_type,
            'file_category', a.file_category,
            'parent_capture_id', a.note_id,
            'parent_action_id', a.action_id,
            'project_id', a.project_id
        ) AS metadata
    FROM public.attachments a
    JOIN attachment_vec av ON av.id = a.id
    LEFT JOIN attachment_recency ar ON ar.id = a.id
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- attachment_rag_search, from 223_capture_visibility.sql
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attachment_rag_search(
    p_user_id TEXT,
    p_embedding TEXT,
    p_workspace_id TEXT DEFAULT NULL,
    p_project_ids TEXT[] DEFAULT '{}',
    p_limit INTEGER DEFAULT 10,
    p_threshold DOUBLE PRECISION DEFAULT 0.3
)
RETURNS TABLE(
    chunk_id UUID,
    attachment_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_type TEXT,
    page_number INTEGER,
    file_name TEXT,
    file_category TEXT,
    mime_type TEXT,
    storage_path TEXT,
    parent_capture_id UUID,
    parent_action_id UUID,
    similarity DOUBLE PRECISION
) AS $$
DECLARE
    v_user_id UUID := p_user_id::UUID;
    v_embedding halfvec(3072) := p_embedding::halfvec(3072);
    v_workspace_id UUID := CASE WHEN p_workspace_id IS NOT NULL THEN p_workspace_id::UUID ELSE NULL END;
    v_has_project_filter BOOLEAN := COALESCE(array_length(p_project_ids, 1), 0) > 0;
    v_project_ids UUID[];
BEGIN
    IF auth.uid() IS NOT NULL AND auth.uid() <> v_user_id THEN
        RETURN;
    END IF;

    IF v_has_project_filter THEN
        v_project_ids := ARRAY(SELECT unnest(p_project_ids)::UUID);
    END IF;

    RETURN QUERY
    SELECT
        ac.id as chunk_id,
        ac.attachment_id,
        ac.project_id,
        ac.chunk_text,
        ac.chunk_type,
        ac.page_number,
        a.file_name,
        a.file_category,
        a.mime_type,
        a.storage_path,
        a.note_id as parent_capture_id,
        a.action_id as parent_action_id,
        1 - (ac.embedding <=> v_embedding) as similarity
    FROM attachment_chunks ac
    JOIN attachments a ON a.id = ac.attachment_id
    WHERE ac.user_id = v_user_id
      AND ac.embedding IS NOT NULL
      AND 1 - (ac.embedding <=> v_embedding) >= p_threshold
      AND (v_workspace_id IS NULL OR ac.workspace_id = v_workspace_id)
      -- 708 (was 223's capture-only EXISTS): chunk ownership is not access;
      -- the attachments table's own read rule decides, every parent kind.
      AND public.attachment_readable_by(a.id, v_user_id)
      AND (
          NOT v_has_project_filter
          OR ac.project_id = ANY(v_project_ids)
      )
    ORDER BY ac.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.attachment_rag_search(TEXT, TEXT, TEXT, TEXT[], INTEGER, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attachment_rag_search(TEXT, TEXT, TEXT, TEXT[], INTEGER, DOUBLE PRECISION) TO authenticated, service_role;

notify pgrst, 'reload schema';
