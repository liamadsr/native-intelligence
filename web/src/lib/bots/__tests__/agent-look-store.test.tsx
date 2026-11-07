// @vitest-environment jsdom
/**
 * The agent's look (agent-look-store.ts), kept on the account with a copy on
 * this device: the default until a look is saved; a save worn at once and sent
 * to the account (the profile PATCH, stubbed), taken back when the account
 * refuses it; the copy read back checked; another window's copy followed; the
 * account's look from a profile read worn, and an account with none (another
 * account signed in) back on the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { applyAccountSettings, beginAccountSettingsRead } from '../../account-setting'
import { DEFAULT_AGENT_LOOK } from '../agent-look'
import { AGENT_LOOK_STORAGE_KEY, __resetAgentLookForTests, saveAgentLook, useAgentLook } from '../agent-look-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let seen: unknown
function Probe() {
  seen = useAgentLook()
  return null
}

let profileOk = true
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: profileOk ? 200 : 500 }))

beforeEach(() => {
  profileOk = true
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.localStorage.clear()
  __resetAgentLookForTests()
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the agent’s look', () => {
  it('is the default until one is saved', () => {
    act(() => root.render(<Probe />))
    expect(seen).toBe(DEFAULT_AGENT_LOOK)
  })

  it('saves a look to the account, and every bot wearing it changes at once', async () => {
    act(() => root.render(<Probe />))
    let ok = false
    await act(async () => {
      ok = await saveAgentLook({ ...DEFAULT_AGENT_LOOK, type: 'cat', hat: 'party' })
    })
    expect(ok).toBe(true)
    expect(seen).toMatchObject({ type: 'cat', hat: 'party' })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ agent_look: expect.objectContaining({ type: 'cat', hat: 'party' }) })
    expect(JSON.parse(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)!)).toMatchObject({ type: 'cat', hat: 'party' })
  })

  it('says so when the account refuses the look, and keeps the look it had', async () => {
    profileOk = false
    act(() => root.render(<Probe />))
    let ok = true
    await act(async () => {
      ok = await saveAgentLook({ ...DEFAULT_AGENT_LOOK, type: 'cat' })
    })
    expect(ok).toBe(false)
    expect(seen).toBe(DEFAULT_AGENT_LOOK)
    expect(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)).toBeNull()
  })

  it('reads its copy back checked, and the default for anything else', () => {
    window.localStorage.setItem(AGENT_LOOK_STORAGE_KEY, JSON.stringify({ type: 'star', glasses: 'laser', bowTie: true }))
    act(() => root.render(<Probe />))
    expect(seen).toEqual({ type: 'star', glasses: 'none', hat: 'none', headphones: false, bowTie: true, shading: 'fabric' })
    __resetAgentLookForTests()
    window.localStorage.setItem(AGENT_LOOK_STORAGE_KEY, '{not json')
    act(() => root.render(<Probe key="again" />))
    expect(seen).toBe(DEFAULT_AGENT_LOOK)
  })

  it('takes another window’s copy', () => {
    act(() => root.render(<Probe />))
    window.localStorage.setItem(AGENT_LOOK_STORAGE_KEY, JSON.stringify({ ...DEFAULT_AGENT_LOOK, type: 'ghost' }))
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: AGENT_LOOK_STORAGE_KEY })))
    expect(seen).toMatchObject({ type: 'ghost' })
  })

  it('wears the signed-in account’s look, and the default for an account with none', () => {
    // The last account's copy on this device.
    window.localStorage.setItem(AGENT_LOOK_STORAGE_KEY, JSON.stringify({ ...DEFAULT_AGENT_LOOK, type: 'ghost' }))
    act(() => root.render(<Probe />))
    expect(seen).toMatchObject({ type: 'ghost' })
    act(() => applyAccountSettings({ id: 'user-2', agent_look: null }, beginAccountSettingsRead()))
    expect(seen).toBe(DEFAULT_AGENT_LOOK)
    expect(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)).toBeNull()
    act(() => applyAccountSettings({ id: 'user-3', agent_look: { ...DEFAULT_AGENT_LOOK, type: 'cat', hat: 'crown' } }, beginAccountSettingsRead()))
    expect(seen).toMatchObject({ type: 'cat', hat: 'crown' })
    expect(JSON.parse(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)!)).toMatchObject({ type: 'cat', hat: 'crown' })
  })
})
