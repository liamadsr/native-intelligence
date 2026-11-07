// @vitest-environment jsdom
/**
 * Tests for the shared use-voice-profile hook's `loading` semantics.
 *
 * The contract: the fetch starts in an effect, so on the VERY FIRST render
 * nothing is in flight yet. If `loading` gated on `inFlight !== null`, it would
 * report `loading === false` on that first synchronous render and an already-
 * enrolled user would see a not-enrolled hero flash before the status resolves.
 * `loading` must therefore be true from the first render until the first fetch
 * settles.
 *
 * The hook keeps module-scoped cache/hasFetched/inFlight state, so each test
 * imports a fresh module copy via vi.resetModules() + dynamic import. Rendered
 * standalone with createRoot/act (no @testing-library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceProfileStatus } from '@/lib/voice-profile/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function enrolledStatus(): VoiceProfileStatus {
  return { enrolled: true, quality: 0.9, chunkCount: 18, createdAt: '2026-07-15T00:00:00Z' }
}

/** A fetch stub whose resolution we control, so we can inspect the state
 *  BEFORE the first fetch settles and again AFTER. */
function deferredFetch(status: VoiceProfileStatus) {
  let resolveJson!: () => void
  const gate = new Promise<void>((r) => {
    resolveJson = r
  })
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    json: async () => {
      await gate
      return status
    },
  })) as unknown as typeof fetch
  return { fetchImpl, settle: resolveJson }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetModules()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('loading is true on the first render before the fetch settles (no not-enrolled flash)', async () => {
  const { fetchImpl, settle } = deferredFetch(enrolledStatus())
  vi.stubGlobal('fetch', fetchImpl)

  const { useVoiceProfile } = await import('../use-voice-profile')

  // Capture the hook value DURING render (synchronously) on every render pass.
  const renders: { status: VoiceProfileStatus | null; loading: boolean }[] = []
  function Harness() {
    const { status, loading } = useVoiceProfile()
    renders.push({ status, loading })
    return null
  }

  await act(async () => {
    root.render(h(Harness))
    await Promise.resolve()
  })

  // The very first render pass must report loading=true with no resolved
  // status — otherwise the consumer flashes its not-enrolled state.
  expect(renders[0].loading).toBe(true)
  expect(renders[0].status).toBeNull()

  // Now let the fetch settle and flush.
  await act(async () => {
    settle()
    await Promise.resolve()
    await Promise.resolve()
  })

  const last = renders[renders.length - 1]
  expect(last.loading).toBe(false)
  expect(last.status).toEqual(enrolledStatus())
})

it('loading flips to false once the fetch resolves', async () => {
  const { fetchImpl, settle } = deferredFetch(enrolledStatus())
  vi.stubGlobal('fetch', fetchImpl)

  const { useVoiceProfile } = await import('../use-voice-profile')

  let latest: { status: VoiceProfileStatus | null; loading: boolean } = {
    status: null,
    loading: false,
  }
  function Harness() {
    latest = useVoiceProfile()
    return null
  }

  await act(async () => {
    root.render(h(Harness))
    await Promise.resolve()
  })
  expect(latest.loading).toBe(true)

  await act(async () => {
    settle()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(latest.loading).toBe(false)
  expect(latest.status).toEqual(enrolledStatus())
})
