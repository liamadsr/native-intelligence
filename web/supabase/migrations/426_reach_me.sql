-- ============================================================
-- 426: The agent reaches you when it needs you, by Slack or by text, and you
-- approve by text.
--
-- docs/plans/text-and-calling.md Phase 2 and docs/plans/slack-connect.md,
-- built once for both channels (src/lib/reach/). When a held call waits on a
-- person and nobody is in a chat to see its card, the agent sends it to their
-- Slack DM (blocks with buttons) or texts it to their verified phone (with its
-- reply code). They answer there ("yes K7Q4"), settled as their own click.
--
--   user_phone.alerts_consented_at,
--   user_phone.alerts_consent_version  the person turned on "text me when
--                            Dial8 needs my OK" (Settings > Phone), with the
--                            consent words they agreed to. Unset: no
--                            proactive texts (replies to their own texts only).
--   slack_user_link.alerts_off_at      the person turned the Slack DMs off.
--                            Unset (the default once linked): on. Skipped on a
--                            database without 412.
--   reach_notice             one row per (person's ask, channel) the agent
--                            sent: never twice, and the per-day caps. Service
--                            only.
--   sms_message.kind         in: 'approval' (a text that answered one by its
--                            code), 'code_miss' (a code that matched nothing,
--                            capped per day). out: 'needs_you' (the agent
--                            asking), 'approval_result'.
--
-- Idempotent. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── user_phone: proactive texts are opt-in ─────────────────────────────────

alter table public.user_phone add column if not exists alerts_consented_at timestamptz null;
alter table public.user_phone add column if not exists alerts_consent_version text null;

comment on column public.user_phone.alerts_consented_at is
  'Set when the person turned on texts from the agent when it needs them (426). Unset: Dial8 texts only replies to their own texts.';
comment on column public.user_phone.alerts_consent_version is
  'Which alert consent words they agreed to (src/lib/sms/consent.ts SMS_ALERTS_CONSENT_VERSION).';

alter table public.user_phone drop constraint if exists user_phone_alerts_consent_version_length;
alter table public.user_phone
  add constraint user_phone_alerts_consent_version_length check (alerts_consent_version is null or char_length(alerts_consent_version) between 1 and 40);

-- ── slack_user_link: DMs are on once linked ────────────────────────────────

alter table if exists public.slack_user_link add column if not exists alerts_off_at timestamptz null;

do $$
begin
  if to_regclass('public.slack_user_link') is not null then
    execute 'comment on column public.slack_user_link.alerts_off_at is ''Set when the person turned off Slack DMs from the agent when it needs them (426). Unset: on.''';
  end if;
end
$$;

-- ── reach_notice ───────────────────────────────────────────────────────────

create table if not exists public.reach_notice (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  ref_type text not null check (ref_type in ('tool_approval')),
  ref_id uuid not null,
  channel text not null check (channel in ('slack', 'sms')),
  created_at timestamptz not null default now()
);

comment on table public.reach_notice is
  'The agent reaching a person on an outside channel about one thing waiting on them (426): one row per thing and channel, so it is never sent twice. Service role only.';

create unique index if not exists reach_notice_ref_channel_key on public.reach_notice (ref_type, ref_id, channel);
create index if not exists reach_notice_user_created_idx on public.reach_notice (user_id, created_at desc);

alter table public.reach_notice enable row level security;
revoke all on public.reach_notice from anon, authenticated;

-- ── sms_message kinds ──────────────────────────────────────────────────────

comment on column public.sms_message.kind is
  'in: text, stop, start, help, unknown, limited, approval, code_miss. out: verification, welcome, reply, notice, unknown_reply, auto_reply (HELP / START answers), needs_you, approval_result.';

alter table public.sms_message drop constraint if exists sms_message_kind_check;
alter table public.sms_message
  add constraint sms_message_kind_check check (
    kind in (
      'text', 'stop', 'start', 'help', 'unknown', 'limited', 'approval', 'code_miss',
      'verification', 'welcome', 'reply', 'notice', 'unknown_reply', 'auto_reply', 'needs_you', 'approval_result'
    )
  );
