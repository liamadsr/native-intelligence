/**
 * The recording's controls in the HUD (lib/live-agent/hud-recording.ts):
 * what crosses windows is checked, a click runs only for its own capture and
 * only as one of the four actions, and the claim the top bar reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetHudRecordingControlsForTests,
  claimHudRecordingControls,
  hudRecordingState,
  hudShowsRecordingControls,
  readHudRecordingAction,
  readHudRecordingState,
  runHudRecordingAction,
  sameHudRecording,
  subscribeHudRecordingControls,
} from '../hud-recording'

afterEach(() => __resetHudRecordingControlsForTests())

describe('the state', () => {
  it("is the recording's own values, the transcription's health kept to three", () => {
    expect(
      hudRecordingState({ captureId: 'c', isPaused: true, isAgentFinalizing: false, transcriptionStatus: 'reconnecting', elapsedSec: 12.7, at: 5 }),
    ).toEqual({ captureId: 'c', paused: true, finalizing: false, transcription: 'reconnecting', elapsedSec: 12, at: 5 })
    expect(hudRecordingState({ captureId: 'c', isPaused: false, isAgentFinalizing: false, transcriptionStatus: 'weird', elapsedSec: -3, at: 5 })).toMatchObject({
      transcription: 'connected',
      elapsedSec: 0,
    })
  })

  it('reads only a state with a capture; a stop (`captureId: null`) or junk is null', () => {
    expect(readHudRecordingState({ captureId: 'c', paused: true, finalizing: 1, transcription: 'disconnected', elapsedSec: 9, at: 7 })).toEqual({
      captureId: 'c',
      paused: true,
      finalizing: false,
      transcription: 'disconnected',
      elapsedSec: 9,
      at: 7,
    })
    expect(readHudRecordingState({ captureId: null })).toBeNull()
    expect(readHudRecordingState('x')).toBeNull()
    expect(readHudRecordingState({ captureId: 'c', elapsedSec: 'NaN' })).toMatchObject({ elapsedSec: 0, at: 0 })
  })

  it('compares by what it draws', () => {
    const a = readHudRecordingState({ captureId: 'c', elapsedSec: 1, at: 2 })
    expect(sameHudRecording(a, readHudRecordingState({ captureId: 'c', elapsedSec: 1, at: 2 }))).toBe(true)
    expect(sameHudRecording(a, readHudRecordingState({ captureId: 'c', elapsedSec: 1, at: 2, paused: true }))).toBe(false)
    expect(sameHudRecording(null, null)).toBe(true)
    expect(sameHudRecording(a, null)).toBe(false)
  })
})

describe('a click', () => {
  const handlers = () => ({ pauseRecording: vi.fn(), resumeRecording: vi.fn(), stopRecording: vi.fn(async () => {}), openCapture: vi.fn() })

  it('runs its handler, for its own capture only', () => {
    const hs = handlers()
    expect(runHudRecordingAction({ captureId: 'c', type: 'pause' }, 'c', hs)).toBe(true)
    expect(runHudRecordingAction({ captureId: 'c', type: 'resume' }, 'c', hs)).toBe(true)
    expect(runHudRecordingAction({ captureId: 'c', type: 'stop' }, 'c', hs)).toBe(true)
    expect(runHudRecordingAction({ captureId: 'c', type: 'open' }, 'c', hs)).toBe(true)
    expect(runHudRecordingAction({ captureId: 'other', type: 'stop' }, 'c', hs)).toBe(false)
    expect(runHudRecordingAction({ captureId: 'c', type: 'delete' }, 'c', hs)).toBe(false)
    expect(runHudRecordingAction(null, 'c', hs)).toBe(false)
    expect(hs.pauseRecording).toHaveBeenCalledTimes(1)
    expect(hs.resumeRecording).toHaveBeenCalledTimes(1)
    expect(hs.stopRecording).toHaveBeenCalledTimes(1)
    expect(hs.openCapture).toHaveBeenCalledWith('c')
  })

  it('a stop that fails is swallowed (the recording surfaces its own error)', () => {
    const hs = { ...handlers(), stopRecording: vi.fn(async () => { throw new Error('nope') }) }
    expect(() => runHudRecordingAction({ captureId: 'c', type: 'stop' }, 'c', hs)).not.toThrow()
  })

  it('reads only the four actions', () => {
    expect(readHudRecordingAction({ captureId: 'c', type: 'open' })).toEqual({ captureId: 'c', type: 'open' })
    expect(readHudRecordingAction({ captureId: '', type: 'open' })).toBeNull()
    expect(readHudRecordingAction({ captureId: 'c', type: 'toString' })).toBeNull()
  })
})

describe('the claim the top bar reads', () => {
  it('holds while any HUD claims that capture, and tells its readers', () => {
    const heard = vi.fn()
    const off = subscribeHudRecordingControls(heard)
    expect(hudShowsRecordingControls('c')).toBe(false)
    const a = claimHudRecordingControls('c')
    const b = claimHudRecordingControls('c')
    expect(hudShowsRecordingControls('c')).toBe(true)
    expect(hudShowsRecordingControls('d')).toBe(false)
    expect(hudShowsRecordingControls(null)).toBe(false)
    a()
    expect(hudShowsRecordingControls('c')).toBe(true)
    b()
    b()
    expect(hudShowsRecordingControls('c')).toBe(false)
    expect(heard).toHaveBeenCalledTimes(4)
    off()
  })
})
