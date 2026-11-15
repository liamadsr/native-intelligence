-- ============================================================
-- 661: Forms (phase 3): the hosted page, the bot check and personal links.
-- ============================================================
-- A form (660) now also has its own page, /f/<key>, which the app draws from
-- the form's fields (src/app/f/), and a small script a business puts on its
-- own site to draw the same form there (public/f/embed.js).
--
--   1. data_form              three things the page shows or needs:
--                             description   a few lines under the form's name
--                                           (at most 1000 characters);
--                             submit_label  the button's words (at most 40);
--                             bot_check     a submission must carry a solved
--                                           challenge: a signed, timed proof
--                                           of work the page and the script
--                                           solve in the browser
--                                           (src/lib/forms/challenge.ts).
--                                           Off for every existing form, so
--                                           a website's own HTML form posting
--                                           to one today keeps working.
--                             access takes 'invited' too: nobody submits with
--                             the form's own link; each person gets a personal
--                             link that stores one submission.
--   2. data_form_attempt.challenge_id
--                             the random part of the challenge a try carried,
--                             set in the same update that names its row. One
--                             challenge stores one submission: the unique
--                             index decides, so two posts side by side with
--                             one challenge store one. A failed write clears
--                             it (the person can send again). The ledger is
--                             kept two days, the challenge lives two hours.
--   3. data_form_invite       one personal link: its form, its secret as its
--                             SHA-256 only (the secret is `fi_` and 32 random
--                             bytes, shown once), who it is for in the owner's
--                             own words, the contact it is for when the owner
--                             named one (the row links that contact, never one
--                             found from what was typed), when it lapses,
--                             when it was used and the row it stored. A
--                             submission claims it with one UPDATE ... WHERE
--                             used_at IS NULL, so two posts side by side store
--                             one; a write that fails gives it back. Pruned
--                             30 days after it was used or lapsed.
--
-- RLS on, and only the service role reads or writes the new table, as 660's
-- (every reader is on the server; a client must never see token_hash).
-- Re-runnable.
--
-- Must run on PROD before the app code that reads it deploys: every read of
-- a form selects the three new columns.
--
-- Apply in a quiet moment. The new columns and checks take a brief exclusive
-- lock on data_form and data_form_attempt (both small, written only by a
-- form's submission and its owner); the checks are added without a scan and
-- validated on their own. The new table's foreign keys take a brief SHARE
-- ROW EXCLUSIVE lock on data_form and contact (reads pass, writes wait).
-- Each statement waits at most 5 s for its lock; one that waits longer rolls
-- the whole file back, and it can simply be applied again.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. data_form: description, submit_label, bot_check, 'invited'
-- ------------------------------------------------------------

alter table public.data_form add column if not exists description text null;
alter table public.data_form add column if not exists submit_label text null;
alter table public.data_form add column if not exists bot_check boolean not null default false;

comment on column public.data_form.description is
  'A few lines the form''s page shows under its name (661). Null: none.';
comment on column public.data_form.submit_label is
  'The words on the form''s button (661). Null: the page''s default.';
comment on column public.data_form.bot_check is
  'A submission must carry a solved challenge (661, src/lib/forms/challenge.ts). The hosted page and the embed solve it; a website''s own HTML form can''t.';
comment on column public.data_form.access is
  'public: anyone holding the link. members: only a signed-in member of the workspace. invited: only someone holding a personal link (data_form_invite), one submission each.';

alter table public.data_form drop constraint if exists data_form_description_length;
alter table public.data_form
  add constraint data_form_description_length check (description is null or char_length(description) <= 1000) not valid;
alter table public.data_form validate constraint data_form_description_length;

alter table public.data_form drop constraint if exists data_form_submit_label_length;
alter table public.data_form
  add constraint data_form_submit_label_length check (submit_label is null or char_length(submit_label) between 1 and 40) not valid;
alter table public.data_form validate constraint data_form_submit_label_length;

-- Widens 660's check, keeping both earlier values.
alter table public.data_form drop constraint if exists data_form_access_check;
alter table public.data_form
  add constraint data_form_access_check check (access in ('public', 'members', 'invited')) not valid;
alter table public.data_form validate constraint data_form_access_check;

-- ------------------------------------------------------------
-- 2. data_form_attempt.challenge_id
-- ------------------------------------------------------------

alter table public.data_form_attempt add column if not exists challenge_id text null;

comment on column public.data_form_attempt.challenge_id is
  'The random part of the solved challenge this try carried (661): one challenge stores one submission.';

alter table public.data_form_attempt drop constraint if exists data_form_attempt_challenge_id_length;
alter table public.data_form_attempt
  add constraint data_form_attempt_challenge_id_length check (challenge_id is null or char_length(challenge_id) between 1 and 64) not valid;
alter table public.data_form_attempt validate constraint data_form_attempt_challenge_id_length;

create unique index if not exists data_form_attempt_challenge_key
  on public.data_form_attempt (form_id, challenge_id) where challenge_id is not null;

-- ------------------------------------------------------------
-- 3. data_form_invite
-- ------------------------------------------------------------

create table if not exists public.data_form_invite (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.data_form(id) on delete cascade,
  token_hash text not null,
  label text null,
  contact_id uuid null references public.contact(id) on delete set null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz null,
  row_id uuid null
);

comment on table public.data_form_invite is
  'A personal link to an invited form (661): it stores one submission, then it is used. Service role only.';
comment on column public.data_form_invite.token_hash is
  'SHA-256 of the secret in the link. The secret itself is shown once and never stored.';
comment on column public.data_form_invite.label is
  'Who it is for, in the owner''s own words. Never shown to the person who opens the link.';
comment on column public.data_form_invite.contact_id is
  'The contact it is for: the row links this contact, and none is found or made from what was typed.';
comment on column public.data_form_invite.used_at is
  'When a submission claimed it. Cleared again when that submission could not be stored.';
comment on column public.data_form_invite.row_id is
  'The row its submission stored.';

alter table public.data_form_invite drop constraint if exists data_form_invite_label_length;
alter table public.data_form_invite
  add constraint data_form_invite_label_length check (label is null or char_length(label) between 1 and 120);

create unique index if not exists data_form_invite_token_hash_key on public.data_form_invite (token_hash);
create index if not exists data_form_invite_form_idx on public.data_form_invite (form_id, created_at);
-- The prune reads by when a link lapsed, and by when it was used.
create index if not exists data_form_invite_expires_idx on public.data_form_invite (expires_at);
create index if not exists data_form_invite_used_idx on public.data_form_invite (used_at) where used_at is not null;

alter table public.data_form_invite enable row level security;
revoke all on table public.data_form_invite from anon, authenticated;
grant all on table public.data_form_invite to service_role;

notify pgrst, 'reload schema';
