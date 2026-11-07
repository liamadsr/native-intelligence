-- ============================================================
-- 175: Self-row owner guard on capture_participant
--
-- The auto-apply gate (self-binding.ts) trusts capture_participant.is_self +
-- self_binding as evidence that a transcript voice IS the capture owner. The
-- table's existing RLS is workspace-wide FOR ALL ("Workspace members can
-- manage capture participants"), so without this guard ANY co-tenant could
-- write self_binding='confirmed' onto a victim's self row — forging the
-- evidence the gate relies on (adversarial review finding, 2026-07-08).
--
-- RESTRICTIVE policies AND with the existing permissive one: rows with
-- is_self=true are only writable by the capture OWNER (captures.user_id).
-- Non-self rows keep today's workspace-wide behavior. The service-role
-- client (seedSelfParticipant) bypasses RLS as always.
-- ============================================================

DROP POLICY IF EXISTS capture_participant_self_owner_update ON public.capture_participant;
CREATE POLICY capture_participant_self_owner_update ON public.capture_participant
  AS RESTRICTIVE FOR UPDATE
  USING (
    NOT is_self
    OR EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_participant.capture_id AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    NOT is_self
    OR EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_participant.capture_id AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS capture_participant_self_owner_insert ON public.capture_participant;
CREATE POLICY capture_participant_self_owner_insert ON public.capture_participant
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT is_self
    OR EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_participant.capture_id AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS capture_participant_self_owner_delete ON public.capture_participant;
CREATE POLICY capture_participant_self_owner_delete ON public.capture_participant
  AS RESTRICTIVE FOR DELETE
  USING (
    NOT is_self
    OR EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_participant.capture_id AND c.user_id = auth.uid()
    )
  );
