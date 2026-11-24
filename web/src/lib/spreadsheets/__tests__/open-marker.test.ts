// @vitest-environment jsdom
/**
 * A spreadsheet that took the page down while it opened names itself on the
 * next boot (../open-marker.ts). The owner's crash on 1198be57 left no error
 * in Sentry: the page died (the desktop's WebContent process), and the shell
 * reloaded it onto Home. A marker in localStorage, which outlives the page,
 * says which spreadsheet and how far it got.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({ captureMessage }))

import {
  DIED_KEY,
  HOLD_MS,
  MARKER_MAX_AGE_MS,
  OPEN_MARKER_KEY,
  PAGE_ID,
  __resetOpenMarkerForTests,
  checkPreviousOpen,
  clearOpening,
  heldAfterDeath,
  markOpening,
  markPhase,
  releaseHold,
  type OpenMarker,
} from '../open-marker'

const marker = () => JSON.parse(localStorage.getItem(OPEN_MARKER_KEY) ?? 'null') as OpenMarker | null
/** What a page load that died left behind. */
function leftByADeadPage(extra: Partial<OpenMarker> = {}) {
  localStorage.setItem(OPEN_MARKER_KEY, JSON.stringify({ page: 'an-earlier-page', id: 'sheet-1', phase: 'engine', at: Date.now() - 5000, pageAgeMs: 2400, workbookChars: 9_000_000, ...extra }))
}

beforeEach(() => {
  localStorage.clear()
  captureMessage.mockClear()
  __resetOpenMarkerForTests()
})
afterEach(() => localStorage.clear())

describe('this page’s marker', () => {
  it('is set when an open starts, follows its phase, and goes when it ends', () => {
    markOpening('sheet-1')
    expect(marker()).toMatchObject({ page: PAGE_ID, id: 'sheet-1', phase: 'fetching' })
    markPhase('sheet-1', 'engine', { workbookChars: 1234 })
    expect(marker()).toMatchObject({ phase: 'engine', workbookChars: 1234 })
    markPhase('another', 'drawing') // not the one open: untouched
    expect(marker()!.phase).toBe('engine')
    clearOpening('sheet-1')
    expect(marker()).toBeNull()
  })

  it('a page leaving normally (pagehide) clears it; another page’s marker is never cleared by this one', async () => {
    const { installPagehideClear } = await import('../open-marker')
    installPagehideClear()
    markOpening('sheet-1')
    window.dispatchEvent(new Event('pagehide'))
    expect(marker()).toBeNull()
    leftByADeadPage()
    clearOpening()
    expect(marker()).not.toBeNull()
  })
})

describe('the next boot', () => {
  it('reports a marker another page load left, holds that spreadsheet, and clears the marker', () => {
    leftByADeadPage()
    const found = checkPreviousOpen()
    expect(found).toMatchObject({ id: 'sheet-1', phase: 'engine' })
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith(
      'The page died while opening a spreadsheet',
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ kind: 'spreadsheet-open-died', spreadsheet_phase: 'engine', launch_restore: 'yes' }),
        extra: expect.objectContaining({ id: 'sheet-1', workbookChars: 9_000_000 }),
      }),
    )
    expect(marker()).toBeNull()
    expect(heldAfterDeath('sheet-1')).toBe(true)
    expect(heldAfterDeath('sheet-2')).toBe(false)
  })

  it('checks once per page load', () => {
    leftByADeadPage()
    checkPreviousOpen()
    leftByADeadPage()
    expect(checkPreviousOpen()).toBeNull()
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('this page’s own marker is not a death', () => {
    markOpening('sheet-1')
    expect(checkPreviousOpen()).toBeNull()
    expect(captureMessage).not.toHaveBeenCalled()
    expect(marker()).not.toBeNull()
  })

  it('an old or garbled marker is dropped without a report', () => {
    leftByADeadPage({ at: Date.now() - MARKER_MAX_AGE_MS - 1 })
    expect(checkPreviousOpen()).toBeNull()
    expect(marker()).toBeNull()
    __resetOpenMarkerForTests()
    localStorage.setItem(OPEN_MARKER_KEY, '{not json')
    expect(checkPreviousOpen()).toBeNull()
    expect(captureMessage).not.toHaveBeenCalled()
  })
})

describe('the hold', () => {
  it('lasts a while, and the person can release it', () => {
    const now = Date.now()
    localStorage.setItem(DIED_KEY, JSON.stringify({ 'sheet-1': now }))
    expect(heldAfterDeath('sheet-1', now + HOLD_MS - 1)).toBe(true)
    expect(heldAfterDeath('sheet-1', now + HOLD_MS + 1)).toBe(false)
    releaseHold('sheet-1')
    expect(heldAfterDeath('sheet-1', now)).toBe(false)
    expect(localStorage.getItem(DIED_KEY)).toBeNull()
  })
})
