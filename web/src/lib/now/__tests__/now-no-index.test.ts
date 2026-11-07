/**
 * The person's Now file is never embedded and changes through the agent only
 * by update_now (migration 440). The person's own restore and revert, from the
 * history panel, still write it, but nothing re-indexes it; the agent's
 * revert_section_edit refuses it. An ordinary document is re-indexed as
 * before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const hoisted = vi.hoisted(() => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 1 })) }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: hoisted.indexDocument }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  appendLogLine: vi.fn(async () => ({ ok: true })),
}))

import { restoreDocumentRevision } from '@/lib/documents/revision'
import { revertSectionEdit } from '@/lib/documents/canon-edit'
import type { DocumentAccess } from '@/lib/documents/access'
import { NOW_EDIT_REFUSAL } from '../now-stamp'

const WS = 'ws-1'
const DOC = 'doc-1'
const BEFORE = '## Focus\n- Guest access (Oct 24)'
const EDITED = '## Focus\n- Guest access is live (Oct 26)'

function store(frontmatter: Record<string, unknown>) {
  const writes: FakeQuery[] = []
  const fake = createFakeSupabase((q): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: 'member', workspace: { settings: {} } }, error: null }
    if (q.table === 'document_revision') {
      const upTo = (q.filters.find(([m, c]) => m === 'lte' && c === 'revision_number')?.[2] as number | undefined) ?? Infinity
      const rows = [
        { revision_number: 3, title: 'Now', content: EDITED, frontmatter, edit_meta: { writer: 'chat' }, created_at: 't', updated_at: 't' },
        { revision_number: 2, title: 'Now', content: BEFORE, frontmatter, edit_meta: null, created_at: 't', updated_at: 't' },
      ]
      return { data: rows.filter((r) => r.revision_number <= upTo), error: null }
    }
    if (q.table === 'document' && q.op === 'update') {
      writes.push(q)
      return { data: [{ id: DOC, title: 'Now', content: (q.payload as { content: string }).content, revision: 4 }], error: null }
    }
    if (q.table === 'document') {
      return {
        data: { id: DOC, workspace_id: WS, created_by: 'mem-1', type: 'note', slug: null, published_status: 'published', frontmatter, project_id: null, status: 'active', canon_key: null, visibility: 'private', title: 'Now', content: EDITED, revision: 3 },
        error: null,
      }
    }
    return { data: null, error: null }
  })
  return { client: fake.client, writes }
}

const access = (frontmatter: Record<string, unknown>): DocumentAccess => ({
  role: 'member',
  memberId: 'mem-1',
  isProductDoc: false,
  row: { id: DOC, workspace_id: WS, created_by: 'mem-1', type: 'note', slug: null, published_status: 'published', frontmatter, project_id: null, status: 'active', canon_key: null, visibility: 'private' },
})

beforeEach(() => hoisted.indexDocument.mockClear())

describe('restoring a version', () => {
  it('writes the person’s Now file back without re-indexing it', async () => {
    const s = store({ now: { tracks: [] } })
    const r = await restoreDocumentRevision(s.client, { documentId: DOC, workspaceId: WS, access: access({ now: { tracks: [] } }), userId: 'u-1', revisionNumber: 2, baseRevision: 3, source: 'human' })
    expect(r).toMatchObject({ ok: true })
    expect(s.writes).toHaveLength(1)
    expect(hoisted.indexDocument).not.toHaveBeenCalled()
  })

  it('re-indexes an ordinary document as before', async () => {
    const s = store({})
    await restoreDocumentRevision(s.client, { documentId: DOC, workspaceId: WS, access: access({}), userId: 'u-1', revisionNumber: 2, baseRevision: 3, source: 'human' })
    expect(hoisted.indexDocument).toHaveBeenCalledTimes(1)
  })
})

describe('undoing one edit', () => {
  it('the agent may not revert an edit of the Now file: update_now is the way', async () => {
    const s = store({ now: { tracks: [] } })
    const r = await revertSectionEdit(s.client, { workspaceId: WS, userId: 'u-1', documentId: DOC, revision: 3 })
    expect(r).toMatchObject({ ok: false, reason: 'refused', error: NOW_EDIT_REFUSAL })
    expect(s.writes).toHaveLength(0)
  })

  it('the person may, and nothing re-indexes it', async () => {
    const s = store({ now: { tracks: [] } })
    const r = await revertSectionEdit(s.client, { workspaceId: WS, userId: 'u-1', documentId: DOC, revision: 3, source: 'human' })
    expect(r).toMatchObject({ ok: true, section: 'Focus' })
    expect((s.writes[0].payload as { content: string }).content).toBe(BEFORE)
    expect(hoisted.indexDocument).not.toHaveBeenCalled()
  })
})
