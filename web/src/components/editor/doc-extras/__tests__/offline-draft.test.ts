// @vitest-environment jsdom
/**
 * The text a document keeps on this device while offline (../offline-draft.ts):
 *  - kept per person AND workspace, with its base; another person on the same
 *    browser (or the same person in another workspace) reads none of it;
 *  - wiped by sign-out (main-chat/state-wipe.ts), and never written again
 *    after the wipe has begun, so the next person on a shared computer finds
 *    nothing; folds (they name headings) go with it;
 *  - dropped when stale or broken (prune sweeps everyone's); what a load does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ANA = { userId: 'user-ana', workspaceId: 'ws-1' }
const BO = { userId: 'user-bo', workspaceId: 'ws-1' }
const DRAFT = { content: 'mine', baseRevision: 4, baseContent: 'base' }

// The wipe's flag lives for a page load: a fresh module per test.
async function load() {
  vi.resetModules()
  const draft = await import('../offline-draft')
  const wipe = await import('@/app/account/(dashboard)/main-chat/state-wipe')
  return { ...draft, ...wipe }
}

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('offline drafts', () => {
  it('keeps the text per person and workspace, with its base, and clears it', async () => {
    const m = await load()
    expect(m.writeOfflineDraft(ANA, 'doc-1', DRAFT, 1000)).toBe(true)
    expect(window.localStorage.getItem('ni:doc-offline:user-ana:ws-1:doc-1')).not.toBeNull()
    expect(m.readOfflineDraft(ANA, 'doc-1', 2000)).toEqual({ ...DRAFT, savedAt: 1000 })
    expect(m.readOfflineDraft(ANA, 'doc-2', 2000)).toBeNull()
    m.clearOfflineDraft(ANA, 'doc-1')
    expect(m.readOfflineDraft(ANA, 'doc-1', 2000)).toBeNull()
  })

  it('another person on the same browser sees none of it, nor does the same person in another workspace', async () => {
    const m = await load()
    m.writeOfflineDraft(ANA, 'doc-1', DRAFT)
    expect(m.readOfflineDraft(BO, 'doc-1')).toBeNull()
    expect(m.readOfflineDraft({ userId: 'user-ana', workspaceId: 'ws-2' }, 'doc-1')).toBeNull()
    // Bo clearing "his" copy leaves Ana's alone.
    m.clearOfflineDraft(BO, 'doc-1')
    expect(m.readOfflineDraft(ANA, 'doc-1')).not.toBeNull()
    // Without a known person nothing is kept or read.
    expect(m.writeOfflineDraft(null, 'doc-1', DRAFT)).toBe(false)
    expect(m.readOfflineDraft(null, 'doc-1')).toBeNull()
  })

  it('sign-out wipes every copy and every fold, and nothing is written after it', async () => {
    const m = await load()
    m.writeOfflineDraft(ANA, 'doc-1', DRAFT)
    m.writeOfflineDraft(BO, 'doc-2', DRAFT)
    window.localStorage.setItem('ni:doc-folds:doc-1', JSON.stringify(['Secret plan#0']))
    window.localStorage.setItem('unrelated', 'stays')
    m.beginPersistedTabStateWipe()
    expect(Object.keys(window.localStorage).sort()).toEqual(['unrelated'])
    // The pagehide save after Sign out can't put it back.
    expect(m.writeOfflineDraft(ANA, 'doc-1', DRAFT)).toBe(false)
    expect(window.localStorage.getItem('ni:doc-offline:user-ana:ws-1:doc-1')).toBeNull()
  })

  it('folds are not written after the wipe either', async () => {
    vi.resetModules()
    const wipe = await import('@/app/account/(dashboard)/main-chat/state-wipe')
    const { Editor } = await import('@tiptap/core')
    const { default: StarterKit } = await import('@tiptap/starter-kit')
    const { HeadingFold, toggleFold, foldStorageKey } = await import('../heading-fold')
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, HeadingFold.configure({ storageKey: foldStorageKey('doc-1') })],
      content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    })
    wipe.beginPersistedTabStateWipe()
    toggleFold(editor.view, 'Plan#0')
    expect(window.localStorage.getItem('ni:doc-folds:doc-1')).toBeNull()
    editor.destroy()
  })

  it('drops a copy that is too old or not one of ours; prune sweeps everyone’s stale copies', async () => {
    const m = await load()
    m.writeOfflineDraft(ANA, 'doc-1', DRAFT, 0)
    expect(m.readOfflineDraft(ANA, 'doc-1', m.OFFLINE_DRAFT_MAX_AGE_MS + 1)).toBeNull()
    expect(window.localStorage.getItem(m.offlineDraftKey(ANA, 'doc-1'))).toBeNull()

    m.writeOfflineDraft(ANA, 'old', DRAFT, 0)
    m.writeOfflineDraft(BO, 'fresh', DRAFT, m.OFFLINE_DRAFT_MAX_AGE_MS)
    window.localStorage.setItem(m.OFFLINE_DRAFT_PREFIX + 'user-x:ws-1:broken', 'not json')
    expect(m.pruneOfflineDrafts(m.OFFLINE_DRAFT_MAX_AGE_MS + 1)).toBe(2)
    expect(m.readOfflineDraft(BO, 'fresh', m.OFFLINE_DRAFT_MAX_AGE_MS + 1)).not.toBeNull()
  })

  it('a full store keeps nothing and says so', async () => {
    const m = await load()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(m.writeOfflineDraft(ANA, 'doc-1', DRAFT)).toBe(false)
  })

  it('on load: drops a copy the server already has, restores one it doesn’t', async () => {
    const m = await load()
    const kept = { ...DRAFT, savedAt: 0 }
    expect(m.offlineDraftOnLoad(null, { content: 'x', revision: 5 })).toBe('none')
    expect(m.offlineDraftOnLoad(kept, { content: 'mine', revision: 5 })).toBe('drop')
    expect(m.offlineDraftOnLoad(kept, { content: 'base', revision: 4 })).toBe('restore')
    expect(m.offlineDraftOnLoad(kept, { content: 'theirs', revision: 6 })).toBe('restore')
  })

  it('tells an undelivered save from a refused one, and reads the connection', async () => {
    const m = await load()
    expect(m.isUndelivered({ ok: false, status: 0 })).toBe(true)
    expect(m.isUndelivered({ ok: false, status: 409 })).toBe(false)
    expect(m.isUndelivered({ ok: true })).toBe(false)
    vi.stubGlobal('navigator', { onLine: false })
    expect(m.isOffline()).toBe(true)
    vi.stubGlobal('navigator', { onLine: true })
    expect(m.isOffline()).toBe(false)
  })
})
