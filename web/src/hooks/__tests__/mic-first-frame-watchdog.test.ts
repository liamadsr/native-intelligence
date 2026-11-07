/**
 * Tests for the shared mic-recovery coordinator's pure decision core.
 *
 * TWO initiators request recover_mic rebuilds — the native audio://mic-fault
 * watchdog and the first-frame watchdog in useRecording.startRecording — and
 * both route through one coordinator so a persistently dead device can't loop
 * rebuilds unboundedly or double-toast. The imperative half (requestMicRecovery)
 * lives inside the hook, which has no isolated test harness (it needs the whole
 * Tauri/Deepgram/Supabase stack — established); the episode/budget/spacing
 * branching is extracted into `decideMicRecovery` precisely so it IS testable.
 *
 * Decision table under test:
 *   - recording over / superseded            → inactive
 *   - audio arrived after the last rebuild   → episode reset (fresh budget)
 *   - already gave up this episode           → suppressed (telemetry-only)
 *   - budget exhausted, mic still dead       → give-up (toast, once per episode)
 *   - inside the spacing window              → throttled (let the rebuild settle)
 *   - otherwise                              → recover
 */
import { describe, it, expect } from 'vitest'
import {
  decideMicRecovery,
  MIC_RECOVER_MAX_ATTEMPTS,
  MIC_RECOVER_MIN_SPACING_MS,
} from '../use-recording'

const T0 = 1_000_000 // arbitrary wall-clock base

describe('decideMicRecovery', () => {
  it('recovers on a fresh episode (no prior recovery, no audio yet)', () => {
    expect(
      decideMicRecovery({
        now: T0,
        stillCurrent: true,
        lastAudioAt: 0,
        lastRecoveryAt: 0,
        attempts: 0,
        gaveUp: false,
      }),
    ).toEqual({ action: 'recover', resetEpisode: false })
  })

  it('recovers on a mid-meeting fault when audio had been flowing (attempts fresh)', () => {
    // Device unplugged an hour in: audio flowed until now, no recoveries yet.
    expect(
      decideMicRecovery({
        now: T0,
        stillCurrent: true,
        lastAudioAt: T0 - 500,
        lastRecoveryAt: 0,
        attempts: 0,
        gaveUp: false,
      }),
    ).toEqual({ action: 'recover', resetEpisode: false })
  })

  it('is inactive once the recording stopped / service was superseded', () => {
    expect(
      decideMicRecovery({
        now: T0,
        stillCurrent: false,
        lastAudioAt: 0,
        lastRecoveryAt: 0,
        attempts: 0,
        gaveUp: false,
      }),
    ).toEqual({ action: 'inactive', resetEpisode: false })
  })

  it('throttles a request inside the spacing window of the last rebuild', () => {
    // Native fault re-flags ~3s after a rebuild: too soon, let it settle.
    expect(
      decideMicRecovery({
        now: T0 + MIC_RECOVER_MIN_SPACING_MS - 1,
        stillCurrent: true,
        lastAudioAt: 0,
        lastRecoveryAt: T0,
        attempts: 1,
        gaveUp: false,
      }),
    ).toEqual({ action: 'throttled', resetEpisode: false })
  })

  it('recovers again once the spacing window has elapsed (budget permitting)', () => {
    expect(
      decideMicRecovery({
        now: T0 + MIC_RECOVER_MIN_SPACING_MS,
        stillCurrent: true,
        lastAudioAt: 0,
        lastRecoveryAt: T0,
        attempts: 1,
        gaveUp: false,
      }),
    ).toEqual({ action: 'recover', resetEpisode: false })
  })

  it('gives up when the shared budget is exhausted and mic audio is still absent', () => {
    expect(
      decideMicRecovery({
        now: T0 + 60_000,
        stillCurrent: true,
        lastAudioAt: 0, // never came back
        lastRecoveryAt: T0,
        attempts: MIC_RECOVER_MAX_ATTEMPTS,
        gaveUp: false,
      }),
    ).toEqual({ action: 'give-up', resetEpisode: false })
  })

  it('suppresses (telemetry-only) further requests after the episode gave up', () => {
    // e.g. the native watchdog keeps re-flagging every ~3s on a dead device
    // after the give-up toast already fired: no recover_mic, no repeat toast.
    expect(
      decideMicRecovery({
        now: T0 + 120_000,
        stillCurrent: true,
        lastAudioAt: 0,
        lastRecoveryAt: T0,
        attempts: MIC_RECOVER_MAX_ATTEMPTS,
        gaveUp: true,
      }),
    ).toEqual({ action: 'suppressed', resetEpisode: false })
  })

  it('resets the episode when mic audio arrived AFTER the last rebuild — fresh budget', () => {
    // Recovery at T0 worked (audio at T0+2s); a NEW fault later must not be
    // starved by the old episode's spent budget.
    expect(
      decideMicRecovery({
        now: T0 + 3_600_000,
        stillCurrent: true,
        lastAudioAt: T0 + 2_000,
        lastRecoveryAt: T0,
        attempts: MIC_RECOVER_MAX_ATTEMPTS,
        gaveUp: false,
      }),
    ).toEqual({ action: 'recover', resetEpisode: true })
  })

  it('episode reset also clears a stale give-up (device came back after the toast)', () => {
    expect(
      decideMicRecovery({
        now: T0 + 3_600_000,
        stillCurrent: true,
        lastAudioAt: T0 + 30_000, // audio returned well after the last rebuild
        lastRecoveryAt: T0,
        attempts: MIC_RECOVER_MAX_ATTEMPTS,
        gaveUp: true,
      }),
    ).toEqual({ action: 'recover', resetEpisode: true })
  })

  it('spacing still applies across an episode reset (flapping must not hammer rebuilds)', () => {
    // Audio blipped back 1s after the rebuild, died again 1s later: new episode,
    // but the last rebuild is only 2s old — rebuilding again now just drops the
    // stream once more before it can settle.
    expect(
      decideMicRecovery({
        now: T0 + 2_000,
        stillCurrent: true,
        lastAudioAt: T0 + 1_000,
        lastRecoveryAt: T0,
        attempts: 2,
        gaveUp: false,
      }),
    ).toEqual({ action: 'throttled', resetEpisode: true })
  })
})
