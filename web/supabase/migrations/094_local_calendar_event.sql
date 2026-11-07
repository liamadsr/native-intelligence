-- Cache for local Exchange calendar events pushed from the desktop app.
-- This allows the AI assistant (server-side) to see exchange events
-- that are normally only available via the Tauri/EventKit bridge.

CREATE TABLE public.local_calendar_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  -- The external event ID from EventKit (used for upsert dedup)
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT false,
  location TEXT,
  organizer TEXT,
  attendees JSONB DEFAULT '[]',
  conference_url TEXT,
  calendar_name TEXT,
  calendar_id TEXT,
  has_recurrence BOOLEAN DEFAULT false,
  source TEXT NOT NULL DEFAULT 'local_exchange',
  -- Staleness: desktop pushes events periodically; we keep a timestamp
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, external_id)
);

CREATE INDEX idx_local_calendar_event_user_range
  ON public.local_calendar_event (user_id, start_at, end_at);

CREATE INDEX idx_local_calendar_event_workspace
  ON public.local_calendar_event (workspace_id);

-- RLS
ALTER TABLE public.local_calendar_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own local calendar events"
  ON public.local_calendar_event FOR ALL
  USING (auth.uid() = user_id);
