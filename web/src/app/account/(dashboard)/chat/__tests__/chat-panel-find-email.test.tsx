// @vitest-environment jsdom
/**
 * The contact panel → Find-email handoff, at the ChatPanel handle.
 *
 * "Find email" on a contact's empty email row dispatches
 * `dial8:find-contact-email`; the shell forwards it to the ACTIVE tab's panel
 * via `findContactEmail`. What this pins:
 *
 *   • the panel selects the `find-email` system skill, so the turn runs inside
 *     its two-category tool allowlist (contacts + emails) and under its
 *     anti-fabrication prompt;
 *   • it auto-sends the SEEDED turn naming the contact and its anchors, rather
 *     than a bare `/find-email` the model would have to interrogate;
 *   • the skill RELEASES after the send — unlike Scout, this is one turn of
 *     work, and a chip left armed would scope the user's next unrelated
 *     question to two categories;
 *   • a deployment WITHOUT the skill (migration 263 unapplied) toasts rather
 *     than degrading to a plain send. That is the deliberate opposite of the
 *     prospecting handoff: the seed authorizes a CRM write off a click, and
 *     handing that sentence to an unarmed general assistant asks it to save an
 *     address with none of the confidence tiers that make the save safe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const sendMessage = vi.fn()
// Hoisted: vi.mock factories run before module-level consts are initialised,
// and `sonner` is imported transitively by email-draft-card at collect time.
const hoisted = vi.hoisted(() => ({ toastError: vi.fn() }))
const toastError = hoisted.toastError

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage,
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: 'ready',
    stop: vi.fn(),
    error: undefined,
    regenerate: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: hoisted.toastError, success: vi.fn(), message: vi.fn() },
  Toaster: () => null,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}))

// The composer's Capture button needs the recording + tabs providers, which
// these tests don't mount; it has its own tests (capture-bar-button-calendar).
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))

// The skill list is fetched over HTTP on mount; the tests drive it directly.
let commands: Array<Record<string, unknown>> = []
vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => commands,
  SlashCommandPicker: () => null,
}))

import { ChatPanel, SKILL_LOOKUP_TIMEOUT_MS, type ChatPanelHandle } from '../chat-panel'
import {
  FIND_CONTACT_EMAIL_EVENT,
  buildFindEmailSeedText,
  startFindContactEmail,
  type FindContactEmailContext,
} from '../../prospecting/start-event'

const FIND_EMAIL = {
  id: 'skill-find-email',
  slug: 'find-email',
  name: 'Find email',
  icon: null,
  color: null,
  description: null,
  views_context: null,
}

const CTX: FindContactEmailContext = {
  contactId: 'ct-1',
  contactName: 'Ada Lovelace',
  jobTitle: 'CTO',
  companyName: 'Acme',
  companyDomain: 'acme.com',
  linkedinUrl: null,
}

describe('ChatPanel.findContactEmail', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(ChatPanel, {
          ref,
          chatSessionId: 'sess-1',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
        }),
      )
    })
  }

  beforeEach(() => {
    sendMessage.mockClear()
    toastError.mockClear()
    commands = [FIND_EMAIL]
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('selects the find-email skill and auto-sends the seeded turn', async () => {
    await mount()
    await act(async () => {
      await ref.current!.findContactEmail(CTX)
    })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message.text).toBe(buildFindEmailSeedText(CTX))
    expect(message.text).toContain('The user clicked Find email')
    expect(message.text).toContain('(contact_id ct-1)')
    // The turn runs inside the skill's tool allowlist and prompt.
    expect(options.body.skillId).toBe('skill-find-email')
    // …and says so in the transcript: the chip is released on the next line, so
    // this metadata is the only sign a skill drove the turn.
    expect(message.metadata).toEqual({ skillSlug: 'find-email', skillName: 'Find email', createdAt: expect.any(String) })
  })

  it('the send carries no model and no thinking level: the server picks the model per turn', async () => {
    await mount()
    await act(async () => {
      await ref.current!.findContactEmail(CTX)
    })
    const [, options] = sendMessage.mock.calls[0]
    expect(options.body).not.toHaveProperty('model')
    expect(options.body).not.toHaveProperty('thinking')
  })

  it('focuses the chat input — the chat strip is already beside the panel', async () => {
    await mount()
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    await act(async () => {
      await ref.current!.findContactEmail(CTX)
    })
    expect(document.activeElement).toBe(textarea)
  })

  it('releases the skill after the send — the NEXT turn carries no skillId', async () => {
    await mount()
    await act(async () => {
      await ref.current!.findContactEmail(CTX)
    })
    // Scout stays armed because it is a conversation. This is a button: the
    // user's next message is usually about something else entirely, and it
    // should not run inside a two-category allowlist.
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      setter.call(textarea, 'what meetings do I have tomorrow?')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0][1].body.skillId).toBe('skill-find-email')
    expect(sendMessage.mock.calls[1][1].body.skillId).toBeUndefined()
  })

  /**
   * The full seam, minus the shell: the panel's real dispatcher → the real
   * CustomEvent → the one line the shell adds → the real handle. Same approach
   * as the prospecting-start test (DashboardShell has never been mounted in a
   * test), and enough to prove the detail survives the event boundary.
   */
  it('a dispatched dial8:find-contact-email reaches the handle with its detail intact', async () => {
    await mount()
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail as FindContactEmailContext | undefined
      if (!detail) return
      void ref.current!.findContactEmail(detail)
    }
    window.addEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    try {
      await act(async () => {
        startFindContactEmail(CTX)
        await Promise.resolve()
      })
    } finally {
      window.removeEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    }

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message.text).toBe(buildFindEmailSeedText(CTX))
    expect(options.body.skillId).toBe('skill-find-email')
  })

  it('toasts and sends NOTHING when the skill is missing (migration not applied)', async () => {
    commands = []
    await mount()
    // The lookup waits out its full window before giving up — a cold-load click
    // must not lose the skill. Run the clock rather than the wall.
    vi.useFakeTimers()
    let done: Promise<void>
    await act(async () => {
      done = ref.current!.findContactEmail(CTX) as unknown as Promise<void>
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SKILL_LOOKUP_TIMEOUT_MS + 200)
      await done
    })
    vi.useRealTimers()

    // Deliberately NOT a degraded send: the seed authorizes a CRM write, and an
    // unarmed model has none of the rules that make that write safe.
    expect(sendMessage).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
