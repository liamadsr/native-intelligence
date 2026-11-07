-- 227_sequences.sql
--
-- Sequences: user-facing email outreach funnels over CRM contacts. A sequence
-- is an ordered set of templated email steps sent FROM THE USER'S OWN
-- connected Gmail/Outlook mailbox (never the internal Resend path — that
-- stays admin-only), auto-stopping on any reply. Distinct from the admin
-- `campaigns` tables by design: those are global, service-role-only, and
-- wired to early_access/auth_users audiences; these are workspace-scoped with
-- real RLS.
--
-- Engine invariants this schema carries (per the red-team review):
--   * Dispatch claims are LEASE-FORWARD (next_send_at pushed 10 min ahead,
--     dispatch_attempts incremented) — never claim-by-NULL, which strands rows
--     when the claimer crashes before emitting the work event.
--   * sequence_send UNIQUE(enrollment_id, step_id) is the at-most-once send
--     guard: the row is inserted as 'claimed' BEFORE the provider call, and a
--     conflict is branched on, never silently ignored.
--   * Reply detection is arithmetic: expected_message_count counts messages
--     the ENGINE put in the thread; any excess in email_thread_index means a
--     human (either side) touched the thread → exit. Never derived from
--     needs_reply, which only describes the last message.
--   * Threading: the parent for step N is the latest 'sent' ledger row's
--     provider_message_id (+ rfc ids for the References chain);
--     thread_subject snapshots the RENDERED step-1 subject.
--   * Enrollment visibility FOLLOWS CONTACT visibility (058's can_view_contact),
--     not bare workspace membership: an enrollment (and its send ledger) names
--     the contact's email and reveals who is being wooed, so a member who
--     cannot see a private contact cannot see its enrollments either.
--     Contact-less enrollments (contact deleted → SET NULL) stay
--     workspace-visible — there is no contact row left to be private.

-- ============================================================
-- 1. sequence
-- ============================================================

CREATE TABLE public.sequence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name                text NOT NULL,
  description         text,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The ONE mailbox this sequence sends from. SET NULL (not RESTRICT): account
  -- disconnect must not be blocked by sequences; the engine pauses the
  -- sequence with one notification when the account goes away.
  sending_account_id  uuid REFERENCES public.connected_account(id) ON DELETE SET NULL,
  -- IANA zone name (e.g. 'America/Los_Angeles'), snapshotted at creation.
  -- All send-window/business-day arithmetic is wall-clock in this zone.
  timezone            text NOT NULL DEFAULT 'America/Los_Angeles',
  -- {"days":[1,2,3,4,5],"start_hour":9,"end_hour":16} — ISO weekday numbers
  -- (1=Mon..7=Sun). Sends are snapped forward into the next open window.
  send_window         jsonb NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start_hour":9,"end_hour":16}',
  delay_unit          text NOT NULL DEFAULT 'business'
                        CHECK (delay_unit IN ('business', 'calendar')),
  -- Armed by Review & Launch. The Inngest send function re-checks it on every
  -- step — flipping it off is the emergency brake.
  auto_send           boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sequence_workspace ON public.sequence (workspace_id, status);

-- ============================================================
-- 2. sequence_step
-- ============================================================

CREATE TABLE public.sequence_step (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id   uuid NOT NULL REFERENCES public.sequence(id) ON DELETE CASCADE,
  step_order    integer NOT NULL CHECK (step_order > 0),
  -- Extension point: 'sms' later. One column — channel is derivable from type.
  step_type     text NOT NULL DEFAULT 'auto_email' CHECK (step_type IN ('auto_email')),
  -- NULL subject ⇒ thread as a reply under step 1 ("Re: <thread_subject>").
  -- A non-null subject on step N>1 deliberately starts a new thread.
  subject       text,
  -- Merge tokens: {{first_name}}, {{last_name}}, {{company}},
  -- {{sender_first_name}}, with inline fallbacks {{first_name|there}}.
  body          text NOT NULL,
  -- Delay from the PREVIOUS step's ACTUAL send time (step 1: from launch).
  delay_days    integer NOT NULL DEFAULT 0 CHECK (delay_days >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_order)
);

-- ============================================================
-- 3. sequence_enrollment
-- ============================================================

CREATE TABLE public.sequence_enrollment (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  sequence_id             uuid NOT NULL REFERENCES public.sequence(id) ON DELETE CASCADE,
  -- SET NULL so deleting a contact keeps the send history; the engine treats a
  -- NULL contact as exit 'removed' at the next touch.
  contact_id              uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  -- Snapshot: renders and sends survive contact edits/deletes.
  contact_email           text NOT NULL,
  enrolled_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'exited')),
  exit_reason             text
                            CHECK (exit_reason IN ('replied', 'completed', 'removed', 'opted_out', 'failed')),
  current_step_order      integer NOT NULL DEFAULT 0 CHECK (current_step_order >= 0),
  -- When the next step is due. Lease-forward claimed by the dispatcher.
  -- Deliberately NOT tied to status: staged-but-unlaunched enrollments are
  -- active with next_send_at NULL.
  next_send_at            timestamptz,
  dispatch_attempts       integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  provider_thread_id      text,
  -- Rendered (post-token, post-override) step-1 subject — follow-ups must
  -- carry a matching "Re:" subject or recipient clients won't thread them.
  thread_subject          text,
  -- Messages the ENGINE has put in the thread. email_thread_index showing more
  -- than this = a human touched the thread = exit.
  expected_message_count  integer NOT NULL DEFAULT 0,
  -- Per-contact subject/body overrides from Review & Launch, keyed by
  -- step_order: {"1": {"subject": "...", "body": "..."}}
  overrides               jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id),
  -- exit_reason present iff exited — no reason-less exits, no reason on a live row.
  CHECK (
    (status = 'exited' AND exit_reason IS NOT NULL)
    OR (status = 'active' AND exit_reason IS NULL)
  )
);

-- One ACTIVE sequence per contact per workspace (industry norm; prevents a
-- contact getting two parallel drips). Exited enrollments don't block.
CREATE UNIQUE INDEX uidx_enrollment_one_active_per_contact
  ON public.sequence_enrollment (workspace_id, contact_id)
  WHERE status = 'active' AND contact_id IS NOT NULL;

-- Same rule keyed on the EMAIL: NULL contact_id rows escape both the pair
-- UNIQUE and the index above (NULLs compare distinct), so without this a
-- contact-less enrollment could run a second parallel drip to the same human.
CREATE UNIQUE INDEX uidx_enrollment_one_active_per_email
  ON public.sequence_enrollment (workspace_id, lower(contact_email))
  WHERE status = 'active';

-- The dispatcher's due-scan.
CREATE INDEX idx_enrollment_due
  ON public.sequence_enrollment (next_send_at)
  WHERE status = 'active';

CREATE INDEX idx_enrollment_sequence ON public.sequence_enrollment (sequence_id, status);
CREATE INDEX idx_enrollment_contact ON public.sequence_enrollment (workspace_id, contact_id);

-- ============================================================
-- 4. sequence_send — the at-most-once ledger
-- ============================================================

CREATE TABLE public.sequence_send (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  enrollment_id        uuid NOT NULL REFERENCES public.sequence_enrollment(id) ON DELETE CASCADE,
  step_id              uuid NOT NULL REFERENCES public.sequence_step(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'claimed'
                         CHECK (status IN ('claimed', 'sending', 'sent', 'failed')),
  scheduled_at         timestamptz,
  sent_at              timestamptz,
  -- The SENT message's provider-internal id (Gmail message id / Graph message
  -- id) — the createReply/threading handle for the NEXT step.
  provider_message_id  text,
  provider_thread_id   text,
  -- Bare RFC 2822 Message-ID — feeds the References chain.
  rfc_message_id       text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, step_id)
);

CREATE INDEX idx_sequence_send_enrollment ON public.sequence_send (enrollment_id, created_at);
-- The reaper's zombie scan.
CREATE INDEX idx_sequence_send_inflight
  ON public.sequence_send (updated_at)
  WHERE status IN ('claimed', 'sending');

-- ============================================================
-- 5. outreach_suppression
-- ============================================================

CREATE TABLE public.outreach_suppression (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  email         text NOT NULL,
  -- 'opted_out' spelling matches sequence_enrollment.exit_reason.
  reason        text NOT NULL DEFAULT 'manual' CHECK (reason IN ('opted_out', 'manual')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uidx_suppression_workspace_email
  ON public.outreach_suppression (workspace_id, lower(email));

-- ============================================================
-- 6. sending_account tenant guard (pattern: 224's reminder_freeze_identity)
-- ============================================================

-- The FK alone lets a member point a sequence at ANY connected_account row —
-- including another tenant's mailbox — and the engine would then send from it
-- with service-role credentials. An account is reachable from the sequence's
-- workspace iff it has a connected_account_workspace junction row (060) OR its
-- owner is a member of that workspace (accounts connected before junction rows
-- existed have workspace_id only, and 060's backfill is per-workspace).
-- SECURITY DEFINER: the check must see junction/member rows the writer's own
-- RLS may hide.
CREATE OR REPLACE FUNCTION public.sequence_sending_account_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.sending_account_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.connected_account_workspace caw
       WHERE caw.account_id = new.sending_account_id
         AND caw.workspace_id = new.workspace_id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.connected_account ca
       JOIN public.member m
         ON m.user_id = ca.user_id
        AND m.workspace_id = new.workspace_id
       WHERE ca.id = new.sending_account_id
     ) THEN
    RAISE EXCEPTION 'sending_account_id is not reachable from this workspace'
      USING ERRCODE = '42501';
  END IF;
  RETURN new;
END;
$$;

CREATE TRIGGER sequence_sending_account_guard
  BEFORE INSERT OR UPDATE ON public.sequence
  FOR EACH ROW EXECUTE FUNCTION public.sequence_sending_account_guard();

-- ============================================================
-- 7. RLS — workspace-member policies (pattern: contact/company tables),
--    with enrollment/send visibility riding contact visibility (058).
--    The engine (cron + Inngest) runs service-role and bypasses these.
-- ============================================================

ALTER TABLE public.sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_suppression ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_member_all ON public.sequence
  FOR ALL
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

-- Steps carry no workspace_id; membership rides the parent sequence.
CREATE POLICY sequence_step_member_all ON public.sequence_step
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.sequence s
    WHERE s.id = sequence_id AND public.is_workspace_member(s.workspace_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sequence s
    WHERE s.id = sequence_id AND public.is_workspace_member(s.workspace_id)
  ));

-- Enrollment visibility follows CONTACT visibility: membership alone is not
-- enough when the enrolled contact is private (same gate the contact table's
-- own policies use, 058). WITH CHECK too — you can only enroll (or retarget
-- to) a contact you can see. NULL contact_id (contact deleted) falls back to
-- plain membership.
CREATE POLICY sequence_enrollment_member_all ON public.sequence_enrollment
  FOR ALL
  USING (
    public.is_workspace_member(workspace_id)
    AND (contact_id IS NULL OR EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
    ))
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND (contact_id IS NULL OR EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
    ))
  );

-- Send ledger is read-only from the client; only the engine writes it.
-- Rides its enrollment's contact gate — a send row names the private
-- contact's thread.
CREATE POLICY sequence_send_member_select ON public.sequence_send
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.sequence_enrollment e
      WHERE e.id = enrollment_id
        AND (e.contact_id IS NULL OR EXISTS (
          SELECT 1 FROM public.contact c
          WHERE c.id = e.contact_id
            AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
        ))
    )
  );

CREATE POLICY outreach_suppression_member_all ON public.outreach_suppression
  FOR ALL
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

REVOKE ALL ON public.sequence, public.sequence_step, public.sequence_enrollment,
  public.sequence_send, public.outreach_suppression FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sequence, public.sequence_step,
  public.sequence_enrollment, public.outreach_suppression TO authenticated;
GRANT SELECT ON public.sequence_send TO authenticated;

-- ============================================================
-- 8. updated_at triggers + realtime
-- ============================================================

CREATE TRIGGER sequence_updated_at
  BEFORE UPDATE ON public.sequence
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER sequence_step_updated_at
  BEFORE UPDATE ON public.sequence_step
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER sequence_enrollment_updated_at
  BEFORE UPDATE ON public.sequence_enrollment
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER sequence_send_updated_at
  BEFORE UPDATE ON public.sequence_send
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Live dashboard: enrollment rows advance / exit in real time.
-- ADD TABLE wrapped to swallow duplicate_object (187 idiom) — a bare re-run
-- would otherwise abort the whole single-transaction migration.
ALTER TABLE public.sequence REPLICA IDENTITY FULL;
ALTER TABLE public.sequence_enrollment REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.sequence;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.sequence_enrollment;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 9. Workspace-move residue — sequence tables (224's precedent)
-- ============================================================

-- Registration of this migration's four workspace-pinned tables with the
-- move engine's residue sweep (_wsmove_residue, 221:560, last replaced by
-- 224):
--
--   * sequence_enrollment — the only one pointing at a movable entity
--     (contact_id). The engine today COPIES contacts ('contact' never enters
--     the moving set — 221:1902), so the clause below is inert until a true
--     contact move exists; registered now so the sweep fails closed the day
--     one is added. EXIT rather than DELETE: sequence_send rides the
--     enrollment (ON DELETE CASCADE) and the ledger is history that must
--     survive; exiting stops the drip and satisfies the status/exit_reason
--     CHECK.
--   * sequence, sequence_send, outreach_suppression — no pointers into
--     movable entities (send rides its enrollment; suppression keys on the
--     bare email string; sequence references only its own workspace and a
--     user-scoped mailbox), so no sweep clause.
--
-- Replacing the whole function is the only option: the working set lives in
-- pg_temp._wsmove_set, created and ON COMMIT DROPped inside this body, so no
-- statement outside it can see the moving ids. The body below is 224:233-327
-- verbatim (diff-verified) plus the one enrollment UPDATE and its counter.
CREATE OR REPLACE FUNCTION public._wsmove_residue(
  p_source uuid,
  p_dest uuid,
  p_moving jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pins int := 0;
  v_notifications int := 0;
  v_threads int := 0;
  v_reminders int := 0;
  v_enrollments int := 0;
BEGIN
  -- pg_temp-qualified so no same-named object in `public` can ever shadow it
  DROP TABLE IF EXISTS pg_temp._wsmove_set;
  CREATE TABLE pg_temp._wsmove_set (t text, i uuid, PRIMARY KEY (t, i)) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmove_set (t, i)
  SELECT DISTINCT m->>'t', (m->>'i')::uuid
  FROM jsonb_array_elements(COALESCE(p_moving, '[]'::jsonb)) m
  ON CONFLICT DO NOTHING;

  WITH gone AS (
    DELETE FROM public.knowledge_package_item i
    WHERE i.workspace_id = p_source
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = i.entity_type AND s.i = i.entity_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_pins FROM gone;

  WITH gone AS (
    DELETE FROM public.notification n
    WHERE n.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = n.target_type AND s.i = n.target_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = n.context_type AND s.i = n.context_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_notifications FROM gone;

  -- 224: pending reminders on moved entities (see section header for why DELETE).
  WITH gone AS (
    DELETE FROM public.reminder r
    WHERE r.workspace_id = p_source
      AND r.delivered_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = r.entity_type AND s.i = r.entity_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_reminders FROM gone;

  -- 227: active enrollments on moved contacts (see section header for why
  -- EXIT, and why this is inert while contacts are copied rather than moved).
  WITH exited AS (
    UPDATE public.sequence_enrollment se
    SET status = 'exited', exit_reason = 'removed', next_send_at = NULL
    WHERE se.workspace_id = p_source
      AND se.status = 'active'
      AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'contact' AND s.i = se.contact_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_enrollments FROM exited;

  WITH cleared AS (
    UPDATE public.email_thread_index e
    SET linked_action_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'action' AND s.i = e.linked_action_id)
          THEN NULL ELSE e.linked_action_id END,
        linked_capture_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'capture' AND s.i = e.linked_capture_id)
          THEN NULL ELSE e.linked_capture_id END,
        linked_project_id = CASE
          WHEN EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = e.linked_project_id)
          THEN NULL ELSE e.linked_project_id END
    WHERE e.workspace_id = p_source
      AND (
        EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'action' AND s.i = e.linked_action_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'capture' AND s.i = e.linked_capture_id)
        OR EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = e.linked_project_id)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_threads FROM cleared;

  -- Workspace briefs: invalidate, don't delete — the stale brief keeps
  -- serving until the weaver's next pass recompiles it (a deleted brief
  -- blanks the AI's world model for up to a day).
  UPDATE public.knowledge_brief b
  SET source_fingerprint = NULL
  WHERE b.workspace_id IN (p_source, p_dest)
    AND b.scope_type = 'workspace';

  -- Project briefs for MOVED projects: delete outright. The project no
  -- longer exists in the source workspace, so a fingerprint-nulled row would
  -- just make the weaver try to recompile a brief for a foreign project.
  DELETE FROM public.knowledge_brief b
  WHERE b.workspace_id = p_source
    AND b.scope_type = 'project'
    AND EXISTS (SELECT 1 FROM pg_temp._wsmove_set s WHERE s.t = 'project' AND s.i = b.scope_id);

  RETURN jsonb_build_object(
    'package_pins_removed', v_pins,
    'notifications_removed', v_notifications,
    'email_threads_unlinked', v_threads,
    'reminders_removed', v_reminders,
    'sequence_enrollments_exited', v_enrollments
  );
END;
$$;

-- CREATE OR REPLACE preserves the 221:2048 revoke, but restate it so the
-- lock-down is visible at the definition site (193/221/224 house pattern).
REVOKE ALL ON FUNCTION public._wsmove_residue(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 10. merge_contacts — repoint sequence enrollments (plan §Phase 1)
-- ============================================================

-- The latest merge_contacts is 132's (193 only revoked EXECUTE). The body
-- below is 132:129-257 verbatim (diff-verified) plus the ONE new block marked
-- "227:" — the sequence_enrollment repoint. Rules, minding BOTH partial
-- uniques (the total pair UNIQUE(sequence_id, contact_id) AND the
-- one-active-per-contact / one-active-per-lower(email) indexes):
--
--   * An ACTIVE loser enrollment exits 'removed' instead of repointing when
--     the survivor already has ANY enrollment in that sequence (pair unique —
--     re-enrollment is not a thing), or the survivor is already actively
--     enrolled anywhere in the workspace — by contact_id OR by an active
--     enrollment carrying the survivor's email (a contact-less active row
--     escapes the contact-keyed index but is the same human's drip). The
--     repointed row keeps its own contact_email snapshot, so repointing never
--     creates a NEW email-index entry — the email collision to guard is the
--     survivor's own parallel drip, checked here.
--   * Everything else repoints to the survivor where the pair slot is free.
--     EXITED loser rows whose pair slot is taken stay pointed at the
--     tombstoned source (history; the source row survives as a tombstone).
--
-- NOTE: unmerge_contacts does not know about enrollments (132's `moved` list
-- is unchanged) — an unmerge leaves repointed enrollments on the target, the
-- same one-way behavior as its notes/tags folding.
CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_target uuid,
  p_source uuid,
  p_match_type text DEFAULT 'manual',
  p_score numeric DEFAULT NULL,
  p_reasons jsonb DEFAULT '[]'::jsonb,
  p_performed_by text DEFAULT 'system'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target public.contact%ROWTYPE;
  v_source public.contact%ROWTYPE;
  v_moved jsonb;
  v_emails text[];
BEGIN
  IF p_target = p_source THEN
    RAISE EXCEPTION 'Cannot merge a contact into itself';
  END IF;

  -- Lock both rows; lowest id first to avoid deadlocks between concurrent merges.
  IF p_target < p_source THEN
    SELECT * INTO v_target FROM public.contact WHERE id = p_target FOR UPDATE;
    SELECT * INTO v_source FROM public.contact WHERE id = p_source FOR UPDATE;
  ELSE
    SELECT * INTO v_source FROM public.contact WHERE id = p_source FOR UPDATE;
    SELECT * INTO v_target FROM public.contact WHERE id = p_target FOR UPDATE;
  END IF;

  IF v_target.id IS NULL OR v_source.id IS NULL THEN
    RAISE EXCEPTION 'Both contacts must exist';
  END IF;
  IF v_target.workspace_id <> v_source.workspace_id THEN
    RAISE EXCEPTION 'Contacts must be in the same workspace';
  END IF;
  IF v_source.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Source contact % is already merged', p_source;
  END IF;
  IF v_target.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Target contact % is already merged', p_target;
  END IF;

  -- Record the exact rows we are about to move, for a precise undo.
  v_moved := jsonb_build_object(
    'capture_participant_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.capture_participant WHERE contact_id = p_source), '[]'::jsonb),
    'contact_interaction_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.contact_interaction WHERE contact_id = p_source), '[]'::jsonb),
    'email_thread_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.email_thread_index WHERE linked_contact_id = p_source), '[]'::jsonb),
    'voice_enrollment_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.voice_enrollment WHERE contact_id = p_source), '[]'::jsonb),
    'comment_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.comment WHERE commentable_type = 'contact' AND commentable_id = p_source), '[]'::jsonb),
    'contact_share_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.contact_share WHERE contact_id = p_source), '[]'::jsonb)
  );

  -- Repoint every reference onto the surviving target.
  UPDATE public.capture_participant SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.contact_interaction SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.email_thread_index SET linked_contact_id = p_target WHERE linked_contact_id = p_source;
  UPDATE public.voice_enrollment SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.comment SET commentable_id = p_target
    WHERE commentable_type = 'contact' AND commentable_id = p_source;
  UPDATE public.contact_share SET contact_id = p_target WHERE contact_id = p_source;

  -- 227: sequence enrollments. Exit-instead-of-repoint for active loser rows
  -- that would collide with the survivor (see the section header for the two
  -- unique constraints this minds); then repoint whatever the pair slot allows.
  UPDATE public.sequence_enrollment se
  SET status = 'exited', exit_reason = 'removed', next_send_at = NULL
  WHERE se.contact_id = p_source
    AND se.status = 'active'
    AND (
      EXISTS (
        SELECT 1 FROM public.sequence_enrollment t
        WHERE t.sequence_id = se.sequence_id AND t.contact_id = p_target
      )
      OR EXISTS (
        SELECT 1 FROM public.sequence_enrollment t
        WHERE t.workspace_id = se.workspace_id
          AND t.status = 'active'
          AND (
            t.contact_id = p_target
            OR (v_target.email IS NOT NULL AND lower(t.contact_email) = lower(v_target.email))
          )
      )
    );

  UPDATE public.sequence_enrollment se
  SET contact_id = p_target
  WHERE se.contact_id = p_source
    AND NOT EXISTS (
      SELECT 1 FROM public.sequence_enrollment t
      WHERE t.sequence_id = se.sequence_id AND t.contact_id = p_target
    );

  -- Build the merged email set: every distinct address from both contacts,
  -- minus whatever stays as the target's primary email.
  v_emails := (
    SELECT COALESCE(array_agg(DISTINCT e), '{}')
    FROM unnest(
      COALESCE(v_target.secondary_emails, '{}')
        || COALESCE(v_source.secondary_emails, '{}')
        || ARRAY[v_source.email]
        || ARRAY[v_target.email]
    ) AS e
    WHERE e IS NOT NULL AND e <> '' AND e IS DISTINCT FROM v_target.email
  );

  -- Backfill blank target fields from the source; the target's own values win.
  UPDATE public.contact SET
    secondary_emails    = v_emails,
    first_name          = COALESCE(v_target.first_name, v_source.first_name),
    last_name           = COALESCE(v_target.last_name, v_source.last_name),
    phone               = COALESCE(v_target.phone, v_source.phone),
    avatar_url          = COALESCE(v_target.avatar_url, v_source.avatar_url),
    job_title           = COALESCE(v_target.job_title, v_source.job_title),
    department          = COALESCE(v_target.department, v_source.department),
    linkedin_url        = COALESCE(v_target.linkedin_url, v_source.linkedin_url),
    company_id          = COALESCE(v_target.company_id, v_source.company_id),
    member_id           = COALESCE(v_target.member_id, v_source.member_id),
    notes               = CASE
                            WHEN COALESCE(NULLIF(trim(v_source.notes), ''), '') = '' THEN v_target.notes
                            WHEN COALESCE(NULLIF(trim(v_target.notes), ''), '') = '' THEN v_source.notes
                            ELSE v_target.notes || E'\n\n' || v_source.notes
                          END,
    tags                = (
                            SELECT COALESCE(array_agg(DISTINCT t), '{}')
                            FROM unnest(COALESCE(v_target.tags, '{}') || COALESCE(v_source.tags, '{}')) AS t
                          ),
    interaction_count   = COALESCE(v_target.interaction_count, 0) + COALESCE(v_source.interaction_count, 0),
    last_interaction_at = GREATEST(v_target.last_interaction_at, v_source.last_interaction_at),
    next_followup_at    = COALESCE(v_target.next_followup_at, v_source.next_followup_at),
    updated_at          = now()
  WHERE id = p_target;

  -- Tombstone the source. NULLing the email frees the (workspace_id, email)
  -- unique slot and ensures future lookups resolve to the target instead.
  UPDATE public.contact SET
    merged_into_contact_id = p_target,
    email                  = NULL,
    secondary_emails       = '{}',
    updated_at             = now()
  WHERE id = p_source;

  INSERT INTO public.contact_merge (
    workspace_id, target_contact_id, source_contact_id,
    source_snapshot, moved, match_type, score, reasons, performed_by
  ) VALUES (
    v_target.workspace_id, p_target, p_source,
    to_jsonb(v_source), v_moved, p_match_type, p_score, p_reasons, p_performed_by
  );

  RETURN p_target;
END;
$$;

-- CREATE OR REPLACE preserves the existing ACL (132 granted service_role only;
-- 193 revoked PUBLIC/anon/authenticated), but restate it so the lock-down is
-- visible at the definition site (193/221/224 house pattern).
REVOKE EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid, text, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid, text, numeric, jsonb, text) TO service_role;
