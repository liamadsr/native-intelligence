// @vitest-environment jsdom
/**
 * The app's one "Show all workspaces" switch (lib/workspace-span): an answer
 * kept on the ACCOUNT, so it follows the user to every device and desktop
 * window, with a per-device cache so the app boots on it without a flash.
 *
 *  • OFF BY DEFAULT, and the cached answer until the account's lands.
 *  • A FLIP is optimistic — every reader moves at once — and is saved to the
 *    account (PATCH /api/account/profile).
 *  • THE ACCOUNT'S ANSWER WINS once read (the profile GET), unless a flip came
 *    after the read began or a save is still in flight: then the read is stale.
 *  • AN ACCOUNT THAT NEVER SAVED ONE takes this device's answer and saves it —
 *    the inbox's old toggle included — but never another user's cache.
 *  • A WINDOW COMING BACK re-reads the account, throttled; windows sharing
 *    storage follow each other at once.
 *  • Storage that throws is the default, never a crash. The sound gate lets the
 *    active workspace through, and everything while the switch is on or the
 *    active workspace is unknown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const active = vi.hoisted(() => ({ id: 'ws-a' as string | null }))
vi.mock('../workspace-fetch', () => ({ getClientWorkspaceId: () => active.id }))

import {
  WORKSPACE_SPAN_PROFILE_URL,
  WORKSPACE_SPAN_RESYNC_MS,
  WORKSPACE_SPAN_STORAGE_KEY,
  applyAccountWorkspaceSpan,
  beginWorkspaceSpanRead,
  getShowAllWorkspaces,
  isInWorkspaceSpan,
  resetWorkspaceSpanForTests,
  setShowAllWorkspaces,
  syncWorkspaceSpanFromAccount,
  useShowAllWorkspaces,
  useWorkspaceSpanAccountSync,
} from '../workspace-span'
import { __resetAgentLookForTests, useAgentLook } from '../bots/agent-look-store'
import { DEFAULT_AGENT_LOOK } from '../bots/agent-look'
import { __resetAssistantNameForTests, getAssistantName } from '../voice/assistant-name-store'

const LEGACY_INBOX_KEY = 'dial8:notifications-scope'

/** Every request the store made. The profile GET answers with `account`. */
let requests: { url: string; init?: RequestInit }[] = []
let account: Record<string, unknown> = {}
let patchStatus = 200

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (init?.method === 'PATCH') return { ok: patchStatus < 400, status: patchStatus, json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => account } as Response
    }),
  )
}

const saves = () =>
  requests
    .filter((r) => r.init?.method === 'PATCH')
    .map((r) => {
      expect(r.url).toBe(WORKSPACE_SPAN_PROFILE_URL)
      return JSON.parse(String(r.init!.body)) as Record<string, unknown>
    })
const cached = () => JSON.parse(window.localStorage.getItem(WORKSPACE_SPAN_STORAGE_KEY) ?? 'null')
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

/** Mount a reader of the hook; returns every value it rendered, and the unmount. */
function mountReader(withSync = false) {
  const seen: boolean[] = []
  function Probe() {
    seen.push(useShowAllWorkspaces())
    return null
  }
  function SyncedProbe() {
    useWorkspaceSpanAccountSync()
    return h(Probe)
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(h(withSync ? SyncedProbe : Probe)))
  return { seen, unmount: () => act(() => root.unmount()) }
}

beforeEach(() => {
  window.localStorage.clear()
  resetWorkspaceSpanForTests()
  active.id = 'ws-a'
  requests = []
  account = {}
  patchStatus = 200
  installFetch()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('before the account answers', () => {
  it('is off for a device that has seen nothing', () => {
    expect(getShowAllWorkspaces()).toBe(false)
  })

  it('boots on the cached answer, with no request of its own', () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: 'u1' }))
    expect(getShowAllWorkspaces()).toBe(true)
    expect(requests).toEqual([])
  })

  it('boots on for a device that had left the inbox on "All workspaces"', () => {
    window.localStorage.setItem(LEGACY_INBOX_KEY, 'all')
    expect(getShowAllWorkspaces()).toBe(true)
  })

  it('treats junk in the cache, and storage that throws, as the default', () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, 'everything')
    expect(getShowAllWorkspaces()).toBe(false)

    resetWorkspaceSpanForTests()
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      expect(getShowAllWorkspaces()).toBe(false)
      // A flip still works for the session, and still reaches the account.
      setShowAllWorkspaces(true)
      expect(getShowAllWorkspaces()).toBe(true)
      expect(saves()).toEqual([{ show_all_workspaces: true }])
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
    }
  })
})

describe('flipping it', () => {
  it('moves every reader at once, caches it, and saves it to the account', async () => {
    const reader = mountReader()
    expect(reader.seen.at(-1)).toBe(false)
    act(() => setShowAllWorkspaces(true))
    expect(reader.seen.at(-1)).toBe(true)
    expect(cached()).toEqual({ all: true, user: null })
    await flush()
    expect(saves()).toEqual([{ show_all_workspaces: true }])
    reader.unmount()
  })

  it('tags the cache with the user once the account has named them', () => {
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: false }, beginWorkspaceSpanRead())
    setShowAllWorkspaces(true)
    expect(cached()).toEqual({ all: true, user: 'u1' })
  })

  it('a flip to the value it already holds saves nothing', () => {
    setShowAllWorkspaces(false)
    expect(saves()).toEqual([])
  })

  it('keeps the flip when the save fails — the next read decides', async () => {
    patchStatus = 500
    setShowAllWorkspaces(true)
    await flush()
    expect(getShowAllWorkspaces()).toBe(true)
    expect(console.warn).toHaveBeenCalled()
  })
})

describe("the account's answer", () => {
  it('wins over the cache once read, and is cached for this user', () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: false, user: 'u1' }))
    const reader = mountReader()
    expect(reader.seen.at(-1)).toBe(false)
    act(() => applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: true }, beginWorkspaceSpanRead()))
    expect(reader.seen.at(-1)).toBe(true)
    expect(cached()).toEqual({ all: true, user: 'u1' })
    // Reading saves nothing back.
    expect(saves()).toEqual([])
    reader.unmount()
  })

  it('is dropped when a flip came after the read began', () => {
    const token = beginWorkspaceSpanRead()
    setShowAllWorkspaces(true)
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: false }, token)
    expect(getShowAllWorkspaces()).toBe(true)
  })

  it('is dropped while a save is still in flight', async () => {
    setShowAllWorkspaces(true)
    // The save has not resolved yet: a read that began after the flip can still carry the old answer.
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: false }, beginWorkspaceSpanRead())
    expect(getShowAllWorkspaces()).toBe(true)
    await flush()
    // Once it has landed, the account is the answer again.
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: false }, beginWorkspaceSpanRead())
    expect(getShowAllWorkspaces()).toBe(false)
  })

  it('says nothing when the body has no such field (an older server)', () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: null }))
    applyAccountWorkspaceSpan({ id: 'u1' }, beginWorkspaceSpanRead())
    expect(getShowAllWorkspaces()).toBe(true)
    expect(saves()).toEqual([])
  })
})

describe('an account that has never saved an answer', () => {
  it("takes this device's cached answer and saves it", async () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: null }))
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: null }, beginWorkspaceSpanRead())
    await flush()
    expect(getShowAllWorkspaces()).toBe(true)
    expect(saves()).toEqual([{ show_all_workspaces: true }])
    expect(cached()).toEqual({ all: true, user: 'u1' })
  })

  it('carries up the inbox\'s old "All workspaces" toggle', async () => {
    window.localStorage.setItem(LEGACY_INBOX_KEY, 'all')
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: null }, beginWorkspaceSpanRead())
    await flush()
    expect(getShowAllWorkspaces()).toBe(true)
    expect(saves()).toEqual([{ show_all_workspaces: true }])
  })

  it('stays off, saving nothing, when this device has no answer either', () => {
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: null }, beginWorkspaceSpanRead())
    expect(getShowAllWorkspaces()).toBe(false)
    expect(saves()).toEqual([])
  })

  it("never inherits another user's cache on a shared device", () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: 'someone-else' }))
    expect(getShowAllWorkspaces()).toBe(true)
    applyAccountWorkspaceSpan({ id: 'u1', show_all_workspaces: null }, beginWorkspaceSpanRead())
    expect(getShowAllWorkspaces()).toBe(false)
    expect(saves()).toEqual([])
  })
})

describe('following other devices and windows', () => {
  it('re-reads the account when the window comes back, at most once per interval', async () => {
    const reader = mountReader(true)
    account = { id: 'u1', show_all_workspaces: true }

    // Back after a while: one read, and the answer from the other device lands.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(requests.filter((r) => !r.init?.method)).toHaveLength(1)
    expect(reader.seen.at(-1)).toBe(true)

    // Again straight away: throttled.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(requests.filter((r) => !r.init?.method)).toHaveLength(1)

    // After the interval: read again.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + WORKSPACE_SPAN_RESYNC_MS + 1)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(requests.filter((r) => !r.init?.method)).toHaveLength(2)
    reader.unmount()
  })

  it('the re-read also brings the account’s agent look and name (another account signed in elsewhere, or saved there)', async () => {
    __resetAgentLookForTests()
    __resetAssistantNameForTests()
    let look: unknown
    function LookProbe() {
      look = useAgentLook()
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(h(LookProbe)))
    expect(look).toBe(DEFAULT_AGENT_LOOK)
    expect(getAssistantName()).toBe('Joseph')
    account = { id: 'u1', show_all_workspaces: false, agent_look: { ...DEFAULT_AGENT_LOOK, type: 'cat' }, assistant_name: 'Ada' }
    await act(async () => {
      await syncWorkspaceSpanFromAccount()
    })
    expect(look).toMatchObject({ type: 'cat' })
    expect(getAssistantName()).toBe('Ada')
    act(() => root.unmount())
    __resetAgentLookForTests()
    __resetAssistantNameForTests()
  })

  it('a re-read that fails keeps the answer held', async () => {
    setShowAllWorkspaces(true)
    await flush()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await syncWorkspaceSpanFromAccount()
    expect(getShowAllWorkspaces()).toBe(true)
  })

  it('follows a flip made in another window sharing this storage', () => {
    const reader = mountReader()
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: 'u1' }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_SPAN_STORAGE_KEY }))
    })
    expect(reader.seen.at(-1)).toBe(true)
    // Another key's event is not this switch's business.
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: false, user: 'u1' }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'dial8:something-else' }))
    })
    expect(reader.seen.at(-1)).toBe(true)
    // Following another window saves nothing: that window already did.
    expect(saves()).toEqual([])
    reader.unmount()
  })
})

describe('isInWorkspaceSpan — the arrival-sound gate', () => {
  it('with the switch off, lets only the active workspace through', () => {
    expect(isInWorkspaceSpan('ws-a')).toBe(true)
    expect(isInWorkspaceSpan('ws-b')).toBe(false)
  })

  it('with the switch on, lets every workspace through', () => {
    setShowAllWorkspaces(true)
    expect(isInWorkspaceSpan('ws-b')).toBe(true)
  })

  it("lets everything through while the active workspace, or the row's, is unknown", () => {
    expect(isInWorkspaceSpan(undefined)).toBe(true)
    active.id = null
    expect(isInWorkspaceSpan('ws-b')).toBe(true)
  })
})
