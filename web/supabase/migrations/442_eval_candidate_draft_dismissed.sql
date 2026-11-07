-- Migration 442: a dismissed agent draft becomes an evals flywheel candidate
-- (GEN-1165; the needs-reply gate's labels, GEN-1164).
--
-- When the person, or the agent at their word (discard_email_draft,
-- src/lib/email/discard-drafts.ts), discards a draft Dial8 wrote, the reason
-- is recorded as one `eval_candidate` row with source 'draft_dismissed':
--   no_reply_needed  nothing in the thread needed a reply (a receipt, a
--                    notice, marketing, a calendar reply): the needs-reply
--                    gate's false positive;
--   outdated         the moment passed (an event that is over, a thread the
--                    person already handled);
--   duplicate        another draft already answers the thread;
--   bad_draft        a reply is owed, but this draft is wrong (its tone, its
--                    facts, written as the wrong person, meta text);
--   other            anything else (the person's words in `reason`).
-- Evidence is pointers only, like a draft rewrite's (migration 349): the
-- reason, the draft's origin, the thread and account ids, the reply's
-- recipient DOMAIN (never an address), never mail text.
--
-- Only the source check changes. Additive and idempotent: code deployed
-- before this migration records nothing for a dismissal (recordEvalCandidate
-- logs the check failure and never throws), and the discard itself runs.

alter table public.eval_candidate drop constraint if exists eval_candidate_source_check;
alter table public.eval_candidate
  add constraint eval_candidate_source_check check (
    source in ('thumbs_down', 'thumbs_up', 'repeated_failure', 'input_invalid', 'draft_rewrite', 'loop_failed', 'draft_dismissed')
  );

comment on column public.eval_candidate.evidence is
  'Templated, clipped evidence: the request, the reply opening, the tool path (clipped inputs, error codes); for a draft rewrite only a similarity score and pointers, for a dismissed draft only its reason and pointers, never mail text.';
