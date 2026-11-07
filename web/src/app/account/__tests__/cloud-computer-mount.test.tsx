// @vitest-environment jsdom
/**
 * The computer's doorbell in an account window (cloud-computer-mount.tsx): its
 * own topic, rings for this window's workspace only, and a driver change makes
 * an open live view connect again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const realtime = vi.hoisted(() => ({ topic: '', handlers: new Map<string, (message: Record<string, unknown>) => void>() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    realtime: { setAuth: async () => {} },
    channel: (topic: string) => {
      realtime.topic = topic
      const channel = {
        on: (_type: string, { event }: { event: string }, handler: (message: Record<string, unknown>) => void) => { realtime.handlers.set(event, handler); return channel },
        subscribe: () => channel,
      }
      return channel
    },
    removeChannel: async () => {},
  }),
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-here' }))
vi.mock('@/components/cloud-browser/live-view', () => ({ CloudBrowserLiveView: () => null }))

import { CloudComputerMount } from '../cloud-computer-mount'
import { __resetComputerForTests, getComputer } from '@/lib/cloud-browser/computer-client'

let root: Root
let host: HTMLElement
const ring = (event: string, workspaceId: string) => act(() => realtime.handlers.get(event)!({ payload: { workspaceId } }))
beforeEach(async () => {
  __resetComputerForTests()
  realtime.handlers.clear()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ exists: true, status: 'running', driver: 'agent', busy: false, liveView: true })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<CloudComputerMount />))
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('the computer doorbell', () => {
  it('listens on the computer’s own topic', () => {
    expect(realtime.topic).toBe('browser-cmd:user-1:computer')
  })

  it('shows and hides the live view for this window’s workspace only', () => {
    ring('browser-show', 'ws-elsewhere')
    expect(getComputer().viewOpen).toBe(false)
    ring('browser-show', 'ws-here')
    expect(getComputer().viewOpen).toBe(true)
    ring('browser-hide', 'ws-elsewhere')
    expect(getComputer().viewOpen).toBe(true)
    ring('browser-hide', 'ws-here')
    expect(getComputer().viewOpen).toBe(false)
  })

  it('connects an open view again when the driver changes', () => {
    const before = getComputer().viewEpoch
    ring('driver-changed', 'ws-elsewhere')
    expect(getComputer().viewEpoch).toBe(before)
    ring('driver-changed', 'ws-here')
    expect(getComputer().viewEpoch).toBe(before + 1)
  })
})
