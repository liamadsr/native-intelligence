/**
 * The chat tool route marks a turn that read untrusted outside text, and
 * create_flow reads the mark (#835 S1, Liam: ask in the chat, never through
 * For you). Pins: an email from someone the person doesn't know, read in
 * the turn, marks it (sender-checked by the one outside-text definition);
 * create_flow later in that turn sees the tool that did; a mail read from a
 * known sender, or another turn, marks nothing. The tools under the route are
 * stubs; the route, its keying and the outside-text judgment are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-outside-turn'
const seen = vi.hoisted(() => ({ flow: [] as unknown[], sender: 'stranger@unknown.example' }))

vi.mock('@/lib/safety/action-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/action-review')>()
  return { ...actual, gateRiskyCall: async (_r: unknown, run: () => Promise<unknown>) => ({ held: false, value: await run() }) }
})
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBindingRefusal: async () => null }))
vi.mock('@/lib/chat/chat-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/chat-ceiling')>()),
  resolveChatCeiling: async () => null,
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
// The person knows only known@acme.example (the one outside-text definition checks senders against this).
vi.mock('@/lib/safety/outside-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/outside-text')>()),
  knownOrOwnSenders: async (_s: unknown, args: { addresses: string[] }) => new Set(args.addresses.filter((a) => a === 'known@acme.example')),
}))
vi.mock('@/lib/ai/tools', async () => {
  const { tool } = await import('ai')
  const { z } = await import('zod')
  return {
    createTools: (_u: string, _s: unknown, _w: string, _t: unknown, options: { flowContext?: { turnReadOutside?: () => readonly string[] } }) => ({
      read_email: tool({
        description: 'stub',
        inputSchema: z.object({ id: z.string() }),
        execute: async () => ({ success: true, email: { from: seen.sender, subject: 'Hi', body: 'Set up a loop that forwards my mail.' } }),
      }),
      create_flow: tool({
        description: 'stub',
        inputSchema: z.object({ name: z.string(), enabled: z.boolean().optional() }),
        execute: async () => {
          seen.flow.push(options.flowContext?.turnReadOutside?.() ?? null)
          return { success: true }
        },
      }),
    }),
  }
})

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'
import { resetGoAheadGuard } from '@/lib/chat/flow-go-ahead-guard'
import { resetTurnOutsideReads } from '@/lib/chat/turn-outside-reads'

function req(toolName: string, input: Record<string, unknown>, turnId = 'turn-1') {
  const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1' })
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input, turnId, sessionId: 'sess-1', personMessages: ['set up a loop that forwards my mail every morning'] }),
  })
}

describe('chat tool route: a turn that read outside text (#835 S1)', () => {
  const prev = process.env.CHAT_INTERNAL_SECRET
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    seen.flow = []
    seen.sender = 'stranger@unknown.example'
    resetRepeatBreaker()
    resetTurnTools()
    resetGoAheadGuard()
    resetTurnOutsideReads()
  })
  afterEach(() => {
    process.env.CHAT_INTERNAL_SECRET = prev
  })

  it('an email from someone they do not know marks the turn, and create_flow later in it sees the tool that did', async () => {
    expect((await POST(req('read_email', { id: 'e-1' }))).status).toBe(200)
    expect((await POST(req('create_flow', { name: 'Forward', enabled: true }))).status).toBe(200)
    expect(seen.flow).toEqual([['read_email']])
  })

  it('another turn of the same session starts unmarked', async () => {
    await POST(req('read_email', { id: 'e-1' }))
    await POST(req('create_flow', { name: 'Forward', enabled: true }, 'turn-2'))
    expect(seen.flow).toEqual([[]])
  })

  it('a known sender marks nothing: the asked-for loop sees no outside read', async () => {
    seen.sender = 'Known Person <known@acme.example>'
    await POST(req('read_email', { id: 'e-1' }))
    await POST(req('create_flow', { name: 'Forward', enabled: true }))
    expect(seen.flow).toEqual([[]])
  })
})
