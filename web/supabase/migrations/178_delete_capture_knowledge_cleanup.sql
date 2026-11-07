-- 178: knowledge-graph cleanup on permanent delete of captures / documents /
-- attachments.
--
-- The permanent-delete paths for captures, documents and attachments did a bare
-- DELETE on the row with NO cleanup of the derived knowledge graph. Because
-- `claim_source.source_id` and `entity_link.{source_id,target_id}` are
-- polymorphic bare UUIDs with NO foreign key (see migration 109), nothing
-- cascades: deleting a capture strands its claims as 100%% evidence-orphaned —
-- every claim_source row of a sole-sourced claim points at a row that no longer
-- exists — yet `claim_chunks` embeddings survive, so those claims keep
-- surfacing via match_claims / RAG / briefs as if they were still grounded.
--
-- `capture_chunks`, `claim_chunks`, and `claim_source` DO cascade off their
-- OWNING row (capture_id / claim_id FKs), so the only leak is the polymorphic
-- provenance that points AT the deleted source.
--
-- Policy (chosen with Liam; greenfield, ~0 users, GDPR-aligned):
-- "permanently delete" means the derived knowledge whose ONLY evidence was this
-- source is deleted too. So we HARD-DELETE claims that are sole-sourced by the
-- deleted source (claim_source + claim_chunks cascade via claim_id), delete
-- their entity_link edges, and for SHARED claims (evidence from elsewhere too)
-- we prune only the claim_source rows + mirrored entity_link edges pointing at
-- the deleted source — the claim itself survives on its remaining evidence.
-- We also delete any entity_link edge whose endpoint is the deleted source
-- itself (capture / document / attachment).
--
-- This mirrors the sole-vs-shared partition migration 155 uses for capture
-- MOVES (GROUP BY claim_id HAVING bool_and(...) over the claim's evidence).
--
-- Three source dimensions:
--   * capture     — the capture PLUS its attachments (attachments.note_id).
--                   An attachment-sourced claim belongs to the capture.
--   * document    — the document only (no attachment dimension).
--   * attachment  — a single attachment only.
--
-- All three share one internal worker, `_cleanup_claim_provenance`, which takes
-- the set of (source_type, source_id) pairs that count as "this source" and
-- does the partition + delete atomically. The public RPCs add the auth /
-- ownership gate and (for capture/document) delete the owning row too so the
-- whole operation is one transaction.

-- ───────────────────────────────────────────────────────────────
-- Internal worker. NOT security-defined on its own behalf — callers below are
-- SECURITY DEFINER and have already authorized. EXECUTE is explicitly revoked
-- from PUBLIC/anon/authenticated/service_role below (new functions default-
-- grant to PUBLIC — the same hole 111/117/126 kept re-fixing), so it can only
-- be reached through the vetted wrappers (which run as the function owner).
--
-- p_workspace_id  — claims/edges are scoped to this workspace.
-- p_source_pairs  — JSONB array of {"t": source_type, "id": uuid}. These are
--                   the sources whose provenance we are tearing down (the
--                   capture + its attachments, or a document, or one
--                   attachment). Rows are matched by (source_type, source_id).
--
-- Returns a counts object.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._cleanup_claim_provenance(
  p_workspace_id UUID,
  p_source_pairs JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pairs_deleted_claims INT := 0;
  v_pruned_shared_claims INT := 0;
  v_linked_claim_ids UUID[] := '{}';
  v_sole_claim_ids UUID[] := '{}';
BEGIN
  -- Materialize the source pairs into a temp set we can join against. Each
  -- element is {"t": "<source_type>", "id": "<uuid>"}.
  CREATE TEMP TABLE _cleanup_sources ON COMMIT DROP AS
  SELECT (elem->>'t')::text AS source_type,
         (elem->>'id')::uuid AS source_id
  FROM jsonb_array_elements(COALESCE(p_source_pairs, '[]'::jsonb)) AS elem;

  -- Every claim (in this workspace) that has ANY evidence pointing at one of
  -- these sources.
  SELECT COALESCE(array_agg(DISTINCT cs.claim_id), '{}')
  INTO v_linked_claim_ids
  FROM public.claim_source cs
  JOIN public.claim c ON c.id = cs.claim_id
  JOIN _cleanup_sources s
    ON s.source_type = cs.source_type
   AND s.source_id = cs.source_id
  WHERE c.workspace_id = p_workspace_id;

  -- Of those, the SOLE-SOURCED ones: EVERY claim_source row of the claim points
  -- at one of the deleted sources. bool_and over the claim's full evidence set
  -- (same shape as migration 155's move partition).
  IF cardinality(v_linked_claim_ids) > 0 THEN
    SELECT COALESCE(array_agg(claim_id), '{}')
    INTO v_sole_claim_ids
    FROM (
      SELECT cs.claim_id
      FROM public.claim_source cs
      WHERE cs.claim_id = ANY(v_linked_claim_ids)
      GROUP BY cs.claim_id
      HAVING bool_and(
        EXISTS (
          SELECT 1 FROM _cleanup_sources s
          WHERE s.source_type = cs.source_type
            AND s.source_id = cs.source_id
        )
      )
    ) sole;
  END IF;

  -- ── Sole-sourced claims: hard-delete. claim_source + claim_chunks cascade
  --    via their claim_id FK. First delete every entity_link edge touching one
  --    of these claim ids (as source OR target), since edges don't cascade.
  IF cardinality(v_sole_claim_ids) > 0 THEN
    DELETE FROM public.entity_link el
    WHERE el.workspace_id = p_workspace_id
      AND (
        (el.source_type = 'claim' AND el.source_id = ANY(v_sole_claim_ids))
        OR (el.target_type = 'claim' AND el.target_id = ANY(v_sole_claim_ids))
      );

    DELETE FROM public.claim c
    WHERE c.id = ANY(v_sole_claim_ids);
    GET DIAGNOSTICS v_pairs_deleted_claims = ROW_COUNT;
  END IF;

  -- ── Shared claims (linked but not sole-sourced): keep the claim, but prune
  --    the evidence + mirrored edges pointing at the deleted sources.
  --    (a) claim_source rows for the shared claims that point at a deleted src
  DELETE FROM public.claim_source cs
  USING _cleanup_sources s
  WHERE cs.source_type = s.source_type
    AND cs.source_id = s.source_id
    AND cs.claim_id = ANY(v_linked_claim_ids)
    AND NOT (cs.claim_id = ANY(v_sole_claim_ids));

  --    (b) mirrored entity_link edges claim→deleted-source (relation cites/about
  --        etc.) for the surviving shared claims. The claim is the source_type
  --        of the mirror edge (see attachClaimProvenance); we also catch the
  --        reverse direction defensively.
  WITH shared_claims AS (
    SELECT unnest(v_linked_claim_ids) AS claim_id
    EXCEPT
    SELECT unnest(v_sole_claim_ids)
  )
  DELETE FROM public.entity_link el
  USING _cleanup_sources s, shared_claims sc
  WHERE el.workspace_id = p_workspace_id
    AND (
      (el.source_type = 'claim' AND el.source_id = sc.claim_id
        AND el.target_type = s.source_type AND el.target_id = s.source_id)
      OR
      (el.target_type = 'claim' AND el.target_id = sc.claim_id
        AND el.source_type = s.source_type AND el.source_id = s.source_id)
    );
  GET DIAGNOSTICS v_pruned_shared_claims = ROW_COUNT;

  -- ── Finally, any entity_link edge whose endpoint IS one of the deleted
  --    sources itself (e.g. capture↔contact, attachment↔project). Nothing
  --    cascades these, and the source row is about to vanish.
  DELETE FROM public.entity_link el
  USING _cleanup_sources s
  WHERE el.workspace_id = p_workspace_id
    AND (
      (el.source_type = s.source_type AND el.source_id = s.source_id)
      OR (el.target_type = s.source_type AND el.target_id = s.source_id)
    );

  DROP TABLE IF EXISTS _cleanup_sources;

  RETURN jsonb_build_object(
    'linked_claims', cardinality(v_linked_claim_ids),
    'deleted_sole_claims', v_pairs_deleted_claims,
    'pruned_shared_claim_edges', v_pruned_shared_claims
  );
END;
$$;

-- Lock the worker down: reachable only via the SECURITY DEFINER wrappers below
-- (which execute as the function owner and need no grant).
REVOKE EXECUTE ON FUNCTION public._cleanup_claim_provenance(UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────
-- Public: delete a capture + its knowledge graph, atomically.
-- Owner-only (captures.user_id = auth.uid()), workspace-scoped — mirrors the
-- route's existing permanent-delete guard. SECURITY DEFINER because the worker
-- and the cross-table deletes bypass RLS; we authorize explicitly.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_capture_with_knowledge(
  p_capture_id UUID,
  p_workspace_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_owner UUID;
  v_attachment_ids UUID[] := '{}';
  v_pairs JSONB;
  v_cleanup JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Lock the capture and verify existence + ownership + workspace.
  SELECT user_id INTO v_owner
  FROM public.captures
  WHERE id = p_capture_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'capture not found' USING ERRCODE = 'P0002';
  END IF;

  -- Permanent delete is owner-only (matches the route's .eq('user_id', ...)).
  IF v_owner <> v_user_id THEN
    RAISE EXCEPTION 'not the capture owner' USING ERRCODE = '42501';
  END IF;

  -- The capture's attachments count as part of the capture: an
  -- attachment-sourced claim belongs to the capture (same as migration 155).
  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
  FROM public.attachments
  WHERE note_id = p_capture_id;

  -- Build the (source_type, source_id) pair set: the capture + each attachment.
  v_pairs := jsonb_build_array(jsonb_build_object('t', 'capture', 'id', p_capture_id));
  IF cardinality(v_attachment_ids) > 0 THEN
    v_pairs := v_pairs || (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('t', 'attachment', 'id', aid)), '[]'::jsonb)
      FROM unnest(v_attachment_ids) AS aid
    );
  END IF;

  v_cleanup := public._cleanup_claim_provenance(p_workspace_id, v_pairs);

  -- Delete the capture row. capture_chunks, decisions, capture_participant,
  -- capture_label, attachments (+ attachment_chunks) cascade via their FKs.
  -- actions.source_note_id is ON DELETE SET NULL, so actions survive unlinked.
  DELETE FROM public.captures
  WHERE id = p_capture_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'capture_id', p_capture_id,
    'attachments', cardinality(v_attachment_ids),
    'cleanup', v_cleanup
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_capture_with_knowledge(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_capture_with_knowledge(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.delete_capture_with_knowledge(UUID, UUID) IS
  'Permanently delete a capture (owner-only) plus its knowledge-graph '
  'provenance: hard-delete claims sole-sourced by this capture or its '
  'attachments, prune shared-claim evidence + mirrored edges, and delete '
  'entity_link edges touching the capture/attachments. Atomic.';

-- ───────────────────────────────────────────────────────────────
-- Public: delete a document + its knowledge graph, atomically.
-- Workspace-member scoped (matches the document route — any member may delete),
-- no attachment dimension.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_document_with_knowledge(
  p_document_id UUID,
  p_workspace_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_exists BOOLEAN;
  v_cleanup JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'not a member of workspace' USING ERRCODE = '42501';
  END IF;

  SELECT TRUE INTO v_exists
  FROM public.document
  WHERE id = p_document_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'P0002';
  END IF;

  v_cleanup := public._cleanup_claim_provenance(
    p_workspace_id,
    jsonb_build_array(jsonb_build_object('t', 'document', 'id', p_document_id))
  );

  DELETE FROM public.document
  WHERE id = p_document_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'document_id', p_document_id,
    'cleanup', v_cleanup
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_document_with_knowledge(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_document_with_knowledge(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.delete_document_with_knowledge(UUID, UUID) IS
  'Permanently delete a document (workspace-member scoped) plus its '
  'knowledge-graph provenance, mirroring delete_capture_with_knowledge '
  'without the attachment dimension. Atomic.';

-- ───────────────────────────────────────────────────────────────
-- Public: clean the knowledge graph for a single attachment. Does NOT delete
-- the attachment row — the attachment route still owns storage removal and the
-- row delete; this only tears down claim provenance + edges. Workspace-member
-- scoped (matches the attachment route's RLS).
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_attachment_knowledge(
  p_attachment_id UUID,
  p_workspace_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'not a member of workspace' USING ERRCODE = '42501';
  END IF;

  RETURN public._cleanup_claim_provenance(
    p_workspace_id,
    jsonb_build_array(jsonb_build_object('t', 'attachment', 'id', p_attachment_id))
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_attachment_knowledge(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_attachment_knowledge(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.cleanup_attachment_knowledge(UUID, UUID) IS
  'Tear down knowledge-graph provenance for one attachment (hard-delete '
  'sole-sourced claims, prune shared evidence + edges). Does NOT delete the '
  'attachment row — the caller does that after storage removal.';
