// @vitest-environment jsdom
/**
 * A host's own `@` list in the composer (ChatInput's `mentionList`; team chat
 * passes its agent and members): `@` lists those options in the inline menu,
 * narrowed by what's typed, in place of the record search (none runs, nor a
 * skills read). A pick puts `@Label ` where the token was and tells the host
 * which option; no chip. A host that takes no files says so in + and takes no
 * dropped or pasted file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect, useState } from 'react'
import type { ComposerMentionOption } from '../command-menu-model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}) }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-list' }))

import { ChatInput } from '../chat-input'

const OPTIONS: ComposerMentionOption[] = [
  { id: '__agent__', label: 'Joseph', hint: 'your agent', agent: true },
  { id: 'm-rosa', label: 'Rosa Lind' },
  { id: 'm-ana', label: 'Ana Ruiz' },
]

const host = vi.hoisted(() => ({
  value: '',
  picks: [] as string[],
  files: [] as File[],
  onSubmit: (() => {}) as () => void,
}))

function Host({ filesOff = false }: { filesOff?: boolean }) {
  const [value, setValue] = useState('')
  // What the host holds, for the tests to read after each act().
  useEffect(() => {
    host.value = value
  })
  return h(ChatInput, {
    value,
    onChange: setValue,
    onSubmit: () => host.onSubmit(),
    onStop: () => {},
    isLoading: false,
    attachedNotes: [],
    onAttachNote: () => {},
    onRemoveNote: () => {},
    attachedFiles: [],
    onAttachFiles: (files: File[]) => host.files.push(...files),
    onRemoveFile: () => {},
    mainComposer: false,
    unavailable: filesOff ? { files: { reason: 'Team chat messages are text only.' } } : undefined,
    mentionList: { options: OPTIONS, onPick: (o: ComposerMentionOption) => host.picks.push(o.id) },
  })
}

let container: HTMLDivElement
let root: Root
let fetchSpy: ReturnType<typeof vi.fn>
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement

function type(text: string) {
  for (const ch of text) {
    act(() => {
      const ta = textarea()
      const { selectionStart: s, selectionEnd: e, value } = ta
      setter.call(ta, value.slice(0, s) + ch + value.slice(e))
      ta.setSelectionRange(s + 1, s + 1)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}
function press(key: string, opts: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  act(() => {
    textarea().dispatchEvent(event)
  })
  return event
}
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const inlineMenu = () => document.querySelector('[data-command-menu="inline"]')
const optionRows = () => [...document.querySelectorAll<HTMLElement>('[data-mention-option]')]
const optionIds = () => optionRows().map((r) => r.getAttribute('data-mention-option'))

async function mount(props: { filesOff?: boolean } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(Host, props)))
  act(() => textarea().focus())
  await settle()
}

beforeEach(() => {
  host.value = ''
  host.picks = []
  host.files = []
  host.onSubmit = vi.fn()
  fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response)
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("a host's own @ list", () => {
  it('lists the options on @, in the host’s order, with their hints, and no record search or skills read runs', async () => {
    await mount()
    type('@')
    await settle(250)
    expect(inlineMenu()).not.toBeNull()
    expect(optionIds()).toEqual(['__agent__', 'm-rosa', 'm-ana'])
    expect(optionRows()[0].textContent).toContain('your agent')
    // No record kinds, no skills: only the host's rows.
    expect(document.querySelectorAll('[data-command-item]:not([data-mention-option])')).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('narrows the options by what follows @ (a word of the name, or the name)', async () => {
    await mount()
    type('@li')
    await settle()
    expect(optionIds()).toEqual(['m-rosa'])
    type('x')
    await settle()
    // Nothing matches: the menu steps aside, and Enter is the box's (it sends).
    expect(inlineMenu()).toBeNull()
    press('Enter')
    expect(host.onSubmit).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Enter picks the highlighted option: "@Label " replaces the token, the host is told, nothing is sent', async () => {
    await mount()
    type('hi @an')
    await settle()
    expect(optionIds()).toEqual(['m-ana'])
    const e = press('Enter')
    expect(e.defaultPrevented).toBe(true)
    await settle()
    expect(host.value).toBe('hi @Ana Ruiz ')
    expect(host.picks).toEqual(['m-ana'])
    expect(host.onSubmit).not.toHaveBeenCalled()
    expect(inlineMenu()).toBeNull()
    // No chip: a host's option attaches nothing.
    expect(container.querySelector('.lucide-user')).toBeNull()
  })

  it('after a pick the menu stays shut where the caret lands, so Enter sends (a message ending in a mention)', async () => {
    await mount()
    type('thanks @ro')
    await settle()
    press('Enter')
    await settle()
    expect(host.value).toBe('thanks @Rosa Lind ')
    // The browser reads the caret where the pick left it, past "@Rosa Lind ".
    const ta = textarea()
    act(() => {
      ta.setSelectionRange(ta.value.length, ta.value.length)
      document.dispatchEvent(new Event('selectionchange'))
      ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
    })
    await settle()
    expect(inlineMenu()).toBeNull()
    press('Enter')
    expect(host.onSubmit).toHaveBeenCalledTimes(1)
    expect(host.picks).toEqual(['m-rosa'])
  })

  it('a click on a row picks it too, and the arrows move the highlight', async () => {
    await mount()
    type('@')
    await settle()
    press('ArrowDown')
    expect(document.querySelector('[data-mention-option][aria-selected="true"]')?.getAttribute('data-mention-option')).toBe('m-rosa')
    act(() => optionRows()[0].click())
    await settle()
    expect(host.value).toBe('@Joseph ')
    expect(host.picks).toEqual(['__agent__'])
  })
})

describe('a host that takes no files', () => {
  it('says why in the + menu, in place of Add files, and takes no pasted file', async () => {
    await mount({ filesOff: true })
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click())
    await settle()
    const note = document.querySelector('[data-composer-unavailable="files"]')
    expect(note?.textContent).toContain('Team chat messages are text only.')
    expect(document.body.textContent).not.toContain('Add files or photos')
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    paste.clipboardData = { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] }
    act(() => {
      textarea().dispatchEvent(paste)
    })
    expect(host.files).toHaveLength(0)
  })
})
