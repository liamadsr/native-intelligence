// @vitest-environment jsdom
/**
 * The text a document keeps on this device while offline (../offline-draft.ts):
 * kept per document with its base, read back, dropped when stale or broken,
 * and what a load does with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OFFLINE_DRAFT_MAX_AGE_MS,
  OFFLINE_DRAFT_PREFIX,
  clearOfflineDraft,
  isOffline,
  isUndelivered,
  offlineDraftOnLoad,
  readOfflineDraft,
  writeOfflineDraft,
} from '../offline-draft'

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('offline drafts', () => {
  it('keeps the text per document, with its base, and clears it', () => {
    expect(writeOfflineDraft('doc-1', { content: 'mine', baseRevision: 4, baseContent: 'base' }, 1000)).toBe(true)
    expect(readOfflineDraft('doc-1', 2000)).toEqual({ content: 'mine', baseRevision: 4, baseContent: 'base', savedAt: 1000 })
    expect(readOfflineDraft('doc-2', 2000)).toBeNull()
    clearOfflineDraft('doc-1')
    expect(readOfflineDraft('doc-1', 2000)).toBeNull()
  })

  it('drops a copy that is too old or not one of ours', () => {
    writeOfflineDraft('doc-1', { content: 'mine', baseRevision: 4, baseContent: 'base' }, 0)
    expect(readOfflineDraft('doc-1', OFFLINE_DRAFT_MAX_AGE_MS + 1)).toBeNull()
    expect(window.localStorage.getItem(OFFLINE_DRAFT_PREFIX + 'doc-1')).toBeNull()
    window.localStorage.setItem(OFFLINE_DRAFT_PREFIX + 'doc-3', '{"content":1}')
    expect(readOfflineDraft('doc-3')).toBeNull()
    window.localStorage.setItem(OFFLINE_DRAFT_PREFIX + 'doc-4', 'not json')
    expect(readOfflineDraft('doc-4')).toBeNull()
  })

  it('a full store keeps nothing and says so', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(writeOfflineDraft('doc-1', { content: 'mine', baseRevision: 4, baseContent: 'base' })).toBe(false)
    setItem.mockRestore()
  })

  it('on load: drops a copy the server already has, restores one it doesn’t', () => {
    const kept = { content: 'mine', baseRevision: 4, baseContent: 'base', savedAt: 0 }
    expect(offlineDraftOnLoad(null, { content: 'x', revision: 5 })).toBe('none')
    expect(offlineDraftOnLoad(kept, { content: 'mine', revision: 5 })).toBe('drop')
    expect(offlineDraftOnLoad(kept, { content: 'base', revision: 4 })).toBe('restore')
    expect(offlineDraftOnLoad(kept, { content: 'theirs', revision: 6 })).toBe('restore')
  })

  it('tells an undelivered save from a refused one, and reads the connection', () => {
    expect(isUndelivered({ ok: false, status: 0 })).toBe(true)
    expect(isUndelivered({ ok: false, status: 409 })).toBe(false)
    expect(isUndelivered({ ok: true })).toBe(false)
    vi.stubGlobal('navigator', { onLine: false })
    expect(isOffline()).toBe(true)
    vi.stubGlobal('navigator', { onLine: true })
    expect(isOffline()).toBe(false)
  })
})
