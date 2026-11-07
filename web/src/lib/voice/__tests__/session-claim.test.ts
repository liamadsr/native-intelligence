// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import {
  claimVoiceSession,
  isVoiceSessionHeld,
  releaseVoiceSession,
  subscribeVoiceSession,
  useVoiceSessionHeld,
} from '../session-claim'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * One voice conversation per page (../session-claim): claiming ends another
 * holder; and whether one is held, live, which Interactive mode yields to.
 */

const owners: object[] = []
afterEach(() => {
  for (const o of owners.splice(0)) releaseVoiceSession(o)
})
const owner = () => {
  const o = {}
  owners.push(o)
  return o
}

describe('session-claim', () => {
  it('claiming ends another holder; releasing by someone else does nothing', () => {
    const a = owner()
    const b = owner()
    const endA = vi.fn()
    claimVoiceSession(a, endA)
    claimVoiceSession(b, () => {})
    expect(endA).toHaveBeenCalledTimes(1)
    releaseVoiceSession(a)
    expect(isVoiceSessionHeld()).toBe(true)
    releaseVoiceSession(b)
    expect(isVoiceSessionHeld()).toBe(false)
  })

  it('says when a conversation comes to hold the voice and when it lets go (not on a hand-over)', () => {
    const listener = vi.fn()
    const stop = subscribeVoiceSession(listener)
    const a = owner()
    const b = owner()
    claimVoiceSession(a, () => {})
    expect(listener).toHaveBeenCalledTimes(1)
    claimVoiceSession(b, () => {})
    expect(listener).toHaveBeenCalledTimes(1)
    releaseVoiceSession(b)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })

  it('useVoiceSessionHeld follows it', async () => {
    let held: boolean | null = null
    function Probe() {
      held = useVoiceSessionHeld()
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(h(Probe)))
    expect(held).toBe(false)
    const a = owner()
    await act(async () => claimVoiceSession(a, () => {}))
    expect(held).toBe(true)
    await act(async () => releaseVoiceSession(a))
    expect(held).toBe(false)
    await act(async () => root.unmount())
  })
})
