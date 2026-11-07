// @vitest-environment jsdom
/** Settings → Dictation (../dictation-settings-view): the filler-word switch, on by default, saved on this device. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../dictate-anywhere-section', () => ({ DictateAnywhereSection: () => null }))

import { DictationSettingsView } from '../dictation-settings-view'
import { REMOVE_FILLERS_KEY, getRemoveFillers } from '@/lib/voice/fillers'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DictationSettingsView', () => {
  it('Remove filler words is on by default, and turning it off is remembered', async () => {
    await act(async () => {
      root.render(<DictationSettingsView />)
    })
    const sw = container.querySelector<HTMLButtonElement>('button[aria-label="Remove filler words"]')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      sw.click()
    })
    expect(localStorage.getItem(REMOVE_FILLERS_KEY)).toBe('0')
    expect(getRemoveFillers()).toBe(false)
    await act(async () => {
      sw.click()
    })
    expect(localStorage.getItem(REMOVE_FILLERS_KEY)).toBeNull()
  })
})
