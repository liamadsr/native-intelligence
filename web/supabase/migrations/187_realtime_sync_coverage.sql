-- Realtime sync coverage (see docs/plans/realtime-ui-sync.md).
--
-- Two changes:
--
-- 1. Publish the remaining UI-rendered tables so server-side writes (MCP
--    tools, AI chat, Inngest jobs, teammates) reach open browser tabs.
--    RLS still gates INSERT/UPDATE delivery per subscriber.
--
-- 2. REPLICA IDENTITY FULL on every published entity table, so UPDATE events
--    carry the complete OLD row (client listeners like the notification
--    unread-count delta diff old vs new). Note: DELETE payloads stay PK-only
--    regardless of replica identity — Supabase strips the old row and ignores
--    subscription filters for deletes (verified empirically on DEV) — so
--    client match predicates must treat an absent scoping column as a match.
--
-- Both operations are idempotent: ADD TABLE is wrapped to swallow
-- duplicate_object, and REPLICA IDENTITY FULL is a plain flag set.

-- ── 1. Publication additions ────────────────────────────────────────────────
-- Deliberately NOT published: email_message (heavy sync churn — the
-- email_thread_index UPDATE is the client signal), document/embedding side
-- tables, and audit/log tables.

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.decision;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.cycle;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.milestone;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.workflow_state;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.label;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.team;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.team_member;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.member;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.recipe;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.flow;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.flow_run;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.email_draft;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contact_interaction;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.local_calendar_event;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_run;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.capture_participant;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. REPLICA IDENTITY FULL ────────────────────────────────────────────────
-- Already FULL (do not re-set, though re-setting is harmless): captures (074),
-- email_thread_index (130), attention_item (167), chat_messages (173).

ALTER TABLE public.actions              REPLICA IDENTITY FULL;
ALTER TABLE public.projects             REPLICA IDENTITY FULL;
ALTER TABLE public.initiative           REPLICA IDENTITY FULL;
ALTER TABLE public.document             REPLICA IDENTITY FULL;
ALTER TABLE public.contact              REPLICA IDENTITY FULL;
ALTER TABLE public.company              REPLICA IDENTITY FULL;
ALTER TABLE public.proposed_change      REPLICA IDENTITY FULL;
ALTER TABLE public.comment              REPLICA IDENTITY FULL;
ALTER TABLE public.claim                REPLICA IDENTITY FULL;
ALTER TABLE public.entity_link          REPLICA IDENTITY FULL;
ALTER TABLE public.notification         REPLICA IDENTITY FULL;
ALTER TABLE public.document_draft       REPLICA IDENTITY FULL;
ALTER TABLE public.document_revision    REPLICA IDENTITY FULL;
ALTER TABLE public.decision             REPLICA IDENTITY FULL;
ALTER TABLE public.cycle                REPLICA IDENTITY FULL;
ALTER TABLE public.milestone            REPLICA IDENTITY FULL;
ALTER TABLE public.workflow_state       REPLICA IDENTITY FULL;
ALTER TABLE public.label                REPLICA IDENTITY FULL;
ALTER TABLE public.team                 REPLICA IDENTITY FULL;
ALTER TABLE public.team_member          REPLICA IDENTITY FULL;
ALTER TABLE public.member               REPLICA IDENTITY FULL;
ALTER TABLE public.recipe               REPLICA IDENTITY FULL;
ALTER TABLE public.flow                 REPLICA IDENTITY FULL;
ALTER TABLE public.flow_run             REPLICA IDENTITY FULL;
ALTER TABLE public.email_draft          REPLICA IDENTITY FULL;
ALTER TABLE public.contact_interaction  REPLICA IDENTITY FULL;
ALTER TABLE public.local_calendar_event REPLICA IDENTITY FULL;
ALTER TABLE public.agent_run            REPLICA IDENTITY FULL;
ALTER TABLE public.capture_participant  REPLICA IDENTITY FULL;
