// @vitest-environment jsdom
import { Chat } from '@ai-sdk/react'
import type { HandleMessageStreamEvent } from 'eve/client'
import { describe, expect, it, vi } from 'vitest'
import { EveChatTransport } from '../eve-chat-transport'

const event = (type: string, data: object): HandleMessageStreamEvent => ({ type, data }) as HandleMessageStreamEvent
const requested = (callId: string, toolName = 'run_browser_task') => event('actions.requested', {
  actions: [{ kind: 'tool-call', callId, toolName, input: { goal: 'Find the requested route' } }],
})
const result = (callId: string, output: unknown, isError = false) => event('action.result', {
  result: { kind: 'tool-result', callId, toolName: 'run_browser_task', output, isError },
})

function harness(events: HandleMessageStreamEvent[], disconnect = false) {
  const persist = vi.fn(async (..._args: unknown[]) => {})
  const onError = vi.fn()
  const response = {
    sessionId: 'wrun-failed-tools',
    async *[Symbol.asyncIterator]() {
      for (const item of events) yield item
      if (disconnect) {
        // Model a connection loss after the live card reached the UI, rather
        // than an error that discards all queued chunks before initial render.
        await new Promise(resolve => setTimeout(resolve, 0))
        throw new TypeError('network disconnected')
      }
    },
  }
  const session = { state: { sessionId: response.sessionId, streamIndex: 0 },
    send: vi.fn(async () => response), cancel: vi.fn(async () => ({ status: 'accepted' })),
  }
  const transport = new EveChatTransport({
    getAccessToken: () => 'synthetic-token',
    mintRunToken: async () => ({ token: 'synthetic.run-token', conversationId: 'synthetic-conversation' }),
    registerEveSession: async () => {},
    // The send-time user-message write (onSend) is not this turn's reply.
    persistTurn: async (args) => { if (!args.body.onSend) await persist(args) },
    createClient: () => ({ sessions: { create: async () => ({ session, response }), attach: () => session } }) as never,
  })
  // The real AI SDK assembler must apply tool updates and still report an
  // error. Raw chunk assertions alone miss controller.error queue loss.
  const chat = new Chat({ id: 'synthetic-chat', transport, onError, sendAutomaticallyWhen: () => false })
  const send = () => chat.sendMessage({ text: 'Find flights with the browser' }, { body: { conversationId: 'synthetic-conversation' } })
  return { chat, send, persist, onError, session }
}

describe('Eve terminal failures settle client tool cards', () => {
  it.each(['turn.failed', 'step.failed', 'session.failed'])('settles three unreturned browser calls on %s in both UI and persistence', async type => {
    const failure = 'AI_MissingToolResultsError: Tool results are missing for 3 tool calls.'
    const { chat, send, persist, onError, session } = harness([
      requested('browser-1'), requested('browser-2'), requested('browser-3'),
      event(type, { code: 'MODEL_CALL_FAILED', message: failure }),
    ])
    await send()
    expect(chat.status).toBe('error')
    expect(onError).toHaveBeenCalledOnce()
    expect(chat.error?.message).toBe(type === 'session.failed' ? 'chat session failed' : failure)
    const tools = chat.messages.at(-1)!.parts.filter(part => part.type === 'dynamic-tool')
    expect(tools).toHaveLength(3)
    expect(tools.map(part => part.state)).toEqual(['output-error', 'output-error', 'output-error'])
    expect(tools.every(part => part.state === 'output-error' && part.errorText === 'No tool result was received before this chat run failed.')).toBe(true)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    const body = (persist.mock.calls[0] as unknown as [{ body: { parts: unknown[] } }])[0].body
    expect(body.parts).toEqual(tools)
    expect(session.cancel).not.toHaveBeenCalled()
  })

  it('preserves successful outputs, genuine background receipts, and already-reported tool errors', async () => {
    const backgroundReceipt = { status: 'working', taskId: 'real-background-task' }
    const { chat, send } = harness([
      requested('complete'), result('complete', { title: 'Results' }),
      requested('background', 'task'), result('background', backgroundReceipt),
      requested('tool-error'), result('tool-error', 'The site is unavailable.', true),
      requested('unreturned'), event('turn.failed', { code: 'MODEL_CALL_FAILED', message: 'parent failed' }),
    ])
    await send()
    const tools = chat.messages.at(-1)!.parts.filter(part => part.type === 'dynamic-tool')
    expect(tools).toMatchObject([
      { toolCallId: 'complete', state: 'output-available', output: { title: 'Results' } },
      { toolCallId: 'background', state: 'output-available', output: backgroundReceipt },
      { toolCallId: 'tool-error', state: 'output-error', errorText: 'The site is unavailable.' },
      { toolCallId: 'unreturned', state: 'output-error', errorText: 'No tool result was received before this chat run failed.' },
    ])
  })

  it('does not invent a failed tool result on a transport disconnect while server work may continue', async () => {
    const { chat, send } = harness([requested('still-on-server')], true)
    await send()
    expect(chat.status).toBe('error')
    expect(chat.error?.message).toBe('network disconnected')
    expect(chat.messages.at(-1)?.parts).toContainEqual(expect.objectContaining({
      toolCallId: 'still-on-server', state: 'input-available',
    }))
  })

  it('leaves ordinary successful browser execution unchanged', async () => {
    const output = { status: 'verified', commandId: 'command-1' }
    const { chat, send, onError } = harness([requested('browser-1'), result('browser-1', output), event('turn.completed', {})])
    await send()
    expect(chat.status).toBe('ready')
    expect(onError).not.toHaveBeenCalled()
    expect(chat.messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ state: 'output-available', output }))
  })
})
