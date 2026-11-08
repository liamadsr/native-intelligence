-- ============================================================
-- 471: imports from the apps that hold a business's customers (roadmap #10)
-- ============================================================
-- An export file from a common tool (QuickBooks, Stripe, HubSpot, Pipedrive,
-- Mailchimp, Jobber, Housecall Pro, Square) is recognised by its columns and
-- imports with no questions (src/lib/crm/import/sources/export-layouts.ts),
-- and a connected Stripe account's customers import directly. Each import's
-- batch names the app it came from, so its contacts are tagged "from Stripe"
-- and the summary says so. One change: the batch source check takes the apps.
-- Re-runnable.

SET LOCAL lock_timeout = '5s';

alter table public.contact_import_batch drop constraint if exists contact_import_batch_source_check;
alter table public.contact_import_batch
  add constraint contact_import_batch_source_check check (source in ('spreadsheet', 'vcard', 'google_contacts', 'hubspot', 'brevo', 'quickbooks', 'stripe', 'pipedrive', 'mailchimp', 'jobber', 'housecall_pro', 'square'));
