/**
 * A form's files field across the forms lib (migration 663): what the form
 * may be saved with (one files field, never alone, never with the bot check
 * off), how a page draws it (type 'file' with the server's limits), how the
 * agent and the builder read it, the quote preset, and where a stored row's
 * files go (each an attachment of the row, from_form, no uploader, its type
 * the one decided). Made-up names.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DataColumn, DataTableWithColumns } from '@/lib/tables/types'

vi.mock('@/lib/knowledge/entity-fences', () => ({ hiddenGraphRefs: vi.fn(async () => new Set()) }))

import { postedNameOf, validateFormFields } from '../fields'
import { storeFormFiles } from '../file-store'
import { describeForm, FILES_NEED_BOT_CHECK, formForApi, prepareFormPatch, prepareNewForm } from '../manage'
import { formPresetFor, QUOTE_REQUEST_PRESET } from '../presets'
import { formShape } from '../public'
import { FORM_FILE_ACCEPT, FORM_FILE_LIMITS, FORM_FILES_KEY, FORM_TITLE_KEY, type DataForm } from '../types'
import { PNG } from './zip-fixture'

const col = (key: string, label: string, field_type: DataColumn['field_type']): DataColumn => ({ id: `c-${key}`, table_id: 't1', key, label, field_type, options: [], config: {}, position: 0, deleted_at: null })
const COLUMNS = [col('email', 'Email', 'email'), col('message', 'Message', 'text')]
const TABLE: DataTableWithColumns = {
  id: '33333333-3333-4333-8333-333333333333',
  workspace_id: 'ws-1',
  name: 'Rug repairs',
  icon: null,
  description: null,
  owner_member_id: 'm-1',
  visibility: 'workspace',
  version: 1,
  position: 0,
  archived_at: null,
  created_at: '',
  updated_at: '',
  columns: COLUMNS,
}
const WHO = { workspaceId: 'ws-1', userId: 'u-1' }
const FILES = { key: FORM_FILES_KEY, label: 'Photos of the rug', required: true }

const FORM: DataForm = {
  id: 'form-1',
  workspaceId: 'ws-1',
  tableId: TABLE.id,
  name: 'Rug repairs',
  fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: true }, { key: 'email', label: 'Email', required: true }, FILES],
  access: 'public',
  allowedOrigins: [],
  thanks: null,
  description: null,
  submitLabel: null,
  botCheck: true,
  active: true,
  keyPrefix: 'fk_abcdef',
  createdBy: 'u-1',
  createdAt: '',
  updatedAt: '',
  lastSubmittedAt: null,
}

describe('saving a form with files', () => {
  it('takes one files field, labelled, posted as files, not a column', () => {
    const out = validateFormFields(COLUMNS, [{ key: FORM_TITLE_KEY }, { key: FORM_FILES_KEY, label: 'Photos of the rug', required: true }])
    expect(out).toEqual({ ok: true, value: [{ key: FORM_TITLE_KEY, label: 'Name', required: false }, FILES] })
    expect(validateFormFields(COLUMNS, [{ key: 'email' }, { key: FORM_FILES_KEY }])).toMatchObject({ ok: true, value: [{ key: 'email' }, { key: FORM_FILES_KEY, label: 'Files' }] })
    expect(postedNameOf(FILES)).toBe('files')
  })

  it('refuses two files fields, and a form of files alone', () => {
    expect(validateFormFields(COLUMNS, [{ key: 'email' }, { key: FORM_FILES_KEY }, { key: FORM_FILES_KEY, label: 'More' }])).toEqual({ ok: false, error: 'A form takes files through one field.' })
    expect(validateFormFields(COLUMNS, [{ key: FORM_FILES_KEY }])).toEqual({ ok: false, error: 'A form needs at least one field besides its files.' })
  })

  it('a label "Files" on a text column does not clash with the files field', () => {
    const cols = [...COLUMNS, col('files', 'Files', 'text')]
    expect(validateFormFields(cols, [{ key: 'files', label: 'Files' }, { key: FORM_FILES_KEY, label: 'Files' }]).ok).toBe(true)
  })

  it('a new form with files keeps the bot check on: asked off, it is refused, and says why', () => {
    expect(prepareNewForm(TABLE, WHO, { fields: [{ key: 'email' }, { key: FORM_FILES_KEY }] })).toMatchObject({ ok: true, value: { botCheck: true } })
    expect(prepareNewForm(TABLE, WHO, { fields: [{ key: 'email' }, { key: FORM_FILES_KEY }], botCheck: false })).toEqual({ ok: false, error: FILES_NEED_BOT_CHECK })
    expect(prepareNewForm(TABLE, WHO, { fields: [{ key: 'email' }], botCheck: false }).ok).toBe(true)
  })

  it('a change is checked with what the form keeps: files added with the check off, or the check turned off with files, is refused', () => {
    const off = { fields: [{ key: 'email', label: 'Email', required: true }], botCheck: false }
    expect(prepareFormPatch(TABLE, 'u-1', { fields: [{ key: 'email' }, { key: FORM_FILES_KEY }] }, off)).toEqual({ ok: false, error: FILES_NEED_BOT_CHECK })
    expect(prepareFormPatch(TABLE, 'u-1', { fields: [{ key: 'email' }, { key: FORM_FILES_KEY }], botCheck: true }, off).ok).toBe(true)
    expect(prepareFormPatch(TABLE, 'u-1', { botCheck: false }, FORM)).toEqual({ ok: false, error: FILES_NEED_BOT_CHECK })
    expect(prepareFormPatch(TABLE, 'u-1', { name: 'Repairs' }, FORM).ok).toBe(true)
    // Files taken off with the check off in one change: fine.
    expect(prepareFormPatch(TABLE, 'u-1', { fields: [{ key: 'email' }], botCheck: false }, FORM).ok).toBe(true)
  })
})

describe('reading a form with files', () => {
  it('a page draws it as type file, with the limits the server keeps', () => {
    const shape = formShape(FORM, COLUMNS)
    expect(shape.fields.at(-1)).toEqual({ name: 'files', label: 'Photos of the rug', type: 'file', required: true, max_files: FORM_FILE_LIMITS.maxFiles, max_bytes: FORM_FILE_LIMITS.maxBytes, accept: FORM_FILE_ACCEPT })
    expect(FORM_FILE_ACCEPT).not.toMatch(/svg|html|zip|exe|js/)
  })

  it('the agent and the builder read it, never as a column that is gone', () => {
    expect(describeForm(FORM, TABLE).fields.at(-1)).toMatchObject({ label: 'Photos of the rug', post_as: 'files', type: 'files', required: true, takes: expect.stringContaining('up to 5 files of 10 MB each') })
    const api = formForApi(FORM, TABLE).fields.at(-1)
    expect(api).toEqual({ key: FORM_FILES_KEY, label: 'Photos of the rug', required: true, post_as: 'files', type: 'file' })
  })
})

describe('the quote preset', () => {
  const quoteColumns = Object.entries(QUOTE_REQUEST_PRESET.columns).map(([key, type]) => col(key, key, type))

  it('is a table’s when it has every column, by key and type, whatever the table is called', () => {
    expect(formPresetFor(quoteColumns)).toBe(QUOTE_REQUEST_PRESET)
    expect(formPresetFor(quoteColumns.filter((c) => c.key !== 'size'))).toBeNull()
    expect(formPresetFor(quoteColumns.map((c) => (c.key === 'preferred_date' ? { ...c, field_type: 'text' as const } : c)))).toBeNull()
    expect(formPresetFor(quoteColumns.map((c) => (c.key === 'email' ? { ...c, deleted_at: '2026-11-01' } : c)))).toBeNull()
  })

  it('its fields are ones a form may be saved with, budget and status left off', () => {
    const out = validateFormFields(quoteColumns, QUOTE_REQUEST_PRESET.fields)
    expect(out.ok).toBe(true)
    expect(QUOTE_REQUEST_PRESET.fields.map((f) => f.key)).toEqual([FORM_TITLE_KEY, 'email', 'phone', 'address', 'service', 'size', 'preferred_date', 'message'])
  })
})

describe('storing a row’s files', () => {
  function fakeStorage(opts: { failUpload?: number; failInsert?: number } = {}) {
    const uploads: Array<{ path: string; contentType: string; size: number }> = []
    const removed: string[][] = []
    const inserted: Record<string, unknown>[] = []
    let n = 0
    let m = 0
    const client = {
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe('attachments')
          return {
            upload: async (path: string, bytes: Uint8Array, o: { contentType: string; upsert: boolean }) => {
              expect(o.upsert).toBe(false)
              if (n++ === opts.failUpload) return { error: new Error('storage down') }
              uploads.push({ path, contentType: o.contentType, size: bytes.length })
              return { error: null }
            },
            remove: async (paths: string[]) => (removed.push(paths), { error: null }),
          }
        },
      },
      from: (table: string) => {
        expect(table).toBe('attachments')
        return {
          insert: async (row: Record<string, unknown>) => {
            if (m++ === opts.failInsert) return { error: { message: 'insert refused' } }
            inserted.push(row)
            return { error: null }
          },
        }
      },
    } as unknown as SupabaseClient
    return { client, uploads, removed, inserted }
  }
  const file = (name: string, mime: string, ext: string) => ({ name, ext, mime, category: mime.startsWith('image/') ? ('image' as const) : ('document' as const), size: PNG.length, bytes: PNG })
  const ids = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002']

  it('each is uploaded under a random name with the decided type, then inserted as the row’s attachment, from the form, with no uploader', async () => {
    const s = fakeStorage()
    let i = 0
    const out = await storeFormFiles(s.client, FORM, 'row-1', [file('rug.png', 'image/png', 'png'), file('quote.pdf', 'application/pdf', 'pdf')], () => ids[i++])
    expect(out).toEqual({ stored: 2, failed: 0 })
    expect(s.uploads).toEqual([
      { path: `forms/ws-1/form-1/${ids[0]}.png`, contentType: 'image/png', size: PNG.length },
      { path: `forms/ws-1/form-1/${ids[1]}.pdf`, contentType: 'application/pdf', size: PNG.length },
    ])
    expect(s.inserted[0]).toEqual({
      user_id: null,
      workspace_id: 'ws-1',
      data_row_id: 'row-1',
      from_form: true,
      form_id: 'form-1',
      file_name: 'rug.png',
      file_size_bytes: PNG.length,
      mime_type: 'image/png',
      file_extension: 'png',
      file_category: 'image',
      storage_bucket: 'attachments',
      storage_path: `forms/ws-1/form-1/${ids[0]}.png`,
      display_order: 0,
    })
    // Never a capture's, an action's or a project's, never indexed.
    expect(s.inserted.every((r) => !('note_id' in r) && !('action_id' in r) && !('project_id' in r))).toBe(true)
  })

  it('a file that can’t be uploaded is counted and skipped; one whose row is refused takes its object back out', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = fakeStorage({ failUpload: 0, failInsert: 0 })
    let i = 0
    const out = await storeFormFiles(s.client, FORM, 'row-1', [file('a.png', 'image/png', 'png'), file('b.png', 'image/png', 'png'), file('c.png', 'image/png', 'png')], () => ids[i++ % 2])
    expect(out).toEqual({ stored: 1, failed: 2 })
    expect(s.removed).toHaveLength(1)
    errors.mockRestore()
  })
})
