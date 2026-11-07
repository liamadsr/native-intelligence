// @vitest-environment jsdom
/**
 * Mic-check step — the 6-way WebAudioCaptureErrorKind branch. Each classified
 * failure must render its OWN specific copy + the right recovery affordance
 * (retry vs no-retry), never a raw DOMException. Covered two ways:
 *   1. micErrorCopy() as a pure mapping (all six kinds, distinct copy).
 *   2. a render smoke that the retry button appears iff the kind is retryable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { WebAudioCaptureErrorKind } from '@/lib/web-audio-capture'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The level meter pulls in nothing heavy, but stub it to keep the render tiny.
vi.mock('@/components/desktop/audio-level-meter', () => ({
  AudioLevelMeter: () => null,
}))

import { MicCheckStep, micErrorCopy } from '../mic-check-step'

const ALL_KINDS: WebAudioCaptureErrorKind[] = [
  'permission-denied',
  'no-device',
  'in-use',
  'insecure-context',
  'unsupported',
  'unknown',
]

describe('micErrorCopy', () => {
  it('returns distinct copy for every classified kind', () => {
    const titles = ALL_KINDS.map((k) => micErrorCopy(k).title)
    expect(new Set(titles).size).toBe(ALL_KINDS.length)
    for (const copy of ALL_KINDS.map(micErrorCopy)) {
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.body.length).toBeGreaterThan(0)
    }
  })

  it('marks recoverable kinds retryable and terminal kinds not', () => {
    expect(micErrorCopy('permission-denied').retry).toBe(true)
    expect(micErrorCopy('no-device').retry).toBe(true)
    expect(micErrorCopy('in-use').retry).toBe(true)
    expect(micErrorCopy('unknown').retry).toBe(true)
    // These can't be fixed by retrying in place.
    expect(micErrorCopy('insecure-context').retry).toBe(false)
    expect(micErrorCopy('unsupported').retry).toBe(false)
  })
})

describe('MicCheckStep render', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Parameters<typeof MicCheckStep>[0]) {
    act(() => root.render(h(MicCheckStep, props)))
  }

  it('shows a Try again button for a retryable kind and the specific copy', () => {
    render({
      level: 0,
      recording: false,
      speechDetected: false,
      error: 'permission-denied',
      onRetry: () => {},
    })
    expect(container.textContent).toContain('Microphone access is blocked')
    const retry = [...container.querySelectorAll('button')].find((b) =>
      /try again/i.test(b.textContent || ''),
    )
    expect(retry).toBeTruthy()
  })

  it('omits the Try again button for a non-retryable kind', () => {
    render({
      level: 0,
      recording: false,
      speechDetected: false,
      error: 'unsupported',
      onRetry: () => {},
    })
    expect(container.textContent).toContain('This browser can’t record')
    const retry = [...container.querySelectorAll('button')].find((b) =>
      /try again/i.test(b.textContent || ''),
    )
    expect(retry).toBeUndefined()
  })

  it('renders the mic prompt (no error) and confirms once speech is detected', () => {
    render({
      level: 0.05,
      recording: true,
      speechDetected: false,
      error: null,
      onRetry: () => {},
    })
    expect(container.textContent).toContain('Say hi to check your mic')
    expect(container.textContent).not.toContain('your mic sounds great')

    render({
      level: 0.05,
      recording: true,
      speechDetected: true,
      error: null,
      onRetry: () => {},
    })
    expect(container.textContent).toContain('your mic sounds great')
  })
})
