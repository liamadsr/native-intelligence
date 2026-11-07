// @vitest-environment jsdom
/**
 * RunChat — the canonical follow-up-chat surface for a settled work run (Loops v3
 * interactive work runs), rendering with the MAIN chat's components. These tests
 * pin the HOST behaviour (send/disable/empty/error states + the inline
 * clarifying-question routing), mocking the heavy children:
 *   - ChatMessage is stubbed to a text dump (its real impl drags in the chat —
 *     out of scope for the host contract; it's exercised by the main chat's tests),
 *   - QuestionPicker is stubbed to bare Submit/Skip buttons so we can drive the
 *     two answer paths (replayed-final vs live) deterministically.
 * The transport is real, driven over a mocked fetch (the /chat proxy).
 *
 * Mounted standalone with createRoot (mirrors run-follow-up-chat.test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; PromptInputTextarea (the main-chat composer
// primitive the RunChat composer is built on) observes the field's width.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Stub ChatMessage: render the message's text parts + a marker for ask_user parts,
// so tests can assert transcript content without the real one.
// It also says whether a feedback store reached it (`data-feedback`), as the real
// one's thumbs would show: a run's replies must never find the main chat's.
vi.mock('@/app/account/(dashboard)/chat/chat-message', async () => {
  const { useContext } = await import('react')
  const { MessageFeedbackContext } = await import('@/app/account/(dashboard)/chat/message-feedback-buttons')
  return {
    ChatMessage: function StubChatMessage({ message }: { message: { role: string; parts: Array<Record<string, unknown>> } }) {
      const feedback = useContext(MessageFeedbackContext)
      return h(
        'div',
        { 'data-role': message.role, className: 'stub-msg', 'data-feedback': feedback ? 'on' : 'off' },
        message.parts
          .map((p) => (p.type === 'text' ? (p.text as string) : p.type === 'dynamic-tool' ? `[tool:${p.toolName}]` : ''))
          .join(' '),
      )
    },
  }
})

// The composer is the main chat's (ChatInput): its skills come from the
// shared skill-commands read, stubbed here (its own tests cover it).
const skillCommands = vi.hoisted(() => [
  { id: 'skill-brief', slug: 'brief', name: 'Brief', icon: null, color: null, description: null, views_context: null },
])
vi.mock('@/app/account/(dashboard)/chat/slash-command-picker', () => ({
  useRecipeCommands: () => skillCommands,
  // The "/" picker, open: a button per skill that picks it.
  SlashCommandPicker: ({ open, onSelect }: { open: boolean; onSelect: (c: (typeof skillCommands)[number]) => void }) =>
    open
      ? h(
          'div',
          { 'data-slash-picker': '' },
          skillCommands.map((c) => h('button', { key: c.id, type: 'button', 'data-pick': c.slug, onClick: () => onSelect(c) }, c.name)),
        )
      : null,
}))

// Stub QuestionPicker: bare Submit/Skip. Submit sends a fixed answers map.
vi.mock('@/app/account/(dashboard)/chat/question-picker', () => ({
  QuestionPicker: ({
    onSubmit,
    onSkip,
    disabled,
  }: {
    onSubmit: (a: Record<string, string>) => void
    onSkip: () => void
    disabled?: boolean
  }) =>
    h('div', { 'data-testid': 'picker' }, [
      h(
        'button',
        { key: 's', 'data-testid': 'picker-submit', disabled, onClick: () => onSubmit({ 'Q?': 'Yes' }) },
        'Submit',
      ),
      h('button', { key: 'k', 'data-testid': 'picker-skip', disabled, onClick: () => onSkip() }, 'Skip'),
    ]),
  AnsweredQuestionsSummary: () => h('div', null, 'answered'),
}))

// Uploads go straight to storage in the app; here they resolve at once.
vi.mock('@/lib/chat/upload-client', () => ({
  ChatUploadError: class ChatUploadError extends Error {},
  uploadChatFile: vi.fn(async (file: File) => ({
    fileId: 'f1',
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    fileExtension: 'md',
    storagePath: 'user-1/chat-uploads/f1.md',
    url: 'https://storage.example/signed/f1.md',
  })),
}))

import { RunChat } from '../run-chat'
import { MessageFeedbackContext } from '@/app/account/(dashboard)/chat/message-feedback-buttons'
import { createMessageFeedbackStore } from '@/hooks/use-message-feedback'
import { uploadChatFile } from '@/lib/chat/upload-client'
import { CHAT_PHOTOS_REASON } from '../run-chat-copy'
import { __resetRunChatsForTests } from '@/hooks/use-run-chat'
import type { RunChatEvent } from '@/lib/agent-run/run-chat-events'

let container: HTMLDivElement
let root: Root

type ReducedLine = RunChatEvent | { type: 'user-message'; text: string }

function ndjsonResponse(events: ReducedLine[], init: { ok?: boolean; status?: number } = {}): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`))
      controller.close()
    },
  })
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body,
    json: async () => ({}),
  } as unknown as Response
}

async function flush(times = 16) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  // The run's conversation lives in useRunChat's store (shared with the bubble): each test starts fresh.
  __resetRunChatsForTests()
})

describe('RunChat — replay + empty state', () => {
  it('shows Loading… then the empty invitation when replay is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ndjsonResponse([]))
    vi.stubGlobal('fetch', fetchImpl)

    await act(async () => {
      root.render(h(RunChat, { runId: 'r1' }))
    })
    await act(async () => {
      await flush()
    })

    expect(container.textContent).toContain('Ask the agent about this run')
  })

  it('renders replayed turns via the stubbed ChatMessage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'text-delta', delta: 'I drafted it.' },
        { type: 'done' },
        { type: 'user-message', text: 'thanks' },
      ]),
    )
    vi.stubGlobal('fetch', fetchImpl)

    await act(async () => {
      root.render(h(RunChat, { runId: 'r1' }))
    })
    await act(async () => {
      await flush()
    })

    expect(container.textContent).toContain('I drafted it.')
    expect(container.textContent).toContain('thanks')
  })
})

describe('RunChat — inside the main chat (a show card opened the run)', () => {
  it('its replies never take the main chat’s thumbs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([{ type: 'text-delta', delta: 'I drafted it.' }, { type: 'done' }])))
    const mainChat = createMessageFeedbackStore('c-main')
    await act(async () => {
      root.render(h(MessageFeedbackContext.Provider, { value: mainChat }, h(RunChat, { runId: 'r1' })))
    })
    await act(async () => {
      await flush()
    })
    const replies = [...container.querySelectorAll<HTMLElement>('.stub-msg[data-role="assistant"]')]
    expect(replies.length).toBeGreaterThan(0)
    expect(replies.every((el) => el.dataset.feedback === 'off')).toBe(true)
  })
})

describe('RunChat — composer', () => {
  it('disables send with empty input and enables it once typed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([])))
    await act(async () => {
      root.render(h(RunChat, { runId: 'r1' }))
    })
    await act(async () => {
      await flush()
    })

    const sendBtn = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(sendBtn.disabled).toBe(true)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'a question')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(sendBtn.disabled).toBe(false)
  })

  it('sends a plain follow-up message (POST /chat {message})', async () => {
    const fetchImpl = vi
      .fn()
      // replay (empty)
      .mockResolvedValueOnce(ndjsonResponse([]))
      // the send turn
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'text-delta', delta: 'Sure.' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchImpl)

    await act(async () => {
      root.render(h(RunChat, { runId: 'r1' }))
    })
    await act(async () => {
      await flush()
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'what did you change?')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      // Enter (no shift) submits.
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await flush()
    })

    // The send POST (2nd fetch) carried the message alone.
    const sendCall = fetchImpl.mock.calls[1]
    const body = JSON.parse((sendCall[1] as { body: string }).body)
    expect(body).toEqual({ message: 'what did you change?' })
    expect(container.textContent).toContain('Sure.')
  })
})

describe('RunChat — clarifying question', () => {
  it('renders the inline picker for a pending REPLAYED final question and answers it via sendMessage + inputResponses', async () => {
    const question = {
      requestId: 'req-7',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [{ question: 'Q?', header: 'Pick', options: [{ label: 'Yes' }], multiSelect: false }],
    }
    const fetchImpl = vi
      .fn()
      // replay: ends on a pending final question.
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'question', question }, { type: 'done' }]))
      // the answer send turn.
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'text-delta', delta: 'Great.' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchImpl)

    await act(async () => {
      root.render(h(RunChat, { runId: 'r1' }))
    })
    await act(async () => {
      await flush()
    })

    // The inline picker is shown for the pending question.
    const submit = container.querySelector('[data-testid="picker-submit"]') as HTMLButtonElement
    expect(submit).toBeTruthy()

    await act(async () => {
      submit.click()
      await flush()
    })

    // The answer went out as a normal send whose body carried the eve inputResponses.
    const answerCall = fetchImpl.mock.calls[1]
    const body = JSON.parse((answerCall[1] as { body: string }).body)
    expect(body.inputResponses).toEqual([{ requestId: 'req-7', optionId: 'approve' }])
    expect(body.message).toContain('Pick')
    // The picker unmounted after answering.
    expect(container.querySelector('[data-testid="picker-submit"]')).toBeNull()
  })

  it('a skip on a replayed final question sends the deny option id', async () => {
    const question = {
      requestId: 'req-8',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [{ question: 'Q?', header: 'Pick', options: [{ label: 'Yes' }], multiSelect: false }],
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'question', question }, { type: 'done' }]))
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'done' }]))
    vi.stubGlobal('fetch', fetchImpl)

    await act(async () => {
      root.render(h(RunChat, { runId: 'r1' }))
    })
    await act(async () => {
      await flush()
    })

    const skip = container.querySelector('[data-testid="picker-skip"]') as HTMLButtonElement
    await act(async () => {
      skip.click()
      await flush()
    })

    const body = JSON.parse((fetchImpl.mock.calls[1][1] as { body: string }).body)
    expect(body.inputResponses).toEqual([{ requestId: 'req-8', optionId: 'deny' }])
  })
})

describe('RunChat — the main chat’s composer (bots v4)', () => {
  async function mounted(props: Record<string, unknown> = {}, sends: Response[] = []) {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ndjsonResponse([]))
    for (const r of sends) fetchImpl.mockResolvedValueOnce(r)
    vi.stubGlobal('fetch', fetchImpl)
    await act(async () => {
      root.render(h(RunChat, { runId: 'r1', ...props }))
    })
    await act(async () => {
      await flush()
    })
    return fetchImpl
  }
  const sendBody = (fetchImpl: ReturnType<typeof vi.fn>, i = 1) =>
    JSON.parse((fetchImpl.mock.calls[i][1] as { body: string }).body) as Record<string, unknown>
  const typeAndSend = async (text: string) => {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
  }

  it('is ChatInput: skills and the + menu, the agent shown dimmed and why, no model control', async () => {
    await mounted({ agentName: 'Scout' })
    // Skills are a "/" away: no "All skills" button or skill chips above the box.
    expect(container.textContent).not.toContain('All skills')
    expect(container.querySelector('button[aria-label="Add"]')).toBeTruthy()
    // The server picks the model per turn: no picker, and no dimmed one either.
    expect(container.querySelector('[data-composer-unavailable="model"]')).toBeNull()
    expect(container.querySelector('[data-model-picker]')).toBeNull()
    const agent = container.querySelector<HTMLElement>('[data-composer-unavailable="agent"]')!
    expect(agent.textContent).toContain('Scout')
    expect(agent.getAttribute('title')).toContain('Scout')
    // The app's one Capture stays in the main composer.
    expect(container.querySelector('[data-capture-liquid]')).toBeNull()
    expect(container.querySelector('[data-capture-controls-slot]')).toBeNull()
  })

  it('photos show dimmed with why: a photo is refused in the box, never uploaded or sent; no "My captures"', async () => {
    const fetchImpl = await mounted({}, [ndjsonResponse([{ type: 'done' }])])
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click()
    })
    expect(document.body.querySelector('[data-composer-unavailable="photos"]')?.textContent).toContain(CHAT_PHOTOS_REASON)
    // A picked photo: an error chip saying why; nothing uploads (the upload client is never called).
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).not.toContain('image/')
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'shot.png', { type: 'image/png' })], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })
    expect(container.querySelector(`[title="${CHAT_PHOTOS_REASON}"]`)).toBeTruthy()
    expect(vi.mocked(uploadChatFile).mock.calls.some(([f]) => (f as File).name === 'shot.png')).toBe(false)
    await typeAndSend('what is this?')
    expect(sendBody(fetchImpl)).toEqual({ message: 'what is this?' })
    // No "My captures" at all, focused and typing or not.
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      textarea.focus()
      await flush()
    })
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, 'more')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-composer-unavailable="searchSettings"]')).toBeNull()
    expect(container.textContent).not.toContain('My captures')
  })

  it('a skill picked from "@" sends /<slug> with the skill, to the run’s own session ("/" in its box is only a character)', async () => {
    const fetchImpl = await mounted({}, [ndjsonResponse([{ type: 'text-delta', delta: 'On it.' }, { type: 'done' }])])
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const typeIn = async (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
    // From an empty box (the run's draft can outlive a mount): "/" opens nothing, "@" the menu.
    await typeIn('')
    await typeIn('/')
    expect(container.querySelector('[data-slash-picker]')).toBeNull()
    await typeIn('@')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slash-picker] [data-pick="brief"]')!.click()
      await flush()
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/account/agent-runs/r1/chat')
    expect(sendBody(fetchImpl)).toMatchObject({ message: '/brief', skillId: 'skill-brief' })
    expect(container.textContent).toContain('On it.')
  })

  it('a loop run’s turn goes to its own route, the same way', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ndjsonResponse([])).mockResolvedValueOnce(ndjsonResponse([{ type: 'done' }]))
    vi.stubGlobal('fetch', fetchImpl)
    await act(async () => {
      root.render(h(RunChat, { runId: 'loop:wi-1' }))
    })
    await act(async () => {
      await flush()
    })
    await typeAndSend('why did you skip it?')
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/account/activity/wi-1/chat')
    expect(sendBody(fetchImpl)).toMatchObject({ message: 'why did you skip it?' })
  })

  it('a typed turn carries the attached file’s storage facts, and its chip leaves the box', async () => {
    const fetchImpl = await mounted({}, [ndjsonResponse([{ type: 'done' }])])
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })
    expect(container.textContent).toContain('notes.md')
    await typeAndSend('summarise this')
    expect(sendBody(fetchImpl)).toMatchObject({
      message: 'summarise this',
      files: [{ storagePath: 'user-1/chat-uploads/f1.md', fileName: 'notes.md', fileSize: file.size, mimeType: 'text/markdown' }],
    })
  })

  it('a refusal from the route (a skill the person can’t use) says why', async () => {
    const refused = {
      ok: false,
      status: 400,
      body: null,
      json: async () => ({ error: 'skill not found', code: 'SKILL_NOT_FOUND' }),
    } as unknown as Response
    await mounted({}, [refused])
    await typeAndSend('/brief go')
    await act(async () => {
      await flush()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('skill not found')
  })
})
