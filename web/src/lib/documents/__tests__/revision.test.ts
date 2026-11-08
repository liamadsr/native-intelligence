/**
 * Version history (src/lib/documents/revision.ts, migration 364): the list is
 * newest first and scoped to the document's workspace; one revision comes
 * with the one before it; a restore is an ordinary conditional write of the
 * old title and body, marked with its summary, refused without edit access
 * and when the document moved on since the revision the person was looking at.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import type { DocumentAccess } from '../access'
import { describeRevisionAuthor, getDocumentRevision, listDocumentRevisions, restoreDocumentRevision } from '../revision'
import { describeRevisionSources } from '../revision-format'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const ROW = (n: number, content: string, extra: Record<string, unknown> = {}) => ({
  revision_number: n,
  title: 'Plan',
  author_kind: 'agent',
  author_id: 'mem-1',
  change_summary: `Change ${n}`,
  created_at: '2026-10-19T10:00:00Z',
  updated_at: '2026-10-19T10:05:00Z',
  author: { display_name: 'Ana' },
  content,
  frontmatter: {},
  ...extra,
})

function access(role = 'owner'): DocumentAccess {
  return {
    role,
    memberId: 'mem-1',
    isProductDoc: false,
    row: { id: 'doc-1', workspace_id: 'ws-1', created_by: 'mem-9', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, status: 'active' },
  }
}

function db(opts: { revisions: ReturnType<typeof ROW>[]; doc?: Record<string, unknown> | null; updateRows?: unknown[] }) {
  return createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'document_revision') {
      const lte = q.filters.find((f) => f[0] === 'lte')?.[2] as number | undefined
      const rows = [...opts.revisions].sort((a, b) => b.revision_number - a.revision_number).filter((r) => lte === undefined || r.revision_number <= lte)
      return { data: rows, error: null }
    }
    if (q.table === 'document' && q.op === 'select') return { data: opts.doc === undefined ? { title: 'Plan', content: 'Now.', revision: 5, project_id: null } : opts.doc, error: null }
    if (q.table === 'document' && q.op === 'update') return { data: opts.updateRows ?? [{ id: 'doc-1', title: 'Plan', content: (q.payload as { content: string }).content, revision: 6 }], error: null }
    return { data: null, error: null }
  })
}

describe('listDocumentRevisions / getDocumentRevision', () => {
  it('lists newest first, scoped to the workspace, with the author named', async () => {
    const fake = db({ revisions: [ROW(4, 'a'), ROW(5, 'b')] })
    const { revisions } = await listDocumentRevisions(fake.client, 'doc-1', 'ws-1', { limit: 500, before: 9 })
    expect(revisions.map((r) => r.revision_number)).toEqual([5, 4])
    expect(revisions[0]).toMatchObject({ author_kind: 'agent', author_name: 'Ana', change_summary: 'Change 5' })
    const q = fake.log[0]
    expect(q.filters).toContainEqual(['eq', 'workspace_id', 'ws-1'])
    expect(q.filters).toContainEqual(['limit', 100])
    expect(q.filters).toContainEqual(['lt', 'revision_number', 9])
    // The list never reads the text.
    expect(q.columns).not.toMatch(/content/)
  })

  it('reads one revision with the one before it', async () => {
    const { revision, previous } = await getDocumentRevision(db({ revisions: [ROW(2, 'two'), ROW(4, 'four'), ROW(5, 'five')] }).client, 'doc-1', 'ws-1', 4)
    expect(revision?.content).toBe('four')
    expect(previous?.revision_number).toBe(2)
  })

  it('a number not in the history is null (a later autosave folded it in)', async () => {
    const { revision } = await getDocumentRevision(db({ revisions: [ROW(2, 'two'), ROW(5, 'five')] }).client, 'doc-1', 'ws-1', 4)
    expect(revision).toBeNull()
  })
})

describe('restoreDocumentRevision', () => {
  const args = { documentId: 'doc-1', workspaceId: 'ws-1', userId: 'user-1', revisionNumber: 4, source: 'human' as const }

  it('writes the old title and body as a new revision, conditional on the one being looked at', async () => {
    const fake = db({ revisions: [ROW(4, 'Old text.', { title: 'Plan v1' }), ROW(5, 'Now.')] })
    const r = await restoreDocumentRevision(fake.client, { ...args, access: access(), baseRevision: 5 })
    expect(r).toMatchObject({ ok: true, revision: 6, restoredFrom: 4, content: 'Old text.' })
    const update = fake.log.find((q) => q.op === 'update')!
    expect(update.payload).toMatchObject({ content: 'Old text.', title: 'Plan v1', edit_source: 'human', edit_summary: 'Restored revision 4', last_edited_by: 'mem-1' })
    expect(update.filters).toContainEqual(['eq', 'revision', 5])
  })

  it('the document moved on since the person looked: a conflict, nothing written', async () => {
    const fake = db({ revisions: [ROW(4, 'Old.'), ROW(5, 'Now.')] })
    const r = await restoreDocumentRevision(fake.client, { ...args, access: access(), baseRevision: 3 })
    expect(r).toEqual({ ok: false, reason: 'conflict', baseRevision: 3, currentRevision: 5 })
    expect(fake.log.filter((q) => q.op === 'update')).toHaveLength(0)
  })

  it('needs edit access', async () => {
    const fake = db({ revisions: [ROW(4, 'Old.')] })
    const r = await restoreDocumentRevision(fake.client, { ...args, access: access('member'), baseRevision: null })
    expect(r).toMatchObject({ ok: false, reason: 'refused' })
    expect(fake.log.filter((q) => q.op === 'update')).toHaveLength(0)
  })

  it('already that text: nothing written', async () => {
    const fake = db({ revisions: [ROW(4, 'Now.')] })
    const r = await restoreDocumentRevision(fake.client, { ...args, access: access(), baseRevision: null })
    expect(r).toMatchObject({ ok: true, unchanged: true, revision: 5 })
    expect(fake.log.filter((q) => q.op === 'update')).toHaveLength(0)
  })

  it('a revision not in the history, or a document gone', async () => {
    expect(await restoreDocumentRevision(db({ revisions: [] }).client, { ...args, access: access(), baseRevision: null })).toEqual({ ok: false, reason: 'revision_not_found' })
    expect(await restoreDocumentRevision(db({ revisions: [ROW(4, 'x')], doc: null }).client, { ...args, access: access(), baseRevision: null })).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('describeRevisionAuthor', () => {
  it('names who a change was for', () => {
    expect(describeRevisionAuthor({ author_kind: 'agent', author_name: 'Ana' })).toBe('Native Intelligence (for Ana)')
    expect(describeRevisionAuthor({ author_kind: 'human', author_name: 'Ana' })).toBe('Ana')
    expect(describeRevisionAuthor({ author_kind: 'system', author_name: null })).toBe('Native Intelligence (system)')
    expect(describeRevisionAuthor({ author_kind: null, author_name: 'Ana' })).toBe('Ana (before history)')
  })
})

describe('an applied agent edit in the history (decision 16: undo, not approve)', () => {
  it('carries its sources by kind and domain, and the outside label, never an address', async () => {
    const meta = {
      section: 'Positioning',
      op: 'append',
      reason: 'A competitor page says so',
      sources: [{ kind: 'capture', id: 'c1' }, { kind: 'web', url: 'https://www.gong.example/pricing' }, { kind: 'email', from: 'dana@northwind.example', domain: 'northwind.example' }],
      outside: 'a web page on gong.example',
    }
    const fake = db({ revisions: [ROW(5, 'b', { edit_meta: meta })] })
    const { revisions } = await listDocumentRevisions(fake.client, 'doc-1', 'ws-1')
    expect(revisions[0]).toMatchObject({ section: 'Positioning', outside: 'a web page on gong.example' })
    expect(JSON.stringify(revisions[0])).not.toContain('dana@')
    expect(describeRevisionSources(revisions[0].sources)).toBe('a call, a web page on gong.example and an email from northwind.example')
  })

  it('a person’s own edit has no label and no sources line', async () => {
    const fake = db({ revisions: [ROW(5, 'b', { author_kind: 'human' })] })
    const { revisions } = await listDocumentRevisions(fake.client, 'doc-1', 'ws-1')
    expect(revisions[0]).not.toHaveProperty('outside')
    expect(describeRevisionSources(revisions[0].sources)).toBeNull()
  })
})
