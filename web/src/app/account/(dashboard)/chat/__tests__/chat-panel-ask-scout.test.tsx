// @vitest-environment jsdom
/**
 * "Ask about this list" (B7) + the selection seam (B6), at the ChatPanel handle.
 *
 * The sibling spec (chat-panel-start-prospecting.test.tsx) pins the handoff that
 * SENDS. This one pins the handoff that deliberately does NOT, and the reason
 * the distinction matters is money: `askAboutList` fires when the user has rows
 * selected and a question we can't guess. Auto-sending anything here would put
 * words in their mouth that the model may act on with a paid tool.
 *
 * So what's pinned:
 *   • askAboutList arms — selects the `scout` skill (so the turn the user writes
 *     runs inside its allowlist), focuses the input, shows a hint naming the
 *     selection — and calls sendMessage ZERO times;
 *   • the user's subsequent submit carries BOTH the skillId and the selection;
 *   • the selection reaches the transport body through the systemContextRef
 *     spread, with NO change to either body builder — the whole point of
 *     putting it on systemContext rather than adding a parallel field;
 *   • a missing skill (migration 253 unapplied) still focuses + hints rather
 *     than leaving a dead button.
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
// PromptInputTextarea BLANKS the placeholder when the field measures narrower
// than 220px (a cramped panel shouldn't show clipped text). jsdom lays nothing
// out, so every element reports clientWidth 0 and the placeholder would always
// come back "" — the assertion would pass vacuously in the "no hint" direction
// and fail in the one we care about. Give the textarea a realistic width.
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 400,
})

const sendMessage = vi.fn()

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

let commands: Array<Record<string, unknown>> = []
vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => commands,
  SlashCommandPicker: () => null,
}))

import { ChatPanel, SKILL_LOOKUP_TIMEOUT_MS, type ChatPanelHandle } from '../chat-panel'
import {
  PROSPECTING_ASK_EVENT,
  askAboutList,
  buildAskAboutListHint,
  type ProspectingAskDetail,
} from '../../prospecting/start-event'
import type { ProspectingSelectionSnapshot } from '../../prospecting/selection-context'

const PROSPECT_LIST_SKILL = {
  id: 'skill-prospect-list',
  slug: 'build-prospect-list',
  name: 'Build a prospect list',
  icon: null,
  color: null,
  description: null,
  views_context: null,
}

const SELECTION: ProspectingSelectionSnapshot = {
  listId: 'list-1',
  listName: 'Series A fintech',
  tab: 'company',
  filter: 'all',
  selectedEntryIds: ['e1', 'e2', 'e3'],
  selectedCount: 3,
}

const ASK: ProspectingAskDetail = {
  listId: 'list-1',
  listName: 'Series A fintech',
  selectedCount: 3,
}

describe('buildAskAboutListHint', () => {
  it('names the count so the user can see the handoff landed', () => {
    expect(buildAskAboutListHint(ASK)).toBe('Ask about the 3 selected rows…')
  })
  it('singular reads as one row', () => {
    expect(buildAskAboutListHint({ ...ASK, selectedCount: 1 })).toBe('Ask about the 1 selected row…')
  })
  it('nothing selected falls back to the list — asking about the list is legal', () => {
    expect(buildAskAboutListHint({ ...ASK, selectedCount: 0 })).toBe('Ask about Series A fintech…')
  })
})

describe('ChatPanel.askAboutList', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  async function mount(systemContext?: Record<string, unknown>) {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(ChatPanel, {
          ref,
          chatSessionId: 'sess-ask',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
          ...(systemContext ? { systemContext } : {}),
        }),
      )
    })
  }

  async function type(text: string) {
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** The composer is a div, not a form — Enter (without shift) is the send. */
  async function submit() {
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    sendMessage.mockClear()
    commands = [PROSPECT_LIST_SKILL]
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('arms the composer and sends NOTHING — the user still owns the question', async () => {
    await mount()
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('focuses the input and shows the selection hint as the placeholder', async () => {
    await mount()
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    expect(document.activeElement).toBe(textarea)
    expect(textarea.getAttribute('placeholder')).toBe(buildAskAboutListHint(ASK))
  })

  it('selects the scout skill, so the turn the user writes carries its skillId', async () => {
    await mount()
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    await type('Which of these raised recently?')
    await submit()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message.text).toBe('Which of these raised recently?')
    expect(options.body.skillId).toBe('skill-prospect-list')
  })

  /**
   * The B6 claim: because BOTH send paths spread `systemContextRef.current`,
   * the selection rides along with no change to either body builder. If someone
   * later replaces the spread with an explicit field list, this fails.
   */
  it('the user’s send carries the prospecting selection via the systemContext spread', async () => {
    await mount({ conversationContext: 'User is viewing prospect list: "Series A fintech" (list-1)', prospectingSelection: SELECTION })
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    await type('Research these.')
    await submit()

    const [, options] = sendMessage.mock.calls[0]
    expect(options.body.systemContext.prospectingSelection).toEqual(SELECTION)
    // The context line the tab already emitted is still there — the selection is
    // additive, not a replacement.
    expect(options.body.systemContext.conversationContext).toContain('prospect list')
  })

  it('the selection rides on EVERY turn, not just the armed one', async () => {
    await mount({ prospectingSelection: SELECTION })
    await type('First question.')
    await submit()
    await type('And a follow-up about the same rows.')
    await submit()

    expect(sendMessage).toHaveBeenCalledTimes(2)
    for (const [, options] of sendMessage.mock.calls) {
      expect(options.body.systemContext.prospectingSelection).toEqual(SELECTION)
    }
    // No skill was armed, so nothing forced one onto these turns.
    expect(sendMessage.mock.calls[0][1].body.skillId).toBeUndefined()
  })

  it('a dispatched dial8:prospecting-ask reaches the handle with its detail intact', async () => {
    await mount()
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail as ProspectingAskDetail | undefined
      if (!detail) return
      void ref.current!.askAboutList(detail)
    }
    window.addEventListener(PROSPECTING_ASK_EVENT, listener)
    try {
      await act(async () => {
        askAboutList(ASK)
        await Promise.resolve()
      })
    } finally {
      window.removeEventListener(PROSPECTING_ASK_EVENT, listener)
    }
    const textarea = container.querySelector('textarea')!
    expect(textarea.getAttribute('placeholder')).toBe(buildAskAboutListHint(ASK))
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('still focuses + hints when the skill is missing (migration not applied yet)', async () => {
    commands = []
    await mount()
    vi.useFakeTimers()
    let done: Promise<void>
    await act(async () => {
      done = ref.current!.askAboutList(ASK) as unknown as Promise<void>
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SKILL_LOOKUP_TIMEOUT_MS + 200)
      await done
    })
    vi.useRealTimers()

    const textarea = container.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    expect(textarea.getAttribute('placeholder')).toBe(buildAskAboutListHint(ASK))
    expect(sendMessage).not.toHaveBeenCalled()

    // A send still works — the general assistant beats a dead button.
    await type('Anything interesting here?')
    await submit()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1].body.skillId).toBeUndefined()
  })
})
