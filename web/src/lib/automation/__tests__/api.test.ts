// @vitest-environment jsdom
/**
 * window.__dial8Automation's ready() and resetUi() (api.ts), with the
 * dashboard's main chat as a stand-in.
 *
 *   - resetUi() resolves only once the new chat is stored and its composer is
 *     empty, and closes an open menu;
 *   - ready() waits for sign-in, the workspace and the composer, and rejects
 *     with what it was waiting for when it times out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutomationApi, type AutomationDeps } from '../api'

afterEach(() => vi.restoreAllMocks())

/**
 * The dashboard as the API sees it: one main chat; a reset commits a moment
 * later, mounting a chat on a new session with an empty composer, which is
 * stored a moment after.
 */
function dashboard(workspaceId: string, composer = document.createElement('textarea')) {
  let chat = { chatSessionId: 'sess-a' }
  let stored: { chatSessionId: string } | null = { chatSessionId: 'sess-a' }
  composer.value = 'a leftover draft'
  const deps: AutomationDeps = {
    workspaceId: () => workspaceId,
    signedIn: async () => true,
    chat: () => chat,
    resetChat: () => {
      setTimeout(() => {
        chat = { chatSessionId: 'sess-new' }
        composer.value = ''
        setTimeout(() => (stored = { chatSessionId: 'sess-new' }), 300)
      }, 10)
    },
    storedChat: () => stored,
    composer: () => composer,
  }
  return { deps, composer, stored: () => stored }
}

describe('resetUi()', () => {
  it('lands the blank chat: resolved only once the new chat is stored and its composer is empty', async () => {
    const { deps, composer, stored } = dashboard('ws-1')
    await createAutomationApi(deps).resetUi()
    expect(stored()).toEqual({ chatSessionId: 'sess-new' })
    expect(composer.value).toBe('')
  })

  it('closes an open menu with Escape, and leaves a closed one kept in the DOM alone', async () => {
    const closed = document.createElement('div')
    closed.setAttribute('role', 'menu')
    closed.setAttribute('aria-hidden', 'true')
    closed.inert = true
    const open = document.createElement('div')
    open.setAttribute('data-radix-popper-content-wrapper', '')
    // jsdom lays nothing out: the open one says it has a size.
    open.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 120, top: 0, left: 0, right: 200, bottom: 120, toJSON: () => ({}) })
    document.body.append(closed, open)
    const escapes: string[] = []
    const onKey = (e: KeyboardEvent) => {
      escapes.push(e.key)
      if (e.key === 'Escape') open.remove()
    }
    document.addEventListener('keydown', onKey)
    try {
      const { deps } = dashboard('ws-1')
      await createAutomationApi(deps).resetUi()
      expect(escapes).toEqual(['Escape'])
      expect(open.isConnected).toBe(false)
      expect(closed.isConnected).toBe(true)

      // Nothing open: no key at all.
      escapes.length = 0
      await createAutomationApi(dashboard('ws-1').deps).resetUi()
      expect(escapes).toEqual([])
    } finally {
      document.removeEventListener('keydown', onKey)
      closed.remove()
    }
  })

  it('needs a workspace', async () => {
    const { deps } = dashboard('ws-1')
    await expect(createAutomationApi({ ...deps, workspaceId: () => null }).resetUi()).rejects.toThrow(/no active workspace/)
  })
})

describe('ready()', () => {
  it('waits for the composer', async () => {
    const { deps } = dashboard('ws-1')
    let composer: HTMLTextAreaElement | null = null
    let settled = false
    const ready = createAutomationApi({ ...deps, composer: () => composer })
      .ready({ timeoutMs: 5000 })
      .then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)
    composer = document.createElement('textarea')
    await ready
    expect(settled).toBe(true)
  })

  it('rejects with what it was waiting for', async () => {
    const { deps } = dashboard('ws-1')
    await expect(createAutomationApi({ ...deps, composer: () => null }).ready({ timeoutMs: 100 })).rejects.toThrow(
      'ready() timed out after 100 ms waiting for the chat composer',
    )
    await expect(createAutomationApi({ ...deps, workspaceId: () => null }).ready({ timeoutMs: 100 })).rejects.toThrow(/the workspace/)
    await expect(createAutomationApi({ ...deps, signedIn: async () => false }).ready({ timeoutMs: 100 })).rejects.toThrow(/sign-in/)
  })

  it('info() says where it is', () => {
    const { deps } = dashboard('ws-1')
    const info = createAutomationApi(deps).info()
    expect(info).toEqual({ buildId: null, route: window.location.pathname, workspaceId: 'ws-1' })
  })
})
