// @vitest-environment jsdom
/**
 * The dashboard voice-enrollment nudge card (§6 + Appendix A of the voice-
 * enrollment plan). The contract these pin:
 *   • hidden while the profile status is still loading (no flash on first paint);
 *   • hidden once enrolled (auto-hides forever, no dismissal needed);
 *   • hidden when user_metadata.voice_nudge_dismissed is true;
 *   • shown iff !enrolled && !dismissed;
 *   • "Later" persists dismissal user-globally via auth.updateUser (the whole
 *     point — "Later" in one workspace must silence it everywhere);
 *   • the CTA links to /account/voice-enrollment.
 *
 * Mount standalone with createRoot/act (attention-card-work.test precedent — no
 * @testing-library). use-voice-profile and the supabase browser client are
 * mocked; framer-motion is stubbed so the card renders synchronously.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceProfileStatus } from '@/lib/voice-profile/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub framer-motion so motion.div renders as a plain div synchronously (no
// entrance-animation gating on visibility).
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          const { initial, animate, exit, transition, layout, ...rest } =
            props as Record<string, unknown>
          void initial
          void animate
          void exit
          void transition
          void layout
          return React.createElement(tag, rest)
        },
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

// --- use-voice-profile: mutable per-test state ---
let voiceState: { status: VoiceProfileStatus | null; loading: boolean } = {
  status: null,
  loading: true,
}
vi.mock('@/hooks/use-voice-profile', () => ({
  useVoiceProfile: () => ({ ...voiceState, refresh: vi.fn() }),
}))

// --- supabase browser client: mutable metadata + a spy on updateUser ---
let voiceNudgeDismissed = false
const updateUser = vi.fn(async () => ({ data: {}, error: null }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { user_metadata: { voice_nudge_dismissed: voiceNudgeDismissed } } },
        error: null,
      }),
      updateUser,
    },
  }),
}))

import { VoiceNudgeCard } from '../voice-nudge-card'

function enrolled(): VoiceProfileStatus {
  return { enrolled: true, quality: 0.9, chunkCount: 18, createdAt: '2026-07-15T00:00:00Z' }
}
function notEnrolled(): VoiceProfileStatus {
  return { enrolled: false, quality: null, chunkCount: 0, createdAt: null }
}

let container: HTMLDivElement
let root: Root

// Render + flush the async getUser() effect so `dismissed` resolves.
async function renderCard() {
  await act(async () => {
    root.render(h(VoiceNudgeCard))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function cardText(): string {
  return container.textContent ?? ''
}

describe('VoiceNudgeCard', () => {
  beforeEach(() => {
    voiceState = { status: null, loading: true }
    voiceNudgeDismissed = false
    updateUser.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('renders nothing while the profile status is still loading (no flash)', async () => {
    voiceState = { status: null, loading: true }
    await renderCard()
    expect(cardText()).toBe('')
    expect(container.querySelector('a')).toBeNull()
  })

  it('renders nothing once the user is enrolled', async () => {
    voiceState = { status: enrolled(), loading: false }
    await renderCard()
    expect(cardText()).toBe('')
  })

  it('renders nothing when voice_nudge_dismissed is set in user_metadata', async () => {
    voiceState = { status: notEnrolled(), loading: false }
    voiceNudgeDismissed = true
    await renderCard()
    expect(cardText()).toBe('')
  })

  it('shows the card when not enrolled and not dismissed', async () => {
    voiceState = { status: notEnrolled(), loading: false }
    await renderCard()
    expect(cardText()).toContain('Teach Dial8 your voice')
  })

  it('links the CTA to /account/voice-enrollment', async () => {
    voiceState = { status: notEnrolled(), loading: false }
    await renderCard()
    const link = container.querySelector('a') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    // next/link renders a plain anchor whose href attribute is the literal path.
    expect(link!.getAttribute('href')).toBe('/account/voice-enrollment')
  })

  it('"Later" persists dismissal user-globally via auth.updateUser and hides the card', async () => {
    voiceState = { status: notEnrolled(), loading: false }
    await renderCard()
    const laterBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Later'),
    )
    expect(laterBtn).toBeTruthy()
    await act(async () => {
      laterBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(updateUser).toHaveBeenCalledWith({ data: { voice_nudge_dismissed: true } })
    // Optimistic hide — the card is gone from the DOM after dismissal.
    expect(cardText()).toBe('')
  })
})
