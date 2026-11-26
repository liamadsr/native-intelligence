/**
 * Migration 722: the person's archive here on the mail index
 * (email_thread_index.local_archived_at, local_archived_history_id), and the
 * code's word for it (src/lib/email/local-archive.ts).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archivedHereSinceNewest, isPre722Error, LOCAL_ARCHIVE_COLUMNS, localArchivePatch, reenteredInbox, withoutLocalArchive } from '@/lib/email/local-archive'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '722_thread_local_archive.sql'), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

describe('migration 722 (text checks of the SQL file)', () => {
  it('is the only 722, holds no backslash, is its own transaction with a lock timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 722)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe('begin')
    expect(STATEMENTS[1]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(STATEMENTS.at(-1)).toBe('commit')
  })

  it('adds the two columns the code names, nullable, if not there, and grants nothing', () => {
    for (const column of LOCAL_ARCHIVE_COLUMNS) {
      expect(STATEMENTS.some((s) => s.startsWith(`alter table public.email_thread_index add column if not exists ${column} `))).toBe(true)
    }
    expect(SQL).not.toMatch(/not null|default |grant |policy /i)
    expect(STATEMENTS).toContain("notify pgrst, 'reload schema'")
  })

  it('says how to apply it, in what order, and where its number came from', () => {
    expect(SQL).toContain('HOW TO APPLY:')
    expect(SQL).toContain('WITHOUT --single-transaction')
    expect(SQL).toContain('⛔ PROD ORDER:')
    expect(SQL).toContain('NUMBER: 722 is the first free number after main')
  })
})

describe('the archive mark', () => {
  const mark = { local_archived_at: '2026-11-26T10:00:00.000Z', local_archived_history_id: '200' }

  it('a read with an older or equal historyId predates the archive; a newer one is back', () => {
    expect(reenteredInbox(mark, { historyId: '150', newestMessageAt: '2026-11-26T11:00:00.000Z' })).toBe(false)
    expect(reenteredInbox(mark, { historyId: '200', newestMessageAt: null })).toBe(false)
    expect(reenteredInbox(mark, { historyId: '201', newestMessageAt: null })).toBe(true)
    // Past 2^53: compared exactly.
    expect(reenteredInbox({ ...mark, local_archived_history_id: '9007199254740993' }, { historyId: '9007199254740992', newestMessageAt: null })).toBe(false)
  })

  it('with no historyId on one side, a message after the archive is the evidence', () => {
    const noHistory = { ...mark, local_archived_history_id: null }
    expect(reenteredInbox(noHistory, { historyId: '999', newestMessageAt: '2026-11-26T09:00:00.000Z' })).toBe(false)
    expect(reenteredInbox(noHistory, { historyId: '999', newestMessageAt: '2026-11-26T10:00:01.000Z' })).toBe(true)
    expect(reenteredInbox(mark, { historyId: null, newestMessageAt: null })).toBe(false)
  })

  it('no mark: the read is the word', () => {
    expect(reenteredInbox(null, { historyId: null, newestMessageAt: null })).toBe(true)
    expect(reenteredInbox({ local_archived_at: null }, { historyId: '1', newestMessageAt: null })).toBe(true)
  })

  it('Incoming leaves out a row archived here with nothing newer in it', () => {
    expect(archivedHereSinceNewest({ ...mark, last_message_at: '2026-11-26T09:00:00Z' })).toBe(true)
    expect(archivedHereSinceNewest({ ...mark, last_message_at: '2026-11-26T10:30:00Z' })).toBe(false)
    expect(archivedHereSinceNewest({ last_message_at: '2026-11-26T09:00:00Z' })).toBe(false)
  })

  it('the patch sets and clears it; before 722 it is dropped', () => {
    expect(localArchivePatch(true, '7', new Date('2026-11-26T10:00:00Z'))).toEqual({ local_archived_at: '2026-11-26T10:00:00.000Z', local_archived_history_id: '7' })
    expect(localArchivePatch(false)).toEqual({ local_archived_at: null, local_archived_history_id: null })
    expect(withoutLocalArchive({ folder: 'archive', ...localArchivePatch(true) })).toEqual({ folder: 'archive' })
    expect(isPre722Error({ code: '42703', message: 'column email_thread_index.local_archived_at does not exist' })).toBe(true)
    expect(isPre722Error({ code: 'PGRST204', message: "Could not find the 'local_archived_history_id' column of 'email_thread_index'" })).toBe(true)
    expect(isPre722Error({ code: '23505', message: 'duplicate key' })).toBe(false)
  })
})
