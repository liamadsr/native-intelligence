// @vitest-environment jsdom
/**
 * Quick helpers (A4 slice 3): the `helpers` workflow tool yields progress,
 * which eve publishes as `action.partial`. The transport projects it as the
 * AI SDK's preliminary tool output, so the row reads "1/3 done" while the call
 * runs, and the final action.result replaces it. Only the final result is
 * persisted.
 */
import { Chat } from '@ai-sdk/react'
import type { HandleMessageStreamEvent } from 'eve/client'
import { describe, expect, it, vi } from 'vitest'
import { EveChatTransport } from '../eve-chat-transport'

const event = (type: string, data: object): HandleMessageStreamEvent => ({ type, data }) as HandleMessageStreamEvent
const requested = (callId: string) =>
  event('actions.requested', { actions: [{ kind: 'tool-call', callId, toolName: 'helpers', input: { tasks: [{ label: 'Acme', task: 'x' }] } }] })
const partial = (callId: string, output: unknown) =>
  event('action.partial', { result: { kind: 'tool-result', callId, toolName: 'helpers', output }, sequence: 1, stepIndex: 0, turnId: 't' })
const result = (callId: string, output: unknown) =>
  event('action.result', { result: { kind: 'tool-result', callId, toolName: 'helpers', output, isError: false } })

const PROGRESS = { kind: 'helpers-progress', total: 2, done: 1, tasks: [{ label: 'Acme', status: 'done' }, { label: 'Globex', status: 'working' }] }
const FINAL = { results: [{ label: 'Acme', status: 'done', output: 'found' }, { label: 'Globex', status: 'timed_out', output: 'stopped' }] }

function harness(events: Array<HandleMessageStreamEvent | Promise<void>>) {
  const persist = vi.fn(async (..._args: unknown[]) => {})
  const response = {
    sessionId: 'wrun-helpers',
    async *[Symbol.asyncIterator]() {
      for (const item of events) {
        if (item instanceof Promise) await item
        else yield item
      }
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
  const send = () => chat.sendMessage({ text: 'Research these' }, { body: { conversationId: 'synthetic-conversation' } })
  return { chat, send, persist }
}

const helpersPart = (chat: Chat<never> | { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
  (chat.messages.at(-1)?.parts ?? []).find((part) => (part as { type?: string }).type === 'dynamic-tool') as Record<string, unknown> | undefined

describe('the chat transport projects a workflow tool’s progress', () => {
  it('shows action.partial as a preliminary output, then the final result replaces it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { chat, send, persist } = harness([requested('h-1'), partial('h-1', PROGRESS), gate, result('h-1', FINAL), event('turn.completed', {})])
    const sending = send()
    await vi.waitFor(() => expect(helpersPart(chat as never)).toMatchObject({ state: 'output-available', preliminary: true, output: PROGRESS }))
    release()
    await sending
    const part = helpersPart(chat as never)
    expect(part).toMatchObject({ toolName: 'helpers', state: 'output-available', output: FINAL })
    expect(part?.preliminary).not.toBe(true)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    // Only the final result is saved.
    expect(JSON.stringify(persist.mock.calls)).not.toContain('helpers-progress')
    expect(JSON.stringify(persist.mock.calls)).toContain('timed_out')
  })

  it('announces the call first when its request was never seen, and ignores an errored partial', async () => {
    const { chat, send } = harness([
      partial('h-2', PROGRESS),
      event('action.partial', { result: { kind: 'tool-result', callId: 'h-2', toolName: 'helpers', output: 'boom', isError: true } }),
      event('turn.completed', {}),
    ])
    await send()
    expect(helpersPart(chat as never)).toMatchObject({ toolCallId: 'h-2', toolName: 'helpers', preliminary: true, output: PROGRESS })
  })
})
