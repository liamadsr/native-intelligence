-- ============================================================
-- 646: Share an email thread into team chat, read live, store no mail.
-- ============================================================
-- Decided by the founder (2026-11-14): a shared thread is READ LIVE from the
-- owner's mailbox, with the owner's token, each time someone opens it, and
-- Native Intelligence stores NOTHING of the mail (as since 2026-10-15,
-- migration 344). What is stored is who shared which thread where:
--
--   email_share          one share: the owner (owner_user_id) shared the
--                        thread (provider_thread_id, in the mailbox
--                        account_id, its index row thread_index_id when it has
--                        one) into a channel or DM (channel_id), as the
--                        message team_chat_message_id. message_ids are the
--                        thread's messages at that moment, frozen: a later
--                        reply stays private unless the owner shares again.
--                        NO subject, body, snippet, names or addresses: only
--                        provider ids, which email_thread_index already holds
--                        the like of. revoked_at: un-shared (access ends at
--                        once; the chat message stays, its card says "No
--                        longer shared").
--                        No client grants and no policies: the server reads
--                        and writes it with the service role, behind routes
--                        that check the owner (sharing, un-sharing) and the
--                        reader (team_chat_can_read on the channel) first
--                        (src/app/api/account/email/shares/*).
--   team_chat_message.email_share_id
--                        the share a message carries: the chat view draws it
--                        as an email card and loads the mail live. Written by
--                        the service role only: a client never inserts one
--                        with it set, nor changes it (the guard below).
--   team_chat_message_email_share_revoke
--                        deleting the message un-shares the thread (its
--                        author deleting it from the channel ends the access
--                        it gave), whoever deletes it: every share the
--                        message carries.
--   email_share_link     a link the owner copied (/mail/s/<token>) to paste
--                        into a chat by hand. It GRANTS NOTHING on its own: a
--                        message its OWNER posts with it becomes a share in
--                        that channel or DM (email_share.link_id), with the
--                        link's message ids, frozen when it was copied. The
--                        token is 256 bits from the CSPRNG, base64url (the
--                        CHECK takes 22 to 128 url-safe characters). Ids only,
--                        as email_share; revoking it revokes every share made
--                        from it (the app does both). Service role only.
--   email_share.link_id  the link a share was made from (null: the picker).
--                        A message may carry several (one per pasted link),
--                        so one share per message is no longer the rule: one
--                        per message and link is.
--
-- Re-runnable on a database that applied the first version of this file
-- (hosted DEV): the link table, link_id and the new index are added, the old
-- one-share-per-message index is dropped, the revoke function is replaced.
--
-- Workspace merge (402): email_share has a workspace_id, so the generic
-- re-stamp (645's _wsmerge_generic_restamp) carries it to the destination
-- with its channel; nothing here needs a merge step of its own.
--
-- Additive. Re-runnable. Safe on a live database: the new column is nullable
-- (no table rewrite); team_chat_message's ACCESS EXCLUSIVE lock is taken
-- under lock_timeout (5 s), so behind a long reader the file fails and rolls
-- back rather than queueing every write. No backslashes anywhere in this file
-- (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ── The link (grants nothing on its own) ─────────────────────────────────────

create table if not exists public.email_share_link (
  id uuid primary key default gen_random_uuid(),
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{22,128}$'),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.connected_account(id) on delete set null,
  provider text not null check (provider in ('google', 'microsoft')),
  provider_thread_id text not null check (char_length(provider_thread_id) between 1 and 512),
  thread_index_id uuid references public.email_thread_index(id) on delete set null,
  message_ids text[] not null check (cardinality(message_ids) between 1 and 100 and array_position(message_ids, null) is null),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- The owner's live links for a thread (reuse, and the chips).
create index if not exists email_share_link_owner_thread_idx
  on public.email_share_link (owner_user_id, workspace_id, provider_thread_id)
  where revoked_at is null;

comment on table public.email_share_link is
  'A copied link to an email thread (646). Grants nothing on its own: pasted by its owner into a team chat message, it becomes an email_share there. Ids and a random token only, never mail. Service role only.';

alter table public.email_share_link enable row level security;
revoke all on table public.email_share_link from public, anon, authenticated;
grant select, insert, update, delete on table public.email_share_link to service_role;

-- ── The share ───────────────────────────────────────────────────────────────

create table if not exists public.email_share (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.connected_account(id) on delete set null,
  provider text not null check (provider in ('google', 'microsoft')),
  provider_thread_id text not null check (char_length(provider_thread_id) between 1 and 512),
  thread_index_id uuid references public.email_thread_index(id) on delete set null,
  message_ids text[] not null check (cardinality(message_ids) between 1 and 100 and array_position(message_ids, null) is null),
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  team_chat_message_id uuid references public.team_chat_message(id) on delete set null,
  shared_by_member_id uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- The owner's live shares of one thread (the thread view's chips).
create index if not exists email_share_owner_thread_idx
  on public.email_share (owner_user_id, workspace_id, provider_thread_id)
  where revoked_at is null;
create index if not exists email_share_channel_idx on public.email_share (channel_id);
-- A message's shares; one per message and pasted link (a picker share has its own message).
drop index if exists public.email_share_message_key;
create index if not exists email_share_message_idx
  on public.email_share (team_chat_message_id)
  where team_chat_message_id is not null;

alter table public.email_share
  add column if not exists link_id uuid references public.email_share_link(id) on delete set null;

create unique index if not exists email_share_message_link_key
  on public.email_share (team_chat_message_id, link_id)
  where team_chat_message_id is not null and link_id is not null;
create index if not exists email_share_link_idx on public.email_share (link_id) where link_id is not null;

comment on table public.email_share is
  'An email thread shared into a team chat channel or DM (646). Holds ids only, never mail: the mail is read live from the owner''s mailbox on each open. message_ids are frozen at share time. Service role only.';

alter table public.email_share enable row level security;
revoke all on table public.email_share from public, anon, authenticated;
grant select, insert, update, delete on table public.email_share to service_role;

-- ── The message that carries it ─────────────────────────────────────────────

alter table public.team_chat_message
  add column if not exists email_share_id uuid references public.email_share(id) on delete set null;

create unique index if not exists team_chat_message_email_share_key
  on public.team_chat_message (email_share_id)
  where email_share_id is not null;

comment on column public.team_chat_message.email_share_id is
  'The email share this message carries (646): drawn as an email card, the mail read live. Written by the service role only.';

-- A client never sets or changes a message's share (the service role does).
create or replace function public.team_chat_message_email_share_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' and new.email_share_id is not null then
    raise exception 'team chat: an email share is posted by the server' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.email_share_id is distinct from old.email_share_id then
    raise exception 'team chat: a message''s email share never changes' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists team_chat_message_email_share_guard on public.team_chat_message;
create trigger team_chat_message_email_share_guard
  before insert or update on public.team_chat_message
  for each row execute function public.team_chat_message_email_share_guard();

-- Deleting the message un-shares every thread it carries.
create or replace function public.team_chat_message_email_share_revoke()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.email_share
       set revoked_at = now()
     where (id = new.email_share_id or team_chat_message_id = new.id)
       and revoked_at is null;
  end if;
  return new;
end;
$$;

-- Trigger functions only: nobody calls them directly (a trigger fires
-- without its invoker holding EXECUTE).
revoke all on function public.team_chat_message_email_share_guard() from public, anon, authenticated;
revoke all on function public.team_chat_message_email_share_revoke() from public, anon, authenticated;

drop trigger if exists team_chat_message_email_share_revoke on public.team_chat_message;
create trigger team_chat_message_email_share_revoke
  after update of deleted_at on public.team_chat_message
  for each row execute function public.team_chat_message_email_share_revoke();

commit;
