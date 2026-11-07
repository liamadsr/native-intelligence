-- ============================================================
-- 462: bringing existing customers in (roadmap track G, docs/plans/customer-import.md)
-- ============================================================
-- At signup the owner connects whatever already holds their customers
-- (a spreadsheet or phone contacts by text, Google Contacts, HubSpot, Brevo)
-- and every source feeds ONE importer (src/lib/crm/import/). Read-only: an
-- import never sends anything through these tools, never enriches, never
-- starts outreach. In order:
--
--   1. contact.address           a customer's address, one line (a pickup
--                                business needs it more than a job title).
--   2. contact_import_batch      one import: its source, progress, counts and
--                                the summary the agent texted. Undone as a
--                                whole.
--   3. contact_import_item       one incoming record and what it did: the
--                                contact it created or matched, the fields it
--                                changed (before and after), the history rows
--                                it added. The undo journal.
--   4. crm_source_link           a source's own id for a contact or company
--                                (a Google resource name, a Brevo id), so a
--                                second import finds the same row.
--   5. checks widened            contact.source 'import'; contact_interaction
--                                'past_job'; connected_account and
--                                user_oauth_tokens provider 'brevo' and
--                                capability 'contacts'.
--
-- The widened checks carry every value the migrations before this one add
-- (458's contact sources; 459's and 460's interaction types, which each
-- replaced the same check with their own list), so whichever order those
-- landed in, 462 leaves the union.
--
-- New tables: RLS on; the member who ran an import reads its batch and items
-- (nobody else: items journal before/after values); only the service role
-- writes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. contact.address
-- ------------------------------------------------------------

alter table public.contact add column if not exists address text null;
alter table public.contact drop constraint if exists contact_address_length;
alter table public.contact
  add constraint contact_address_length check (address is null or char_length(address) <= 300);

comment on column public.contact.address is
  'The contact''s address on one line (462), as an import or the owner gave it.';

-- ------------------------------------------------------------
-- 2. contact_import_batch
-- ------------------------------------------------------------

create table if not exists public.contact_import_batch (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  label text null,
  account_id uuid null references public.connected_account(id) on delete set null,
  status text not null default 'staging',
  total integer not null default 0,
  counts jsonb not null default '{}'::jsonb,
  summary text null,
  error text null,
  notify boolean not null default true,
  created_at timestamptz not null default now(),
  finished_at timestamptz null,
  notified_at timestamptz null,
  undone_at timestamptz null
);

alter table public.contact_import_batch drop constraint if exists contact_import_batch_source_check;
alter table public.contact_import_batch
  add constraint contact_import_batch_source_check check (source in ('spreadsheet', 'vcard', 'google_contacts', 'hubspot', 'brevo'));
alter table public.contact_import_batch drop constraint if exists contact_import_batch_status_check;
alter table public.contact_import_batch
  add constraint contact_import_batch_status_check check (status in ('staging', 'running', 'done', 'failed', 'undoing', 'undone'));
alter table public.contact_import_batch drop constraint if exists contact_import_batch_text_lengths;
alter table public.contact_import_batch
  add constraint contact_import_batch_text_lengths check (
    (label is null or char_length(label) <= 200)
    and (summary is null or char_length(summary) <= 1000)
    and (error is null or char_length(error) <= 1000)
  );

create index if not exists contact_import_batch_workspace_idx
  on public.contact_import_batch (workspace_id, created_at desc);
create index if not exists contact_import_batch_account_idx
  on public.contact_import_batch (account_id) where account_id is not null;

comment on table public.contact_import_batch is
  'One import of existing customers into the CRM (462): source, progress, counts, the texted summary. Undone as a whole.';

-- ------------------------------------------------------------
-- 3. contact_import_item
-- ------------------------------------------------------------

create table if not exists public.contact_import_item (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.contact_import_batch(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  seq integer not null,
  kind text not null default 'contact',
  record jsonb not null,
  outcome text not null default 'pending',
  contact_id uuid null references public.contact(id) on delete set null,
  company_id uuid null references public.company(id) on delete set null,
  candidate_contact_id uuid null references public.contact(id) on delete set null,
  match_type text null,
  changes jsonb not null default '{}'::jsonb,
  created_company_id uuid null references public.company(id) on delete set null,
  history_ids uuid[] not null default '{}',
  links jsonb not null default '[]'::jsonb,
  error text null,
  created_at timestamptz not null default now(),
  applied_at timestamptz null,
  undone_at timestamptz null,
  undo_outcome text null
);

alter table public.contact_import_item drop constraint if exists contact_import_item_kind_check;
alter table public.contact_import_item
  add constraint contact_import_item_kind_check check (kind in ('contact', 'company'));
alter table public.contact_import_item drop constraint if exists contact_import_item_outcome_check;
alter table public.contact_import_item
  add constraint contact_import_item_outcome_check check (outcome in ('pending', 'created', 'matched', 'repeat', 'review', 'unchanged', 'skipped', 'failed'));
alter table public.contact_import_item drop constraint if exists contact_import_item_undo_outcome_check;
alter table public.contact_import_item
  add constraint contact_import_item_undo_outcome_check check (undo_outcome is null or undo_outcome in ('removed', 'restored', 'kept', 'none'));
alter table public.contact_import_item drop constraint if exists contact_import_item_error_length;
alter table public.contact_import_item
  add constraint contact_import_item_error_length check (error is null or char_length(error) <= 500);

create unique index if not exists contact_import_item_batch_seq_key
  on public.contact_import_item (batch_id, seq);
create index if not exists contact_import_item_pending_idx
  on public.contact_import_item (batch_id, seq) where outcome = 'pending';
create index if not exists contact_import_item_contact_idx
  on public.contact_import_item (contact_id) where contact_id is not null;

comment on table public.contact_import_item is
  'One incoming record of an import (462) and what it did: created or matched contact, changed fields (before/after), added history. The undo journal.';

-- ------------------------------------------------------------
-- 4. crm_source_link
-- ------------------------------------------------------------

create table if not exists public.crm_source_link (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  source text not null,
  kind text not null,
  external_id text not null,
  entity_id uuid not null,
  batch_id uuid null references public.contact_import_batch(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, source, kind, external_id)
);

alter table public.crm_source_link drop constraint if exists crm_source_link_kind_check;
alter table public.crm_source_link
  add constraint crm_source_link_kind_check check (kind in ('contact', 'company'));
alter table public.crm_source_link drop constraint if exists crm_source_link_external_id_length;
alter table public.crm_source_link
  add constraint crm_source_link_external_id_length check (char_length(external_id) between 1 and 300);

create index if not exists crm_source_link_entity_idx
  on public.crm_source_link (entity_id);

comment on table public.crm_source_link is
  'A source''s own id for a CRM contact or company (462: a Google resource name, a Brevo id), so a second import finds the same row.';

-- ------------------------------------------------------------
-- 5. Checks widened
-- ------------------------------------------------------------

alter table public.contact drop constraint if exists contact_source_check;
alter table public.contact
  add constraint contact_source_check check (source in ('manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'member', 'hubspot_sync', 'prospecting', 'web_form', 'sms', 'import'));

alter table public.contact_interaction drop constraint if exists contact_interaction_interaction_type_check;
alter table public.contact_interaction
  add constraint contact_interaction_interaction_type_check check (interaction_type in ('capture', 'email_sent', 'email_received', 'action_assigned', 'action_completed', 'note_added', 'payment_requested', 'payment_received', 'review_request', 'past_job'));

alter table public.contact_interaction drop constraint if exists contact_interaction_reference_type_check;
alter table public.contact_interaction
  add constraint contact_interaction_reference_type_check check (reference_type in ('capture', 'email_thread', 'action', 'document', 'payment_request', 'import_batch'));

alter table public.connected_account drop constraint if exists connected_account_provider_check;
alter table public.connected_account
  add constraint connected_account_provider_check check (provider in ('google', 'microsoft', 'github', 'hubspot', 'asana', 'jira', 'linear', 'brevo'));

alter table public.connected_account drop constraint if exists connected_account_capability_check;
alter table public.connected_account
  add constraint connected_account_capability_check check (capability in ('calendar', 'email', 'github', 'crm', 'tasks', 'contacts'));

-- The token row of a Brevo or Google Contacts connection (src/lib/oauth/complete-connect.ts).
alter table public.user_oauth_tokens drop constraint if exists user_oauth_tokens_provider_check;
alter table public.user_oauth_tokens
  add constraint user_oauth_tokens_provider_check check (provider in ('google', 'microsoft', 'github', 'hubspot', 'asana', 'jira', 'linear', 'brevo'));

alter table public.user_oauth_tokens drop constraint if exists user_oauth_tokens_capability_check;
alter table public.user_oauth_tokens
  add constraint user_oauth_tokens_capability_check check (capability in ('calendar', 'email', 'both', 'github', 'crm', 'tasks', 'contacts'));

-- ------------------------------------------------------------
-- 6. RLS and grants
-- ------------------------------------------------------------

alter table public.contact_import_batch enable row level security;
alter table public.contact_import_item enable row level security;
alter table public.crm_source_link enable row level security;

-- Only the member who ran an import reads it: its items journal the fields
-- it changed (before and after), which can be another member's contact data.
drop policy if exists contact_import_batch_member_read on public.contact_import_batch;
drop policy if exists contact_import_batch_own_read on public.contact_import_batch;
create policy contact_import_batch_own_read on public.contact_import_batch
  for select using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
drop policy if exists contact_import_item_member_read on public.contact_import_item;
drop policy if exists contact_import_item_own_read on public.contact_import_item;
create policy contact_import_item_own_read on public.contact_import_item
  for select using (exists (
    select 1 from public.contact_import_batch b
     where b.id = contact_import_item.batch_id and b.user_id = auth.uid()
  ));

revoke all on table public.contact_import_batch from anon, authenticated;
revoke all on table public.contact_import_item from anon, authenticated;
revoke all on table public.crm_source_link from anon, authenticated;
grant select on table public.contact_import_batch to authenticated;
grant select on table public.contact_import_item to authenticated;
grant all on table public.contact_import_batch to service_role;
grant all on table public.contact_import_item to service_role;
grant all on table public.crm_source_link to service_role;
