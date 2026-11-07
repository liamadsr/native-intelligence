// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({ requests: [] as Array<{ sound: string; key: string }> }))
vi.mock('../alerts', () => ({
  playAlertSound: vi.fn(async (req: { sound: string; key: string }) => {
    shared.requests.push(req)
    return 'played'
  }),
}))

import { ASK_LIVE_GRACE_MS, useAskArrivalSound } from '../use-ask-arrival-sound'
import { askKey, notificationAlert } from '../triggers'

type Msg = { id: string; role: string; parts: unknown[] }

const user = (id: string, text = 'hi'): Msg => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const ask = (id: string, question: string, state = 'input-available', tool = 'tool-ask_user') => ({
  type: tool,
  toolCallId: id,
  state,
  input: { questions: [{ question, header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
})
const assistant = (id: string, ...parts: unknown[]): Msg => ({ id, role: 'assistant', parts })

function Probe({ messages, status }: { messages: Msg[]; status: string }) {
  useAskArrivalSound(messages, status)
  return null
}

let root: Root
function render(messages: Msg[], status: string) {
  act(() => root.render(h(Probe, { messages, status })))
}

describe('useAskArrivalSound', () => {
  beforeEach(() => {
    shared.requests.length = 0
    act(() => {
      root = createRoot(document.createElement('div'))
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('plays once when a question arrives in a live reply', () => {
    const history = [user('u1')]
    render(history, 'ready')
    render([...history, user('u2')], 'submitted')
    // Streaming: the input isn't complete yet — nothing plays on a partial.
    render([...history, user('u2'), assistant('a2', ask('t1', 'Which', 'input-streaming'))], 'streaming')
    expect(shared.requests).toEqual([])
    const done = [...history, user('u2'), assistant('a2', ask('t1', 'Which repo?'))]
    render(done, 'streaming')
    render(done, 'ready')
    render([...done], 'ready')
    expect(shared.requests).toEqual([{ sound: 'agent-alert', key: askKey('Which repo?') }])
  })

  it('never plays for a question already pending when the panel mounts (history, reload, restored tab)', () => {
    const restored = [user('u1'), assistant('a1', ask('t1', 'Keep going?'))]
    render(restored, 'ready')
    render([...restored], 'streaming') // a resumed stream re-delivers it
    expect(shared.requests).toEqual([])
  })

  it('never plays for an answered question', () => {
    render([user('u1')], 'ready')
    render([user('u1'), assistant('a1', ask('t1', 'Done?', 'output-available'))], 'streaming')
    expect(shared.requests).toEqual([])
  })

  it('a pending question switched in from history (no reply streaming) stays silent', () => {
    vi.useFakeTimers()
    render([user('u1')], 'ready')
    vi.advanceTimersByTime(ASK_LIVE_GRACE_MS + 1)
    render([user('x1'), assistant('x2', ask('old', 'From another chat?'))], 'ready')
    expect(shared.requests).toEqual([])
  })

  it('a dynamic ask_user tool counts too', () => {
    render([user('u1')], 'ready')
    render([user('u1'), assistant('a1', { type: 'dynamic-tool', toolName: 'ask_user', toolCallId: 't9', state: 'input-available', input: { questions: [{ question: 'Ship it?' }] } })], 'streaming')
    expect(shared.requests).toEqual([{ sound: 'agent-alert', key: askKey('Ship it?') }])
  })

  it('shares its key with the work_needs_you notification for the same question', () => {
    const fromNotification = notificationAlert({
      id: 'n1',
      type: 'work_needs_you',
      body: 'Which repo?',
      target_type: 'work_item',
      target_id: 'w1',
      is_read: false,
      metadata: { kind: 'work_run', status: 'needs_input' },
    })
    render([user('u1')], 'ready')
    render([user('u1'), assistant('a1', ask('t1', 'Which repo?'))], 'streaming')
    expect(shared.requests[0]).toEqual(fromNotification)
  })
})
