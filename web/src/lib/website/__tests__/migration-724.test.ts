/**
 * Migration 724 (a website on a site builder, docs/plans/hosted-site-builders.md)
 * pinned to the app's constants: the providers its check allows, the columns
 * the store reads, its own transaction, and nothing but additions.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SITE_PROVIDERS } from '../providers/types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/724_website_builders.sql'), 'utf8')
const CODE = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 724', () => {
  it('holds its own transaction and reloads the data API', () => {
    expect(CODE.startsWith('begin;')).toBe(true)
    expect(CODE).toMatch(/commit; notify pgrst, 'reload schema';$/)
    expect(SQL).toContain('WITHOUT --single-transaction')
  })

  it('allows exactly the providers the app knows, GitHub by default', () => {
    const check = CODE.match(/website_site_provider_check check \(provider in \(([^)]+)\)\)/)
    expect(check).not.toBeNull()
    expect(check![1].split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...SITE_PROVIDERS])
    expect(CODE).toContain("add column if not exists provider text not null default 'github'")
  })

  it('adds the columns the store reads and writes, and drops nothing', () => {
    for (const col of ['provider_site_id text null', 'credentials_encrypted text null', 'staged jsonb null']) expect(CODE).toContain(`add column if not exists ${col}`)
    expect(CODE).not.toMatch(/drop (table|column)/i)
    // A GitHub site still needs its repo and branch.
    expect(CODE).toContain("(provider = 'github' and repo_full_name is not null")
    expect(CODE).toContain("(provider = 'github' and default_branch is not null")
    // Only ciphertext in the credentials column.
    expect(CODE).toContain("credentials_encrypted ~ '^v1\\.'")
  })
})
