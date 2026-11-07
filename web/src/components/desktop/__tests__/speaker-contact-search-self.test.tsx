// @vitest-environment jsdom
/**
 * SpeakerContactSearch's "This is me" (followups issue 11): an unknown
 * speaker can be linked to the user themselves, above the contact list, and
 * the item only shows when the caller offers it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView = () => {}

import { SpeakerContactSearch } from '../speaker-contact-search'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ contacts: [] }) })))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function open(onAssignSelf?: () => void) {
  act(() => {
    root.render(
      h(SpeakerContactSearch, { speakerId: 'local_2', speakerDisplayName: 'local_2', onAssign: () => {}, onAssignSelf, children: h('button', { id: 'trigger' }, 'local_2') }),
    )
  })
  await act(async () => {
    document.getElementById('trigger')!.click()
  })
}
const item = () => Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).find((el) => el.textContent?.includes('This is me'))

describe('SpeakerContactSearch — This is me', () => {
  it('offers it and calls back when chosen', async () => {
    const onAssignSelf = vi.fn()
    await open(onAssignSelf)
    expect(item()).toBeTruthy()
    await act(async () => {
      item()!.click()
    })
    expect(onAssignSelf).toHaveBeenCalledTimes(1)
  })

  it('is absent when the caller does not offer it', async () => {
    await open(undefined)
    expect(document.querySelector('[cmdk-list]')).toBeTruthy()
    expect(item()).toBeUndefined()
  })
})
