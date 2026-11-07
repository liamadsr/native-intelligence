/**
 * Decision 18: a report or prep nobody changed or opened in 30 days and
 * nothing links to is archived (never deleted); an open is stamped only for
 * those kinds; a system document is never in the batch; a failed read keeps
 * everything.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { archiveStaleReports, documentsToArchive, noteDocumentOpened } from '../report-archive'

const WS = 'w1'
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-20T04:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const doc = (id: string, kind: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({ id, workspace_id: WS, kind, status: 'active', canon_key: null, updated_at: iso(daysAgo), ...extra })

describe('documentsToArchive', () => {
  it('keeps what was opened lately, is linked, or is a system document', () => {
    expect(documentsToArchive(['a', 'b', 'c', 'd'], { openedSince: new Set(['a']), linked: new Set(['b']), system: new Set(['c']) })).toEqual(['d'])
  })
})

describe('archiveStaleReports', () => {
  it('archives old, unopened, unkept reports and preps only (S3)', async () => {
    const fake = makeFakeSupabase()
    fake.seed('document', [
      doc('old-report', 'report', 45),
      doc('old-prep', 'prep', 40),
      doc('recent-report', 'report', 5),
      doc('old-doc', 'doc', 90),
      doc('opened-report', 'report', 60),
      doc('linked-prep', 'prep', 60),
      doc('attached-report', 'report', 60),
      doc('opened-long-ago', 'report', 90),
      doc('self-cited', 'report', 70),
      doc('in-project', 'report', 70, { project_id: 'p1' }),
      doc('pinned', 'report', 70, { is_pinned: true }),
      doc('packaged', 'report', 70),
      doc('carded', 'report', 70),
    ])
    fake.seed('document_open', [
      { document_id: 'opened-report', workspace_id: WS, last_opened_at: iso(10) },
      { document_id: 'opened-long-ago', workspace_id: WS, last_opened_at: iso(80) },
    ])
    fake.seed('entity_link', [
      { workspace_id: WS, target_type: 'document', target_id: 'linked-prep', source_type: 'action', source_id: 'a1', relation: 'about' },
      // A claim drawn from the report itself, citing it: not a link anyone made.
      { workspace_id: WS, target_type: 'document', target_id: 'self-cited', source_type: 'claim', source_id: 'c1', relation: 'cites' },
    ])
    fake.seed('claim_source', [{ claim_id: 'c1', source_type: 'document', source_id: 'self-cited' }])
    fake.seed('action_document', [{ document_id: 'attached-report' }])
    fake.seed('knowledge_package_item', [{ workspace_id: WS, entity_type: 'document', entity_id: 'packaged' }])
    fake.seed('attention_item', [{ workspace_id: WS, entity_type: 'document', entity_id: 'carded' }])
    fake.seed('workspace', [{ id: WS, settings: {} }])
    const n = await archiveStaleReports(fake as never, WS, NOW)
    const archived = fake.rows('document').filter((d) => d.status === 'archived').map((d) => d.id).sort()
    expect(archived).toEqual(['old-prep', 'old-report', 'opened-long-ago', 'self-cited'])
    expect(n).toBe(4)
    expect(fake.rows('document')).toHaveLength(13)
  })

  it('pages past kept rows, so they never hold the rest back (S3)', async () => {
    const fake = makeFakeSupabase()
    const kept = Array.from({ length: 200 }, (_, i) => doc(`kept-${String(i).padStart(3, '0')}`, 'report', 200, { is_pinned: true }))
    fake.seed('document', [...kept, doc('z-stale', 'report', 60)])
    fake.seed('workspace', [{ id: WS, settings: {} }])
    expect(await archiveStaleReports(fake as never, WS, NOW)).toBe(1)
    expect(fake.rows('document').find((d) => d.id === 'z-stale')?.status).toBe('archived')
  })

  it('never archives the product doc', async () => {
    const fake = makeFakeSupabase()
    fake.seed('document', [doc('p', 'report', 60)])
    fake.seed('workspace', [{ id: WS, settings: { product_doc: { document_id: 'p' } } }])
    expect(await archiveStaleReports(fake as never, WS, NOW)).toBe(0)
  })
})

describe('noteDocumentOpened', () => {
  it('stamps only reports and preps', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }))
    await noteDocumentOpened({ rpc } as never, { documentId: 'd', workspaceId: WS, kind: 'doc' })
    expect(rpc).not.toHaveBeenCalled()
    await noteDocumentOpened({ rpc } as never, { documentId: 'd', workspaceId: WS, kind: 'prep' })
    expect(rpc).toHaveBeenCalledWith('note_document_open', { p_document_id: 'd', p_workspace_id: WS })
  })
})
