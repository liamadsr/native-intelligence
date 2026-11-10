// @vitest-environment jsdom
/**
 * PACKAGE B — the Prospecting → Scout handoff, at the ChatPanel handle.
 *
 * "Learn about my company" on the Prospecting page dispatches
 * `ni:prospecting-start`; the shell forwards it to the ACTIVE tab's panel via
 * `startProspecting`. What this pins:
 *
 *   • the panel selects the `scout` system skill (the send carries its
 *     `skillId`, so the turn runs inside the skill's tool allowlist), and
 *   • auto-sends the SEEDED first turn — the domain and whether the workspace
 *     already has a source company — rather than a bare `/scout`, so Scout's
 *     first move isn't a question it already has the answer to;
 *   • it focuses the chat input, since Scout shares the tab the user is on
 *     (Liam's decision 2) and the strip is always mounted beside the page;
 *   • a click that lands before the skill list has finished loading still
 *     sends, once the skill appears;
 *   • a deployment without the skill (migration 253 not applied) degrades to a
 *     plain send rather than a dead button.
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

// The panel reads the live-capture recorder only to flush a transcript before a
// turn; there is no meeting in these tests.
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

import { ChatPanel, waitForSkillBySlug, SKILL_LOOKUP_TIMEOUT_MS, type ChatPanelHandle } from '../chat-panel'
import {
  PROSPECTING_START_EVENT,
  buildProspectingSeedText,
  startProspectingChat,
  type ProspectingStartDetail,
} from '../../prospecting/start-event'

const PROSPECT_LIST_SKILL = {
  id: 'skill-prospect-list',
  slug: 'build-prospect-list',
  name: 'Build a prospect list',
  icon: null,
  color: null,
  description: null,
  views_context: null,
}

describe('waitForSkillBySlug', () => {
  it('resolves immediately when the skill is already loaded', async () => {
    const found = await waitForSkillBySlug(() => [PROSPECT_LIST_SKILL], 'build-prospect-list')
    expect(found).toBe(PROSPECT_LIST_SKILL)
  })

  it('waits for a list that arrives late (a click during the cold-load fetch)', async () => {
    let list: typeof PROSPECT_LIST_SKILL[] = []
    setTimeout(() => { list = [PROSPECT_LIST_SKILL] }, 30)
    const found = await waitForSkillBySlug(() => list, 'build-prospect-list', { timeoutMs: 500, pollMs: 10 })
    expect(found).toBe(PROSPECT_LIST_SKILL)
  })

  it('gives up (null, not a hang) when the skill never appears', async () => {
    const found = await waitForSkillBySlug(() => [], 'build-prospect-list', { timeoutMs: 30, pollMs: 10 })
    expect(found).toBeNull()
  })
})

describe('ChatPanel.startProspecting', () => {
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
    commands = [PROSPECT_LIST_SKILL]
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('selects the scout skill and auto-sends the seeded first turn', async () => {
    await mount()
    await act(async () => {
      await ref.current!.startProspecting({ domain: 'acme.com', sourceEstablished: false })
    })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message.text).toBe(
      buildProspectingSeedText({ domain: 'acme.com', sourceEstablished: false }),
    )
    expect(message.text).toContain('Learn about my company.')
    expect(message.text).toContain('Domain: acme.com.')
    expect(message.text).toContain('Source company established: no.')
    // The turn runs inside Scout's tool allowlist.
    expect(options.body.skillId).toBe('skill-prospect-list')
    // The transcript marker: this sentence was auto-sent by a button.
    expect(message.metadata).toEqual({ skillSlug: 'build-prospect-list', skillName: 'Build a prospect list', createdAt: expect.any(String) })
  })

  it('an unknown domain reaches Scout as "unknown" (it asks with ask_user)', async () => {
    await mount()
    await act(async () => {
      await ref.current!.startProspecting({ domain: null, sourceEstablished: true })
    })
    const [message] = sendMessage.mock.calls[0]
    expect(message.text).toContain('Domain: unknown.')
    expect(message.text).toContain('Source company established: yes.')
  })

  it('focuses the chat input — Scout shares the tab the user is already on', async () => {
    await mount()
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    await act(async () => {
      await ref.current!.startProspecting({ domain: 'acme.com', sourceEstablished: false })
    })
    expect(document.activeElement).toBe(textarea)
  })

  /**
   * The full seam, minus the shell: the page's real dispatcher → the real
   * CustomEvent → the shell's forwarding line → the real handle. There is no
   * precedent for mounting DashboardShell in a test (its five existing
   * dispatch/listen pairs have none either), so what is reproduced here is the
   * one line the shell adds — `activePanel()?.startProspecting(detail)` — which
   * is enough to prove the detail survives the event boundary intact.
   */
  it('a dispatched ni:prospecting-start reaches the handle with its detail intact', async () => {
    await mount()
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail as ProspectingStartDetail | undefined
      if (!detail) return
      void ref.current!.startProspecting(detail)
    }
    window.addEventListener(PROSPECTING_START_EVENT, listener)
    try {
      await act(async () => {
        startProspectingChat({ domain: 'acme.com', sourceEstablished: true })
        // Let the skill lookup + flush microtasks settle before asserting.
        await Promise.resolve()
      })
    } finally {
      window.removeEventListener(PROSPECTING_START_EVENT, listener)
    }

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message.text).toBe(
      buildProspectingSeedText({ domain: 'acme.com', sourceEstablished: true }),
    )
    expect(options.body.skillId).toBe('skill-prospect-list')
  })

  it('still sends when the skill list is empty (migration not applied yet)', async () => {
    commands = []
    await mount()
    // The lookup waits out its full window before giving up (a cold-load click
    // must not lose the skill). Run the clock rather than the wall.
    vi.useFakeTimers()
    let done: Promise<void>
    await act(async () => {
      done = ref.current!.startProspecting({ domain: 'acme.com', sourceEstablished: false }) as unknown as Promise<void>
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SKILL_LOOKUP_TIMEOUT_MS + 200)
      await done
    })
    vi.useRealTimers()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message.text).toContain('Learn about my company.')
    // No skill to scope the turn to — a plain send beats a dead button. And no
    // "via" marker either: an unarmed turn must not claim a skill ran it.
    expect(options.body.skillId).toBeUndefined()
    // Only its time (message-time.ts): no skill marker.
    expect(message.metadata).toEqual({ createdAt: expect.any(String) })
  })
})
