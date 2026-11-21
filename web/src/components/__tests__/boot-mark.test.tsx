// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BootMark, isChunkLoadFailure, markBooted } from '../boot-mark'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('next/error', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement

function render(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
}

beforeEach(() => {
  delete window.__niBoot
  delete window.__niBooted
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

describe('BootMark', () => {
  it("tells the boot watchdog once React has committed, so a healthy page is never reloaded", () => {
    const boot = vi.fn()
    window.__niBoot = boot
    render(<BootMark />)
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it('marks the page started where there is no watchdog (next dev, a frame)', () => {
    render(<BootMark />)
    expect(window.__niBooted).toBe(true)
  })

  it('markBooted prefers the watchdog, which also clears its count and its message', () => {
    const boot = vi.fn()
    window.__niBoot = boot
    markBooted()
    expect(boot).toHaveBeenCalledTimes(1)
    expect(window.__niBooted).toBeUndefined()
  })
})

describe('isChunkLoadFailure', () => {
  it.each([
    ['Turbopack', new Error('Failed to load chunk /_next/static/chunks/abc.js from module 123')],
    ['webpack', Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' })],
    ['webpack CSS', new Error('Loading CSS chunk 7 failed.')],
    ['Chromium import()', new TypeError('Failed to fetch dynamically imported module: https://x/_next/a.js')],
    ['Safari import()', new TypeError('Importing a module script failed.')],
    ['Firefox import()', new TypeError('error loading dynamically imported module')],
  ])('%s', (_, error) => {
    expect(isChunkLoadFailure(error)).toBe(true)
  })

  it.each([
    ['a crash in the app', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a failed fetch', new TypeError('Failed to fetch')],
    ['not an error', 'Failed to load chunk'],
    ['nothing', undefined],
  ])('not %s', (_, error) => {
    expect(isChunkLoadFailure(error)).toBe(false)
  })
})

describe('the global error page', () => {
  async function renderGlobalError(error: Error) {
    const { default: GlobalError } = await import('@/app/global-error')
    // It renders its own <html>; React says so in the console when it sits in a test's <div>.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<GlobalError error={error} />)
    } finally {
      quiet.mockRestore()
    }
  }

  it('counts as started for a crash in the app, so the watchdog does not reload it and cover it', async () => {
    const boot = vi.fn()
    window.__niBoot = boot
    await renderGlobalError(new TypeError("Cannot read properties of undefined (reading 'id')"))
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it('leaves a chunk that failed to load to the watchdog, which reloads the page', async () => {
    const boot = vi.fn()
    window.__niBoot = boot
    await renderGlobalError(new Error('Failed to load chunk /_next/static/chunks/abc.js'))
    expect(boot).not.toHaveBeenCalled()
  })
})
