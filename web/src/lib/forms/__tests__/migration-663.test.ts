/**
 * Migration 663: forms take files, a table's row has files. Pins the file to
 * the app: the columns the intake and the readers use, a stranger's file with
 * no uploader, the row's read rule as restrictive policies (so the rules for
 * captures, actions and projects stay as they are), the storage rules
 * restated from their newest definitions with only the row arm added, the
 * restrictive storage rules that hold a row's file's bytes to its table
 * whoever uploaded them (and their lookup and indexes), the
 * byte ledger and a workspace's daily sum over it, files needing the bot
 * check, checks added without a scan, idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { FORM_FILES_KEY } from '../types'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const SQL = read('663_form_files.sql')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .map((l) => l.replace(/\s+--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
const BODY = flat(SQL)

/** A policy's text from its create to its semicolon. */
const policy = (sql: string, name: string) => {
  const at = sql.indexOf(`create policy ${name}`)
  return at < 0 ? '' : sql.slice(at, sql.indexOf(';', at) + 1)
}

const ROW_SELECT_ARM = 'r.table_id = any ((select public.my_data_table_ids())::uuid[])'
const ROW_EDIT_ARM = 'public.data_table_editable_by(r.table_id, auth.uid())'

describe('migration 663', () => {
  it('holds no backslash (one MCP transport decodes escapes), and waits at most 5 s for a lock', () => {
    expect(SQL).not.toContain('\\')
    expect(BODY.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
  })

  it("adds the row, the form's mark and its form to attachments; a form's file has no uploader", () => {
    expect(BODY).toContain('alter table public.attachments add column if not exists data_row_id uuid null references public.data_row(id) on delete cascade;')
    expect(BODY).toContain('alter table public.attachments add column if not exists from_form boolean not null default false;')
    expect(BODY).toContain('alter table public.attachments add column if not exists form_id uuid null references public.data_form(id) on delete set null;')
    expect(BODY).toContain('alter table public.attachments alter column user_id drop not null;')
    expect(BODY).toContain('check (user_id is not null or from_form) not valid;')
    expect(BODY).toContain('check (not from_form or (data_row_id is not null and user_id is null)) not valid;')
  })

  it("widens 128's parent check with the row, keeping its three parents", () => {
    expect(BODY).toContain('add constraint attachments_has_parent check (note_id is not null or action_id is not null or project_id is not null or data_row_id is not null) not valid;')
  })

  it("follows the row's table with restrictive policies only, so every existing attachments policy stands as it is", () => {
    for (const name of ['attachments_row_select', 'attachments_row_insert', 'attachments_row_update', 'attachments_row_delete']) {
      const text = flat(policy(SQL, name))
      expect(text, name).toContain('as restrictive')
      expect(text, name).toContain('data_row_id is null')
    }
    expect(flat(policy(SQL, 'attachments_row_select'))).toContain(ROW_SELECT_ARM)
    for (const name of ['attachments_row_insert', 'attachments_row_update', 'attachments_row_delete']) expect(flat(policy(SQL, name)), name).toContain(ROW_EDIT_ARM)
    // No member's client writes a stranger's file, or marks one as such.
    expect(flat(policy(SQL, 'attachments_row_insert'))).toContain('with check ( not from_form')
    expect(flat(policy(SQL, 'attachments_row_update'))).toContain('using (not from_form)')
    // No permissive attachments policy is restated here.
    expect(BODY).not.toMatch(/create policy attachments_(workspace|user)_/)
  })

  it("restates the bucket's read rule from 223 and its delete rule from 128, each with only the row arm added", () => {
    const all = migrationsInOrder()
    const newestBefore = (name: string) => {
      for (const m of [...all].reverse()) {
        if (m.file.startsWith('663_')) continue
        const text = policy(m.sql.replace(/CREATE POLICY/g, 'create policy'), `"${name}"`)
        if (text) return { file: m.file, text: flat(text).toLowerCase() }
      }
      throw new Error(name)
    }
    const readBefore = newestBefore('attachments workspace read')
    const deleteBefore = newestBefore('attachments workspace delete')
    expect(readBefore.file.startsWith('223_')).toBe(true)
    expect(deleteBefore.file.startsWith('128_')).toBe(true)
    const readNow = flat(policy(SQL, '"attachments workspace read"'))
    const deleteNow = flat(policy(SQL, '"attachments workspace delete"'))
    const readArm = ` and ( a.data_row_id is null or exists ( select 1 from public.data_row r where r.id = a.data_row_id and ${ROW_SELECT_ARM} ) )`
    const deleteArm = ` and ( a.data_row_id is null or exists ( select 1 from public.data_row r where r.id = a.data_row_id and ${ROW_EDIT_ARM} ) )`
    const norm = (s: string) => s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim()
    expect(readNow).toContain(readArm)
    expect(deleteNow).toContain(deleteArm)
    expect(norm(readNow.replace(readArm, ''))).toBe(norm(readBefore.text))
    expect(norm(deleteNow.replace(deleteArm, ''))).toBe(norm(deleteBefore.text))
    expect(BODY).toContain('drop policy if exists "attachments workspace read" on storage.objects;')
    expect(BODY).toContain('drop policy if exists "attachments workspace delete" on storage.objects;')
  })

  it("narrows every storage rule of the bucket for a row's file's object, the uploader's own-folder rules included, and leaves every other object as it was", () => {
    const READ = 'public.data_table_visible_to(t.id, auth.uid())'
    const EDIT = 'public.data_table_editable_by(t.id, auth.uid())'
    const LOOKUP = 'from unnest(public.attachment_object_row_tables(storage.objects.name)) as t(id)'
    for (const [name, rule, action] of [
      ['"attachments row files read"', READ, 'select'],
      ['"attachments row files update"', EDIT, 'update'],
      ['"attachments row files delete"', EDIT, 'delete'],
    ] as const) {
      const text = flat(policy(SQL, name))
      expect(text, name).toContain(`on storage.objects as restrictive for ${action} to authenticated`)
      // Another bucket, and an object no row's file names, pass untouched.
      expect(text, name).toContain("bucket_id <> 'attachments' or coalesce((")
      expect(text, name).toContain(`select bool_and(coalesce(${rule}, false)) ${LOOKUP} ), true)`)
      expect(BODY).toContain(`drop policy if exists ${name} on storage.objects;`)
    }
    // An update is checked on the object it leaves as well as the one it takes.
    expect(flat(policy(SQL, '"attachments row files update"'))).toContain('with check (')
    // The lookup sees through attachments_row_select (security definer), pins
    // its search path, reads both names an object goes by, answers every table,
    // and is no one's but a signed-in member's and the service role's.
    expect(BODY).toContain('create or replace function public.attachment_object_row_tables(p_name text) returns uuid[] language sql stable security definer')
    expect(BODY).toContain(
      "set search_path = '' as $$ select array_agg(distinct r.table_id) from ( select a.data_row_id from public.attachments a where a.storage_path = p_name and a.data_row_id is not null union all select a.data_row_id from public.attachments a where a.thumbnail_path = p_name and a.data_row_id is not null ) f join public.data_row r on r.id = f.data_row_id; $$;",
    )
    expect(BODY).toContain('revoke all on function public.attachment_object_row_tables(text) from public, anon;')
    expect(BODY).toContain('grant execute on function public.attachment_object_row_tables(text) to authenticated, service_role;')
    // One index probe per name.
    expect(BODY).toContain('create index if not exists idx_attachments_storage_path on public.attachments (storage_path);')
    expect(BODY).toContain('create index if not exists idx_attachments_thumbnail_path on public.attachments (thumbnail_path) where thumbnail_path is not null;')
    // The app writes these two names (the route's own-folder path, the intake's forms/ path).
    expect(readFileSync(join(process.cwd(), 'src/lib/forms/file-store.ts'), 'utf8')).toContain('storage_path: path,')
    expect(readFileSync(join(process.cwd(), 'src/app/api/account/attachments/route.ts'), 'utf8')).toContain('storage_path: storagePath,')
    expect(readFileSync(join(process.cwd(), 'src/app/api/account/attachments/[id]/route.ts'), 'utf8')).toContain('[attachment.storage_path, attachment.thumbnail_path]')
  })

  it('adds the byte ledger the caps count', () => {
    expect(BODY).toContain('alter table public.data_form_attempt add column if not exists upload_bytes bigint not null default 0;')
    expect(BODY).toContain('check (upload_bytes >= 0) not valid;')
  })

  it("sums a workspace's upload bytes in one query, the service role's alone, under the name and arguments the app calls", () => {
    expect(BODY).toContain('create or replace function public.data_form_workspace_upload_bytes(p_workspace_id uuid, p_since timestamptz) returns bigint language sql stable')
    expect(BODY).toContain(
      'select coalesce(sum(a.upload_bytes), 0)::bigint from public.data_form_attempt a join public.data_form f on f.id = a.form_id where f.workspace_id = p_workspace_id and a.created_at >= p_since and a.upload_bytes > 0;',
    )
    expect(BODY).toContain("set search_path = ''")
    expect(BODY).toContain('revoke all on function public.data_form_workspace_upload_bytes(uuid, timestamptz) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.data_form_workspace_upload_bytes(uuid, timestamptz) to service_role;')
    // The store calls it by these names (../store.ts uploadBytesSince).
    const store = readFileSync(join(process.cwd(), 'src/lib/forms/store.ts'), 'utf8')
    expect(store).toContain("rpc('data_form_workspace_upload_bytes', { p_workspace_id: by.workspaceId, p_since: sinceIso })")
    expect(BODY).toContain('create index if not exists data_form_attempt_upload_idx on public.data_form_attempt (form_id, created_at) include (upload_bytes) where upload_bytes > 0;')
  })

  it("says that a deleted row's file objects are left in the bucket, as an action's and a capture's are", () => {
    expect(SQL).toContain('storage objects are left in the')
    expect(SQL).toContain('no queue is')
  })

  it('a form with a files field must have the bot check on', () => {
    expect(BODY).toContain(`check (bot_check or not (fields @> '[{"key": "${FORM_FILES_KEY}"}]'::jsonb)) not valid;`)
  })

  it('every check on an existing table is added not valid and then validated', () => {
    for (const m of BODY.matchAll(/alter table public\.(attachments|data_form|data_form_attempt) add constraint (\w+)[^;]+;/g)) {
      expect(m[0], m[2]).toMatch(/not valid;$/)
      expect(BODY).toContain(`alter table public.${m[1]} validate constraint ${m[2]};`)
    }
  })

  it('no unique index includes workspace_id, and no new table', () => {
    for (const m of BODY.matchAll(/create unique index[^;]+;/g)) expect(m[0]).not.toContain('workspace_id')
    expect(BODY).not.toContain('create table')
  })

  it('is re-runnable', () => {
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    for (const m of BODY.matchAll(/create policy ("[^"]+"|\w+) on ([\w.]+)/g)) expect(BODY).toContain(`drop policy if exists ${m[1]} on ${m[2]};`)
    expect(BODY).not.toContain('drop trigger')
    expect(BODY.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })
})
