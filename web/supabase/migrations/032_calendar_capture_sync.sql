-- ============================================================
-- 032: Calendar → Capture Sync
-- Links calendar events to captures for auto-capture workflow.
-- Adds new notification types for meeting reminders and follow-ups.
-- ============================================================

-- 1. Add new columns to captures for calendar sync
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS calendar_provider text,
  ADD COLUMN IF NOT EXISTS scheduled_start timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_end timestamptz,
  ADD COLUMN IF NOT EXISTS auto_capture_status text DEFAULT NULL
    CHECK (auto_capture_status IS NULL OR auto_capture_status IN ('pending', 'ready', 'recording', 'completed', 'skipped'));

-- Index for upcoming auto-captures (pending captures sorted by start time)
CREATE INDEX IF NOT EXISTS captures_scheduled_start_idx
  ON public.captures (scheduled_start)
  WHERE scheduled_start IS NOT NULL AND auto_capture_status = 'pending';

-- Index for calendar provider lookups
CREATE INDEX IF NOT EXISTS captures_calendar_provider_idx
  ON public.captures (calendar_provider)
  WHERE calendar_provider IS NOT NULL;

-- 2. Update notification type constraint to include new types
ALTER TABLE public.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE public.notification ADD CONSTRAINT notification_type_check
  CHECK (type IN (
    'action_assigned',
    'action_unassigned',
    'action_status_changed',
    'action_priority_changed',
    'action_due_soon',
    'action_overdue',
    'action_mentioned',
    'capture_processed',
    'capture_shared',
    'comment_added',
    'comment_reply',
    'decision_confirmed',
    'cycle_started',
    'cycle_ending_soon',
    'share_comment_added',
    'project_status_changed',
    'meeting_starting_soon',
    'followup_reminder'
  ));

-- 3. Add new notification types to the seed function
CREATE OR REPLACE FUNCTION public.seed_notification_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.notification_preference (member_id, notification_type, in_app, email)
  VALUES
    (NEW.id, 'action_assigned', true, false),
    (NEW.id, 'action_unassigned', true, false),
    (NEW.id, 'action_status_changed', true, false),
    (NEW.id, 'action_priority_changed', false, false),
    (NEW.id, 'action_due_soon', true, false),
    (NEW.id, 'action_overdue', true, false),
    (NEW.id, 'action_mentioned', true, false),
    (NEW.id, 'capture_processed', true, false),
    (NEW.id, 'capture_shared', true, false),
    (NEW.id, 'comment_added', true, false),
    (NEW.id, 'comment_reply', true, false),
    (NEW.id, 'decision_confirmed', true, false),
    (NEW.id, 'cycle_started', true, false),
    (NEW.id, 'cycle_ending_soon', true, false),
    (NEW.id, 'share_comment_added', true, false),
    (NEW.id, 'project_status_changed', false, false),
    (NEW.id, 'meeting_starting_soon', true, false),
    (NEW.id, 'followup_reminder', true, false)
  ON CONFLICT (member_id, notification_type) DO NOTHING;
  RETURN NEW;
END;
$$;

-- 4. Seed new notification preferences for existing members
INSERT INTO public.notification_preference (member_id, notification_type, in_app, email)
SELECT m.id, t.type, true, false
FROM public.member m
CROSS JOIN (VALUES ('meeting_starting_soon'), ('followup_reminder')) AS t(type)
ON CONFLICT (member_id, notification_type) DO NOTHING;
