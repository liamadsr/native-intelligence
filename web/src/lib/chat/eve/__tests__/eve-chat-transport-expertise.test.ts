// @vitest-environment jsdom
/**
 * An expertise pack is the model's alone (one-agent plan, Part 3). The
 * chat-agent attaches it to a tool's output under `__expertise` for its
 * toModelOutput, but eve still sends the full output on action.result, so the
 * transport must drop it before the part is drawn or persisted.
 */
import { Chat } from '@ai-sdk/react'
import type { HandleMessageStreamEvent } from 'eve/client'
import { describe, expect, it, vi } from 'vitest'
import { EveChatTransport } from '../eve-chat-transport'
import { stripModelOnlyToolFields } from '../tool-output-truncation'

const event = (type: string, data: object): HandleMessageStreamEvent => ({ type, data }) as HandleMessageStreamEvent
const requested = (callId: string, toolName: string) =>
  event('actions.requested', { actions: [{ kind: 'tool-call', callId, toolName, input: { query: 'email draft' } }] })
const result = (callId: string, toolName: string, output: unknown) =>
  event('action.result', { result: { kind: 'tool-result', callId, toolName, output, isError: false } })

function harness(events: HandleMessageStreamEvent[]) {
  const persist = vi.fn(async (..._args: unknown[]) => {})
  const response = {
    sessionId: 'wrun-expertise',
    async *[Symbol.asyncIterator]() {
      for (const item of events) yield item
    },
  }
  const session = {
    state: { sessionId: response.sessionId, streamIndex: 0 },
    send: vi.fn(async () => response),
    cancel: vi.fn(async () => ({ status: 'accepted' })),
  }
  const transport = new EveChatTransport({
    getAccessToken: () => 'synthetic-token',
    mintRunToken: async () => ({ token: 'synthetic.run-token', conversationId: 'synthetic-conversation' }),
    registerEveSession: async () => {},
    // The send-time user-message write (onSend) is not this turn's reply.
    persistTurn: async (args) => { if (!args.body.onSend) await persist(args) },
    createClient: () => ({ sessions: { create: async () => ({ session, response }), attach: () => session } }) as never,
  })
  const chat = new Chat({ id: 'synthetic-chat', transport, sendAutomaticallyWhen: () => false })
  const send = () => chat.sendMessage({ text: 'Draft a reply' }, { body: { conversationId: 'synthetic-conversation' } })
  return { chat, send, persist }
}

describe('the chat transport keeps expertise packs out of the UI', () => {
  it('drops __expertise from the drawn part and from what is persisted', async () => {
    const pack = [{ area: 'mail', text: '<expertise area="mail">\n# Mail\nSECRET-ISH PLAYBOOK\n</expertise>' }]
    const discovered = { tools: [{ name: 'create_email_draft', description: 'Draft an email' }], hint: 'available' }
    const { chat, send, persist } = harness([
      requested('search-1', 'search_tools'),
      result('search-1', 'search_tools', { ...discovered, __expertise: pack }),
      event('turn.completed', {}),
    ])
    await send()
    const tool = chat.messages.at(-1)!.parts.find((part) => part.type === 'dynamic-tool')
    expect(tool).toMatchObject({ toolCallId: 'search-1', state: 'output-available', output: discovered })
    expect(JSON.stringify(chat.messages)).not.toContain('PLAYBOOK')
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    expect(JSON.stringify(persist.mock.calls)).not.toContain('__expertise')
    expect(JSON.stringify(persist.mock.calls)).not.toContain('PLAYBOOK')
  })

  it('leaves an output without model-only fields untouched (same reference)', () => {
    const output = { ok: true }
    expect(stripModelOnlyToolFields(output)).toBe(output)
    expect(stripModelOnlyToolFields('text')).toBe('text')
    expect(stripModelOnlyToolFields([1])).toEqual([1])
    expect(stripModelOnlyToolFields({ ok: true, __expertise: [] })).toEqual({ ok: true })
  })
})
