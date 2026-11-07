/**
 * A document's meeting-prep stamp (`frontmatter.meeting_prep`) is the
 * server's alone (prep-doc.ts markPrepDocuments): the chat and MCP document
 * tools that write frontmatter (propose_document_edit's draft, publish_draft)
 * never set or drop it (prep-ref.ts withServerFrontmatter), so a teammate
 * can't make a document read as someone's prep.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const REAL = { startIso: '2026-10-18T15:00:00.000Z', calendarEventId: 'evt-1', meetingKey: 'a'.repeat(40), userId: USER }
const FORGED = { ...REAL, userId: 'victim-9' }

function db(stored: Record<string, unknown>, draftFrontmatter: unknown) {
  return createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.op !== 'select') return { data: q.table === 'document_draft' ? { document_id: DOC } : { id: DOC, title: 'T' }, error: null }
    if (q.table === 'document') return { data: { id: DOC, workspace_id: WS, title: 'T', content: 'c', content_json: null, frontmatter: stored, tags: [], revision: 2 }, error: null }
    if (q.table === 'member') return { data: { id: 'mem-1', role: 'owner', workspace_id: WS, user_id: USER }, error: null }
    if (q.table === 'document_draft') return { data: { title: 'T2', content: 'c2', content_json: null, frontmatter: draftFrontmatter, tags: null, base_revision: 2 }, error: null }
    if (q.table === 'document_revision') return { data: null, error: null }
    return { data: null, error: null }
  })
}

const payload = (fake: ReturnType<typeof db>, table: string, op: string) =>
  fake.log.find((q) => q.table === table && q.op === op)?.payload as Record<string, unknown> | undefined

describe('document tools never write a meeting-prep stamp', () => {
  it('propose_document_edit: a forged stamp in the draft is dropped', async () => {
    const fake = db({}, null)
    const tools = createDocumentTools(USER, fake.client, WS)
    const result = (await tools.propose_document_edit.execute!({ document_id: DOC, base_revision: 2, frontmatter: { area: 'x', meeting_prep: FORGED } }, OPTS)) as { success: boolean }
    expect(result.success).toBe(true)
    expect(payload(fake, 'document_draft', 'upsert')?.frontmatter).toEqual({ area: 'x' })
  })

  it('publish_draft: the published document keeps its own stamp, whatever the draft holds', async () => {
    const fake = db({ meeting_prep: REAL }, { area: 'y', meeting_prep: FORGED })
    const tools = createDocumentTools(USER, fake.client, WS)
    await tools.publish_draft.execute!({ document_id: DOC }, OPTS)
    expect(payload(fake, 'document', 'update')?.frontmatter).toEqual({ area: 'y', meeting_prep: REAL })
  })
})
