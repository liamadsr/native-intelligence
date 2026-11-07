-- Migration 334: email.trust marks on mail threads (docs/plans/always-on-agent.md
-- §6b, A5 slice 1).
--
-- Jev's reply gate (email-reply-v4) also asks whether a thread is phishing or
-- impersonation, or carries text aimed at an AI assistant (injection). It
-- ships in SHADOW: the answers are recorded in ai_usage_logs and nothing is
-- written here. Once enforced (EMAIL_TRUST_ENFORCE, src/lib/crm/email-trust.ts),
-- a flagged thread is marked:
--
--   email_thread_index.trust               'suspicious' (phishing or impersonation:
--                                          no draft, a "Suspicious" chip in Mail)
--                                          or 'injection' (drafts only through the
--                                          no-tools generator); null otherwise.
--   email_thread_index.trust_message_id    the provider message the verdict is
--                                          about, so a newer message is checked again.
--   email_thread_index.trust_inference_id  the Jev decision (ai_usage_logs
--                                          metadata.inference_id) behind the mark.
--
-- A thread index keeps one copy per linked workspace (migration 301). The one
-- writer (markThreadTrust) updates every copy, keyed on the owner, the account
-- and the provider thread, never the workspace.
--
-- RLS is unchanged (the owner reads their own rows). No backfill: no thread is
-- marked until trust is enforced.
--
-- Safe to run twice.

alter table public.email_thread_index
  add column if not exists trust text;

alter table public.email_thread_index
  add column if not exists trust_message_id text;

alter table public.email_thread_index
  add column if not exists trust_inference_id text;

alter table public.email_thread_index drop constraint if exists email_thread_index_trust_check;
alter table public.email_thread_index
  add constraint email_thread_index_trust_check
  check (trust is null or trust in ('suspicious', 'injection'));

comment on column public.email_thread_index.trust is
  'email.trust mark: suspicious (phishing or impersonation) or injection (text aimed at an AI assistant), null when unmarked. Written only by src/lib/crm/email-trust.ts markThreadTrust, to every workspace copy.';
