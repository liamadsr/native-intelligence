-- Meeting Agent: real-time meeting processing with proposed actions
-- Tracks live meeting sessions and the agent's proposed actions during meetings

-- ── Meeting sessions (one per recording session) ─────────────────
CREATE TABLE IF NOT EXISTS public.meeting_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  capture_id UUID REFERENCES public.captures(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reviewing', 'completed', 'dismissed')),
  detected_app TEXT,              -- e.g. "Zoom", "Google Meet"
  participants JSONB DEFAULT '[]', -- [{name, speaker_label, contact_id?, confidence}]
  topics JSONB DEFAULT '[]',       -- [{name, project_id?, first_mentioned_at}]
  context_summary TEXT,            -- Agent's rolling understanding of the meeting
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_session_user ON public.meeting_session(user_id);
CREATE INDEX idx_meeting_session_workspace ON public.meeting_session(workspace_id);
CREATE INDEX idx_meeting_session_status ON public.meeting_session(status) WHERE status = 'active';

-- ── Proposed actions from the agent during a meeting ─────────────
CREATE TABLE IF NOT EXISTS public.meeting_proposed_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.meeting_session(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('create_action', 'update_project', 'update_milestone', 'capture_decision', 'create_note')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed', 'expired')),
  title TEXT NOT NULL,
  description TEXT,
  reason TEXT,                     -- Why the agent proposed this (quote or rationale)
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  tool_name TEXT,                  -- Which tool to call on accept (e.g. 'create_action')
  tool_args JSONB,                 -- Arguments for the tool call
  result_id TEXT,                  -- ID of the created entity after acceptance
  transcript_quote TEXT,           -- Relevant snippet from the transcript
  speaker_label TEXT,              -- Who said it
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_meeting_proposed_action_session ON public.meeting_proposed_action(session_id);
CREATE INDEX idx_meeting_proposed_action_status ON public.meeting_proposed_action(status) WHERE status = 'pending';

-- ── Agent activity log (ambient context-building events) ─────────
CREATE TABLE IF NOT EXISTS public.meeting_agent_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.meeting_session(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('context_loaded', 'participant_identified', 'topic_detected', 'project_linked', 'confidence_update', 'summary_update')),
  message TEXT NOT NULL,           -- Human-readable description
  metadata JSONB,                  -- Extra data (project_id, contact_id, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_agent_event_session ON public.meeting_agent_event(session_id);

-- ── RLS Policies ─────────────────────────────────────────────────
ALTER TABLE public.meeting_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_proposed_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_agent_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY meeting_session_user_policy ON public.meeting_session
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY meeting_proposed_action_user_policy ON public.meeting_proposed_action
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY meeting_agent_event_user_policy ON public.meeting_agent_event
  FOR ALL USING (
    session_id IN (SELECT id FROM public.meeting_session WHERE user_id = auth.uid())
  );

-- ── Realtime ─────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_session;
ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_proposed_action;
ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_agent_event;

-- ── Updated_at trigger ───────────────────────────────────────────
CREATE OR REPLACE TRIGGER meeting_session_updated_at
  BEFORE UPDATE ON public.meeting_session
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
