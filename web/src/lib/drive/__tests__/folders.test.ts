import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FOLDER_ITEM_TYPES, childFolders, folderAndDescendants, folderName, folderPath, isFolderItemType, type DriveFolder } from '../folders'
import { folderRefusal } from '../folder-store'

const f = (id: string, name: string, parent_id: string | null = null): DriveFolder => ({ id, name, parent_id, created_by: null, created_at: '', updated_at: '' })
const tree = [f('a', 'Clients'), f('b', 'Acme', 'a'), f('c', 'Invoices', 'b'), f('d', 'Archive'), f('e', 'Beta', 'a')]

describe('Drive folders, in the app', () => {
  it('names a folder trimmed, 1 to 200 characters', () => {
    expect(folderName('  Clients ')).toBe('Clients')
    expect(folderName('   ')).toBeNull()
    expect(folderName('x'.repeat(201))).toBeNull()
    expect(folderName(3)).toBeNull()
  })

  it('holds docs, tables, spreadsheets, canvases and Drive uploads (709), nothing else', () => {
    expect([...FOLDER_ITEM_TYPES]).toEqual(['document', 'data_table', 'spreadsheet', 'canvas', 'attachment'])
    expect(isFolderItemType('contact')).toBe(false)
  })

  it('walks a folder’s path, its children and everything under it', () => {
    expect(folderPath(tree, 'c').map((x) => x.name)).toEqual(['Clients', 'Acme', 'Invoices'])
    expect(folderPath(tree, null)).toEqual([])
    expect(childFolders(tree, 'a').map((x) => x.name)).toEqual(['Acme', 'Beta'])
    expect(childFolders(tree, null).map((x) => x.name)).toEqual(['Archive', 'Clients'])
    expect([...folderAndDescendants(tree, 'a')].sort()).toEqual(['a', 'b', 'c', 'e'])
  })

  it('stops on a loop rather than hang', () => {
    const loop = [f('x', 'X', 'y'), f('y', 'Y', 'x')]
    expect(folderPath(loop, 'x').map((v) => v.id)).toEqual(['y', 'x'])
  })

  it('answers a database refusal with its own status', () => {
    expect(folderRefusal({ code: '42501', message: 'no' }).status).toBe(403)
    expect(folderRefusal({ code: '23514' }).status).toBe(400)
    expect(folderRefusal({ code: '23505' }).status).toBe(409)
    expect(folderRefusal({ code: 'XX000' }).status).toBe(500)
  })
})

// supabase/tests/690_drive_folders.sql runs the SQL; this pins the file's text.
describe('migration 690', () => {
  const raw = readFileSync(join(process.cwd(), 'supabase/migrations/690_drive_folders.sql'), 'utf8')
  const sql = raw.replace(/--[^\n]*/g, '')

  it('carries its own transaction, once, and no backslash', () => {
    expect(sql.match(/^\s*begin\s*;/gim)).toHaveLength(1)
    expect(sql.match(/^\s*commit\s*;/gim)).toHaveLength(1)
    expect(sql.trim().endsWith('commit;')).toBe(true)
    expect(raw).not.toContain('\\')
  })

  it('touches only its own two tables and its own functions', () => {
    for (const m of sql.matchAll(/(?:create|alter|drop)\s+(?:table|policy|trigger)(?:\s+if\s+(?:not\s+)?exists)?\s+(\w+)(?:\s+on)?\s+public\.(\w+)/gi)) {
      expect(['drive_folder', 'drive_folder_item'], m[0]).toContain(m[2] ?? m[1])
    }
    for (const m of sql.matchAll(/create or replace function public\.(\w+)/gi)) expect(m[1]).toMatch(/^drive_folder/)
    for (const m of sql.matchAll(/alter table public\.(\w+)/gi)) expect(['drive_folder', 'drive_folder_item']).toContain(m[1])
  })

  it('turns row security on for both tables, with every command covered', () => {
    for (const t of ['drive_folder', 'drive_folder_item']) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${t} enable row level security`))
      for (const cmd of ['select', 'insert', 'update', 'delete']) expect(sql).toMatch(new RegExp(`create policy ${t}_${cmd} on public\\.${t}\\s+for ${cmd}`))
    }
  })

  it('a filed row is seen, moved and unfiled only by someone who can open its record', () => {
    for (const cmd of ['select', 'update', 'delete']) {
      const policy = sql.match(new RegExp(`create policy drive_folder_item_${cmd}[\\s\\S]*?;`))?.[0] ?? ''
      expect(policy, cmd).toMatch(/drive_folder_item_readable\(item_type, item_id, workspace_id\)/)
    }
  })

  it('names the kinds the app files: 690 the first four, 709 adds the Drive upload', () => {
    const check = sql.match(/item_type in \(([^)]*)\)/)?.[1] ?? ''
    expect([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(FOLDER_ITEM_TYPES.filter((t) => t !== 'attachment'))
    const sql696 = readFileSync(join(process.cwd(), 'supabase/migrations/709_drive_uploads.sql'), 'utf8')
    const check696 = sql696.match(/item_type in \(([^)]*)\)\) not valid/)?.[1] ?? ''
    expect([...check696.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...FOLDER_ITEM_TYPES])
  })

  it('its guards are not definers (the caller’s own row security reads the parent and the record)', () => {
    for (const name of ['drive_folder_before_write', 'drive_folder_item_before_write', 'drive_folder_item_readable']) {
      const start = sql.indexOf(`create or replace function public.${name}(`)
      const head = sql.slice(start, sql.indexOf('as $$', start))
      expect(head, name).not.toMatch(/security definer/i)
    }
  })
})
