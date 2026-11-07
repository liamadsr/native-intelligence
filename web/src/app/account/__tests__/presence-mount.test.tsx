// @vitest-environment jsdom
/**
 * PresenceMount (../presence-mount, inside AccountProviders) starts the
 * presence client only for a signed-in person: nothing while signed out, a
 * start on sign-in, a stop on sign-out or unmount, and a restart when another
 * person signs in. An errored lookup is not a sign-out. Renders nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  user: null as { id: string } | null,
  lookupError: null as { message: string } | null,
  listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
  unsubscribe: vi.fn(),
  started: [] as string[],
  stopped: [] as string[],
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: env.user }, error: env.lookupError }),
      onAuthStateChange: (cb: NonNullable<typeof env.listener>) => {
        env.listener = cb
        return { data: { subscription: { unsubscribe: env.unsubscribe } } }
      },
    },
  }),
}))
vi.mock('@/lib/presence/client', () => ({
  startPresence: (userId: string) => {
    env.started.push(userId)
    return () => env.stopped.push(userId)
  },
}))

import { PresenceMount } from '../presence-mount'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  env.user = null
  env.lookupError = null
  env.listener = null
  env.unsubscribe.mockReset()
  env.started = []
  env.stopped = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = () => act(async () => root.render(h(PresenceMount)))

describe('PresenceMount', () => {
  it('starts nothing while signed out, and renders nothing', async () => {
    await render()
    expect(env.started).toEqual([])
    expect(container.innerHTML).toBe('')
  })

  it('starts for the signed-in person, and stops on unmount', async () => {
    env.user = { id: 'user-1' }
    await render()
    expect(env.started).toEqual(['user-1'])
    act(() => root.unmount())
    expect(env.stopped).toEqual(['user-1'])
    expect(env.unsubscribe).toHaveBeenCalled()
    root = createRoot(container)
  })

  it('follows sign-in, sign-out and a switch of person', async () => {
    await render()
    await act(async () => env.listener!('SIGNED_IN', { user: { id: 'user-1' } }))
    expect(env.started).toEqual(['user-1'])
    // A token refresh names the same person: no restart.
    await act(async () => env.listener!('TOKEN_REFRESHED', { user: { id: 'user-1' } }))
    expect(env.started).toEqual(['user-1'])
    await act(async () => env.listener!('SIGNED_IN', { user: { id: 'user-2' } }))
    expect(env.stopped).toEqual(['user-1'])
    expect(env.started).toEqual(['user-1', 'user-2'])
    await act(async () => env.listener!('SIGNED_OUT', null))
    expect(env.stopped).toEqual(['user-1', 'user-2'])
    expect(env.started).toEqual(['user-1', 'user-2'])
  })

  it('an errored lookup is not a sign-out', async () => {
    env.lookupError = { message: 'offline' }
    await render()
    expect(env.started).toEqual([])
    await act(async () => env.listener!('INITIAL_SESSION', { user: { id: 'user-1' } }))
    expect(env.started).toEqual(['user-1'])
  })
})
