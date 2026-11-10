// @vitest-environment jsdom
/**
 * Settings → Preferences → Assistant (../assistant-name-section), with
 * the real name store (@/lib/voice/assistant-name-store): the account (the
 * profile PATCH, stubbed) and this device's copy in localStorage:
 *  - it shows the saved name, or Joseph when the user never picked one, and
 *    saves nothing until the name changes;
 *  - a valid name (trimmed, 1–30 letters, spaces, hyphens, apostrophes) saves
 *    to the account and the device's copy (ni:voice:assistant-name), says
 *    so, and is the name in effect at once (Interactive mode's wake word);
 *  - an invalid one says why and can't be saved; the account refusing says so
 *    and keeps the old name;
 *  - another window saving a name (a storage event) shows up here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { AssistantNameSection } from '../assistant-name-section'
import { __resetAssistantNameForTests, getAssistantName } from '@/lib/voice/assistant-name-store'

let container: HTMLDivElement
let root: Root

const input = () => container.querySelector<HTMLInputElement>('#assistant-name')!
const save = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Sav'))!

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function mount() {
  await act(async () => root.render(h(AssistantNameSection)))
  await flush()
}

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const KEY = 'ni:voice:assistant-name'
/** The device's copy of a name, as the store keeps it. */
const copy = (name: string) => JSON.stringify(name)

/** The account: the profile PATCH answers `profileOk`. */
let profileOk = true
const fetchMock = vi.fn(async () => new Response('{}', { status: profileOk ? 200 : 500 }))

beforeEach(() => {
  profileOk = true
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.localStorage.clear()
  __resetAssistantNameForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
  __resetAssistantNameForTests()
})

describe('AssistantNameSection', () => {
  it('shows Joseph when the user never picked a name; nothing to save until it changes', async () => {
    await mount()
    expect(container.textContent).toContain('Your assistant’s name')
    expect(input().value).toBe('Joseph')
    expect(save().disabled).toBe(true)
  })

  it('shows the name the user saved', async () => {
    window.localStorage.setItem(KEY, copy('Ada'))
    await mount()
    expect(input().value).toBe('Ada')
    expect(getAssistantName()).toBe('Ada')
  })

  it('saves a valid name, trimmed, to the account; it is the name in effect at once', async () => {
    await mount()
    await type('  Mary-Jane  ')
    expect(save().disabled).toBe(false)
    await act(async () => save().click())
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/profile', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ assistant_name: 'Mary-Jane' }) }))
    expect(window.localStorage.getItem(KEY)).toBe(copy('Mary-Jane'))
    expect(container.textContent).toContain('Saved. Your assistant is now Mary-Jane.')
    expect(getAssistantName()).toBe('Mary-Jane')
    expect(input().value).toBe('Mary-Jane')
  })

  it('an invalid name says why and cannot be saved', async () => {
    await mount()
    for (const [value, why] of [
      ['R2-D2', 'Use letters, spaces, hyphens and apostrophes only.'],
      ['x'.repeat(31), 'Keep it to 30 characters or fewer.'],
      ['   ', 'Give your assistant a name.'],
    ] as const) {
      await type(value)
      expect(save().disabled).toBe(true)
      expect(container.textContent).toContain(why)
    }
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the account refusing the name says so and keeps the old name', async () => {
    profileOk = false
    await mount()
    await type('Ada')
    await act(async () => save().click())
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t save the name. Try again.')
    expect(getAssistantName()).toBe('Joseph')
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('a name saved in another Native Intelligence window shows up here', async () => {
    await mount()
    window.localStorage.setItem(KEY, copy('Ada'))
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: copy('Ada') }))
    })
    expect(getAssistantName()).toBe('Ada')
    expect(input().value).toBe('Ada')
  })
})
