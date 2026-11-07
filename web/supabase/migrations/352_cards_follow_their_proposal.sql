-- ============================================================
-- 352: a For You card follows its proposal
-- ============================================================
-- WHY: an attention_item card that stands for a proposal (proposal_id set)
-- was resolved only when the person clicked the card. Accepting or dismissing
-- the proposal anywhere else (the capture page, the call's proposals card in
-- chat, the accept_proposal / dismiss_proposal tools, the live agent, Triage's
-- own dismiss or fold, the age-out sweeps, a Reprocess that deletes pending
-- proposals) left the card pending in For You until its 7-day expiry. On PROD
-- (30 days to 2026-10-17), 95 of ~132 Create action cards outlived their
-- proposal that way, by a median of ~97 hours. Triage no longer makes Create
-- action cards at all (src/lib/flows/verdict-apply.ts: a new to-do it won't
-- file stays in its capture); this migration makes every remaining card kind
-- leave For You when its proposal is settled, wherever that happens.
--
-- What lands:
--   attention_item_follow_proposal()   AFTER UPDATE OF status on
--     proposed_change. When a proposal leaves 'pending', its pending cards
--     settle to match:
--       applied                  -> accepted
--       dismissed                -> dismissed
--       dismissed by an age-out  -> expired   (extra.aged_out, migration 168,
--                                              or extra.dismiss_reason
--                                              'aged_out_30d',
--                                              proposal-create-age-out.ts:
--                                              nobody answered it)
--       expired                  -> expired
--     with resolved_at = now(), exactly the two columns the settle path
--     (src/lib/attention/settle-card.ts) writes, plus payload
--     .resolved_with_proposal = the proposal's new status, so the reverse
--     below knows which cards it took down. Only pending cards are touched: a
--     card the settle path already resolved is left as it is.
--     Two exceptions, both because the settle path drives the proposal itself:
--       * A draft_email card is not settled when its proposal is applied. Its
--         accept applies the send_email proposal first and only then writes
--         the draft's body; a failed write keeps the card pending so the
--         person can retry into the same draft (settle-card fillDraftAndRespond).
--         Applied elsewhere, the card resolves on its next click.
--       * When a proposal comes BACK to 'pending' (every accept claims the
--         proposal 'pending' -> 'applied' before it applies, and hands the
--         claim back when the apply fails: claim-apply.ts, settle-card
--         acceptCard; an undo re-stages it: undo-applied.ts), the newest card
--         this trigger settled for it is pending again, unless it has expired
--         or another card is already pending for the proposal (one live card
--         per proposal, migration 171). Without this a failed accept from the
--         card would take the card away with nothing done. Should a card for
--         the proposal land in another transaction meanwhile, the restore
--         gives way (unique_violation is swallowed), so the hand-back itself
--         never fails.
--   attention_item_expire_with_proposal()   BEFORE DELETE on proposed_change.
--     A deleted proposal's pending cards expire. attention_item.proposal_id is
--     ON DELETE SET NULL (migration 165), so a Reprocess or the 60-day purge
--     (migration 313) used to leave an orphan card with nothing behind it.
--   (No new index: attention_item_proposal_run_uidx, migration 165, already
--   leads on proposal_id for the lookups above and ON DELETE SET NULL.)
--   One-time cleanup (both updates are idempotent: they only touch pending
--   cards and leave them expired):
--     a. pending cards whose proposal is no longer pending, and pending
--        action_card / draft_email cards whose proposal is gone (NULL: those
--        kinds always stand for a proposal) -> expired. Spared, as the trigger
--        spares it: a draft_email card over an applied proposal (waiting for a
--        retry of its body).
--     b. pending Create action cards (action_card, payload change_type
--        'create', entity_type 'action') -> expired. Their proposals stay
--        pending in the capture, where the person can still accept them.
--
-- Both functions are SECURITY DEFINER with an empty search_path (every name
-- is schema-qualified), like migrations 306 and 320: a person updating or
-- deleting a proposal under RLS has no UPDATE on someone else's card, and the
-- proposal write must not fail on that. They write attention_item only, only
-- the cards of the proposal row that fired them, and nobody can call them
-- directly (EXECUTE revoked).
--
-- The realtime listener (src/hooks/use-attention-items.ts) already drops a
-- card whose status leaves 'pending' and re-shows one that returns to it, so
-- the column follows live.
--
-- Applied by hand, from this file: DEV first, PROD on the owner's word. Code
-- does not depend on it: before it lands, cards behave as they did, and the
-- app already stops making Create action cards and hides any still pending.
-- Re-runnable: create or replace, drop trigger if exists + create, and
-- cleanup updates that only touch pending rows. This
-- file holds no backslash anywhere: one MCP transport decodes escapes, so the
-- applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. Settle a proposal's cards when it leaves pending (and back) ─────────
CREATE OR REPLACE FUNCTION public.attention_item_follow_proposal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_card_status text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  IF OLD.status = 'pending' THEN
    v_card_status := CASE
      WHEN NEW.status = 'applied' THEN 'accepted'
      WHEN NEW.status = 'dismissed'
           AND (coalesce(NEW.extra ->> 'aged_out', '') = 'true'
                OR coalesce(NEW.extra ->> 'dismiss_reason', '') = 'aged_out_30d') THEN 'expired'
      WHEN NEW.status = 'dismissed' THEN 'dismissed'
      ELSE 'expired'
    END;

    UPDATE public.attention_item a
       SET status = v_card_status,
           resolved_at = now(),
           payload = coalesce(a.payload, '{}'::jsonb)
                     || jsonb_build_object('resolved_with_proposal', NEW.status)
     WHERE a.proposal_id = NEW.id
       AND a.status = 'pending'
       AND NOT (a.kind = 'draft_email' AND NEW.status = 'applied');

  ELSIF NEW.status = 'pending' THEN
    BEGIN
    UPDATE public.attention_item a
       SET status = 'pending',
           resolved_at = NULL,
           payload = a.payload - 'resolved_with_proposal'
     WHERE a.id = (
             SELECT c.id
               FROM public.attention_item c
              WHERE c.proposal_id = NEW.id
                AND c.status <> 'pending'
                AND c.payload ->> 'resolved_with_proposal' IS NOT NULL
              ORDER BY c.resolved_at DESC NULLS LAST
              LIMIT 1
           )
       AND (a.expires_at IS NULL OR a.expires_at > now())
       AND NOT EXISTS (
             SELECT 1
               FROM public.attention_item p
              WHERE p.proposal_id = NEW.id
                AND p.status = 'pending'
           );
    EXCEPTION WHEN unique_violation THEN
      -- Another transaction's card for this proposal landed first: it stands.
      NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS attention_item_follow_proposal ON public.proposed_change;
CREATE TRIGGER attention_item_follow_proposal
  AFTER UPDATE OF status ON public.proposed_change
  FOR EACH ROW EXECUTE FUNCTION public.attention_item_follow_proposal();

-- ── 2. Expire a deleted proposal's cards ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.attention_item_expire_with_proposal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.attention_item a
     SET status = 'expired',
         resolved_at = now()
   WHERE a.proposal_id = OLD.id
     AND a.status = 'pending';
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS attention_item_expire_with_proposal ON public.proposed_change;
CREATE TRIGGER attention_item_expire_with_proposal
  BEFORE DELETE ON public.proposed_change
  FOR EACH ROW EXECUTE FUNCTION public.attention_item_expire_with_proposal();

REVOKE EXECUTE ON FUNCTION public.attention_item_follow_proposal() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.attention_item_expire_with_proposal() FROM PUBLIC, anon, authenticated;

-- ── 3. One-time cleanup ─────────────────────────────────────────────────────
-- a. Cards left behind by a proposal that was settled or deleted elsewhere.
UPDATE public.attention_item a
   SET status = 'expired',
       resolved_at = now()
 WHERE a.status = 'pending'
   AND (
         (a.proposal_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM public.proposed_change pc
             WHERE pc.id = a.proposal_id
               AND pc.status = 'pending'
          )
          AND NOT (a.kind = 'draft_email' AND EXISTS (
            SELECT 1
              FROM public.proposed_change pc
             WHERE pc.id = a.proposal_id
               AND pc.status = 'applied'
          )))
      OR (a.proposal_id IS NULL AND a.kind IN ('action_card', 'draft_email'))
       );

-- b. Create action cards still waiting: their proposals stay in the capture.
UPDATE public.attention_item a
   SET status = 'expired',
       resolved_at = now()
 WHERE a.status = 'pending'
   AND a.kind = 'action_card'
   AND a.payload ->> 'change_type' = 'create'
   AND a.payload ->> 'entity_type' = 'action';
