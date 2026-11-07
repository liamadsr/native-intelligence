/**
 * list_documents leaves skill and loop reports and meeting preps out unless
 * asked (documents phase 1, item 7, document.kind from migration 367), and
 * each row says its kind.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'

const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

function list(args: Record<string, unknown>) {
  const fake = createFakeSupabase((q: FakeQuery): FakeResult =>
    q.table === 'document' ? { data: [{ id: 'd-1', workspace_id: 'ws-1', title: 'Plan', kind: 'doc', status: 'active', project: null, author: null }], error: null } : { data: null, error: null },
  )
  const run = createDocumentTools('user-1', fake.client, 'ws-1').list_documents.execute!({ limit: 20, ...args } as never, OPTS) as Promise<unknown>
  return run.then((r) => ({ r: r as Record<string, unknown>, q: fake.log.find((x) => x.table === 'document')! }))
}

describe('list_documents and document kinds', () => {
  it('docs only by default, and says what it left out', async () => {
    const { r, q } = await list({})
    expect(q.filters).toContainEqual(['in', 'kind', ['doc']])
    expect(r.left_out).toBe('reports and meeting preps')
    expect((r.documents as Array<{ kind: string }>)[0].kind).toBe('doc')
  })

  it('reports and preps when asked', async () => {
    expect((await list({ include_reports: true })).q.filters).toContainEqual(['in', 'kind', ['doc', 'report']])
    const both = await list({ include_reports: true, include_preps: true })
    expect(both.q.filters).toContainEqual(['in', 'kind', ['doc', 'report', 'prep']])
    expect(both.r).not.toHaveProperty('left_out')
  })
})
