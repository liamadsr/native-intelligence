/**
 * writeDocument (migration 364): the update is conditional on the revision
 * read, carries who it is for and a summary for the history row, and a
 * 0-row result is told apart by re-reading: moved on (a conflict), gone, or
 * still at the base (RLS refused it).
 */
import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { clampSummary, conflictResult, parseRevision, writeDocument } from '../write'

function db(opts: { stored: number | null; updateRows?: unknown[]; updateError?: { message: string; code?: string } }) {
  return createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.op === 'update') return { data: opts.updateError ? null : (opts.updateRows ?? []), error: opts.updateError ?? null }
    if (q.op === 'select') return { data: opts.stored === null ? null : { revision: opts.stored }, error: null }
    return { data: null, error: null }
  })
}

const ARGS = {
  documentId: 'doc-1',
  workspaceId: 'ws-1',
  baseRevision: 4,
  patch: { content: 'New.' },
  source: 'agent' as const,
  memberId: 'mem-1',
  summary: 'Replaced section Risks',
}

describe('writeDocument', () => {
  it('writes conditional on the base, with edit_source, summary and editor', async () => {
    const fake = db({ stored: 4, updateRows: [{ id: 'doc-1', revision: 5 }] })
    const r = await writeDocument(fake.client, ARGS)
    expect(r).toEqual({ ok: true, row: { id: 'doc-1', revision: 5 }, revision: 5 })
    const update = fake.log.find((q) => q.op === 'update')!
    expect(update.payload).toEqual({ content: 'New.', edit_source: 'agent', edit_summary: 'Replaced section Risks', last_edited_by: 'mem-1' })
    expect(update.filters).toEqual([
      ['eq', 'id', 'doc-1'],
      ['eq', 'workspace_id', 'ws-1'],
      ['eq', 'revision', 4],
    ])
    expect(update.columns).toBe('id, revision')
  })

  it('0 rows and the document moved on: a conflict with its revision now', async () => {
    expect(await writeDocument(db({ stored: 6 }).client, ARGS)).toEqual({ ok: false, reason: 'conflict', currentRevision: 6 })
  })

  it('0 rows and still at the base: refused (RLS)', async () => {
    expect(await writeDocument(db({ stored: 4 }).client, ARGS)).toEqual({ ok: false, reason: 'refused' })
  })

  it('0 rows and gone: not found', async () => {
    expect(await writeDocument(db({ stored: null }).client, ARGS)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('the 359 guard raising is a refusal; any other error is passed on', async () => {
    expect(await writeDocument(db({ stored: 4, updateError: { message: 'no', code: '42501' } }).client, ARGS)).toEqual({ ok: false, reason: 'refused' })
    expect(await writeDocument(db({ stored: 4, updateError: { message: 'boom', code: 'XX000' } }).client, ARGS)).toEqual({
      ok: false,
      reason: 'error',
      error: 'boom',
      code: 'XX000',
    })
  })

  it('keeps an asked-for revision column once', async () => {
    const fake = db({ stored: 4, updateRows: [{ id: 'doc-1', revision: 5 }] })
    await writeDocument(fake.client, { ...ARGS, select: 'id, title, revision' })
    expect(fake.log.find((q) => q.op === 'update')!.columns).toBe('id, title, revision')
  })
})

describe('helpers', () => {
  it('clampSummary: one line, at most 200 characters, null when empty', () => {
    expect(clampSummary('  Rewrote\n the   intro ')).toBe('Rewrote the intro')
    expect(clampSummary('   ')).toBeNull()
    expect(clampSummary('x'.repeat(300))?.length).toBe(200)
  })

  it('parseRevision: positive whole numbers only', () => {
    expect(parseRevision(3)).toBe(3)
    expect(parseRevision('7')).toBe(7)
    expect(parseRevision(0)).toBeNull()
    expect(parseRevision(2.5)).toBeNull()
    expect(parseRevision(undefined)).toBeNull()
  })

  it('conflictResult says what to do', () => {
    expect(conflictResult(3, 5)).toMatchObject({ success: false, conflict: true, base_revision: 3, current_revision: 5 })
    expect(conflictResult(3, 5).error).toMatch(/revision 3.*revision 5.*get_document/)
  })
})
