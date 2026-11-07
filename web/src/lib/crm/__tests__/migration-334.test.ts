/**
 * Migration 334: email.trust marks on email_thread_index. Pins: three
 * nullable columns, no default and no backfill, the check limits trust to
 * 'suspicious' | 'injection', every statement is safe to run twice, and the
 * file has no backslash (the PROD apply path mangles them).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/334_email_thread_trust.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 334', () => {
  it('adds the three trust columns, nullable, idempotently, with no default and no backfill', () => {
    for (const column of ['trust text', 'trust_message_id text', 'trust_inference_id text']) {
      expect(BODY).toContain(`alter table public.email_thread_index add column if not exists ${column};`)
    }
    expect(BODY).not.toMatch(/(trust|trust_message_id|trust_inference_id) text (not null|default)/)
    expect(BODY).not.toMatch(/\bupdate public\.email_thread_index\b/)
  })

  it('checks trust is null, suspicious or injection, dropping the check first so a re-run adds it again', () => {
    const drop = BODY.indexOf('drop constraint if exists email_thread_index_trust_check;')
    const add = BODY.indexOf('add constraint email_thread_index_trust_check')
    expect(drop).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(drop)
    expect(BODY).toContain("check (trust is null or trust in ('suspicious', 'injection'));")
  })

  it('leaves RLS, policies and the realtime publication alone', () => {
    expect(BODY).not.toMatch(/policy|row level security|publication|replica identity/i)
  })

  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('every statement is idempotent (if not exists / drop if exists / comment)', () => {
    const statements = BODY.split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of statements) {
      expect(/if not exists|if exists|^comment on|^alter table public\.email_thread_index add constraint/.test(s), s).toBe(true)
    }
  })
})
