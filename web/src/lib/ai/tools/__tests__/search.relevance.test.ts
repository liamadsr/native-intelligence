import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { RetrievalRelevanceInput } from '@/lib/ai/decisions/tasks/retrieval-relevance'

const mocks = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/ai/gemini-embeddings', () => ({ embedQuery: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/email/email-search-service', () => ({ searchEmails: vi.fn(async () => ({ results: [] })) }))
vi.mock('@/lib/email/email-context-service', () => ({ searchEmailsWithContext: vi.fn(async () => []) }))
import { createSearchTools } from '../search'

const options = { toolCallId: 'search', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const text = 'The quarterly pricing review explains how hosting costs changed.'
const capture = (id: string, similarity = 0.9) => ({ capture_id: id, capture_title: id, chunk_text: `${text} ${id}`, similarity })
const accepted = (irrelevantIds: string[]) => ({ status: 'accepted', value: { irrelevantIds }, inferenceId: 'id', version: 'v1' })

function client(args: {
  rows?: Record<string, unknown[]>
  byWorkspace?: Record<string, unknown[]>
  workspaces?: string[]
  visible?: string[]
} = {}) {
  const rpc = vi.fn(async (name: string, params: { p_workspace_id?: string }) => ({
    data: (name === 'rag_search' && args.byWorkspace ? args.byWorkspace[params.p_workspace_id ?? ''] : args.rows?.[name]) ?? [], error: null,
  }))
  const from = vi.fn((table: string) => {
    const data = table === 'member' ? (args.workspaces ?? ['ws']).map(id => ({ workspace: { id, name: id } })) :
      table === 'captures' ? (args.visible ?? []).map(id => ({ id })) : []
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      maybeSingle: async () => ({ data: null, error: null }),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, { get(target, key: string) {
      return key in target ? target[key] : () => proxy
    } })
    return proxy
  })
  return { rpc, from, storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.invalid/private' } }) }) } }
}

async function deep(db: ReturnType<typeof client>, args: Record<string, unknown> = {}, omitPrivate = false) {
  const tool = createSearchTools('user', db as never, 'ws', omitPrivate).deep_search
  const parsed = (tool.inputSchema as unknown as { parse(value: unknown): never }).parse({ query: 'Why did pricing change?', types: ['captures'], ...args })
  return await tool.execute!(parsed, options) as {
    captures: Array<Record<string, unknown>>; attachments: Array<Record<string, unknown>>; claims: Array<Record<string, unknown>>
    count: number; searchMeta: { irrelevantPassagesRemoved?: number }
  }
}

beforeEach(() => { mocks.decide.mockReset().mockResolvedValue({ status: 'escalate', reason: 'uncertain' }) })

describe('deep_search relevance integration', () => {
  it('removes only accepted negatives after ranking and keeps unexamined results in order', async () => {
    mocks.decide.mockResolvedValueOnce(accepted(['0:1']))
    const result = await deep(client({ rows: { rag_search: [capture('third', 0.3), capture('first', 0.9), capture('second', 0.6)] } }))
    expect(result.captures.map(row => row.capture_id)).toEqual(['first', 'third'])
    expect(result.count).toBe(2)
    expect(result.searchMeta.irrelevantPassagesRemoved).toBe(1)
  })

  it('never sends private capture passages to the classifier', async () => {
    const result = await deep(client({ rows: { rag_search: [capture('private'), capture('visible')] }, visible: ['visible'] }), {}, true)
    expect(result.captures.map(row => row.capture_id)).toEqual(['visible'])
    expect(mocks.decide.mock.calls[0][1].passages.map((p: { title: string }) => p.title)).toEqual(['visible'])
  })

  it('classifies cross-workspace passages under their own membership and preserves tags', async () => {
    mocks.decide.mockImplementation(async (_kind: string, input: RetrievalRelevanceInput, ctx: { workspaceId: string }) =>
      accepted(ctx.workspaceId === 'other' ? input.passages.map(p => p.id) : []))
    const result = await deep(client({ workspaces: ['ws', 'other'], byWorkspace: { ws: [capture('home')], other: [capture('away')] } }), { cross_workspace: true })
    expect(mocks.decide.mock.calls.map(call => call[2].workspaceId)).toEqual(['ws', 'other'])
    expect(result.captures).toMatchObject([{ capture_id: 'home', workspace_id: 'ws', workspace_name: 'ws' }])
    expect(result.count).toBe(1)
  })

  it('may remove all complete irrelevant passages without inventing a retained top hit', async () => {
    mocks.decide.mockImplementation(async (_kind: string, input: RetrievalRelevanceInput) => accepted(input.passages.map(p => p.id)))
    const result = await deep(client({ rows: { rag_search: [capture('irrelevant')] } }))
    expect(result.captures).toEqual([])
    expect(result.count).toBe(0)
    expect(result.searchMeta.irrelevantPassagesRemoved).toBe(1)
  })

  it('retains missing text and multimodal previews, and never sends signed links', async () => {
    mocks.decide.mockImplementation(async (_kind: string, input: RetrievalRelevanceInput) => accepted(input.passages.map(p => p.id)))
    const attachment = { attachment_id: 'file', file_name: 'Pricing graph', chunk_type: 'image', chunk_text: text, similarity: 0.8, storage_path: 'secret/path' }
    const result = await deep(client({ rows: {
      rag_search: [{ ...capture('empty'), chunk_text: null }, capture('complete')],
      attachment_rag_search: [attachment, { ...attachment, attachment_id: 'text-file', chunk_type: 'text' }],
      match_claims: [{ claim_id: 'claim', claim_text: text, similarity: 0.8 }],
    } }), { types: ['captures', 'attachments', 'claims'] })
    expect(result.captures.map(row => row.capture_id)).toEqual(['empty'])
    expect(result.attachments.map(row => row.attachment_id)).toEqual(['file'])
    expect(result.claims).toEqual([])
    expect(result.count).toBe(2)
    const sent = JSON.stringify(mocks.decide.mock.calls)
    expect(sent).not.toContain('https://signed.invalid')
    expect(sent).not.toContain('secret/path')
  })

  it('preserves all retrieved evidence when the decision service fails', async () => {
    mocks.decide.mockRejectedValue(new Error('provider unavailable'))
    const result = await deep(client({ rows: { rag_search: [capture('first'), capture('second')] } }))
    expect(result.captures.map(row => row.capture_id)).toEqual(['first', 'second'])
    expect(result.count).toBe(2)
    expect(result.searchMeta).not.toHaveProperty('irrelevantPassagesRemoved')
  })

  it('leaves keyword search and hybrid find unchanged without any classifier call', async () => {
    const db = client()
    const tools = createSearchTools('user', db as never, 'ws')
    for (const tool of [tools.search, tools.find]) {
      const parsed = (tool.inputSchema as unknown as { parse(value: unknown): never }).parse({ query: 'Pricing', types: ['capture'] })
      await tool.execute!(parsed, options)
    }
    expect(mocks.decide).not.toHaveBeenCalled()
  })
})
