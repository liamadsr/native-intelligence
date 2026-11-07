-- Mail threads: one copy per LINKED workspace, all of them current.
--
-- email_thread_index keeps a copy of each thread per workspace (unique on
-- workspace + account + provider thread) because a copy carries that
-- workspace's own links (linked_contact_id, labels, work touches). But only the
-- account's home workspace was kept current (the Gmail/Outlook push and the
-- cron write under connected_account.workspace_id), the other copies came from
-- whichever workspace a manual Sync or a drafted reply ran in, and Mail listed
-- by account, so every copy showed: the same thread twice, counts doubled, and
-- copies left behind in workspaces the mailbox was no longer linked to.
--
-- From here the writers fan each thread out to every workspace its account is
-- linked to (connected_account_workspace), Mail lists one workspace's copies,
-- and reconcile_email_thread_copies() brings an account's copies in line with
-- its links: called below for every account, and by the app whenever an
-- account's links change.
--
-- Apply BEFORE deploying the app code (the app calls the function).

create or replace function public.reconcile_email_thread_copies(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- An account linked nowhere (connected before a workspace was active) keeps
  -- its rows where they are; linking it later reconciles it.
  if not exists (select 1 from connected_account_workspace where account_id = p_account_id) then
    return;
  end if;

  -- The freshest copy of each thread, in any workspace, is the mailbox as last read.
  create temporary table _fresh on commit drop as
  select distinct on (t.provider_thread_id) t.*
  from email_thread_index t
  where t.account_id = p_account_id
  order by t.provider_thread_id, t.synced_at desc nulls last, t.last_message_at desc nulls last,
    t.updated_at desc nulls last, t.id;

  -- 1. Stale copies take the mailbox's state from the freshest one. The
  --    workspace's own links (contact, capture, action, project) stay its own.
  update email_thread_index t set
    provider = f.provider,
    provider_message_id = f.provider_message_id,
    subject = f.subject,
    snippet = f.snippet,
    from_email = f.from_email,
    from_name = f.from_name,
    to_emails = f.to_emails,
    cc_emails = f.cc_emails,
    participant_emails = f.participant_emails,
    message_count = f.message_count,
    is_unread = f.is_unread,
    is_starred = f.is_starred,
    has_attachments = f.has_attachments,
    last_message_at = f.last_message_at,
    needs_reply = f.needs_reply,
    auto_classified = f.auto_classified,
    synced_at = f.synced_at,
    history_id = f.history_id,
    folder = f.folder,
    label_ids = f.label_ids,
    is_draft = f.is_draft,
    messages_stored = f.messages_stored,
    message_count_stored = f.message_count_stored,
    total_size_bytes = f.total_size_bytes
  from _fresh f
  where t.account_id = p_account_id
    and t.provider_thread_id = f.provider_thread_id
    and t.id <> f.id
    and (t.provider, t.provider_message_id, t.subject, t.snippet, t.from_email, t.from_name,
         t.to_emails, t.cc_emails, t.participant_emails, t.message_count, t.is_unread,
         t.is_starred, t.has_attachments, t.last_message_at, t.needs_reply, t.auto_classified,
         t.synced_at, t.history_id, t.folder, t.label_ids, t.is_draft, t.messages_stored,
         t.message_count_stored, t.total_size_bytes)
      is distinct from
        (f.provider, f.provider_message_id, f.subject, f.snippet, f.from_email, f.from_name,
         f.to_emails, f.cc_emails, f.participant_emails, f.message_count, f.is_unread,
         f.is_starred, f.has_attachments, f.last_message_at, f.needs_reply, f.auto_classified,
         f.synced_at, f.history_id, f.folder, f.label_ids, f.is_draft, f.messages_stored,
         f.message_count_stored, f.total_size_bytes);

  -- 2. Every linked workspace without a copy gets one, its contact link that
  --    workspace's own contact for the sender (as the sync links it).
  insert into email_thread_index (
    workspace_id, user_id, account_id, provider, provider_thread_id, provider_message_id,
    subject, snippet, from_email, from_name, to_emails, cc_emails, participant_emails,
    message_count, is_unread, is_starred, has_attachments, last_message_at, needs_reply,
    auto_classified, linked_contact_id, synced_at, history_id, folder, label_ids, is_draft,
    messages_stored, message_count_stored, total_size_bytes
  )
  select
    j.workspace_id, f.user_id, f.account_id, f.provider, f.provider_thread_id, f.provider_message_id,
    f.subject, f.snippet, f.from_email, f.from_name, f.to_emails, f.cc_emails, f.participant_emails,
    f.message_count, f.is_unread, f.is_starred, f.has_attachments, f.last_message_at, f.needs_reply,
    f.auto_classified,
    (select c.id from contact c
      where c.workspace_id = j.workspace_id and c.email = lower(f.from_email)
      order by c.id limit 1),
    f.synced_at, f.history_id, f.folder, f.label_ids, f.is_draft,
    f.messages_stored, f.message_count_stored, f.total_size_bytes
  from _fresh f
  join connected_account_workspace j on j.account_id = p_account_id
  where not exists (
    select 1 from email_thread_index t
    where t.workspace_id = j.workspace_id
      and t.account_id = p_account_id
      and t.provider_thread_id = f.provider_thread_id
  )
  on conflict do nothing;

  -- 3. Copies in workspaces the account is no longer linked to go. What points
  --    at one moves first: a draft to its own workspace's copy of the thread
  --    when there is one, else to a linked workspace's; a message lets go (its
  --    foreign key cascades, and the message itself is stored once per mailbox).
  update email_draft d set email_thread_id = coalesce(
    (select k.id from email_thread_index k
      where k.account_id = p_account_id and k.provider_thread_id = t.provider_thread_id
        and k.workspace_id = d.workspace_id
        and exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = k.workspace_id)
      limit 1),
    (select k.id from email_thread_index k
      join connected_account_workspace j on j.account_id = p_account_id and j.workspace_id = k.workspace_id
      where k.account_id = p_account_id and k.provider_thread_id = t.provider_thread_id
      order by k.id limit 1))
  from email_thread_index t
  where d.email_thread_id = t.id
    and t.account_id = p_account_id
    and not exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = t.workspace_id);

  update email_message m set email_thread_id = null
  from email_thread_index t
  where m.email_thread_id = t.id
    and t.account_id = p_account_id
    and not exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = t.workspace_id);

  delete from email_thread_index t
  where t.account_id = p_account_id
    and not exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = t.workspace_id);

  drop table _fresh;
end;
$$;

revoke execute on function public.reconcile_email_thread_copies(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_email_thread_copies(uuid) to service_role;

-- Folder counts are one workspace's copies. With account ids they counted every
-- linked workspace's copy of each thread.
create or replace function public.get_email_folder_counts(
  p_user_id uuid,
  p_workspace_id uuid,
  p_account_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'inbox_unread', count(*) filter (where folder = 'inbox' and is_unread = true),
    'inbox_total', count(*) filter (where folder = 'inbox'),
    'starred', count(*) filter (where is_starred = true),
    'sent', count(*) filter (where folder = 'sent'),
    'drafts', count(*) filter (where folder = 'drafts'),
    'spam', count(*) filter (where folder = 'spam'),
    'trash', count(*) filter (where folder = 'trash'),
    'needs_reply', count(*) filter (where needs_reply = true and folder = 'inbox')
  ) into result
  from public.email_thread_index
  where user_id = p_user_id
    and workspace_id = p_workspace_id
    and (p_account_ids is null or account_id = any(p_account_ids));

  return result;
end;
$$;

revoke execute on function public.get_email_folder_counts(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.get_email_folder_counts(uuid, uuid, uuid[]) to service_role;

-- Bring every account's copies in line with its links now.
do $$
declare
  a record;
begin
  for a in select distinct account_id from public.connected_account_workspace loop
    perform public.reconcile_email_thread_copies(a.account_id);
  end loop;
end
$$;
