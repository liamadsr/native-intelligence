-- ====================================================================
-- 131: upsert_email_messages RPC
-- ====================================================================
--
-- Why this exists
-- ---------------
-- email_message's uniqueness is enforced by an *expression* index:
--   email_message_account_message_key
--     ON (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
--         provider_message_id)
--
-- PostgREST's `.upsert({ onConflict })` only accepts a bare column list and
-- cannot target a COALESCE() expression index (verified: ON CONFLICT
-- (account_id, provider_message_id) -> 42P10 "no unique or exclusion
-- constraint matching the ON CONFLICT specification"; only the full COALESCE
-- expression is accepted by Postgres). The previous code used
-- onConflict: 'user_id,provider_message_id' — a target that does not exist —
-- so EVERY message upsert errored and was swallowed, and no mail was stored
-- after the multi-account index migration landed.
--
-- This function does a single set-based INSERT ... ON CONFLICT against the
-- real expression index and returns the rows that were actually inserted, so
-- the application can map attachments to new messages and report a truthful
-- count. SECURITY DEFINER because writes come from the service role via
-- background sync (Inngest); callers already scope by user/account.
--
-- Idempotent: drops+recreates the function. Non-destructive to data.
--
-- NOTE: OUT columns are named out_* on purpose. Naming them
-- provider_message_id / user_id makes those identifiers ambiguous inside the
-- INSERT ... ON CONFLICT ... RETURNING body (PL/pgSQL can't tell the OUT
-- variable from the table column), raising 42702. Drop-then-create (not
-- REPLACE) because changing the return type isn't allowed by REPLACE.

drop function if exists public.upsert_email_messages(jsonb);

create function public.upsert_email_messages(messages jsonb)
returns table (out_id uuid, out_provider_message_id text, out_user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into public.email_message (
    workspace_id, user_id, account_id, provider,
    provider_message_id, provider_thread_id, subject,
    from_name, from_email, to_recipients, cc_recipients, bcc_recipients,
    reply_to, in_reply_to, references_header,
    body_html, body_text, snippet, message_date,
    is_unread, is_starred, is_draft, has_attachments,
    gmail_label_ids, gmail_internal_date,
    outlook_folder_id, outlook_categories, raw_size_bytes
  )
  select
    (m->>'workspace_id')::uuid,
    (m->>'user_id')::uuid,
    nullif(m->>'account_id', '')::uuid,
    m->>'provider',
    m->>'provider_message_id',
    m->>'provider_thread_id',
    m->>'subject',
    m->>'from_name',
    m->>'from_email',
    coalesce(m->'to_recipients', '[]'::jsonb),
    coalesce(m->'cc_recipients', '[]'::jsonb),
    coalesce(m->'bcc_recipients', '[]'::jsonb),
    m->>'reply_to',
    m->>'in_reply_to',
    m->>'references_header',
    m->>'body_html',
    m->>'body_text',
    m->>'snippet',
    (m->>'message_date')::timestamptz,
    coalesce((m->>'is_unread')::boolean, false),
    coalesce((m->>'is_starred')::boolean, false),
    coalesce((m->>'is_draft')::boolean, false),
    coalesce((m->>'has_attachments')::boolean, false),
    case when m ? 'gmail_label_ids'
      then array(select jsonb_array_elements_text(m->'gmail_label_ids'))
      else null end,
    nullif(m->>'gmail_internal_date', '')::bigint,
    m->>'outlook_folder_id',
    case when m ? 'outlook_categories'
      then array(select jsonb_array_elements_text(m->'outlook_categories'))
      else null end,
    nullif(m->>'raw_size_bytes', '')::bigint
  from jsonb_array_elements(messages) as m
  on conflict (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_message_id)
    do nothing
  returning
    email_message.id,
    email_message.provider_message_id,
    email_message.user_id;
end;
$$;

comment on function public.upsert_email_messages(jsonb) is
  'Bulk-insert email messages, skipping duplicates via the COALESCE(account_id)/provider_message_id expression index that PostgREST onConflict cannot target. Returns rows actually inserted (out_id, out_provider_message_id, out_user_id).';

grant execute on function public.upsert_email_messages(jsonb) to service_role;
