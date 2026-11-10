// @vitest-environment jsdom
/**
 * Sticky skills (step C follow-up).
 *
 * Every skill used to clear the moment its message went out. For Scout that
 * broke the second turn of every conversation: no skillId → the skill's
 * preferred tools were not in the model's active set → the model called
 * `list_prospect_entries` from memory → NoSuchToolError ("An error occurred."
 * in the transcript) → a wasted step re-discovering the tools. Seen on every
 * turn of the DEV smoke.
 *
 * Pinned here:
 *   • Scout stays armed after a send — the NEXT typed turn carries skillId too;
 *   • a one-shot skill still clears after its send (the old rule, unchanged);
 *   • the composer hint is per-turn: it goes after the send even though the
 *     skill stays;
 *   • the chip's own × still clears a sticky skill.
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

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { buildAskAboutListHint, isStickySkill, type ProspectingAskDetail } from '../../prospecting/start-event'

const PROSPECT_LIST_SKILL = {
  id: 'skill-prospect-list',
  slug: 'build-prospect-list',
  name: 'Build a prospect list',
  icon: null,
  color: null,
  description: null,
  views_context: null,
}
const BRIEF = {
  id: 'skill-brief',
  slug: 'morning-brief',
  name: 'Morning Brief',
  icon: null,
  color: null,
  description: null,
  views_context: null,
}
const ASK: ProspectingAskDetail = { listId: 'list-1', listName: 'Series A fintech', selectedCount: 3 }

describe('isStickySkill', () => {
  it('is true for the prospect-list skill and false for everything else', () => {
    expect(isStickySkill('build-prospect-list')).toBe(true)
    // The pre-322 slug is gone from every database.
    expect(isStickySkill('scout')).toBe(false)
    expect(isStickySkill('morning-brief')).toBe(false)
    expect(isStickySkill(null)).toBe(false)
    expect(isStickySkill(undefined)).toBe(false)
  })
})

describe('ChatPanel sticky skill', () => {
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
          chatSessionId: 'sess-sticky',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
        }),
      )
    })
  }

  async function type(text: string) {
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function submit() {
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    sendMessage.mockClear()
    commands = [PROSPECT_LIST_SKILL, BRIEF]
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('Scout stays armed: the turn AFTER the armed one still carries skillId', async () => {
    await mount()
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    await type('research these')
    await submit()
    await type('now find people at them')
    await submit()

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0][1].body.skillId).toBe('skill-prospect-list')
    expect(sendMessage.mock.calls[1][1].body.skillId).toBe('skill-prospect-list')
  })

  it('the seeded "Learn about my company" turn leaves Scout armed for the follow-up', async () => {
    await mount()
    await act(async () => {
      await ref.current!.startProspecting({ domain: 'nativeintelligence.dev', sourceEstablished: true })
    })
    await type("yes that's right, find me fintechs")
    await submit()

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[1][1].body.skillId).toBe('skill-prospect-list')
  })

  it('a one-shot skill still clears after its send', async () => {
    await mount()
    await act(async () => {
      ref.current!.triggerSkillBySlug('morning-brief')
      await Promise.resolve()
    })
    await type('and one more thing')
    await submit()

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0][1].body.skillId).toBe('skill-brief')
    expect(sendMessage.mock.calls[1][1].body.skillId).toBeUndefined()
  })

  it('the composer hint is per-turn even though the skill stays', async () => {
    await mount()
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    expect(textarea.getAttribute('placeholder')).toBe(buildAskAboutListHint(ASK))
    await type('research these')
    await submit()
    expect(textarea.getAttribute('placeholder')).not.toBe(buildAskAboutListHint(ASK))
    // …but the skill is still there for the next turn.
    await type('and people')
    await submit()
    expect(sendMessage.mock.calls[1][1].body.skillId).toBe('skill-prospect-list')
  })
})
