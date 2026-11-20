-- ============================================================
-- 671: comments @-mention teammates and records, and a mentioned teammate is
-- told (docs/plans/mentions-everywhere.md, decisions 2 and 4).
-- ============================================================
--   comment.mentions         the workspace members a comment @-mentions (member
--                            ids, at most 50), as team_chat_message.mentions
--                            holds them (474).
--   comment.record_mentions  the records it @-mentions, as its words show them:
--                            [{ "type", "id", "label" }], at most 50, the one
--                            mention format (480's, on team chat messages).
--                            Written by the comment routes after fencing each
--                            for the author (src/lib/comment-mentions.ts); the
--                            same records are `mentions` edges in entity_link
--                            from the record the comment is on.
--   notification.type        + 'mentioned': a teammate @-mentioned in a comment,
--                            a document, or a description or note. In-app, like
--                            the comment notices; no new channel.
--
-- Old comments keep empty defaults: nothing is rewritten.
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

alter table public.comment
  add column if not exists mentions uuid[] not null default '{}',
  add column if not exists record_mentions jsonb not null default '[]'::jsonb;

alter table public.comment drop constraint if exists comment_mentions_max;
alter table public.comment
  add constraint comment_mentions_max check (cardinality(mentions) <= 50);

alter table public.comment drop constraint if exists comment_record_mentions;
alter table public.comment
  add constraint comment_record_mentions check (
    jsonb_typeof(record_mentions) = 'array' and jsonb_array_length(record_mentions) <= 50
  );

comment on column public.comment.mentions is
  'The workspace members this comment @-mentions (member ids). Fenced to the workspace by the comment routes.';
comment on column public.comment.record_mentions is
  'The records this comment @-mentions: [{type,id,label}], each fenced for the author before it is stored.';

-- 642's list, plus 'mentioned'.
alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message',
  'meeting_waiting', 'email_send_failed', 'mentioned'
])) not valid;
alter table public.notification validate constraint notification_type_check;

commit;

notify pgrst, 'reload schema';
