// @vitest-environment jsdom
/**
 * New desktop users record meetings automatically (Liam, 2026-10-08): the one
 * meeting setting, Auto-record, defaults on. The wizard turns it on once per
 * Mac (a second workspace's onboarding never overrides a choice made since),
 * and never in a browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const env = vi.hoisted(() => ({
  desktop: true,
  setAutoRecord: vi.fn<(enabled: boolean) => Promise<void>>(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: { setAutoRecord: (enabled: boolean) => env.setAutoRecord(enabled) },
}))
vi.mock('../hard-navigate', () => ({
  hardNavigate: () => {},
  DOCUMENT_SCOPE_HEADERS: { 'x-workspace-id': '' },
}))
vi.mock('../onboarding-steps', () => {
  const React = require('react')
  return {
    PrimeStep: () => React.createElement('div', { 'data-step': 'prime' }),
    WorkingStep: () => React.createElement('div', { 'data-step': 'working' }),
  }
})
vi.mock('../question-steps', () => {
  const React = require('react')
  return {
    SourceStep: () => React.createElement('div', { 'data-step': 'source' }),
    MeetingsStep: () => React.createElement('div', { 'data-step': 'meetings' }),
  }
})
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          const { initial, animate, exit, transition, ...rest } = props as Record<string, unknown>
          void initial
          void animate
          void exit
          void transition
          return React.createElement(tag, rest)
        },
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children),
  }
})

import { OnboardingWizard } from '../onboarding-wizard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A fresh member: no step answered yet. */
globalThis.fetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({
    member: { id: 'member-1', displayName: 'Liam', onboardingCompletedAt: null, onboardingProgress: {} },
    connectedAccounts: [],
    workspace: { id: 'ws-1' },
    userEmail: 'liam@dial8.ai',
    userName: 'Liam A',
    avatarUrl: null,
  }),
})) as never

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  env.desktop = true
  env.setAutoRecord.mockReset().mockResolvedValue(undefined)
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mountWizard() {
  act(() => {
    root.render(<OnboardingWizard />)
  })
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

describe('onboarding: Auto-record defaults on for new desktop users', () => {
  it('turns Auto-record on, once per Mac', async () => {
    await mountWizard()
    expect(container.querySelector('[data-step="source"]')).not.toBeNull()
    expect(env.setAutoRecord.mock.calls).toEqual([[true]])

    // Another onboarding on the same Mac (a second workspace) leaves it be.
    act(() => root.unmount())
    root = createRoot(container)
    await mountWizard()
    expect(env.setAutoRecord).toHaveBeenCalledTimes(1)
  })

  it('never in a browser', async () => {
    env.desktop = false
    await mountWizard()
    expect(env.setAutoRecord).not.toHaveBeenCalled()
  })

  it('a desktop without the command is no problem', async () => {
    env.setAutoRecord.mockRejectedValue(new Error('command set_auto_record not found'))
    await mountWizard()
    expect(container.querySelector('[data-step="source"]')).not.toBeNull()
  })
})
