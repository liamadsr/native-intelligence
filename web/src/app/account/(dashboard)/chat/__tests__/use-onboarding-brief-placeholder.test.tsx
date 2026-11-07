// @vitest-environment jsdom
/**
 * Locks the skip-race placeholder (conversational onboarding, P1 item 6):
 *   - paints an immediate narrating placeholder (never empty on the slow-
 *     research path) under the SAME stable id the real brief will use;
 *   - marks it saved so autosave never persists it;
 *   - narrates the current research phase (ages), not a static string;
 *   - never clobbers a real brief row that already replaced the placeholder;
 *   - stays inert when there's no adopted home conversation;
 *   - stops polling once research is terminal, and once it gives up (the
 *     generic greeting is never narrated over).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { useOnboardingBriefPlaceholder } from '../use-onboarding-brief-placeholder'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

function programStatus(status: string) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ member: { onboardingProgress: { research: { status } } } }),
  })
}

function mount(initial: {
  homeConversationId: string | null
  briefMessageId: string | null
  messages: UIMessage[]
}) {
  const container = document.createElement('div')
  const root = createRoot(container)
  const state = { ...initial }
  const savedIds: string[] = []
  function Harness() {
    useOnboardingBriefPlaceholder({
      homeConversationId: state.homeConversationId,
      briefMessageId: state.briefMessageId,
      messages: state.messages,
      setMessages: (updater) => { state.messages = updater(state.messages) },
      markSaved: (ids) => savedIds.push(...ids),
    })
    return null
  }
  const render = () => act(() => { root.render(h(Harness)) })
  render()
  return {
    set(next: Partial<typeof state>) {
      Object.assign(state, next)
      render()
    },
    messages: () => state.messages,
    savedIds: () => savedIds,
    unmount: () => act(() => root.unmount()),
  }
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  fetchMock.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('useOnboardingBriefPlaceholder', () => {
  it('paints an immediate narrating placeholder under the stable brief id and marks it saved', async () => {
    programStatus('running')
    const hk = mount({ homeConversationId: 'home-1', briefMessageId: 'onboarding-brief-w1', messages: [] })
    await flush()
    const msgs = hk.messages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe('onboarding-brief-w1')
    expect((msgs[0] as { metadata?: { onboarding_placeholder?: boolean } }).metadata?.onboarding_placeholder).toBe(true)
    // Narrates progress — not empty.
    expect((msgs[0].parts[0] as { text: string }).text.length).toBeGreaterThan(0)
    expect(hk.savedIds()).toContain('onboarding-brief-w1')
    hk.unmount()
  })

  it('narrates the running phase distinctly from the initial paint', async () => {
    programStatus('running')
    const hk = mount({ homeConversationId: 'home-1', briefMessageId: 'onboarding-brief-w1', messages: [] })
    await flush()
    const text = (hk.messages()[0].parts[0] as { text: string }).text
    // The 'running' narration mentions reading up on the company (ages from the
    // generic 'starting' paint).
    expect(text.toLowerCase()).toContain('company')
    hk.unmount()
  })

  it('does not clobber a real brief row that already replaced the placeholder', async () => {
    programStatus('running')
    const realBrief = {
      id: 'onboarding-brief-w1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'The real brief is here' }],
    } as unknown as UIMessage
    const hk = mount({
      homeConversationId: 'home-1',
      briefMessageId: 'onboarding-brief-w1',
      messages: [realBrief],
    })
    await flush()
    const msgs = hk.messages()
    expect(msgs).toHaveLength(1)
    // The real brief stands — the placeholder effect sees realBriefPresent and
    // never runs.
    expect((msgs[0].parts[0] as { text: string }).text).toBe('The real brief is here')
    hk.unmount()
  })

  it('stops polling once research is terminal: the brief row is on its way', async () => {
    vi.useFakeTimers()
    try {
      programStatus('done')
      const hk = mount({ homeConversationId: 'home-1', briefMessageId: 'onboarding-brief-w1', messages: [] })
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(10_000) })
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      hk.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('once it gives up, it stops polling and never narrates over the generic greeting', async () => {
    vi.useFakeTimers()
    try {
      programStatus('running')
      const hk = mount({ homeConversationId: 'home-1', briefMessageId: 'onboarding-brief-w1', messages: [] })
      await flush()
      await act(async () => { vi.advanceTimersByTime(90_000) })
      await flush()
      const greeting = (hk.messages()[0].parts[0] as { text: string }).text
      expect(greeting).toMatch(/^Welcome in/)
      const calls = fetchMock.mock.calls.length
      await act(async () => { vi.advanceTimersByTime(10_000) })
      await flush()
      expect(fetchMock.mock.calls.length).toBe(calls)
      expect((hk.messages()[0].parts[0] as { text: string }).text).toBe(greeting)
      hk.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is inert with no adopted home conversation', async () => {
    programStatus('running')
    const hk = mount({ homeConversationId: null, briefMessageId: null, messages: [] })
    await flush()
    expect(hk.messages()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    hk.unmount()
  })
})
