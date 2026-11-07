-- Migration 312: suggestions everywhere, the data (docs/plans/suggestions-everywhere.md,
-- Phase 2).
--
-- WHY: every staged change ("suggestion") is a proposed_change row, and every
-- row had to belong to a capture (capture_id NOT NULL, RLS joined captures).
-- Agents in chat, in loops (the morning brief) and in work runs could only
-- describe a change in prose. This gives a suggestion more homes, records who
-- staged it, and adds what the lifecycle needs.
--
-- What lands:
--   capture_id       nullable. A suggestion has at most one home:
--   document_id      a document (the brief's output, a doc the chat wrote),
--                    deleted with the document;
--   conversation_id  a main-chat conversation, deleted with it, visible only to
--                    its owner.
--                    A row with no home yet is a run's suggestion waiting for
--                    the run's document (re-homed at delivery); no client can
--                    see it.
--   tracked_job_id   the run that staged it (bot pages count by it).
--   origin           who staged it: live_agent | triage | chat | skill_run |
--                    work_run | mcp. NULL on rows from before this migration.
--   fingerprint      hash of workspace + combo + target + proposed values, for
--                    dedup and the recently-dismissed block (src/lib/suggestions/fingerprint.ts).
--   base             the target's fields when it was staged, for the drift check.
--   expires_at       when a pending suggestion nobody acted on expires. A
--                    trigger gives a pending row outside a capture 30 days
--                    when the writer doesn't set it. Capture proposals keep
--                    the age-out they have today (proposal-age-out.ts: 45 days,
--                    and 30 for creates), so theirs stays NULL.
--   resolved_at      when it left 'pending' (the purge works from it). A trigger
--                    keeps it in step with `status`, so no writer has to.
--   status           gains 'expired': nobody acted, for suggestions outside a
--                    capture. 'dismissed' stays "a person said no", and stays
--                    what a capture proposal's age-out writes, as today.
--   expire_reason    why it expired: ttl | already_true | target_deleted |
--                    applied_elsewhere | run_undelivered.
--
-- RLS: SELECT and UPDATE follow the home (the capture's visibility as before;
-- members of the document's workspace, like `document`; the owner for a
-- conversation), on top of membership in the suggestion's own workspace. The
-- two workspaces can differ: a brief written in one workspace can suggest a
-- change to an action in another, and only someone in both sees it. INSERT and DELETE stay capture-only for clients: suggestions
-- in documents and chats are staged by the server (service role).
--
-- Back-fill: resolved_at for every row that isn't pending, from applied_at or
-- the last write. The updated_at trigger is held off for it so no row's
-- updated_at moves.

-- ── Homes and provenance ────────────────────────────────────────────────────
ALTER TABLE public.proposed_change ALTER COLUMN capture_id DROP NOT NULL;

ALTER TABLE public.proposed_change
  ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES public.document(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS tracked_job_id uuid REFERENCES public.tracked_job(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS base jsonb,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS expire_reason text;

ALTER TABLE public.proposed_change DROP CONSTRAINT IF EXISTS proposed_change_one_home;
ALTER TABLE public.proposed_change
  ADD CONSTRAINT proposed_change_one_home
  CHECK (num_nonnulls(capture_id, document_id, conversation_id) <= 1);

ALTER TABLE public.proposed_change DROP CONSTRAINT IF EXISTS proposed_change_origin_check;
ALTER TABLE public.proposed_change
  ADD CONSTRAINT proposed_change_origin_check
  CHECK (origin IS NULL OR origin IN ('live_agent', 'triage', 'chat', 'skill_run', 'work_run', 'mcp'));

ALTER TABLE public.proposed_change DROP CONSTRAINT IF EXISTS proposed_change_expire_reason_check;
ALTER TABLE public.proposed_change
  ADD CONSTRAINT proposed_change_expire_reason_check
  CHECK (expire_reason IS NULL OR expire_reason IN ('ttl', 'already_true', 'target_deleted', 'applied_elsewhere', 'run_undelivered'));

ALTER TABLE public.proposed_change DROP CONSTRAINT IF EXISTS proposed_change_status_check;
ALTER TABLE public.proposed_change
  ADD CONSTRAINT proposed_change_status_check
  CHECK (status IN ('pending', 'applied', 'dismissed', 'expired'));

COMMENT ON COLUMN public.proposed_change.document_id IS
  'Home: the document this suggestion is shown in. At most one of capture_id, document_id, conversation_id.';
COMMENT ON COLUMN public.proposed_change.conversation_id IS
  'Home: the main-chat conversation this suggestion is shown in. Visible only to the conversation owner.';
COMMENT ON COLUMN public.proposed_change.tracked_job_id IS
  'The run that staged it. A run''s suggestions have no home until delivery re-homes them onto its document.';
COMMENT ON COLUMN public.proposed_change.fingerprint IS
  'Hash of workspace + combo + target + proposed values (src/lib/suggestions/fingerprint.ts).';
COMMENT ON COLUMN public.proposed_change.base IS
  'The target''s fields when the suggestion was staged, for the apply-time drift check.';
COMMENT ON COLUMN public.proposed_change.expires_at IS
  'When a pending suggestion nobody acted on becomes expired.';
COMMENT ON COLUMN public.proposed_change.expire_reason IS
  'Why an expired suggestion expired: ttl | already_true | target_deleted | applied_elsewhere | run_undelivered.';
COMMENT ON COLUMN public.proposed_change.resolved_at IS
  'When it left pending. Dismissed and expired rows are purged some time after it.';

-- ── Back-fill resolved_at without touching updated_at ───────────────────────
ALTER TABLE public.proposed_change DISABLE TRIGGER trg_proposed_change_updated_at;
UPDATE public.proposed_change
   SET resolved_at = COALESCE(applied_at, updated_at, created_at)
 WHERE status <> 'pending' AND resolved_at IS NULL;
ALTER TABLE public.proposed_change ENABLE TRIGGER trg_proposed_change_updated_at;

-- ── resolved_at and expires_at follow the status, in the database ───────────
-- Every writer (the routes, the live agent, Triage's verdict, the sweeps, undo)
-- moves `status`; none of them has to remember resolved_at. Leaving 'pending'
-- stamps it; going back to 'pending' (undo, a failed apply handing its claim
-- back) clears it. A pending row outside a capture with no expires_at gets the
-- default 30 days; a capture proposal's stays NULL (it ages out as today).
CREATE OR REPLACE FUNCTION public.proposed_change_track_resolution()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' AND NEW.resolved_at IS NULL THEN
      NEW.resolved_at = now();
    END IF;
    IF NEW.status = 'pending' AND NEW.expires_at IS NULL AND NEW.capture_id IS NULL THEN
      NEW.expires_at = now() + interval '30 days';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'pending' THEN
      NEW.resolved_at = NULL;
    ELSE
      NEW.resolved_at = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_proposed_change_track_resolution
  BEFORE INSERT OR UPDATE ON public.proposed_change
  FOR EACH ROW
  EXECUTE FUNCTION public.proposed_change_track_resolution();

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_proposed_change_document
  ON public.proposed_change (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposed_change_conversation
  ON public.proposed_change (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposed_change_tracked_job
  ON public.proposed_change (tracked_job_id) WHERE tracked_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposed_change_fingerprint
  ON public.proposed_change (workspace_id, fingerprint, status) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposed_change_expiry
  ON public.proposed_change (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposed_change_resolved
  ON public.proposed_change (resolved_at) WHERE status IN ('dismissed', 'expired');

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- One visibility rule for SELECT and UPDATE, by home. ALTER POLICY rewrites
-- migration 223's two policies in place (same names, commands and roles), so
-- the table is never without them and a renamed policy fails here instead of
-- leaving a second one beside it.
ALTER POLICY "Members can view proposed changes"
  ON public.proposed_change
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
    )
    AND (
      (capture_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = capture_id
          AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
      ))
      OR (document_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = document_id
          AND d.workspace_id IN (
            SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
          )
      ))
      OR (conversation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.chat_conversations cc
        WHERE cc.id = conversation_id AND cc.user_id = auth.uid()
      ))
    )
  );

ALTER POLICY "Members can update proposed changes"
  ON public.proposed_change
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
    )
    AND (
      (capture_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = capture_id
          AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
      ))
      OR (document_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = document_id
          AND d.workspace_id IN (
            SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
          )
      ))
      OR (conversation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.chat_conversations cc
        WHERE cc.id = conversation_id AND cc.user_id = auth.uid()
      ))
    )
  );

-- INSERT and DELETE keep the capture-only rule (migration 223) unchanged: the
-- `capture_id = c.id` join is false for a NULL capture_id, so a client can't
-- insert or delete a document or chat suggestion.
