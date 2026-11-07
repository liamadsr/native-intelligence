// @vitest-environment jsdom
/**
 * Locks the F2 first-land adoption gating (conversational onboarding):
 *   - a returning user with a persisted conversation is NEVER hijacked;
 *   - adoption happens at most once per workspace (localStorage bit), so a later
 *     New chat does not re-adopt the onboarding thread;
 *   - only within the recent-completion window AND only when research ran;
 *   - the adopted conversation id comes from POST /api/account/chat-history/home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import {
  useHomeConversationAdoption,
  isRecentlyCompleted,
  homeAdoptedKey,
  RECENT_COMPLETION_MS,
} from '../use-home-conversation-adoption'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

/** Program the two fetches: onboarding read, then the home get-or-create. */
function programFetch(opts: {
  completedAt?: string | null
  hasResearch?: boolean
  homeConversationId?: string
  onboardingOk?: boolean
  homeOk?: boolean
}) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/account/onboarding') {
      return Promise.resolve({
        ok: opts.onboardingOk ?? true,
        json: async () => ({
          member: {
            onboardingCompletedAt: opts.completedAt ?? null,
            onboardingProgress: opts.hasResearch ? { research: { status: 'done' } } : {},
          },
        }),
      })
    }
    if (url === '/api/account/chat-history/home') {
      return Promise.resolve({
        ok: opts.homeOk ?? true,
        json: async () => ({ conversationId: opts.homeConversationId ?? 'home-1' }),
      })
    }
    return Promise.resolve({ ok: false, json: async () => ({}) })
  })
}

function mount(initial: { workspaceId: string | null; alreadyPersistedConversation: boolean }) {
  const container = document.createElement('div')
  const root = createRoot(container)
  let props = initial
  let result: string | null = null
  function Harness() {
    result = useHomeConversationAdoption(props)
    return null
  }
  const render = () => act(() => { root.render(h(Harness)) })
  render()
  return {
    set(next: Partial<typeof props>) {
      props = { ...props, ...next }
      render()
    },
    result: () => result,
    unmount: () => act(() => root.unmount()),
  }
}

/** Let the effect's awaited fetch chain settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const now = new Date().toISOString()

beforeEach(() => {
  fetchMock.mockReset()
  localStorage.clear()
})
afterEach(() => vi.clearAllMocks())

describe('isRecentlyCompleted', () => {
  it('true for a just-completed onboarding', () => {
    expect(isRecentlyCompleted(now)).toBe(true)
  })
  it('false with no timestamp', () => {
    expect(isRecentlyCompleted(null)).toBe(false)
    expect(isRecentlyCompleted(undefined)).toBe(false)
  })
  it('false outside the window', () => {
    const old = new Date(Date.now() - RECENT_COMPLETION_MS - 60_000).toISOString()
    expect(isRecentlyCompleted(old)).toBe(false)
  })
  it('tolerates small clock skew but rejects a far-future stamp', () => {
    expect(isRecentlyCompleted(new Date(Date.now() + 10_000).toISOString())).toBe(true)
    expect(isRecentlyCompleted(new Date(Date.now() + 60 * 60_000).toISOString())).toBe(false)
  })
})

describe('useHomeConversationAdoption', () => {
  it('adopts the home conversation on a fresh recent-completion first land', async () => {
    programFetch({ completedAt: now, hasResearch: true, homeConversationId: 'home-42' })
    const hk = mount({ workspaceId: 'w1', alreadyPersistedConversation: false })
    await flush()
    expect(hk.result()).toBe('home-42')
    // Adopt-once bit persisted.
    expect(localStorage.getItem(homeAdoptedKey('w1'))).toBe('1')
  })

  it('NEVER hijacks a returning user who already has a persisted conversation', async () => {
    programFetch({ completedAt: now, hasResearch: true })
    const hk = mount({ workspaceId: 'w1', alreadyPersistedConversation: true })
    await flush()
    expect(hk.result()).toBeNull()
    // No network at all — the hard gate is pre-fetch.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not re-adopt when the adopt-once bit is already set (post New chat)', async () => {
    localStorage.setItem(homeAdoptedKey('w1'), '1')
    programFetch({ completedAt: now, hasResearch: true })
    const hk = mount({ workspaceId: 'w1', alreadyPersistedConversation: false })
    await flush()
    expect(hk.result()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not adopt when onboarding completed too long ago', async () => {
    const old = new Date(Date.now() - RECENT_COMPLETION_MS - 60_000).toISOString()
    programFetch({ completedAt: old, hasResearch: true })
    const hk = mount({ workspaceId: 'w1', alreadyPersistedConversation: false })
    await flush()
    expect(hk.result()).toBeNull()
    // The onboarding read happened, but no home get-or-create.
    expect(fetchMock).toHaveBeenCalledWith('/api/account/onboarding', expect.anything())
    expect(fetchMock).not.toHaveBeenCalledWith('/api/account/chat-history/home', expect.anything())
  })

  it('does not adopt when research never ran', async () => {
    programFetch({ completedAt: now, hasResearch: false })
    const hk = mount({ workspaceId: 'w1', alreadyPersistedConversation: false })
    await flush()
    expect(hk.result()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/account/chat-history/home', expect.anything())
  })
})
