-- 252_evals.sql
--
-- Evals: suites of synthetic-meeting cases that grade an agent (a live-meeting
-- persona) or a skill (a chat/loop preset), run against a prompt version so the
-- number moves as the prompt is edited. Spec: docs/plans/evals.md §3.2, §5.2.
--
-- THE load-bearing decision this schema encodes (spec §3.3): **an eval case is
-- a real `captures` row.** The live-agent route reads everything it needs from
-- that row and its derived tables — pending proposals ordered by sort_order,
-- applied proposals, participants, the summary, the chat tail, live_mode,
-- user_notes. Faking the row would mean forking the engine; using the real row
-- means the eval measures the real engine. Every consequence below follows from
-- that one choice:
--
--   * `captures.is_eval` is a FIRST-CLASS COLUMN, not only `metadata.demo`.
--     `metadata` is unindexed jsonb and its `demo` flag has already drifted
--     (index-capture-finished.ts gates claim extraction on it but embeds
--     capture_chunks unconditionally), and the Captures list route has no demo
--     predicate at all. But every eval capture ALSO sets `metadata.demo = true`
--     and `visibility = 'private'`: the demo flag buys nine existing gates for
--     free, so a missed `is_eval` predicate degrades to "already gated by demo"
--     rather than "leaked into the knowledge graph", and private visibility
--     hides the row from other members through the RLS 223 already installed.
--   * `captures` gains a UNIQUE (id, is_eval) pair so `eval_case` and
--     `eval_trial` can carry a COMPOSITE FK. That makes "an eval case points at
--     a real capture" a constraint violation rather than a bug class. It
--     matters because batch mode DELETES every pending proposal on its capture
--     before re-extracting (live-agent/route.ts:315-325) — a mis-seeded case
--     aimed at a real capture would destroy real work.
--   * A `capture_participant` trigger refuses contact_id / member_id links on
--     eval captures (except the creator's own self row, which self-binding
--     needs). That is what keeps a mock sales call off a real contact's CRM
--     timeline BY CONSTRUCTION — for the synthesizer path, the clone path, and
--     the save-from-a-real-capture path alike, without any of them having to
--     remember.
--   * The four SECURITY DEFINER search functions gain `AND NOT c.is_eval`.
--     RLS on `captures` deliberately does NOT change (spec §5.2): three things
--     the feature depends on run `SELECT ... FROM public.captures` as the
--     caller's `authenticated` role and would silently break — the nudge
--     channel's subscribe policy (152), the transcript-append RPC (192, and it
--     is SECURITY INVOKER), and the Evals screens themselves. Postgres
--     permissive policies OR together, so a "companion" allow policy would
--     re-admit eval rows everywhere.
--
-- Idempotent throughout (IF NOT EXISTS / DROP … IF EXISTS), same as 248.

-- ============================================================
-- 1. The isolation column
-- ============================================================

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS is_eval boolean NOT NULL DEFAULT false;

-- Partial: the workspace's eval captures are a rounding error next to its real
-- ones, and every reader of this column asks "the eval captures in THIS
-- workspace", never "is this one capture an eval" (that arrives by id).
CREATE INDEX IF NOT EXISTS idx_captures_is_eval
  ON public.captures (workspace_id) WHERE is_eval = true;

-- The referencable pair for the composite FKs below. Redundant with the
-- primary key by definition — that is the point: it costs one index and makes
-- the invariant enforceable from the child side.
ALTER TABLE public.captures
  DROP CONSTRAINT IF EXISTS captures_id_is_eval_unique;
ALTER TABLE public.captures
  ADD CONSTRAINT captures_id_is_eval_unique UNIQUE (id, is_eval);

-- ============================================================
-- 2. Tables
-- ============================================================

-- A suite is a named set of cases targeting ONE recipe. `capability` suites
-- start low and show progress; `regression` suites must stay green.
CREATE TABLE IF NOT EXISTS public.eval_suite (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text,
  target_kind       text NOT NULL CHECK (target_kind IN ('agent', 'skill')),
  -- ON DELETE SET NULL, never CASCADE: deleting a recipe must not silently
  -- destroy the record of how it used to score.
  target_recipe_id  uuid REFERENCES public.recipe (id) ON DELETE SET NULL,
  suite_kind        text NOT NULL DEFAULT 'capability'
                      CHECK (suite_kind IN ('capability', 'regression')),
  watch             boolean NOT NULL DEFAULT false,   -- nightly re-run against the live prompt
  judge_model       text,                             -- gateway catalog slug; NULL = workspace default judge
  created_by        uuid REFERENCES auth.users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_suite_workspace_idx
  ON public.eval_suite (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eval_suite_recipe_idx
  ON public.eval_suite (target_recipe_id) WHERE target_recipe_id IS NOT NULL;

-- A case is ONE synthetic meeting: the script, the frozen flush windows, the
-- expected outcomes, and the template eval capture they are all about.
CREATE TABLE IF NOT EXISTS public.eval_case (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id                uuid NOT NULL REFERENCES public.eval_suite (id) ON DELETE CASCADE,
  workspace_id            uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name                    text NOT NULL,
  capture_id              uuid NOT NULL,              -- template eval capture; composite FK below
  capture_is_eval         boolean NOT NULL DEFAULT true,
  script                  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{t_ms, speaker, stream:'mic'|'system', text}]
  -- Frozen flush windows, computed once at authoring time from the script's own
  -- t_ms values (spec decision 1): [{index, t_ms_start, t_ms_end, segment_indices}].
  -- The real TranscriptGate measures WALL-CLOCK silence, so replaying through it
  -- at any speed but real time collapses into one end-of-call flush. Freezing the
  -- boundaries makes a watched replay and an instant sweep comparable.
  chunks                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected                jsonb NOT NULL DEFAULT '{}'::jsonb,  -- §6.1
  modes                   text[] NOT NULL DEFAULT ARRAY['batch', 'live'],
  -- A suite of only positive cases measures nothing about restraint; the suite
  -- screen warns when every case is 'positive'.
  polarity                text NOT NULL DEFAULT 'positive'
                            CHECK (polarity IN ('positive', 'negative')),
  seeded_from_capture_id  uuid REFERENCES public.captures (id) ON DELETE SET NULL,
  -- A case seeded from a private capture stays creator-only (§3.2).
  visibility              text NOT NULL DEFAULT 'workspace'
                            CHECK (visibility IN ('workspace', 'private')),
  created_by              uuid REFERENCES auth.users (id),
  sort_order              integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- An eval case may only EVER point at an eval capture.
  CONSTRAINT eval_case_capture_is_eval CHECK (capture_is_eval = true),
  CONSTRAINT eval_case_capture_fk FOREIGN KEY (capture_id, capture_is_eval)
    REFERENCES public.captures (id, is_eval) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS eval_case_suite_idx
  ON public.eval_case (suite_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS eval_case_workspace_idx
  ON public.eval_case (workspace_id);
CREATE INDEX IF NOT EXISTS eval_case_capture_idx
  ON public.eval_case (capture_id);

-- The x-axis. There is no prompt history in Dial8 today, so "how well do these
-- prompts do over time" has no axis to plot against without one. Snapshotted on
-- every save through ONE shared helper (snapshotRecipePrompt), deduped by
-- content_hash. Deliberately NOT a trigger: a trigger would record every
-- migration-seeded system-skill update as a user version.
CREATE TABLE IF NOT EXISTS public.recipe_prompt_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id      uuid NOT NULL REFERENCES public.recipe (id) ON DELETE CASCADE,
  -- Nullable: system recipes live at workspace_id IS NULL, same as `recipe`.
  workspace_id   uuid REFERENCES public.workspace (id) ON DELETE CASCADE,
  system_prompt  text,
  agent_config   jsonb,
  model          text,
  content_hash   text NOT NULL,                       -- sha256(system_prompt || model || agent_config)
  -- 'proposed' = staged by the assistant via propose_prompt_edit and rendered as
  -- a diff with Promote. The assistant can never rewrite the prompt under test
  -- without a click.
  status         text NOT NULL DEFAULT 'saved'
                   CHECK (status IN ('saved', 'proposed')),
  label          text,
  rationale      text,
  created_by     uuid REFERENCES auth.users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recipe_prompt_version_recipe_hash_key UNIQUE (recipe_id, content_hash)
);

CREATE INDEX IF NOT EXISTS recipe_prompt_version_recipe_idx
  ON public.recipe_prompt_version (recipe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recipe_prompt_version_workspace_idx
  ON public.recipe_prompt_version (workspace_id) WHERE workspace_id IS NOT NULL;

-- One execution of a suite, in one mode, against one prompt version. The
-- comparable unit.
CREATE TABLE IF NOT EXISTS public.eval_run (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id                  uuid NOT NULL REFERENCES public.eval_suite (id) ON DELETE CASCADE,
  workspace_id              uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  mode                      text NOT NULL CHECK (mode IN ('batch', 'live')),
  speed                     text NOT NULL DEFAULT 'instant'
                              CHECK (speed IN ('realtime', 'fast', 'instant')),
  -- Which driver executes it (§4.1): 'server' = Inngest (batch, and live at
  -- instant); 'client' = the replay screen in the browser (live at realtime/fast,
  -- where a person is watching and Stop must be synchronous).
  driver                    text NOT NULL DEFAULT 'server'
                              CHECK (driver IN ('server', 'client')),
  trials_per_case           smallint NOT NULL DEFAULT 1 CHECK (trials_per_case > 0),
  target_recipe_id          uuid REFERENCES public.recipe (id) ON DELETE SET NULL,
  target_prompt_version_id  uuid REFERENCES public.recipe_prompt_version (id) ON DELETE SET NULL,
  target_prompt_hash        text NOT NULL,            -- computed from the LIVE recipe at queue time
  -- Denormalized deliberately: a run REMEMBERS what it tested. A foreign key to
  -- a mutable row would start lying the moment someone edits the prompt.
  target_system_prompt      text,
  target_agent_config       jsonb,
  target_model              text,
  status                    text NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  -- Server-authored liveness, the prospecting use-run-poll contract: the client
  -- polls on THIS, never on its own guess about staleness.
  is_live                   boolean GENERATED ALWAYS AS (status IN ('queued', 'running')) STORED,
  progress                  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {cases_total, trials_done, stage}
  outcome                   text CHECK (outcome IN ('passed', 'scored', 'failed')),
  scores                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost_usd        numeric(10, 6),
  cost_usd                  numeric(10, 6) NOT NULL DEFAULT 0,
  max_cost_usd              numeric(10, 6),
  tokens_in                 integer NOT NULL DEFAULT 0,
  tokens_out                integer NOT NULL DEFAULT 0,
  duration_ms               integer,
  -- Resolved to the most recent completed run of the same suite+mode whose
  -- target_prompt_hash DIFFERS. Two runs of the same prompt are variance
  -- samples, never a before/after pair.
  baseline_run_id           uuid REFERENCES public.eval_run (id) ON DELETE SET NULL,
  started_by                uuid REFERENCES auth.users (id),
  started_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                  timestamptz,
  error_code                text,
  error_message             text
);

CREATE INDEX IF NOT EXISTS eval_run_suite_idx
  ON public.eval_run (suite_id, started_at DESC);
CREATE INDEX IF NOT EXISTS eval_run_workspace_idx
  ON public.eval_run (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS eval_run_live_idx
  ON public.eval_run (workspace_id) WHERE is_live;

-- The DATABASE, not the app, refuses a second concurrent run of the same
-- suite+mode. The runs route turns the 23505 into "adopt the in-flight run",
-- so a double-click and a chat tool racing the UI converge instead of erroring.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_run_one_live
  ON public.eval_run (suite_id, mode) WHERE status IN ('queued', 'running');

-- One execution of one case inside a run, against its OWN fresh capture clone.
-- The clone is not an optimization: the route re-reads pending proposals every
-- call, so a second trial on the same capture would see the first trial's
-- proposals as prior context (§3.4).
CREATE TABLE IF NOT EXISTS public.eval_trial (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES public.eval_run (id) ON DELETE CASCADE,
  case_id          uuid NOT NULL REFERENCES public.eval_case (id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  trial_index      smallint NOT NULL DEFAULT 0,
  capture_id       uuid NOT NULL,                     -- the clone; composite FK below
  capture_is_eval  boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'completed', 'errored', 'cancelled')),
  -- 'errored' is a FOURTH state here and not on eval_run's outcome, deliberately:
  -- a harness failure (the route returned auto_archived_junk, a question went
  -- unanswered) must be distinguishable in the compare view from a prompt
  -- regression. It is never scored as a zero.
  outcome          text CHECK (outcome IN ('passed', 'scored', 'failed', 'errored')),
  trace            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- §4.5; the durable record, survives the clone's deletion
  cost_usd         numeric(10, 6) NOT NULL DEFAULT 0,
  tokens_in        integer NOT NULL DEFAULT 0,
  tokens_out       integer NOT NULL DEFAULT 0,
  duration_ms      integer,
  -- Retention (§2 decision 5): a nightly sweep deletes UNPINNED trial captures
  -- older than 30 days. It deletes captures, never trials — the trace is the
  -- durable record.
  is_pinned        boolean NOT NULL DEFAULT false,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  error_code       text,
  error_message    text,

  CONSTRAINT eval_trial_capture_is_eval CHECK (capture_is_eval = true),
  CONSTRAINT eval_trial_capture_fk FOREIGN KEY (capture_id, capture_is_eval)
    REFERENCES public.captures (id, is_eval) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS eval_trial_run_idx
  ON public.eval_trial (run_id, case_id, trial_index);
CREATE INDEX IF NOT EXISTS eval_trial_case_idx
  ON public.eval_trial (case_id, started_at DESC);
CREATE INDEX IF NOT EXISTS eval_trial_workspace_idx
  ON public.eval_trial (workspace_id);
CREATE INDEX IF NOT EXISTS eval_trial_capture_idx
  ON public.eval_trial (capture_id);

-- One grader result on one trial. `check_key` is stable across runs — it is
-- what the compare view joins on, and what makes "this check regressed" a
-- statement about the same check rather than about row order.
CREATE TABLE IF NOT EXISTS public.eval_check (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_id        uuid NOT NULL REFERENCES public.eval_trial (id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  dimension       text NOT NULL
                    CHECK (dimension IN ('proposals', 'summary', 'nudges', 'tools', 'gate', 'cost', 'latency')),
  grader          text NOT NULL,                      -- 'tool_called' | 'proposal_match' | 'judge_summary' | …
  check_key       text NOT NULL,
  label           text NOT NULL,
  -- eve's severity vocabulary, imported verbatim because it has no better
  -- English replacement: a `gate` failure fails the trial, a `soft` miss scores it.
  severity        text NOT NULL DEFAULT 'soft' CHECK (severity IN ('gate', 'soft')),
  -- 'unknown' is a FIRST-CLASS third state and is excluded from the pass-rate
  -- denominator: a judge that cannot tell must not be counted as either.
  -- 'skipped' is the missing-credential / nothing-to-grade case.
  outcome         text NOT NULL CHECK (outcome IN ('pass', 'fail', 'unknown', 'skipped')),
  score           numeric(5, 4),
  threshold       numeric(5, 4),
  rationale       text,
  evidence        jsonb,                              -- mandatory for judges: quotes, proposal ids, chunk indices, match_method
  human_override  text CHECK (human_override IN ('agree', 'disagree')),
  human_note      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eval_check_trial ON public.eval_check (trial_id);
CREATE INDEX IF NOT EXISTS idx_eval_check_key ON public.eval_check (workspace_id, check_key);

-- ============================================================
-- 3. RLS — is_workspace_member on every table (248's idiom),
--    plus eval_case's own visibility (223's posture)
-- ============================================================
--
-- The run engine is service-role and bypasses these entirely, so every
-- service-role bulk operation must carry an explicit workspace check in
-- application code — the rule documented at the top of
-- src/lib/crm/delete-companies.ts.

ALTER TABLE public.eval_suite            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_case             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_prompt_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_run              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_trial            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_check            ENABLE ROW LEVEL SECURITY;

-- eval_suite: full member CRUD. A suite is cheap to recreate and carries no
-- suppression semantics, so there is no creator-or-admin delete gate here.
DROP POLICY IF EXISTS eval_suite_member_select ON public.eval_suite;
CREATE POLICY eval_suite_member_select ON public.eval_suite
  FOR SELECT USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS eval_suite_member_insert ON public.eval_suite;
CREATE POLICY eval_suite_member_insert ON public.eval_suite
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS eval_suite_member_update ON public.eval_suite;
CREATE POLICY eval_suite_member_update ON public.eval_suite
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  -- workspace_id pinned to the PRE-image so an UPDATE can never relocate a row
  -- across workspaces (191's trap, restated in 248): a member of two workspaces
  -- would otherwise pass every clause for both the old and a new workspace_id.
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT s.workspace_id FROM public.eval_suite s WHERE s.id = eval_suite.id)
  );

DROP POLICY IF EXISTS eval_suite_member_delete ON public.eval_suite;
CREATE POLICY eval_suite_member_delete ON public.eval_suite
  FOR DELETE USING (public.is_workspace_member(workspace_id));

-- eval_case: membership AND the case's own visibility, matching 223's
-- captures_select posture. A case seeded from a private capture (via
-- capture_to_eval_case) stays creator-only, because its script is a pseudonymized
-- copy of that capture's content.
DROP POLICY IF EXISTS eval_case_member_select ON public.eval_case;
CREATE POLICY eval_case_member_select ON public.eval_case
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
    AND (visibility = 'workspace' OR created_by = auth.uid())
  );

DROP POLICY IF EXISTS eval_case_member_insert ON public.eval_case;
CREATE POLICY eval_case_member_insert ON public.eval_case
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS eval_case_member_update ON public.eval_case;
CREATE POLICY eval_case_member_update ON public.eval_case
  FOR UPDATE
  USING (
    public.is_workspace_member(workspace_id)
    AND (visibility = 'workspace' OR created_by = auth.uid())
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT c.workspace_id FROM public.eval_case c WHERE c.id = eval_case.id)
  );

DROP POLICY IF EXISTS eval_case_member_delete ON public.eval_case;
CREATE POLICY eval_case_member_delete ON public.eval_case
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
    AND (visibility = 'workspace' OR created_by = auth.uid())
  );

-- recipe_prompt_version: a version of a SYSTEM recipe has workspace_id NULL and
-- is readable by every signed-in user, the same way the recipe itself is.
-- Writes go through snapshotRecipePrompt service-role; there is no client
-- UPDATE or DELETE policy, deliberately — a version is an immutable snapshot,
-- and an editable one would make the trend line lie.
DROP POLICY IF EXISTS recipe_prompt_version_member_select ON public.recipe_prompt_version;
CREATE POLICY recipe_prompt_version_member_select ON public.recipe_prompt_version
  FOR SELECT USING (
    workspace_id IS NULL OR public.is_workspace_member(workspace_id)
  );

DROP POLICY IF EXISTS recipe_prompt_version_member_insert ON public.recipe_prompt_version;
CREATE POLICY recipe_prompt_version_member_insert ON public.recipe_prompt_version
  FOR INSERT WITH CHECK (
    workspace_id IS NULL OR public.is_workspace_member(workspace_id)
  );

-- eval_run: members may create a run and cancel one (status → 'cancelled');
-- the engine writes everything else service-role. No client DELETE: a run is
-- the historical record the sparkline and the baseline are drawn from.
DROP POLICY IF EXISTS eval_run_member_select ON public.eval_run;
CREATE POLICY eval_run_member_select ON public.eval_run
  FOR SELECT USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS eval_run_member_insert ON public.eval_run;
CREATE POLICY eval_run_member_insert ON public.eval_run
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS eval_run_member_update ON public.eval_run;
CREATE POLICY eval_run_member_update ON public.eval_run
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT r.workspace_id FROM public.eval_run r WHERE r.id = eval_run.id)
  );

-- eval_trial: read-only from the client except the flush-append endpoint, which
-- runs service-role. A client that could rewrite a trace could rewrite a score.
DROP POLICY IF EXISTS eval_trial_member_select ON public.eval_trial;
CREATE POLICY eval_trial_member_select ON public.eval_trial
  FOR SELECT USING (public.is_workspace_member(workspace_id));

-- eval_check: read for members; UPDATE exists solely so a member can record a
-- thumbs-up/down on a judge check (human_override / human_note). Everything
-- else on the row is grader-written service-role.
DROP POLICY IF EXISTS eval_check_member_select ON public.eval_check;
CREATE POLICY eval_check_member_select ON public.eval_check
  FOR SELECT USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS eval_check_member_update ON public.eval_check;
CREATE POLICY eval_check_member_update ON public.eval_check
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT k.workspace_id FROM public.eval_check k WHERE k.id = eval_check.id)
  );

REVOKE ALL ON public.eval_suite, public.eval_case, public.recipe_prompt_version,
  public.eval_run, public.eval_trial, public.eval_check FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eval_suite TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eval_case TO authenticated;
GRANT SELECT, INSERT ON public.recipe_prompt_version TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.eval_run TO authenticated;
GRANT SELECT ON public.eval_trial TO authenticated;
GRANT SELECT, UPDATE ON public.eval_check TO authenticated;

-- ============================================================
-- 4. updated_at triggers (248 section 7's pattern)
-- ============================================================
-- Without these the column is write-once and lies forever.
-- recipe_prompt_version, eval_run, eval_trial and eval_check have no updated_at:
-- a version is immutable, and the other three carry started_at / ended_at as
-- their lifecycle. Listed here so their absence reads as deliberate.

DROP TRIGGER IF EXISTS eval_suite_updated_at ON public.eval_suite;
CREATE TRIGGER eval_suite_updated_at
  BEFORE UPDATE ON public.eval_suite
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS eval_case_updated_at ON public.eval_case;
CREATE TRIGGER eval_case_updated_at
  BEFORE UPDATE ON public.eval_case
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. The participant-link guard
-- ============================================================
--
-- A `capture_participant` row on an eval capture must not point at a real
-- contact or a real member. That is what keeps a mock sales call off a real
-- contact's CRM timeline BY CONSTRUCTION rather than by every writer
-- remembering — the synthesizer path, the per-trial clone path, and the
-- save-from-a-real-capture path all pass through this one gate.
--
-- The ONE exception is the self participant's member link. Self-binding needs
-- it: seedSelfParticipant (src/lib/crm/contacts.ts) inserts the capture owner's
-- own row with is_self = true and member_id set, and the route's
-- currentMemberId / isMineExplicit resolution — which is exactly what a trial
-- is grading — behaves like a real call only when that row exists. So member_id
-- is allowed when is_self AND the member is the capture's own user; contact_id
-- is refused unconditionally, including on the self row, because the self
-- CONTACT is a real CRM row with a real timeline.
--
-- Same shape as 222's enforce_action_status_team: a BEFORE trigger on
-- INSERT and on UPDATE OF the two columns only, so ordinary participant edits
-- (speaker_label, voice_match_confidence) pay nothing. SECURITY DEFINER with a
-- pinned search_path because it reads `captures` and `member`, which the caller
-- may not see under RLS.

CREATE OR REPLACE FUNCTION public.enforce_eval_capture_participant_links()
RETURNS trigger AS $$
DECLARE
  v_is_eval boolean;
  v_capture_user uuid;
  v_member_user uuid;
BEGIN
  -- Fast path: nothing to police unless a link is actually being set.
  IF new.contact_id IS NULL AND new.member_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT c.is_eval, c.user_id
  INTO v_is_eval, v_capture_user
  FROM public.captures c
  WHERE c.id = new.capture_id;

  -- Unknown capture (let the FK speak) or a real one: not our business.
  IF v_is_eval IS NOT TRUE THEN
    RETURN new;
  END IF;

  IF new.contact_id IS NOT NULL THEN
    RAISE EXCEPTION
      'capture_participant.contact_id must be NULL on an eval capture (capture %)', new.capture_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF new.member_id IS NOT NULL THEN
    IF NOT new.is_self THEN
      RAISE EXCEPTION
        'capture_participant.member_id is allowed on an eval capture only for the self participant (capture %)', new.capture_id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT m.user_id INTO v_member_user
    FROM public.member m
    WHERE m.id = new.member_id;

    -- The self row may only bind the capture's OWN user. Otherwise a clone could
    -- silently attribute a mock call's commitments to a colleague.
    IF v_member_user IS NULL OR v_member_user IS DISTINCT FROM v_capture_user THEN
      RAISE EXCEPTION
        'the self participant on an eval capture must be the capture owner (capture %)', new.capture_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS eval_capture_participant_links_guard ON public.capture_participant;
CREATE TRIGGER eval_capture_participant_links_guard
  BEFORE INSERT OR UPDATE OF contact_id, member_id, is_self, capture_id
    ON public.capture_participant
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_eval_capture_participant_links();

-- ============================================================
-- 6. Search functions — AND NOT c.is_eval
-- ============================================================
--
-- The four SECURITY DEFINER search functions that can surface a capture. Each
-- body below is copied VERBATIM from its current definition, with the single
-- `AND NOT <alias>.is_eval` predicate added and nothing else changed:
--
--   * hybrid_search              — body from 226 (NOT 223; 226 re-declared it to
--                                  add series_key to the capture metadata, and
--                                  its own header warns later migrations to copy
--                                  THAT body). Predicate lands on capture_fts,
--                                  capture_vec, capture_final, and on the two
--                                  capture EXISTS clauses inside claim_top_source.
--   * hybrid_search_attachments  — body from 223. Predicate lands on the
--                                  capture-parent EXISTS.
--   * unified_search             — body from 223. Predicate lands on the capture
--                                  branch and on the decision branch's captures
--                                  join (a decision on a mock call is capture-
--                                  derived content and must not surface either).
--   * claim_visible_to           — body from 223. A claim whose only source is an
--                                  eval capture resolves to NOT visible, the same
--                                  way a private capture already does. This is
--                                  belt-and-braces: record_commitment
--                                  short-circuits before writing any claim row on
--                                  an eval capture (§5.1), so no such claim should
--                                  exist — but the nightly isolation assertion
--                                  should be the thing that finds one, not a user.
--
-- Signatures are IDENTICAL, so CREATE OR REPLACE keeps every existing grant.

-- ---------- claim_visible_to (from 223) ----------
CREATE OR REPLACE FUNCTION public.claim_visible_to(
  p_claim_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT
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
                   OR (p_user_id IS NOT NULL AND c.user_id = p_user_id))
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
                         OR (p_user_id IS NOT NULL AND c.user_id = p_user_id))
                )
              )
          )
          ELSE TRUE
        END
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- ---------- hybrid_search (from 226) ----------
CREATE OR REPLACE FUNCTION public.hybrid_search(
    p_workspace_id   UUID,
    p_query          TEXT,
    p_embedding      TEXT DEFAULT NULL,               -- OpenAI 1536-d as '[..]' text; NULL → FTS-only
    p_types          TEXT[] DEFAULT ARRAY['claim','capture','document'],
    p_since          TIMESTAMPTZ DEFAULT NULL,
    p_until          TIMESTAMPTZ DEFAULT NULL,
    p_limit          INTEGER DEFAULT 20,
    p_candidate_k    INTEGER DEFAULT 40,              -- depth of each method's own list before fusion
    p_w_fts          DOUBLE PRECISION DEFAULT 1.0,
    p_w_vec          DOUBLE PRECISION DEFAULT 1.0,
    p_w_recent       DOUBLE PRECISION DEFAULT 0.5,
    p_claim_status   TEXT DEFAULT 'active',           -- claims-only filter; ignored for other types
    p_requesting_user_id UUID DEFAULT NULL            -- NULL → auth.uid(); still NULL → private captures excluded
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
    v_tsquery   tsquery;
    v_embedding vector(1536) := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding::vector(1536) END;
    v_requester uuid := COALESCE(p_requesting_user_id, auth.uid());
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
        RETURN;
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
                         OR (v_requester IS NOT NULL AND cap2.user_id = v_requester))
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
                                   OR (v_requester IS NOT NULL AND cap3.user_id = v_requester))
                        )
                    )
              )
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
                    WHEN 'email'    THEN em.subject
                    ELSE ts.source_type
                END, 'Claim'
            ) AS source_label,
            ts.source_type,
            cs.metadata
        FROM claim_scored cs
        LEFT JOIN claim_top_source ts ON ts.claim_id = cs.result_id
        LEFT JOIN public.captures      cap ON ts.source_type = 'capture'  AND cap.id = ts.source_id
        LEFT JOIN public.document      doc ON ts.source_type = 'document' AND doc.id = ts.source_id
        LEFT JOIN public.email_message em  ON ts.source_type = 'email'    AND em.id  = ts.source_id
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
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester))
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
              AND (cap.visibility = 'workspace' OR (v_requester IS NOT NULL AND cap.user_id = v_requester))
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
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester))
    ),

    -- ============ DOCUMENTS (FTS + vector + recency) ============
    document_fts AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY ts_rank(d.fts, v_tsquery) DESC)::int AS rnk
        FROM public.document d
        WHERE d.workspace_id = p_workspace_id AND 'document' = ANY(p_types)
          AND v_tsquery IS NOT NULL AND d.fts @@ v_tsquery
          AND (p_since IS NULL OR d.created_at >= p_since)
          AND (p_until IS NULL OR d.created_at <= p_until)
        LIMIT p_candidate_k
    ),
    document_vec AS (
        SELECT id, MIN(rnk)::int AS rnk FROM (
            SELECT dc.document_id AS id,
                   ROW_NUMBER() OVER (ORDER BY dc.embedding <=> v_embedding) AS rnk
            FROM public.document_chunks dc
            JOIN public.document d ON d.id = dc.document_id
            WHERE dc.workspace_id = p_workspace_id AND 'document' = ANY(p_types) AND v_embedding IS NOT NULL
              AND (p_since IS NULL OR d.created_at >= p_since)
              AND (p_until IS NULL OR d.created_at <= p_until)
            ORDER BY dc.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    document_union AS (SELECT id FROM document_fts UNION SELECT id FROM document_vec),
    document_recency AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY d.created_at DESC)::int AS rnk
        FROM public.document d JOIN document_union u ON u.id = d.id
    ),
    document_final AS (
        SELECT
            'document'::text AS result_type,
            d.id AS result_id,
            d.title,
            p_w_fts    * COALESCE(1.0/(60+df.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+dv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+dr.rnk), 0) AS score,
            d.created_at AS event_at,
            df.rnk AS fts_rank,
            dv.rnk AS vec_rank,
            dr.rnk AS recency_rank,
            LEFT(d.content, 300) AS excerpt,
            'Document'::text AS source_label,
            'document'::text AS source_type,
            jsonb_build_object('status', d.status, 'project_id', d.project_id) AS metadata
        FROM public.document d
        JOIN document_union u ON u.id = d.id
        LEFT JOIN document_fts df ON df.id = d.id
        LEFT JOIN document_vec dv ON dv.id = d.id
        LEFT JOIN document_recency dr ON dr.id = d.id
    )

    SELECT * FROM claim_final
    UNION ALL SELECT * FROM capture_final
    UNION ALL SELECT * FROM document_final
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

-- ---------- hybrid_search_attachments (from 223) ----------
CREATE OR REPLACE FUNCTION public.hybrid_search_attachments(
    p_workspace_id   UUID,
    p_embedding      TEXT DEFAULT NULL,           -- Gemini 3072-d as '[..]' text; NULL → no results
    p_since          TIMESTAMPTZ DEFAULT NULL,
    p_until          TIMESTAMPTZ DEFAULT NULL,
    p_limit          INTEGER DEFAULT 20,
    p_candidate_k    INTEGER DEFAULT 40,
    p_w_vec          DOUBLE PRECISION DEFAULT 1.0,
    p_w_recent       DOUBLE PRECISION DEFAULT 0.5,
    p_requesting_user_id UUID DEFAULT NULL        -- NULL → auth.uid(); still NULL → private captures excluded
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
    v_requester uuid := COALESCE(p_requesting_user_id, auth.uid());
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
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
              AND (
                  a.note_id IS NULL
                  OR EXISTS (
                      SELECT 1 FROM public.captures c
                      WHERE c.id = a.note_id
                        AND NOT c.is_eval
                        AND (c.visibility = 'workspace'
                             OR (v_requester IS NOT NULL AND c.user_id = v_requester))
                  )
              )
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

-- ---------- unified_search (from 223) ----------
CREATE OR REPLACE FUNCTION public.unified_search(
    p_workspace_id UUID,
    p_query TEXT,
    p_types TEXT[] DEFAULT ARRAY['action', 'capture', 'document', 'project', 'decision', 'claim'],
    p_limit INTEGER DEFAULT 20,
    p_requesting_user_id UUID DEFAULT NULL
)
RETURNS TABLE(
    result_type TEXT,
    result_id UUID,
    title TEXT,
    subtitle TEXT,
    icon TEXT,
    rank REAL,
    metadata JSONB
) AS $$
DECLARE
  v_tsquery tsquery;
  v_identifier_pattern text;
  v_is_identifier bool;
  v_requester uuid := COALESCE(p_requesting_user_id, auth.uid());
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
    RETURN;
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
    AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester))

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
         OR (v_requester IS NOT NULL AND c.user_id = v_requester)
         OR dec.confirmation = 'confirmed')

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
