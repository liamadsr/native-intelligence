// Node environment: no window, no AudioContext — the server render path.
import { describe, it, expect } from 'vitest'
import { canPlaySoundsNow, playSound, preloadSounds, primeSounds, stopAllSounds, unlockSounds } from '../engine'
import { getSoundEffectsEnabled } from '../settings'

describe('sound engine on the server', () => {
  it('never throws and resolves at once', async () => {
    expect(() => primeSounds()).not.toThrow()
    expect(() => unlockSounds()).not.toThrow()
    expect(canPlaySoundsNow()).toBe(false)
    expect(getSoundEffectsEnabled()).toBe(true)
    const handle = playSound('voice-chat-start')
    await expect(handle.started).resolves.toBe(false)
    await expect(handle.ended).resolves.toBeUndefined()
    expect(() => handle.stop()).not.toThrow()
    expect(() => stopAllSounds()).not.toThrow()
    await expect(preloadSounds()).resolves.toBeUndefined()
  })
})
