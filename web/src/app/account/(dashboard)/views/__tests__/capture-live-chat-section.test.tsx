// @vitest-environment jsdom
/**
 * The capture page's read-only "Live chat" section (one-chat plan, Slice 3,
 * "After the call"). Pinned:
 *   - useCaptureLiveChat asks once the call is over (never while it records),
 *     and offers a section only for a thread with messages in it;
 *   - CaptureLiveChatSection draws the thread read-only: the person's words,
 *     the agent's replies (plain text) and heads-ups, its questions, the items
 *     it captured; nothing in it sends;
 *   - the heads-ups (say_to_user rows), and only they, take thumbs after the
 *     call: the stored rating loads, a click posts the row's ui_message id
 *     in the call's conversation, a thumbs-down offers the reason chips
 *     (`nudge_reason`); a call with no heads-ups draws no rating UI and reads
 *     no ratings;
 *   - CaptureDetailPanel shows the tab only when there's a thread, and builds
 *     the section from them (pinned in the source: the panel can't be mounted
 *     in a unit test, see live-agent-card-placement.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('sonner', () => ({ toast: vi.fn() }))

import { CaptureLiveChatSection, useCaptureLiveChat } from '../capture-live-chat-section'
import { __resetMessageFeedbackForTests } from '@/hooks/use-message-feedback'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()

beforeEach(() => {
  __resetMessageFeedbackForTests()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

const json = (body: unknown) => ({ ok: true, json: async () => body })

function Probe({ captureId, recording, seen }: { captureId: string; recording: boolean; seen: Array<string | null> }) {
  seen.push(useCaptureLiveChat(captureId, recording))
  return null
}

describe('useCaptureLiveChat', () => {
  it('asks after the call, never during it, and offers only a thread with messages', async () => {
    const seen: Array<string | null> = []
    fetchMock.mockResolvedValue(json({ conversationId: 'conv-live', messageCount: 4 }))
    await act(async () => root.render(h(Probe, { captureId: 'cap-1', recording: true, seen })))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(seen.at(-1)).toBeNull()

    await act(async () => root.render(h(Probe, { captureId: 'cap-1', recording: false, seen })))
    await settle()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/chat-history/live?capture_id=cap-1')
    expect(seen.at(-1)).toBe('conv-live')
  })

  it('no thread, or an empty one: no section', async () => {
    const seen: Array<string | null> = []
    fetchMock.mockResolvedValueOnce(json({ conversationId: 'conv-live', messageCount: 0 }))
    await act(async () => root.render(h(Probe, { captureId: 'cap-1', recording: false, seen })))
    await settle()
    expect(seen.at(-1)).toBeNull()
    fetchMock.mockResolvedValueOnce(json({ conversationId: null, messageCount: 0 }))
    await act(async () => root.render(h(Probe, { captureId: 'cap-2', recording: false, seen })))
    await settle()
    expect(seen.at(-1)).toBeNull()
  })
})

describe('CaptureLiveChatSection', () => {
  it('draws the thread read-only', async () => {
    fetchMock.mockResolvedValue(
      json({
        messages: [
          { id: 'g', role: 'assistant', parts: [{ type: 'text', text: '**Sales Coach** here — listening in.' }], metadata: { kind: 'greeting' } },
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What did they say about price?' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'They asked for **10%** off.' }] },
          { id: 's1', role: 'assistant', parts: [{ type: 'text', text: 'They mentioned a competitor.' }], metadata: { kind: 'say_to_user', nudge_kind: 'reminder' } },
          {
            id: 'q1',
            role: 'assistant',
            parts: [{ type: 'tool-ask_user', toolCallId: 't1', state: 'output-available', input: { questions: [{ question: 'Log the discount ask?', options: [] }] } }],
          },
          { id: 'p1', role: 'assistant', parts: [{ type: 'data-proposals', data: { capture_id: 'cap-1', proposal_ids: ['x', 'y'] } }] },
        ],
      }),
    )
    await act(async () => root.render(h(CaptureLiveChatSection, { conversationId: 'conv-live' })))
    await settle()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/chat-history/conv-live')
    const rows = [...container.querySelectorAll('[data-row-kind]')].map((el) => [el.getAttribute('data-row-kind'), el.textContent])
    expect(rows).toEqual([
      ['reply', 'Sales Coach here — listening in.'],
      ['user', 'What did they say about price?'],
      ['reply', 'They asked for 10% off.'],
      ['say', 'ReminderThey mentioned a competitor.'],
      ['question', 'AskedLog the discount ask?'],
      ['proposals', '2 items captured'],
    ])
    // Nothing sends a message; the only controls are the heads-up's thumbs.
    expect(container.querySelector('textarea, input')).toBeNull()
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('data-message-feedback'))).toEqual(['up', 'down'])
    expect(buttons.every((b) => b.closest('[data-nudge-row="s1"] [data-nudge-feedback]'))).toBe(true)
  })

  describe('rating the heads-ups after the call', () => {
    const THREAD = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Any risks?' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Budget is tight.' }] },
      { id: 'n-1', role: 'assistant', parts: [{ type: 'text', text: 'Ask who signs off.' }], metadata: { kind: 'say_to_user', nudge_kind: 'suggestion' } },
      { id: 'n-2', role: 'assistant', parts: [{ type: 'text', text: 'They named a start date.' }], metadata: { kind: 'say_to_user', nudge_kind: 'insight' } },
    ]
    let posts: Array<Record<string, unknown>>

    function serve(messages: unknown[], ratings: Record<string, string> = {}) {
      posts = []
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/account/chat-history/')) return json({ messages })
        if (url.startsWith('/api/account/chat/feedback') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body))
          posts.push(body)
          return { ok: true, status: 200, json: async () => ({ rating: body.rating }) }
        }
        if (url.startsWith('/api/account/chat/feedback')) return json({ ratings })
        return { ok: false, status: 404, json: async () => ({}) }
      })
    }
    const thumb = (id: string, which: 'up' | 'down') => container.querySelector<HTMLButtonElement>(`[data-nudge-row="${id}"] [data-message-feedback="${which}"]`)
    const click = async (el: Element | null) => {
      await act(async () => {
        el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 0))
      })
    }
    const mount = async () => {
      await act(async () => root.render(h(CaptureLiveChatSection, { conversationId: 'conv-live' })))
      await settle()
    }

    it('thumbs on the heads-ups only, never on the person’s words or the replies', async () => {
      serve(THREAD)
      await mount()
      expect(container.querySelectorAll('[data-message-feedback="up"]')).toHaveLength(2)
      expect(thumb('n-1', 'up')).not.toBeNull()
      expect(thumb('n-2', 'down')).not.toBeNull()
      for (const kind of ['user', 'reply']) {
        const el = container.querySelector(`[data-row-kind="${kind}"]`)!
        expect(el.querySelector('button')).toBeNull()
        expect(el.closest('[data-nudge-row]')).toBeNull()
      }
    })

    it('loads the stored ratings: a rated heads-up shows its rating', async () => {
      serve(THREAD, { 'n-2': 'down' })
      await mount()
      expect(fetchMock).toHaveBeenCalledWith('/api/account/chat/feedback?conversationId=conv-live')
      expect(thumb('n-2', 'down')!.getAttribute('aria-pressed')).toBe('true')
      expect(thumb('n-1', 'down')!.getAttribute('aria-pressed')).toBe('false')
    })

    it('a thumbs-up posts the row’s id in the call’s conversation', async () => {
      serve(THREAD)
      await mount()
      await click(thumb('n-1', 'up'))
      expect(posts).toEqual([{ conversationId: 'conv-live', messageId: 'n-1', rating: 'up' }])
      expect(thumb('n-1', 'up')!.getAttribute('aria-pressed')).toBe('true')
    })

    it('a thumbs-down offers the reason chips; a chip posts as nudge_reason, beside the optional words', async () => {
      serve(THREAD)
      await mount()
      await click(thumb('n-2', 'down'))
      expect(posts[0]).toEqual({ conversationId: 'conv-live', messageId: 'n-2', rating: 'down' })
      const chips = [...document.querySelectorAll<HTMLButtonElement>('[data-nudge-reasons] [data-nudge-reason]')]
      expect(chips.map((c) => c.textContent)).toEqual(['Not useful', 'Repeated', 'Wrong', 'Too late'])
      const send = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send') as HTMLButtonElement
      expect(send().disabled).toBe(true)
      await click(chips[1])
      expect(chips[1].getAttribute('aria-pressed')).toBe('true')
      expect(send().disabled).toBe(false)
      await click(send())
      expect(posts[1]).toEqual({ conversationId: 'conv-live', messageId: 'n-2', rating: 'down', nudge_reason: 'repeated' })
    })

    it('a call with no heads-ups draws no rating UI and reads no ratings', async () => {
      serve(THREAD.slice(0, 2))
      await mount()
      expect(container.querySelector('button, [data-nudge-feedback]')).toBeNull()
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/account/chat/feedback'))).toBe(false)
    })
  })

  it('says so when the thread can’t be read', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await act(async () => root.render(h(CaptureLiveChatSection, { conversationId: 'conv-live' })))
    await settle()
    expect(container.textContent).toContain('Couldn’t load the live chat.')
  })
})

describe('CaptureDetailPanel wires it in', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/account/(dashboard)/views/capture-detail-panel.tsx'), 'utf8')
  it('offers the tab only with a thread, and draws the section from it', () => {
    expect(source).toContain("const CAPTURE_SECTIONS = ['overview', 'agents', 'live-chat'] as const")
    expect(source).toContain("CAPTURE_SECTIONS.filter((tab) => tab !== 'live-chat' || liveChatConversationId)")
    expect(source).toContain('useCaptureLiveChat(captureId, isActiveRecording)')
    expect(source).toContain("activeSection === 'live-chat' && liveChatConversationId && (")
    expect(source).toContain('<CaptureLiveChatSection conversationId={liveChatConversationId} />')
  })
})
