/**
 * The chat tool route and a canon edit's provenance (review R1, decision 16
 * as apply with undo): a turn nobody asked for (a home turn the server
 * started, a turn relayed into a bot's thread) is unattended, and with no run
 * to check, its canon edit applies labelled as resting on outside text (fail
 * closed). The person's own chat applies it with no label. Neither raises a
 * card. The route hands the real canon tool the caller-derived context; the
 * document reads and writes underneath are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-canon'
const canon = vi.hoisted(() => ({ contexts: [] as unknown[], applied: [] as Array<Record<string, unknown>> }))

vi.mock('@/lib/safety/action-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/action-review')>()
  return { ...actual, gateRiskyCall: async (_r: unknown, run: () => Promise<unknown>) => ({ held: false, value: await run() }) }
})
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBindingRefusal: async () => null }))
vi.mock('@/lib/chat/chat-ceiling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/chat-ceiling')>()
  return {
    ...actual,
    resolveChatCeiling: async () => null,
    resolveTeammateChatBounds: async () => ({}),
    resolveTeammateChatCeiling: async () => new Set(['propose_section_edit']),
  }
})
vi.mock('@/lib/chat/follow-through', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/follow-through')>()),
  resolveFollowThrough: async () => new Set<string>(),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'limit', 'order']) c[m] = () => c
      c.maybeSingle = async () => ({ data: table === 'workspace' ? { settings: null } : { agent_config: null }, error: null })
      c.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return c
    }
    return { from: (table: string) => chain(table) }
  },
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined) }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }) }))
// The canon document and the writes under the tool: stubbed; the label is the real one.
vi.mock('@/lib/documents/canon-doc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-doc')>()),
  resolveCanonDocument: async () => ({ ok: true, memberId: 'm1', viaPointer: false, doc: { id: 'doc-1', title: 'Product', content: '## Positioning\nVs spreadsheets.\n', revision: 3, created_by: 'm1', canon_key: 'product' } }),
}))
vi.mock('@/lib/documents/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/access')>()),
  loadDocumentAccess: async () => ({ access: { role: 'owner', memberId: 'm1', isProductDoc: true, row: { id: 'doc-1', created_by: 'm1', type: 'note', published_status: 'published', canon_key: 'product', visibility: 'workspace' } }, error: null }),
}))
vi.mock('@/lib/documents/canon-edit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-edit')>()),
  applyCanonSectionEdit: async (_s: unknown, args: Record<string, unknown>) => (canon.applied.push(args), { ok: true, documentId: 'doc-1', revision: 4, section: 'Positioning', before: '', after: '', rebased: false, title: 'Product' }),
}))
vi.mock('@/lib/ai/tools', async () => {
  const { createCanonTools } = await import('@/lib/ai/tools/canon')
  return {
    createTools: (userId: string, supabase: unknown, workspaceId: string, _token: unknown, options: { canonContext?: { attended: boolean; outsideReadsRunId?: string | null } }) => {
      canon.contexts.push(options.canonContext)
      return createCanonTools(userId, supabase as never, workspaceId, options.canonContext ?? { attended: true })
    },
  }
})

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, type ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'

type Extra = Partial<Omit<ChatRunTokenClaims, 'exp' | 'conversationId' | 'workspaceId' | 'userId'>>

function req(extra: Extra) {
  const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', ...extra })
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({
      toolName: 'propose_section_edit',
      input: { key: 'product', section: 'Positioning', op: 'append', text: 'Cheaper than Gong.', reason: 'Seen in mail' },
      turnId: 'turn-1',
      sessionId: 'sess-1',
      personMessages: ['hi'],
    }),
  })
}

describe('chat tool route: a canon edit’s label follows the caller class (R1)', () => {
  const prev = process.env.CHAT_INTERNAL_SECRET
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    canon.contexts = []
    canon.applied = []
    resetRepeatBreaker()
    resetTurnTools()
  })
  afterEach(() => {
    process.env.CHAT_INTERNAL_SECRET = prev
  })

  it('a home turn the server started acts on its own: its canon edit applies, labelled unattended (nobody was watching)', async () => {
    const res = await POST(req({ server: 'home_turn', homeTurnReason: 'event' }))
    expect(res.status).toBe(200)
    expect(canon.contexts[0]).toMatchObject({ attended: false })
  })

  it("a turn relayed into a bot's thread is unattended: its canon edit applies, labelled as resting on outside text", async () => {
    const res = await POST(req({ teammateId: 'bot-1', relay: 'relay-1' }))
    const body = (await res.json()) as { output?: Record<string, unknown> }
    expect(canon.contexts[0]).toEqual({ attended: false, outsideReadsRunId: null })
    expect(body.output).toMatchObject({ success: true, revision: 4, outside: 'outside text' })
    expect(body.output).not.toHaveProperty('held')
    expect(canon.applied).toHaveLength(1)
    expect(canon.applied[0]).toMatchObject({ outside: 'outside text' })
  })

  it('a relay token outside a bot thread never applies one either', async () => {
    const res = await POST(req({ relay: 'relay-1' }))
    expect(res.status).not.toBe(200)
    expect(canon.applied).toHaveLength(0)
  })

  it("the person's own chat applies it", async () => {
    const res = await POST(req({}))
    const body = (await res.json()) as { output?: Record<string, unknown> }
    expect(canon.contexts[0]).toEqual({ attended: true, outsideReadsRunId: null })
    expect(body.output).toMatchObject({ success: true, revision: 4 })
    expect(canon.applied).toHaveLength(1)
    expect(canon.applied[0].outside).toBeNull()
  })
})
