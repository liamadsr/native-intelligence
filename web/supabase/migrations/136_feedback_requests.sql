-- 136: Feedback Requests
-- Resurrects the old desktop "request feedback from a user" capability on the web.
-- Builds on the existing in-app messaging system (003) + feature requests (005):
--   * admin sends a `feedback_prompt` in_app_message tied to a user's account
--   * a companion `notification` (type 'feedback_requested') surfaces it in the web inbox
--   * the user answers via message_responses (rating + text), optionally linked to a
--     specific feature_request on the public board.
-- No new core tables — only the minimal additions to wire the existing tables to the web.
-- Idempotent: safe to re-run.

-- 1. Allow the new notification type so the request appears in the inbox bell + list.
ALTER TABLE public.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE public.notification ADD CONSTRAINT notification_type_check CHECK (type = ANY (ARRAY[
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
  'followup_reminder',
  'contact_followup_due',
  'relationship_going_stale',
  'email_drafts_ready',
  'feedback_requested'
]));

-- 2. Optionally tie a feedback response to a specific public feature request, so an
--    admin can ask "what do you think of <roadmap item>?" and route the answer back to it.
ALTER TABLE public.message_responses
  ADD COLUMN IF NOT EXISTS feature_request_id UUID REFERENCES public.feature_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_message_responses_feature_request
  ON public.message_responses(feature_request_id)
  WHERE feature_request_id IS NOT NULL;

-- Deep-linking uses the existing in_app_messages.cta_url column (no new column needed):
--   cta_action = 'respond'  -> opens the in-inbox answer form
--   cta_action = 'url'      -> opens cta_url (can point at /account#feedback or a request)
