/**
 * Migration 376: a section edit's metadata rides document.edit_meta into its
 * revision (read and cleared by 364's trigger, redefined whole), never from a
 * signed-in caller, never folded into a person's autosave; and the
 * 'doc_updated' log kind. Everything else in the trigger is 364's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_LOG_KINDS } from '@/lib/log/agent-log'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/376_document_edit_meta.sql'), 'utf8')
const OLD = readFileSync(join(process.cwd(), 'supabase/migrations/364_document_revisions_and_safe_writes.sql'), 'utf8')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
const fn = (body: string) => {
  const start = body.indexOf('create or replace function public.document_track_change(')
  return body.slice(start, body.indexOf('$$;', start) + 3)
}

describe('migration 376', () => {
  it('has no backslash and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain('alter table public.document add column if not exists edit_meta jsonb;')
    expect(BODY).toContain('alter table public.document_revision add column if not exists edit_meta jsonb;')
    expect(BODY).toContain('drop trigger if exists document_track_change on public.document;')
    expect(BODY).toContain('alter table public.agent_log drop constraint if exists agent_log_kind_check;')
  })

  it('the trigger reads edit_meta into the revision and always clears it', () => {
    const t = fn(BODY)
    expect(t.match(/new\.edit_meta := null;/g)?.length).toBe(2)
    expect(t).toContain("when jsonb_typeof(new.edit_meta) = 'object' and octet_length(new.edit_meta::text) <= 8192 then new.edit_meta")
    expect(t).toContain('change_summary, edit_meta, created_at, updated_at')
    expect(t).toContain("coalesce(v_source, 'system'), v_summary, v_meta,")
  })

  it('a signed-in caller files none, and a meta edit never folds into an autosave', () => {
    const t = fn(BODY)
    const human = t.indexOf("v_source := 'human';")
    expect(t.slice(human, human + 60)).toContain('v_meta := null;')
    expect(t).toContain('and v_summary is null and v_meta is null and v_latest_at')
  })

  it('is 364’s trigger otherwise, line for line', () => {
    const strip = (t: string) =>
      t
        .replace(/v_meta\s+jsonb;/, '')
        .replace(/new\.edit_meta := null;/g, '')
        .replace(/v_meta := case.*?end;/, '')
        .replace(/v_meta := null;/, '')
        .replace(/and v_meta is null /, '')
        .replace(/, edit_meta, created_at/, ', created_at')
        .replace(/v_summary, v_meta,/, 'v_summary,')
        .replace(/-- what a section edit was \(376\)[^\n]*/, '')
        .replace(/\s+/g, ' ')
    expect(strip(fn(BODY))).toBe(strip(fn(flat(OLD))))
  })

  it('the log kind matches the app’s list', () => {
    expect(AGENT_LOG_KINDS).toContain('doc_updated')
    // 'pr_changed' (443), 'mail_archived' (446), 'action_done_from_mail' (450) and 'look_ahead' (452) came later (their own tests pin them).
    for (const kind of AGENT_LOG_KINDS.filter((k) => k !== 'pr_changed' && k !== 'mail_archived' && k !== 'action_done_from_mail' && k !== 'look_ahead')) expect(BODY).toContain(`'${kind}'`)
  })
})
