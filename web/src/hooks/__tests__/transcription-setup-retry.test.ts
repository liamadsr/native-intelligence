/**
 * Tests for the bounded transcription setup-retry loop (Part B of the 386s
 * zero-transcript fix).
 *
 * The imperative retry orchestration in useRecording.startRecording needs the
 * whole Tauri/Deepgram/Supabase stack, which the hook has no isolated harness
 * for (established — see mic-first-frame-watchdog.test.ts). So the loop is
 * extracted into `runTranscriptionSetupWithRetry`, a pure function whose side
 * effects (token fetch, build+start, dispose, telemetry, toast, the generation
 * guard) are all INJECTED — exactly what these tests drive. `sleep` is injected
 * as an immediate resolve so the backoff schedule doesn't slow the suite.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  nextSetupRetryDelayMs,
  SETUP_RETRY_DELAYS_MS,
  runTranscriptionSetupWithRetry,
  type SetupRetryDeps,
} from '../use-recording'

/** Fake service token so we can assert which service object was returned. */
type Svc = { id: number }

function baseDeps(overrides: Partial<SetupRetryDeps<Svc>> = {}): SetupRetryDeps<Svc> {
  return {
    fetchToken: vi.fn(async () => 'fresh-token'),
    buildAndStart: vi.fn(async () => ({ id: 1 })),
    dispose: vi.fn(),
    isCurrent: () => true,
    sleep: async () => {}, // immediate — no real backoff wait
    onAttemptFailed: vi.fn(),
    onExhausted: vi.fn(),
    ...overrides,
  }
}

describe('nextSetupRetryDelayMs', () => {
  it('returns the backoff schedule for the first N retries, then null', () => {
    expect(nextSetupRetryDelayMs(1)).toBe(SETUP_RETRY_DELAYS_MS[0])
    expect(nextSetupRetryDelayMs(2)).toBe(SETUP_RETRY_DELAYS_MS[1])
    expect(nextSetupRetryDelayMs(3)).toBe(SETUP_RETRY_DELAYS_MS[2])
    // Exhausted after SETUP_RETRY_DELAYS_MS.length retries.
    expect(nextSetupRetryDelayMs(SETUP_RETRY_DELAYS_MS.length + 1)).toBeNull()
    expect(nextSetupRetryDelayMs(0)).toBeNull() // 0 is "no prior failure"
  })
})

describe('runTranscriptionSetupWithRetry', () => {
  it('returns the started service on a first-try success (no token re-fetch)', async () => {
    const deps = baseDeps({ buildAndStart: vi.fn(async () => ({ id: 42 })) })
    const result = await runTranscriptionSetupWithRetry('first-token', deps)

    expect(result).toEqual({ status: 'started', service: { id: 42 } })
    // The first token was used as-is; no retry token fetch happened.
    expect(deps.fetchToken).not.toHaveBeenCalled()
    expect(deps.buildAndStart).toHaveBeenCalledTimes(1)
    expect(deps.buildAndStart).toHaveBeenCalledWith('first-token')
    expect(deps.onAttemptFailed).not.toHaveBeenCalled()
  })

  it('re-fetches a FRESH token and retries after a start failure, then succeeds', async () => {
    let attempt = 0
    const buildAndStart = vi.fn(async (token: string) => {
      attempt++
      if (attempt === 1) {
        // First attempt used the (now-expired) first token and failed to connect.
        expect(token).toBe('first-token')
        throw new Error('both legs failed')
      }
      // Retry must use the FRESH token, never the stale first one.
      expect(token).toBe('fresh-token')
      return { id: 7 }
    })
    const fetchToken = vi.fn(async () => 'fresh-token')
    const deps = baseDeps({ buildAndStart, fetchToken })

    const result = await runTranscriptionSetupWithRetry('first-token', deps)

    expect(result).toEqual({ status: 'started', service: { id: 7 } })
    expect(fetchToken).toHaveBeenCalledTimes(1) // one fresh token for the retry
    expect(buildAndStart).toHaveBeenCalledTimes(2)
    // The failed attempt was reported once (1-based), never 'exhausted'.
    expect(deps.onAttemptFailed).toHaveBeenCalledTimes(1)
    expect(deps.onAttemptFailed).toHaveBeenCalledWith(1, 'both legs failed')
    expect(deps.onExhausted).not.toHaveBeenCalled()
  })

  it('exhausts after the bounded retries: onExhausted fires + a terminal failure is reported', async () => {
    // Every attempt fails → we should try 1 + SETUP_RETRY_DELAYS_MS.length times.
    const buildAndStart = vi.fn(async () => { throw new Error('connect timeout') })
    const deps = baseDeps({ buildAndStart })

    const result = await runTranscriptionSetupWithRetry('first-token', deps)

    expect(result).toEqual({ status: 'exhausted' })
    // Total start attempts = initial + one per backoff step.
    expect(buildAndStart).toHaveBeenCalledTimes(SETUP_RETRY_DELAYS_MS.length + 1)
    // onExhausted fires exactly once (drives the toast + error state in the hook).
    expect(deps.onExhausted).toHaveBeenCalledTimes(1)
    // Each failure reported (1-based), and the FINAL one also reports 'exhausted'.
    const failedCalls = (deps.onAttemptFailed as ReturnType<typeof vi.fn>).mock.calls
    const exhaustedReport = failedCalls.filter((c) => c[1] === 'exhausted')
    expect(exhaustedReport.length).toBe(1)
    expect(exhaustedReport[0][0]).toBe(SETUP_RETRY_DELAYS_MS.length + 1) // terminal attempt #
  })

  it('cancels pending retries when the session generation moves on during the backoff window', async () => {
    let current = true
    const buildAndStart = vi.fn(async () => { throw new Error('both legs failed') })
    // The stop happens DURING the backoff sleep (mirrors stopRecording bumping
    // sessionGenerationRef while a retry is parked on setTimeout).
    const sleep = vi.fn(async () => { current = false })
    const deps = baseDeps({
      buildAndStart,
      sleep,
      isCurrent: () => current,
    })

    const result = await runTranscriptionSetupWithRetry('first-token', deps)

    expect(result).toEqual({ status: 'cancelled' })
    // Only the first attempt ran; the retry was cancelled before rebuilding.
    expect(buildAndStart).toHaveBeenCalledTimes(1)
    expect(deps.fetchToken).not.toHaveBeenCalled() // never even fetched a retry token
    expect(deps.onExhausted).not.toHaveBeenCalled()
  })

  it('disposes a service that started AFTER a stop raced the successful start', async () => {
    // start() succeeds, but by the time it resolves the session is no longer
    // current (a fast stop-after-start). The built service must be disposed, not
    // returned — else the socket leaks into a stopped session (the exact race the
    // generation guard defends).
    let current = true
    const built: Svc = { id: 99 }
    const buildAndStart = vi.fn(async () => { current = false; return built })
    const dispose = vi.fn()
    const deps = baseDeps({ buildAndStart, dispose, isCurrent: () => current })

    const result = await runTranscriptionSetupWithRetry('first-token', deps)

    expect(result).toEqual({ status: 'cancelled' })
    expect(dispose).toHaveBeenCalledWith(built)
  })

  it('treats a failed retry-token fetch as that cycle continuing (still bounded)', async () => {
    const buildAndStart = vi.fn(async () => { throw new Error('both legs failed') })
    // Token re-fetch always fails — the loop must still terminate via exhaustion,
    // never spin unboundedly.
    const fetchToken = vi.fn(async () => { throw new Error('token 500') })
    const deps = baseDeps({ buildAndStart, fetchToken })

    const result = await runTranscriptionSetupWithRetry('first-token', deps)

    expect(result).toEqual({ status: 'exhausted' })
    expect(deps.onExhausted).toHaveBeenCalledTimes(1)
  })
})
