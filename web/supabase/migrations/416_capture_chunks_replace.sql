-- ============================================================
-- 416: a capture's chunks are swapped in one transaction, one re-index at a
-- time (the capture half of what 365 did for documents).
-- ============================================================
-- indexCapture (src/lib/ai/embeddings.ts) embedded a capture's text and then
-- deleted its chunks and inserted the new ones as two separate requests. Two
-- runs that overlap (the finish-recording index and an edit's re-index, or an
-- Inngest retry beside the first attempt) can both delete before either
-- inserts, and then both insert: the capture ends up with every chunk twice.
-- Search returns the same passage twice and the capture weighs double in
-- hybrid_search. On DEV (2026-10-21) 226 (capture_id, chunk_index) groups
-- hold more than one row.
--
-- This changes three things:
--   1. Existing duplicates go: per (capture_id, chunk_index) the newest row
--      stays (created_at, then id), the rest are deleted. A duplicated group
--      came from runs over the same text, so the newest row is the one the
--      last run wrote.
--   2. capture_chunks gets a unique index on (capture_id, chunk_index), so
--      a duplicate can never be written again: a racing old-style
--      delete-then-insert now fails its insert (23505) instead of doubling.
--   3. replace_capture_chunks(capture, workspace, rows): deletes the
--      capture's chunks and inserts the new ones in one transaction,
--      serialized per capture (advisory lock), so the second of two
--      overlapping runs replaces the first instead of adding to it. It
--      refuses a capture that is not in the workspace it names (42501) and
--      files every row under that capture and workspace whatever the rows
--      say. SECURITY INVOKER: RLS on capture_chunks applies as it did to the
--      old delete-then-insert. No embedding reuse (unlike 365): a capture
--      re-index always embeds every chunk before it calls this. Any failure
--      (a bad row, a refused insert) rolls the whole call back, so the old
--      chunks stay.
--
-- Rollout: DEV, then PROD, before or after the app PR (the app calls
-- replace_capture_chunks; without it, it falls back to the old
-- delete-then-insert after embedding).
--
-- Idempotent: the cleanup delete finds nothing the second time, create index
-- if not exists, create or replace. No backslash anywhere in this file (the
-- MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. Remove duplicated chunks (keep the newest per capture and index)
-- ------------------------------------------------------------

DELETE FROM public.capture_chunks cc
 USING (
    SELECT id,
           row_number() OVER (
               PARTITION BY capture_id, chunk_index
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) AS rn
      FROM public.capture_chunks
 ) ranked
 WHERE cc.id = ranked.id
   AND ranked.rn > 1;

-- ------------------------------------------------------------
-- 2. One row per capture and chunk index
-- ------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS capture_chunks_capture_id_chunk_index_key
    ON public.capture_chunks (capture_id, chunk_index);

-- ------------------------------------------------------------
-- 3. replace_capture_chunks
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_capture_chunks(
    p_capture_id   UUID,
    p_workspace_id UUID,
    p_rows         JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    -- The capture must be in the workspace the chunks are filed under (read
    -- as the caller: RLS applies). Chunks never cross workspaces.
    IF NOT EXISTS (
        SELECT 1 FROM public.captures c
         WHERE c.id = p_capture_id AND c.workspace_id = p_workspace_id
    ) THEN
        RAISE EXCEPTION 'capture % is not in workspace %', p_capture_id, p_workspace_id
          USING ERRCODE = '42501';
    END IF;

    -- One re-index of a capture at a time: a second run waits here and then
    -- replaces what the first wrote.
    PERFORM pg_advisory_xact_lock(hashtext('capture_chunks:' || p_capture_id::text));

    DELETE FROM public.capture_chunks
     WHERE capture_id = p_capture_id;

    INSERT INTO public.capture_chunks (capture_id, user_id, project_id, workspace_id, chunk_index, chunk_text, source, embedding)
    SELECT
        p_capture_id,
        (r ->> 'user_id')::uuid,
        NULLIF(r ->> 'project_id', '')::uuid,
        p_workspace_id,
        (r ->> 'chunk_index')::int,
        r ->> 'chunk_text',
        COALESCE(NULLIF(r ->> 'source', ''), 'summary'),
        (r ->> 'embedding')::vector(1536)
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_capture_chunks(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_capture_chunks(UUID, UUID, JSONB) TO authenticated, service_role;
