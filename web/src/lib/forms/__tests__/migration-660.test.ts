/**
 * Migration 660: forms. Pins the file to the app: the sources the app writes,
 * the access values, apply_data_ops unchanged from 540 but for the 'form'
 * source, the row mark set by the insert itself, service-role-only tables,
 * idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_CHANGE_SOURCES } from '@/lib/tables/types'
import { FORM_ACCESS, FORM_LIMITS } from '../types'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const SQL = read('660_data_forms.sql')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .map((l) => l.replace(/\s+--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
const BODY = flat(SQL)
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

/** apply_data_ops from its `create or replace` to its closing dollar quote. */
function applyDataOps(sql: string): string {
  const start = sql.lastIndexOf('create or replace function public.apply_data_ops(')
  const open = sql.indexOf('$$', start)
  return flat(sql.slice(start, sql.indexOf('$$', open + 2) + 2))
}

describe('migration 660', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("checks every source the app writes, 'form' among them", () => {
    expect(DATA_CHANGE_SOURCES).toContain('form')
    // Added without a scan, then validated: a plain add would hold every table write while it reads data_change.
    expect(BODY).toContain(`add constraint data_change_source_check check (source in (${list(DATA_CHANGE_SOURCES)})) not valid;`)
    expect(BODY).toContain('alter table public.data_change validate constraint data_change_source_check;')
    expect(BODY).toContain(`if coalesce(p_source, '') not in (${list(DATA_CHANGE_SOURCES)}) then`)
  })

  it("restates 540's apply_data_ops with the source list as its only change", () => {
    const before = applyDataOps(read('540_pipeline_tables.sql'))
    const after = applyDataOps(SQL)
    expect(after.replace(", 'sms', 'form')", ", 'sms')")).toBe(before)
    expect(BODY).toContain('revoke all on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean, text) from public, anon;')
  })

  it("marks a form's row in its own insert, and lets no update change the mark", () => {
    expect(BODY).toContain('alter table public.data_row add column if not exists from_form boolean not null default false;')
    expect(BODY).toContain("new.from_form := coalesce(current_setting('dial8.data_source', true), '') = 'form';")
    expect(BODY).toContain('new.from_form := old.from_form;')
    expect(BODY).toContain('create or replace trigger data_row_mark_from_form before insert or update on public.data_row for each row execute function public.data_row_mark_from_form();')
    // Never dropped first: a drop would hold every read of data_row.
    expect(BODY).not.toContain('drop trigger')
  })

  it("lets a loop start on a table's new rows: the trigger check keeps every earlier type and adds record_created", () => {
    expect(BODY).toContain(
      "add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received', 'email_received', 'chat_message', 'document_created', 'record_created')) not valid;",
    )
    expect(BODY).toContain('alter table public.flow validate constraint flow_trigger_type_check;')
  })

  it('checks the access values and the limits the app keeps', () => {
    expect(BODY).toContain(`check (access in (${list(FORM_ACCESS)}));`)
    expect(BODY).toContain(`check (char_length(name) between 1 and ${FORM_LIMITS.name});`)
    expect(BODY).toContain(`jsonb_array_length(fields) <= ${FORM_LIMITS.fields}`)
    expect(BODY).toContain(`char_length(thanks) <= ${FORM_LIMITS.thanks}`)
    expect(BODY).toContain(`array_length(allowed_origins, 1), 0) <= ${FORM_LIMITS.origins}`)
    expect(BODY).toContain(`char_length(external_id) between 1 and ${FORM_LIMITS.externalId}`)
  })

  it('one sender\'s submission id is one row: unique per form and sender, never across senders', () => {
    expect(BODY).toContain("on public.data_form_attempt (form_id, coalesce(client_hash, ''), external_id) where external_id is not null;")
  })

  it('keeps both tables to the service role: RLS on, nothing for anon or signed-in clients, no policy', () => {
    for (const table of ['data_form', 'data_form_attempt']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).toContain(`grant all on table public.${table} to service_role;`)
    }
    expect(BODY).not.toContain('create policy')
  })

  it('no unique index includes workspace_id (the workspace merge re-stamps it)', () => {
    for (const m of BODY.matchAll(/create unique index[^;]+;/g)) expect(m[0]).not.toContain('workspace_id')
  })

  it('is re-runnable', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    expect(BODY).toContain("notify pgrst, 'reload schema';")
    expect(BODY).not.toMatch(/create function /)
  })
})
