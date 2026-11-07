-- Migration 313: the suggestion lifecycle (docs/plans/suggestions-everywhere.md,
-- Phase 3).
--
-- WHY: nothing ever deleted a proposed_change row. On PROD (2026-10-08) the
-- table held 4,268 rows, 3,314 of them dismissed and 1,826 of those aged out
-- because nobody looked. With agents suggesting from chat, documents and loops
-- the volume grows many times over, so suggestions nobody acts on now leave:
--
--   pending ── expires_at passes ──▶ expired      (expire_stale_suggestions)
--   dismissed / expired ── 60 days after resolved_at ──▶ deleted
--                                                  (purge_resolved_suggestions)
--
-- Applied rows are kept: they record where a task came from, and their volume
-- is bounded by real work. A suggestion that still matters after it's gone is
-- simply staged again; with the row deleted nothing blocks it.
--
-- What lands:
--   expires_at back-fill   pending rows outside a capture get created_at + 30
--                          days (there are none before this feature ships).
--   expire_stale_suggestions(p_now, p_limit)
--                          pending → expired ('ttl') past expires_at, for
--                          suggestions OUTSIDE a capture only, with the same
--                          guards as age_out_stale_proposals (168): never a row
--                          with any trace of an apply. Also expires a run's
--                          suggestions that never got a home ('run_undelivered')
--                          a day on. Capture proposals are untouched: they keep
--                          today's age-out (dismissed + marker, 45 days, 30 for
--                          creates; src/lib/flows/proposal-age-out.ts and
--                          proposal-create-age-out.ts).
--   purge_resolved_suggestions(p_before, p_limit, p_dry_run)
--                          deletes dismissed and expired rows resolved before
--                          p_before, never a demo or eval capture's (the rule
--                          is purgeable_suggestions). p_dry_run counts them and
--                          deletes nothing. The rows pointing here
--                          (attention_item.proposal_id, agent_run.proposal_id)
--                          are ON DELETE SET NULL.
-- All are SECURITY DEFINER and service-role only, like 168.

-- ── Back-fill expires_at on pending rows ────────────────────────────────────
ALTER TABLE public.proposed_change DISABLE TRIGGER trg_proposed_change_updated_at;
UPDATE public.proposed_change
   SET expires_at = created_at + interval '30 days'
 WHERE status = 'pending' AND expires_at IS NULL AND capture_id IS NULL;
ALTER TABLE public.proposed_change ENABLE TRIGGER trg_proposed_change_updated_at;

-- ── Expire ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expire_stale_suggestions(
  p_now timestamptz,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (id uuid, workspace_id uuid, expire_reason text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH stale AS (
    SELECT pc.id,
           CASE
             WHEN pc.document_id IS NULL AND pc.conversation_id IS NULL
               THEN 'run_undelivered'
             ELSE 'ttl'
           END AS reason
    FROM proposed_change pc
    WHERE pc.status = 'pending'
      AND pc.capture_id IS NULL
      AND pc.applied_at IS NULL
      AND pc.result_entity_id IS NULL
      AND (pc.extra ->> 'applied_at') IS NULL
      AND (
        pc.expires_at < p_now
        OR (pc.document_id IS NULL AND pc.conversation_id IS NULL
            AND pc.created_at < p_now - interval '24 hours')
      )
    ORDER BY pc.expires_at ASC NULLS LAST
    LIMIT greatest(coalesce(p_limit, 500), 1)
  )
  UPDATE proposed_change pc SET
    status = 'expired',
    expire_reason = stale.reason
  FROM stale
  WHERE pc.id = stale.id
    -- Re-assert at write time: a row accepted since the scan is left alone.
    AND pc.status = 'pending'
    AND pc.capture_id IS NULL
    AND pc.applied_at IS NULL
    AND pc.result_entity_id IS NULL
    AND (pc.extra ->> 'applied_at') IS NULL
  RETURNING pc.id, pc.workspace_id, pc.expire_reason;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_suggestions(timestamptz, integer) FROM public, anon, authenticated;

-- ── Purge ───────────────────────────────────────────────────────────────────
-- The rule, once: dismissed and expired rows resolved before p_before, never a
-- demo or eval capture's. The purge and its dry run both read it, so a dry run
-- counts exactly what the purge would delete.
CREATE OR REPLACE FUNCTION public.purgeable_suggestions(p_before timestamptz)
RETURNS TABLE (id uuid, resolved_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pc.id, pc.resolved_at
  FROM proposed_change pc
  WHERE pc.status IN ('dismissed', 'expired')
    AND pc.resolved_at < p_before
    AND NOT EXISTS (
      SELECT 1 FROM captures cap
      WHERE cap.id = pc.capture_id
        AND (coalesce((cap.metadata ->> 'demo')::boolean, false) = true
             OR coalesce(cap.is_eval, false) = true)
    );
$$;

REVOKE ALL ON FUNCTION public.purgeable_suggestions(timestamptz) FROM public, anon, authenticated;

-- p_dry_run: count every row the purge would delete (no cap) and delete
-- nothing. The first PROD purge is previewed this way.
CREATE OR REPLACE FUNCTION public.purge_resolved_suggestions(
  p_before timestamptz,
  p_limit integer DEFAULT 1000,
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  IF p_dry_run THEN
    SELECT count(*)::integer INTO n FROM purgeable_suggestions(p_before);
    RETURN n;
  END IF;

  WITH doomed AS (
    SELECT p.id FROM purgeable_suggestions(p_before) p
    ORDER BY p.resolved_at ASC
    LIMIT greatest(coalesce(p_limit, 1000), 1)
  ), gone AS (
    DELETE FROM proposed_change pc
    USING doomed
    WHERE pc.id = doomed.id
      -- Re-assert at write time: a row undone back to pending since is kept.
      AND pc.status IN ('dismissed', 'expired')
    RETURNING pc.id
  )
  SELECT count(*)::integer INTO n FROM gone;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_resolved_suggestions(timestamptz, integer, boolean) FROM public, anon, authenticated;
