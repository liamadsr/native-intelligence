-- ============================================================
-- 031: Notifications
-- ============================================================

-- Notification table
CREATE TABLE public.notification (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,

  type text NOT NULL CHECK (type IN (
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
    'project_status_changed'
  )),

  title text NOT NULL,
  body text,

  actor_id uuid REFERENCES public.member (id) ON DELETE SET NULL,

  target_type text CHECK (target_type IN ('action', 'capture', 'document', 'project', 'cycle', 'comment', 'decision', 'share')),
  target_id uuid,

  context_type text,
  context_id uuid,

  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  is_archived boolean NOT NULL DEFAULT false,

  group_key text,

  metadata jsonb DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX notification_recipient_idx
  ON public.notification (recipient_id, is_read, created_at DESC)
  WHERE is_archived = false;

CREATE INDEX notification_recipient_unread_idx
  ON public.notification (recipient_id)
  WHERE is_read = false AND is_archived = false;

CREATE INDEX notification_group_idx
  ON public.notification (group_key)
  WHERE group_key IS NOT NULL;

CREATE INDEX notification_target_idx
  ON public.notification (target_type, target_id);

CREATE INDEX notification_created_idx
  ON public.notification (created_at DESC);

-- Notification preferences table
CREATE TABLE public.notification_preference (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  member_id uuid NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  UNIQUE (member_id, notification_type)
);

-- Seed default preferences for new members
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
    (NEW.id, 'project_status_changed', false, false);
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_seed_notification_preferences
  AFTER INSERT ON public.member
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_notification_preferences();

-- RLS
ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preference ENABLE ROW LEVEL SECURITY;

-- Users can only see their own notifications
CREATE POLICY "notification_select"
  ON public.notification FOR SELECT
  USING (recipient_id = (
    SELECT id FROM public.member
    WHERE user_id = auth.uid() AND workspace_id = notification.workspace_id
    LIMIT 1
  ));

-- Users can update their own notifications (mark read, archive)
CREATE POLICY "notification_update"
  ON public.notification FOR UPDATE
  USING (recipient_id = (
    SELECT id FROM public.member
    WHERE user_id = auth.uid() AND workspace_id = notification.workspace_id
    LIMIT 1
  ));

-- Users can manage their own preferences
CREATE POLICY "notification_preference_select"
  ON public.notification_preference FOR SELECT
  USING (member_id = (
    SELECT id FROM public.member WHERE user_id = auth.uid() LIMIT 1
  ));

CREATE POLICY "notification_preference_update"
  ON public.notification_preference FOR UPDATE
  USING (member_id = (
    SELECT id FROM public.member WHERE user_id = auth.uid() LIMIT 1
  ));

-- Enable Realtime for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.notification;

-- Cleanup function for old notifications (run via pg_cron or scheduled job)
CREATE OR REPLACE FUNCTION public.cleanup_old_notifications()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM public.notification
  WHERE (is_archived = true AND created_at < now() - interval '30 days')
     OR (is_read = true AND created_at < now() - interval '90 days');
$$;
