/**
 * The internal chat routes with a guest's token (guest access): the spec
 * route builds the guest's own spec (never the owner's rebuild) and answers
 * 403 for a guest who is gone; the tool route hands every call to the guest
 * branch before any of the owner's ceilings, external tools or chat-native
 * tools are consulted; the memory route refuses the token outright.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'test-chat-internal-secret-guest-routes'
const h = vi.hoisted(() => ({
  rebuild: vi.fn(async () => ({ systemPrompt: 'owner', model: 'm', ceiling: null, ceilingTools: [], coreToolNames: [] })),
  rebuildGuest: vi.fn(async () => ({ systemPrompt: 'guest', model: 'm', ceiling: ['get_free_busy'], ceilingTools: [], coreToolNames: ['get_free_busy'] })),
  guestToolCall: vi.fn(async () => new Response(JSON.stringify({ output: { guest: true } }))),
  createTools: vi.fn(() => ({})),
  answer: vi.fn(async () => ({ success: true, texted: true })),
}))

vi.mock('@/lib/chat/chat-run-rebuild', () => ({ rebuildChatSpec: h.rebuild }))
vi.mock('@/lib/guests/guest-spec', async (orig) => ({ ...(await orig<typeof import('@/lib/guests/guest-spec')>()), rebuildGuestChatSpec: h.rebuildGuest }))
vi.mock('@/lib/guests/guest-tools', () => ({ guestToolCall: h.guestToolCall }))
vi.mock('@/lib/guests/guest-asks', () => ({ answerGuestAsk: h.answer }))
vi.mock('@/lib/ai/tools', () => ({ createTools: h.createTools }))
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBindingRefusal: async () => null }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: vi.fn(async () => ({ tools: {}, meta: new Map(), servers: [] })) }))

import { GET as specGET } from '@/app/api/internal/chat/spec/route'
import { POST as toolPOST } from '@/app/api/internal/chat/tool/route'
import { GuestTurnRefused } from '@/lib/guests/guest-spec'
import { CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, mintChatRunToken } from '@/lib/chat/chat-run-token'

const GUEST = '22222222-2222-4222-8222-222222222222'
const token = () => mintChatRunToken({ conversationId: 'conv-g', workspaceId: 'ws-1', userId: 'owner-1', server: 'channel_turn', surface: 'sms', guestId: GUEST })
const headers = () => ({ 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token() })

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  vi.clearAllMocks()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('spec route', () => {
  it("builds the guest's own spec, never the owner's", async () => {
    const res = await specGET(new Request('http://localhost/api/internal/chat/spec?schemas=1&turnContext=1', { headers: headers() }))
    expect(res.status).toBe(200)
    expect((await res.json()).systemPrompt).toBe('guest')
    expect(h.rebuild).not.toHaveBeenCalled()
    expect(h.rebuildGuest).toHaveBeenCalledWith(expect.objectContaining({ guestId: GUEST }), { includeSchemas: true, splitTurnContext: true })
  })

  it('a guest who is gone: 403', async () => {
    h.rebuildGuest.mockRejectedValueOnce(new GuestTurnRefused())
    const res = await specGET(new Request('http://localhost/api/internal/chat/spec', { headers: headers() }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('GUEST_UNAVAILABLE')
  })
})

describe('tool route', () => {
  const call = (toolName: string) =>
    toolPOST(new Request('http://localhost/api/internal/chat/tool', { method: 'POST', headers: headers(), body: JSON.stringify({ toolName, input: {}, turnId: 't', sessionId: 's' }) }))

  it('every call goes to the guest branch, before the owner’s tools are ever built', async () => {
    for (const tool of ['get_free_busy', 'list_emails', 'remember', 'search_tools']) {
      const res = await call(tool)
      expect((await res.json()).output).toEqual({ guest: true })
    }
    expect(h.guestToolCall).toHaveBeenCalledTimes(4)
    expect(h.createTools).not.toHaveBeenCalled()
  })

  it('the chat-native relay and helpers are refused before even that', async () => {
    for (const tool of ['send_bot_message', 'start_helper', 'start_local_agent']) {
      const res = await call(tool)
      expect(res.status, tool).toBe(403)
    }
    expect(h.guestToolCall).not.toHaveBeenCalled()
  })
})

describe('answer_guest (the owner\'s agent answers a guest\'s ask)', () => {
  const ASK = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'
  const post = (claims: Record<string, unknown>, input: unknown = { ask_id: ASK, answer: 'After 6.' }) =>
    toolPOST(
      new Request('http://localhost/api/internal/chat/tool', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: mintChatRunToken({ conversationId: 'home-1', workspaceId: 'ws-1', userId: 'owner-1', ...claims } as never) },
        body: JSON.stringify({ toolName: 'answer_guest', input, callId: 'c', turnId: 't', sessionId: 's' }),
      }),
    )

  it("a home turn answers one of the token owner's asks", async () => {
    const res = await post({ server: 'home_turn' })
    expect((await res.json()).output).toEqual({ success: true, texted: true })
    expect(h.answer).toHaveBeenCalledWith(expect.anything(), { userId: 'owner-1', workspaceId: 'ws-1' }, { ask_id: ASK, answer: 'After 6.' })
  })

  it('a bad input is refused before anything runs', async () => {
    const res = await post({ server: 'home_turn' }, { ask_id: 'nope', answer: 'x' })
    expect(res.status).toBe(400)
    expect(h.answer).not.toHaveBeenCalled()
  })

  it("never a bot's, a surface's or a guest's", async () => {
    for (const claims of [{ teammateId: 'tm-1' }, { surface: 'device_ask' }, { server: 'channel_turn', surface: 'sms', guestId: GUEST }]) {
      const res = await post(claims)
      if (!('guestId' in claims)) expect(res.status, JSON.stringify(claims)).toBe(403)
    }
    expect(h.answer).not.toHaveBeenCalled()
  })
})
