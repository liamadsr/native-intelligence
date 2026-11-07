// @vitest-environment jsdom
/**
 * RunFollowUpChat — talk to a settled work run's parked eve session (Loops v3
 * interactive work runs). These tests pin the Phase-3 UI fixes:
 *   - finalizeReplay: empties dropped, and every question EXCEPT the final turn
 *     marked `answered` (an inert receipt — the pending question is always last);
 *   - mount replay: GET /chat rebuilds user turns from `user-message` and
 *     assistant turns from text/tool, alternating correctly;
 *   - answered follow-up questions render as an inert receipt (no live picker);
 *   - a failed send removes the stranded empty assistant bubble (no permanent
 *     "Thinking…") and restores the typed message;
 *   - accessibility: the textarea has an accessible name and the transcript is a
 *     polite live region.
 *
 * Mounted standalone with createRoot (mirrors run-question-section.test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; PromptInputTextarea (the main-chat composer
// primitive this composer is built on) observes the field's width.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import { RunFollowUpChat, finalizeReplay } from '../run-follow-up-chat'
import type { FollowUpTurn } from '../run-chat-stream'
import type { RunChatQuestionPayload } from '@/lib/agent-run/run-chat-events'

let container: HTMLDivElement
let root: Root

function questionPayload(reqId: string): RunChatQuestionPayload {
  return {
    requestId: reqId,
    approveOptionId: 'approve',
    denyOptionId: 'deny',
    questions: [{ question: `Q ${reqId}?`, header: `H ${reqId}`, options: [{ label: 'A' }], multiSelect: false }],
  }
}

/** Build a Response whose body streams the given NDJSON lines (the /chat wire). */
function ndjsonResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function flush() {
  // Let the replay/stream microtasks (fetch → readChatStream → setTurns) settle.
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('finalizeReplay', () => {
  const q = (id: string, question: RunChatQuestionPayload): FollowUpTurn => ({
    id,
    role: 'assistant',
    text: '',
    tools: [],
    question,
  })
  const text = (id: string, role: 'user' | 'assistant', t: string): FollowUpTurn => ({
    id,
    role,
    text: t,
    tools: [],
  })

  it('drops empty turns (no text / tools / question)', () => {
    const built: FollowUpTurn[] = [
      text('a1', 'assistant', ''),
      text('u1', 'user', 'hi'),
      text('a2', 'assistant', 'reply'),
    ]
    const out = finalizeReplay(built)
    expect(out.map((t) => t.id)).toEqual(['u1', 'a2'])
  })

  it('marks an earlier (answered) question inert but keeps the final one live', () => {
    const built: FollowUpTurn[] = [
      q('a1', questionPayload('r1')),
      text('u1', 'user', 'Warm'),
      text('a2', 'assistant', 'Done.'),
      q('a3', questionPayload('r2')),
    ]
    const out = finalizeReplay(built)
    // a1 is followed by later turns → answered; a3 is the last turn → still live.
    expect(out.find((t) => t.id === 'a1')?.answered).toBe(true)
    expect(out.find((t) => t.id === 'a3')?.answered).toBeFalsy()
  })

  it('leaves a lone still-pending question live (it is the final turn)', () => {
    const built: FollowUpTurn[] = [text('a0', 'assistant', 'ok'), q('a1', questionPayload('r1'))]
    const out = finalizeReplay(built)
    expect(out.find((t) => t.id === 'a1')?.answered).toBeFalsy()
  })
})

describe('RunFollowUpChat', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fetchMock = vi.fn(async () => ndjsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetches GET /chat on mount to replay prior turns (even on a terminal run)', async () => {
    await act(async () => {
      root.render(h(RunFollowUpChat, { runId: 'run-1' }))
      await flush()
    })
    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/agent-runs/run-1/chat')
    // GET (no method) — the replay, not a send.
    expect(init?.method).toBeUndefined()
  })

  it('rebuilds alternating user + assistant turns from the replay stream', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse([
        '{"type":"user-message","text":"why contact X?"}\n',
        '{"type":"text-delta","delta":"Because X replied last."}\n',
        '{"type":"done"}\n',
        '{"type":"user-message","text":"change the subject"}\n',
        '{"type":"text-delta","delta":"Updated it."}\n',
        '{"type":"done"}\n',
      ]),
    )
    await act(async () => {
      root.render(h(RunFollowUpChat, { runId: 'run-2' }))
      await flush()
    })
    const text = container.textContent || ''
    expect(text).toContain('why contact X?')
    expect(text).toContain('Because X replied last.')
    expect(text).toContain('change the subject')
    expect(text).toContain('Updated it.')
  })

  it('renders an answered follow-up question as an inert receipt (no live picker)', async () => {
    // A question, then a user answer + assistant follow-up → the question is answered.
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse([
        '{"type":"question","question":{"requestId":"r1","approveOptionId":"approve","denyOptionId":"deny","questions":[{"question":"Which tone?","header":"Tone","options":[{"label":"Warm"}],"multiSelect":false}]}}\n',
        '{"type":"user-message","text":"Warm"}\n',
        '{"type":"text-delta","delta":"Got it."}\n',
        '{"type":"done"}\n',
      ]),
    )
    await act(async () => {
      root.render(h(RunFollowUpChat, { runId: 'run-3' }))
      await flush()
    })
    const text = container.textContent || ''
    expect(text).toContain('Asked') // the inert receipt header
    expect(text).toContain('Tone')
    // No live Submit/Skip picker buttons for the answered question.
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent || '')
    expect(buttons.some((t) => /submit/i.test(t))).toBe(false)
    expect(buttons.some((t) => /skip/i.test(t))).toBe(false)
  })

  it('keeps a still-pending replayed question as a live picker', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse([
        '{"type":"text-delta","delta":"One question:"}\n',
        '{"type":"question","question":{"requestId":"r9","approveOptionId":"approve","denyOptionId":"deny","questions":[{"question":"Which tone?","header":"Tone","options":[{"label":"Warm"}],"multiSelect":false}]}}\n',
      ]),
    )
    await act(async () => {
      root.render(h(RunFollowUpChat, { runId: 'run-4' }))
      await flush()
    })
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent || '')
    // The final, still-pending question renders its picker (Submit/Skip present).
    expect(buttons.some((t) => /submit/i.test(t) || /skip/i.test(t))).toBe(true)
  })

  it('removes the empty assistant bubble and restores input after a failed send (no permanent Thinking…)', async () => {
    // Mount replay resolves empty; the POST send returns a non-ok status.
    fetchMock
      .mockResolvedValueOnce(ndjsonResponse([])) // GET replay on mount
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'session gone' }), { status: 500 })) // POST
    await act(async () => {
      root.render(h(RunFollowUpChat, { runId: 'run-5' }))
      await flush()
    })
    // Type a message and send it.
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, 'please redo the draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })
    const text = container.textContent || ''
    expect(text).not.toContain('Thinking…') // stranded empty bubble was pruned
    expect(text).toContain('session gone') // the error is surfaced
    // The typed message is restored so a retry isn't lost.
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('please redo the draft')
  })

  it('exposes an accessible name on the textarea and a polite live region for the transcript', async () => {
    await act(async () => {
      root.render(h(RunFollowUpChat, { runId: 'run-6' }))
      await flush()
    })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.getAttribute('aria-label')).toBe('Ask about this run')
    const log = container.querySelector('[role="log"]') as HTMLElement
    expect(log).toBeTruthy()
    expect(log.getAttribute('aria-live')).toBe('polite')
  })
})
