-- ============================================================
-- 418: Local agents as teammates, the columns (docs/plans/teammate-agent.md,
-- C4 and C5; workstream C). Additive only: safe for the code running before
-- this PR, so apply it BEFORE the deploy. The one-live-session-per-folder
-- index is 419, applied AFTER the deploy.
--
--   local_model   the Mac ran this session's latest launch on a model on the
--                 Mac (Ollama, LM Studio) instead of the Dial8 model relay.
--                 Set at every claim (a resume re-claims), from what the Mac
--                 says. C1's routes read it to narrow the tools (no server-side
--                 web_fetch / web_search; risky writes behind cards).
--   pr_url        the pull request opened for the session's own dial8/...
--                 branch: by the server route
--                 (POST /api/local-agent/sessions/[id]/pull-request, the
--                 person's Dial8 GitHub sign-in) or by gh on the Mac (its
--                 pull_request event). github.com only.
--   start_words   the person's own words from the chat turn that started the
--                 job (at most 3, oldest first); null for a start of their own,
--                 whose request is their words.
--   local_agent_message.person_words
--                 the same, from the chat turn that sent a Dial8-agent message
--                 to the job (a join, a steer); null from a home turn.
--                 Both are the reviewer's evidence for the Mac body's risky
--                 calls (C1), stored at the time, never looked up later by
--                 timestamp.
--
-- The code reads every column as optional, and writes pr_url, start_words,
-- person_words and a relay Mac's local_model in their own error-tolerant
-- updates. This migration is a HARD PREREQUISITE of the claim change, though:
-- a claim that says the Mac runs its own model writes local_model in the claim
-- itself, and is refused until this is applied (it fails closed). Apply it
-- before the code that ships with it.
--
-- Not applied by the builder: Liam applies it (DEV, then PROD).
-- ============================================================

alter table public.local_agent_session
  add column if not exists local_model boolean not null default false;

alter table public.local_agent_session
  add column if not exists pr_url text
    constraint local_agent_session_pr_url_ck
    check (pr_url is null or (char_length(pr_url) between 20 and 2048 and pr_url like 'https://github.com/%'));

alter table public.local_agent_session
  add column if not exists start_words text[]
    constraint local_agent_session_start_words_ck check (start_words is null or cardinality(start_words) <= 3);

alter table public.local_agent_message
  add column if not exists person_words text[]
    constraint local_agent_message_person_words_ck check (person_words is null or cardinality(person_words) <= 3);

comment on column public.local_agent_session.local_model is
  'Local agents (418): the Mac ran this session''s latest launch on a model on the Mac, not the Dial8 relay. Set at each claim from the Mac''s report; C1 narrows the tools by it.';
comment on column public.local_agent_session.pr_url is
  'Local agents (418): the github.com pull request for the session''s own dial8/ branch, opened by the server route or by gh on the Mac.';
comment on column public.local_agent_session.start_words is
  'Local agents (418): the person''s own words from the chat turn that started the job (at most 3, oldest first): the reviewer''s evidence for the Mac body''s calls.';
comment on column public.local_agent_message.person_words is
  'Local agents (418): the person''s own words from the chat turn that sent this Dial8-agent message (a join, a steer): the reviewer''s evidence.';
