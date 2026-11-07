-- Migration 180: claim.event_at — the real-world event time a claim pertains to.
--
-- WHY: the knowledge-recall plan draws a hard line between two timestamps that
-- the graph had conflated:
--   - claim.created_at  = when WE learned the fact (graph write time). Answers
--     "what are the new findings" — a month-old PDF ingested today is new.
--   - claim.event_at    = when the underlying event actually happened in the
--     real world (the meeting, the email, the doc's authoring). Answers "what
--     came up last week / a month ago" — the fuzzy TEMPORAL recall case.
-- Wave 2's hybrid_search filters and orders on event_at (WHERE event_at >= X,
-- ORDER BY event_at DESC), so this column is the foundation everything temporal
-- depends on. This migration adds it, backfills it from each claim's earliest
-- resolvable source event, and indexes it for the range+recency access pattern.
--
-- NULLABILITY: nullable, NO default. `NOT NULL DEFAULT now()` is wrong — it
-- would stamp the ingest time onto every backdated fact, silently defeating the
-- whole point (a claim from a 6-month-old meeting must NOT read as "happened
-- now"). A plain DEFAULT now() has the same failure mode for any insert that
-- forgets to set it. Instead every claim-writer forward-fills event_at at write
-- time (claim-extraction, attachClaimProvenance corroboration, supersede_claim,
-- record_commitment); a row that still ends up NULL is HONESTLY unknown-time and
-- is correctly excluded from a time-windowed query rather than lying about it.

BEGIN;

-- ── 1. Column ─────────────────────────────────────────────────────────────
ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;

-- ── 2. Backfill from the earliest resolvable source event ────────────────
-- A claim can have N claim_source rows; we take the MIN over their resolved
-- real-world event times, falling back to claim.created_at when no source
-- resolves (manual / external_url / attachment sources have no natural event
-- time — claim.created_at is the correct proxy, same as forward-fill does).
--
-- Source → event-time column mapping (verified against the live schema):
--   capture       → captures.started_at        (025; nullable, itself backfilled from recorded_at)
--   email         → email_message.message_date (040; NOT NULL)
--   document      → document.created_at         (025; NOT NULL DEFAULT now())
--   conversation  → chat_conversations.created_at (012; DEFAULT now())
--   attachment / external_url / manual → no source event time → fallback
UPDATE public.claim c
SET event_at = COALESCE(
  (
    SELECT MIN(
      CASE cs.source_type
        WHEN 'capture'      THEN cap.started_at
        WHEN 'email'        THEN em.message_date
        WHEN 'document'     THEN doc.created_at
        WHEN 'conversation' THEN conv.created_at
        ELSE NULL
      END
    )
    FROM public.claim_source cs
    LEFT JOIN public.captures          cap  ON cs.source_type = 'capture'      AND cap.id  = cs.source_id
    LEFT JOIN public.email_message     em   ON cs.source_type = 'email'        AND em.id   = cs.source_id
    LEFT JOIN public.document          doc  ON cs.source_type = 'document'     AND doc.id  = cs.source_id
    LEFT JOIN public.chat_conversations conv ON cs.source_type = 'conversation' AND conv.id = cs.source_id
    WHERE cs.claim_id = c.id
  ),
  c.created_at
)
WHERE c.event_at IS NULL;

-- ── 3. Index for the range-filter + recency-ordering access pattern ───────
-- hybrid_search runs, per workspace: WHERE event_at >= p_since / <= p_until and
-- ORDER BY event_at DESC. A composite (workspace_id, event_at DESC) btree serves
-- both the workspace-scoped range scan and the descending recency ordering from
-- one index. DESC on event_at matches the ORDER BY so the planner can walk the
-- index backward-free.
CREATE INDEX IF NOT EXISTS idx_claim_workspace_event_at
  ON public.claim (workspace_id, event_at DESC);

COMMIT;
