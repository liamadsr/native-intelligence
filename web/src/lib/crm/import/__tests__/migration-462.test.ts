/**
 * Migration 462: bringing existing customers in (roadmap track G). Pins the
 * file: the batch, item and source-link tables with no client writes, the
 * checks matching the app's lists, and every widened check carrying the
 * values the migrations before it added (458, 459, 460), so the latest
 * definition in the directory is the union.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { IMPORT_SOURCES } from '../record'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/462_customer_import.sql'), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const BODY = flat(SQL)

/** The values of the LATEST `add constraint <name> check (<col> in (...))` across all migrations. */
function latestCheck(name: string): string[] {
  let found: string[] = []
  for (const m of migrationsInOrder()) {
    const body = flat(m.sql)
    const re = new RegExp(`add constraint ${name}\\s+check \\(\\s*\\(?\\s*[a-z_]+ (?:= any \\(array\\[|in \\()([^)]*)\\)`, 'gi')
    for (const match of body.matchAll(re)) found = [...match[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1])
  }
  return found
}

describe('migration 462', () => {
  it('has no backslash, waits at most 5 s for its locks, and is re-runnable', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    for (const t of ['contact_import_batch', 'contact_import_item', 'crm_source_link']) expect(BODY).toContain(`create table if not exists public.${t} (`)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${name};`)
    expect(BODY).toContain('alter table public.contact add column if not exists address text null;')
  })

  it('the importer reads its own batches and items; nobody but the service role writes; links are server only', () => {
    for (const t of ['contact_import_batch', 'contact_import_item', 'crm_source_link']) {
      expect(BODY).toContain(`alter table public.${t} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${t} from anon, authenticated;`)
      expect(BODY).toContain(`grant all on table public.${t} to service_role;`)
    }
    expect(BODY).toContain('create policy contact_import_batch_own_read on public.contact_import_batch for select using (user_id = auth.uid() and public.is_workspace_member(workspace_id));')
    // Items journal before/after values (another member's contact data): only the importer reads them.
    expect(BODY).toContain('create policy contact_import_item_own_read on public.contact_import_item for select using (exists ( select 1 from public.contact_import_batch b where b.id = contact_import_item.batch_id and b.user_id = auth.uid() ));')
    expect(BODY).not.toMatch(/create policy contact_import_item_member_read/)
    expect(BODY).toContain('grant select on table public.contact_import_batch to authenticated;')
    expect(BODY).not.toMatch(/create policy [a-z_]+ on public\.crm_source_link/)
    expect(BODY).not.toMatch(/grant (insert|update|delete|all)[a-z, ]* on table public\.contact_import_(batch|item) to authenticated/)
  })

  it("the batch source check is exactly the app's sources", () => {
    expect(latestCheck('contact_import_batch_source_check').sort()).toEqual([...IMPORT_SOURCES].sort())
  })

  it('every widened check keeps what 458, 459 and 460 added', () => {
    expect(latestCheck('contact_source_check')).toEqual(expect.arrayContaining(['web_form', 'sms', 'hubspot_sync', 'prospecting', 'import']))
    expect(latestCheck('contact_interaction_interaction_type_check')).toEqual(expect.arrayContaining(['payment_requested', 'payment_received', 'review_request', 'past_job']))
    expect(latestCheck('contact_interaction_reference_type_check')).toEqual(expect.arrayContaining(['payment_request', 'import_batch']))
    expect(latestCheck('connected_account_provider_check')).toEqual(expect.arrayContaining(['hubspot', 'linear', 'brevo']))
    expect(latestCheck('connected_account_capability_check')).toEqual(expect.arrayContaining(['crm', 'tasks', 'contacts']))
    // A connection's token row takes the same provider and capability.
    expect(latestCheck('user_oauth_tokens_provider_check')).toEqual(expect.arrayContaining(['hubspot', 'linear', 'brevo']))
    expect(latestCheck('user_oauth_tokens_capability_check')).toEqual(expect.arrayContaining(['both', 'crm', 'tasks', 'contacts']))
  })
})
