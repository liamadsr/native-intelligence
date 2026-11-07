// @vitest-environment jsdom
/**
 * The composer's `/` and `@` menu, end to end in the real composer (the menu
 * real too, the server stubbed). The text in the box is the menu's query and
 * the caret never leaves the box, so:
 *   - typed fast, every key lands in the box (`/capt` is all there, not a `/`
 *     in the box and the rest somewhere else), and the menu follows it;
 *   - Backspace over the trigger closes the menu with nothing left behind,
 *     and backspacing back into a trigger opens it again;
 *   - a space after `/` means it was only a slash: the text stays, the menu goes;
 *   - Esc puts the menu away for that trigger and keeps what was typed;
 *   - Enter picks while the menu shows (a person is mentioned and attached),
 *     and sends once it's done;
 *   - in the box only `@` opens the menu, to attach: a `/` there is a
 *     character;
 *   - `/` pressed anywhere outside a text field opens the same menu centred,
 *     its own field focused at once, and what's picked there lands in the box;
 *     ⌘K opens it from anywhere, and closes it again;
 *   - `/` opens what's picked, `@` attaches it, and nothing swaps them
 *     (docs/plans/slash-search.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { Profiler, act, createElement as h, useEffect, useState } from 'react'
import { getEdition } from '@/lib/editions/manifest'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import type { MentionContact } from '../mention-picker'
import type { SkillCommand } from '../chat-panel'
import { scoreText, toMentionContact, type MentionRecord, type MenuSearchRow } from '@/lib/search/menu-search'
import { clearMenuSearchCache } from '../use-menu-search'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}) }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-menu' }))

import { ChatInput } from '../chat-input'

const SKILLS: SkillCommand[] = [
  { id: 's-brief', slug: 'brief', name: 'Morning Brief', icon: null, color: null, description: 'Your day', views_context: null },
  { id: 's-scout', slug: 'scout', name: 'Scout', icon: null, color: null, description: null, views_context: null },
]
const PEOPLE = [
  { id: 'c-maya', full_name: 'Maya Chen', email: 'maya@acme.test', job_title: 'CEO', member_id: null, company: null },
  { id: 'c-omar', full_name: 'Omar Diaz', email: 'omar@acme.test', job_title: null, member_id: null, company: null },
  { id: 'c-tom', full_name: 'Tom Reyes', email: 'tom@acme.test', job_title: null, member_id: null, company: null },
]
const ACTIONS = [{ kind: 'action' as const, id: 'a-42', title: 'Pricing page copy', identifier: 'GEN-42', status: 'Todo', score: 0 }]
const PAGES = pagesFor(getEdition('full'), { desktop: false })

const host = vi.hoisted(() => ({
  value: '',
  skill: null as SkillCommand | null,
  contacts: [] as MentionContact[],
  records: [] as MentionRecord[],
  onSubmit: (() => {}) as () => void,
  onOpenPage: (() => {}) as (page: { slug: string }) => void,
  onOpenRecord: (() => {}) as (row: MenuSearchRow) => void,
}))

function Host() {
  const [value, setValue] = useState('')
  const [skill, setSkill] = useState<SkillCommand | null>(null)
  const [contacts, setContacts] = useState<MentionContact[]>([])
  const [records, setRecords] = useState<MentionRecord[]>([])
  // What the host holds, for the tests to read after each act().
  useEffect(() => {
    Object.assign(host, { value, skill, contacts, records })
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
    attachedContacts: contacts,
    onAttachContact: (c: MentionContact) => setContacts((cs) => [...cs, c]),
    onRemoveContact: (id: string) => setContacts((cs) => cs.filter((c) => c.id !== id)),
    attachedCompanies: [],
    onAttachCompany: () => {},
    onRemoveCompany: () => {},
    attachedRecords: records,
    onAttachRecord: (r: MentionRecord) => setRecords((rs) => [...rs, r]),
    onRemoveRecord: (id: string) => setRecords((rs) => rs.filter((r) => r.id !== id)),
    onOpenRecord: (row: MenuSearchRow) => host.onOpenRecord(row),
    attachedFiles: [],
    onAttachFiles: () => {},
    onRemoveFile: () => {},
    activeSkill: skill,
    onActivateSkill: setSkill,
    onClearSkill: () => setSkill(null),
    pages: PAGES,
    onOpenPage: (page: { slug: string }) => host.onOpenPage(page),
  })
}

let container: HTMLDivElement
let root: Root
/** Renders committed under the composer's host (a React Profiler round it). */
let commits = 0
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement

/** Type into the box at its caret, a key at a time, as fast as the events come. */
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
function backspace(times = 1) {
  for (let i = 0; i < times; i++) {
    act(() => {
      const ta = textarea()
      const { selectionStart: s, value } = ta
      if (s === 0) return
      setter.call(ta, value.slice(0, s - 1) + value.slice(s))
      ta.setSelectionRange(s - 1, s - 1)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}
/** A key in the box; returns the event (was it taken?). */
function press(key: string, opts: KeyboardEventInit = {}, target: EventTarget = textarea()) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}
/** Move the caret without typing (an arrow key, a click): the document's selectionchange, as a browser sends it. */
function moveCaret(to: number) {
  act(() => {
    textarea().setSelectionRange(to, to)
    document.dispatchEvent(new Event('selectionchange'))
  })
}
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

/** Type into the palette's own field (it has the focus once open). */
function searchFor(text: string) {
  const input = document.querySelector<HTMLInputElement>('[data-command-menu-input]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const inlineMenu = () => document.querySelector('[data-command-menu="inline"]')
const palette = () => document.querySelector('[data-command-menu="palette"]')
const rows = () => [...document.querySelectorAll('[data-command-item]')]
const highlighted = () => document.querySelector('[data-command-item][aria-selected="true"]')

beforeEach(async () => {
  host.onSubmit = vi.fn()
  host.onOpenPage = vi.fn()
  host.onOpenRecord = vi.fn()
  clearMenuSearchCache()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://app.test')
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const types = (url.searchParams.get('types') ?? '').split(',')
      const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
      if (url.pathname === '/api/account/skills/commands') return json({ commands: SKILLS })
      if (url.pathname === '/api/account/search') {
        const results: Record<string, MenuSearchRow[]> = {}
        for (const t of types) results[t] = []
        if (types.includes('contact')) {
          results.contact = PEOPLE.filter((p) => !q || p.full_name.toLowerCase().includes(q)).map((p) => ({
            kind: 'contact' as const,
            contact: toMentionContact(p),
            score: scoreText(p.full_name, q),
          }))
        }
        if (types.includes('action') && q) {
          results.action = ACTIONS.filter((a) => a.identifier.toLowerCase().startsWith(q) || a.title.toLowerCase().includes(q)).map((a) => ({
            ...a,
            score: a.identifier.toLowerCase().startsWith(q) ? 1.1 : scoreText(a.title, q),
          }))
        }
        return json({ query: q, results })
      }
      return json({})
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  commits = 0
  act(() => root.render(h(Profiler, { id: 'composer', onRender: () => void commits++ }, h(Host))))
  act(() => textarea().focus())
  await settle()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the menu in the box: `@`, to attach', () => {
  it('`/` in the box is only a character: no menu (search is the global palette’s)', async () => {
    type('/capt')
    await settle(200)
    expect(host.value).toBe('/capt')
    expect(inlineMenu()).toBeNull()
    expect(palette()).toBeNull()
  })

  it('keeps every key typed fast in the box, and the menu follows it', async () => {
    type('@ma')
    await settle(200)
    expect(host.value).toBe('@ma')
    expect(inlineMenu()).not.toBeNull()
    expect(highlighted()?.getAttribute('data-contact-item')).toBe('c-maya')
  })

  it('Backspace over the trigger closes it with nothing left behind', async () => {
    type('@ma')
    await settle(200)
    backspace(3)
    await settle()
    expect(host.value).toBe('')
    expect(inlineMenu()).toBeNull()
  })

  it('backspacing back into a trigger opens it again, every time', async () => {
    type('@')
    await settle(200)
    expect(inlineMenu()).not.toBeNull()
    backspace()
    await settle()
    expect(inlineMenu()).toBeNull()
    type('@')
    await settle(200)
    expect(inlineMenu()).not.toBeNull()
    // A space straight after `@` means it was only an at sign.
    type(' ')
    await settle()
    expect(inlineMenu()).toBeNull()
    backspace()
    await settle(200)
    expect(inlineMenu()).not.toBeNull()
  })

  it('steps aside once nothing matches, and Enter sends what was typed', async () => {
    type('@zzqx')
    // Searching first; the empty answer puts it away.
    await settle(300)
    expect(inlineMenu()).toBeNull()
    const enter = press('Enter')
    expect(enter.defaultPrevented).toBe(true) // the composer's own send
    expect(host.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Esc puts it away for that trigger and keeps the text; it opens again once the caret comes back', async () => {
    type('@ma')
    await settle(200)
    expect(inlineMenu()).not.toBeNull()
    press('Escape')
    await settle()
    expect(inlineMenu()).toBeNull()
    expect(host.value).toBe('@ma')
    type('y')
    await settle(200)
    expect(inlineMenu()).toBeNull()
    moveCaret(0)
    await settle()
    moveCaret(4)
    await settle(200)
    expect(inlineMenu()).not.toBeNull()
  })

  it('arrows move the highlight and Tab switches the kind shown', async () => {
    type('@a')
    await settle(200)
    const first = highlighted()
    press('ArrowDown')
    expect(highlighted()).not.toBe(first)
    press('ArrowUp')
    expect(highlighted()).toBe(first)
    const tab = press('Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-menu-tab="people"]')!.getAttribute('aria-selected')).toBe('true')
    expect(rows().map((r) => r.getAttribute('data-contact-item'))).toEqual(['c-maya', 'c-omar'])
    press('Tab')
    expect(rows().map((r) => r.getAttribute('data-record-item'))).toEqual(['action:a-42'])
    press('Tab', { shiftKey: true })
    expect(document.querySelector('[data-menu-tab="people"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('`@` finds people, and Enter mentions one and attaches them', async () => {
    type('ask @ma')
    await settle(200)
    expect(highlighted()?.getAttribute('data-contact-item')).toBe('c-maya')
    expect(highlighted()?.querySelector('[data-menu-row-verb]')?.getAttribute('data-menu-row-verb')).toBe('mention')
    press('Enter')
    expect(host.value).toBe('ask @Maya Chen ')
    expect(host.contacts.map((c) => c.id)).toEqual(['c-maya'])
    expect(host.onOpenRecord).not.toHaveBeenCalled()
  })

  it('⌘↵ is never the menu’s: `@` only attaches, and nothing opens from the box', async () => {
    type('@ma')
    await settle(200)
    press('Enter', { ctrlKey: true })
    expect(host.onOpenRecord).not.toHaveBeenCalled()
    expect(host.contacts).toEqual([])
    press('Enter')
    expect(host.contacts.map((c) => c.id)).toEqual(['c-maya'])
    expect(host.onOpenRecord).not.toHaveBeenCalled()
  })

  it('`@` mentions an action by its identifier, attached as a record', async () => {
    type('what about @gen-4')
    await settle(200)
    expect(highlighted()?.getAttribute('data-record-item')).toBe('action:a-42')
    press('Enter')
    expect(host.value).toBe('what about @GEN-42 ')
    expect(host.records).toEqual([{ kind: 'action', id: 'a-42', title: 'Pricing page copy', identifier: 'GEN-42' }])
    // Its chip is in the box, and deleting the text takes it off.
    expect(container.querySelector('[data-record-chip="action:a-42"]')).not.toBeNull()
    backspace(7)
    expect(host.records).toEqual([])
  })

  it('`@` arms a skill like the palette does: its `/slug` leads the message, and Enter after it sends', async () => {
    type('@bri')
    await settle(200)
    expect(highlighted()?.getAttribute('data-skill-item')).toBe('brief')
    expect(highlighted()?.querySelector('[data-menu-row-verb]')?.getAttribute('data-menu-row-verb')).toBe('use')
    press('Enter')
    expect(host.value).toBe('/brief ')
    expect(host.skill?.slug).toBe('brief')
    await settle()
    expect(inlineMenu()).toBeNull()
    press('Enter')
    expect(host.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('`@` lists what attaches, recent people first, then the skills; never a page', async () => {
    const listed = () => [...document.querySelectorAll('[data-command-menu="inline"] [role="group"]')].map((g) => g.getAttribute('aria-label'))
    const searches = () =>
      vi
        .mocked(fetch)
        .mock.calls.map((c) => new URL(String(c[0]), 'http://app.test'))
        .filter((u) => u.pathname === '/api/account/search')
    type('@')
    await settle(200)
    expect(listed()).toEqual(['People', 'Skills'])
    type('ca')
    await settle(200)
    expect(rows().some((r) => r.hasAttribute('data-page-item'))).toBe(false)
    expect(searches().at(-1)!.searchParams.get('types')!.split(',')).not.toContain('agent')
  })

  it('moving the caret in plain text re-renders nothing', async () => {
    type('hello there world')
    await settle()
    const before = commits
    moveCaret(3)
    moveCaret(11)
    moveCaret(0)
    moveCaret(17)
    await settle()
    expect(commits).toBe(before)
    expect(inlineMenu()).toBeNull()
  })

  it('marks the box as the menu’s combobox while it shows, pointing at the highlighted row', async () => {
    type('@ma')
    await settle(200)
    const ta = textarea()
    expect(ta.getAttribute('role')).toBe('combobox')
    expect(ta.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(ta.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('listbox')
    expect(ta.getAttribute('aria-activedescendant')).toBe(highlighted()!.id)
    press('Escape')
    await settle()
    for (const name of ['role', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) {
      expect(ta.hasAttribute(name)).toBe(false)
    }
  })

  it('the highlight moving re-renders the menu, and points the box at the new row', async () => {
    type('@a')
    await settle(200)
    press('ArrowDown')
    expect(textarea().getAttribute('aria-activedescendant')).toBe(highlighted()!.id)
  })

  it('Enter on a tab with nothing matching sends what was typed', async () => {
    type('@a')
    await settle(200)
    press('Tab')
    expect(document.querySelector('[data-menu-tab="people"]')!.getAttribute('aria-selected')).toBe('true')
    type('zzqx')
    await settle(300)
    // The tab stays up, empty.
    expect(inlineMenu()).not.toBeNull()
    expect(rows()).toHaveLength(0)
    press('Enter')
    expect(host.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Enter while the answer is still out waits: it neither picks nor sends', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    type('ask @ma')
    await settle()
    const enter = press('Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(host.onSubmit).not.toHaveBeenCalled()
    expect(host.value).toBe('ask @ma')
  })

  it('an Enter held for an answer that finds nothing sends what was typed', async () => {
    type('@zzqx')
    const enter = press('Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(host.onSubmit).not.toHaveBeenCalled()
    await settle(300)
    expect(host.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('an `@` typed straight after a pick opens the menu, and stays open once the pick’s caret would land', async () => {
    type('@ma')
    await settle(200)
    press('Enter')
    // Before the next frame, where the pick puts the caret back (a browser
    // tells the page of that caret move with a selectionchange).
    type('@')
    await settle(40)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(host.value).toBe('@Maya Chen @')
    await settle(200)
    expect(inlineMenu()).not.toBeNull()
  })

  it('a click on a row picks it and leaves the caret in the box', async () => {
    type('@ma')
    await settle(200)
    act(() => (document.querySelector('[data-contact-item="c-maya"]') as HTMLButtonElement).click())
    expect(host.contacts.map((c) => c.id)).toEqual(['c-maya'])
    expect(host.value).toBe('@Maya Chen ')
  })
})

describe('`/` anywhere', () => {
  beforeEach(() => {
    act(() => textarea().blur())
  })

  it('opens the menu centred, its field focused in the same keystroke', async () => {
    const slash = press('/', {}, document.body)
    expect(slash.defaultPrevented).toBe(true)
    expect(palette()).not.toBeNull()
    expect(document.activeElement?.hasAttribute('data-command-menu-input')).toBe(true)
    // Nothing went into the box.
    expect(host.value).toBe('')
  })

  it('opens a page from its own field', async () => {
    press('/', {}, document.body)
    const input = document.activeElement as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'calen')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(200)
    press('Enter', {}, input)
    expect(host.onOpenPage).toHaveBeenCalledWith(expect.objectContaining({ slug: 'calendar' }))
    expect(palette()).toBeNull()
  })

  it('lists what opens: recent people, then the pages and skills', async () => {
    press('/', {}, document.body)
    await settle(200)
    const listed = [...document.querySelectorAll('[data-command-menu="palette"] [role="group"]')].map((g) => g.getAttribute('aria-label'))
    expect(listed).toEqual(['People', 'Pages', 'Skills'])
  })

  it('opens a record: Enter puts its card in the chat', async () => {
    press('/', {}, document.body)
    searchFor('oma')
    await settle(200)
    expect(highlighted()?.getAttribute('data-contact-item')).toBe('c-omar')
    expect(highlighted()?.querySelector('[data-menu-row-verb]')?.getAttribute('data-menu-row-verb')).toBe('open')
    press('Enter', {}, document.activeElement!)
    expect(host.onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contact', contact: expect.objectContaining({ id: 'c-omar' }) }))
    expect(host.contacts).toEqual([])
    expect(palette()).toBeNull()
  })

  it('Enter typed straight after the words waits for their answer: `tom⏎` opens Tom, not a page that matched first', async () => {
    press('/', {}, document.body)
    searchFor('tom')
    // Before the debounced answer is back.
    const enter = press('Enter', {}, document.activeElement!)
    expect(enter.defaultPrevented).toBe(true)
    expect(host.onOpenRecord).not.toHaveBeenCalled()
    await settle(300)
    expect(host.onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contact', contact: expect.objectContaining({ id: 'c-tom' }) }))
    expect(host.onOpenPage).not.toHaveBeenCalled()
  })

  it('a skill picked there leads the draft and arms it', async () => {
    type('what happened')
    act(() => textarea().blur())
    press('/', {}, document.body)
    const input = document.activeElement as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'brief')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(200)
    press('Enter', {}, input)
    expect(host.value).toBe('/brief what happened')
    expect(host.skill?.slug).toBe('brief')
  })

  it('⌘K opens it from anywhere, the box included, and ⌘K again closes it', async () => {
    const open = press('k', { metaKey: true })
    expect(open.defaultPrevented).toBe(true)
    expect(palette()).not.toBeNull()
    expect(document.activeElement?.hasAttribute('data-command-menu-input')).toBe(true)
    press('k', { metaKey: true }, document.activeElement!)
    expect(palette()).toBeNull()
  })

  it('the top bar’s search button opens it (open-search.ts), and pressing it again closes it', async () => {
    const { openSearch } = await import('@/lib/chat/open-search')
    let answered = false
    act(() => {
      answered = openSearch()
    })
    expect(answered).toBe(true)
    expect(palette()).not.toBeNull()
    expect(document.activeElement?.hasAttribute('data-command-menu-input')).toBe(true)
    act(() => {
      openSearch()
    })
    expect(palette()).toBeNull()
  })

  it('`/` again closes it, whatever its field holds: `/` opens and closes the palette', async () => {
    press('/', {}, document.body)
    expect(palette()).not.toBeNull()
    searchFor('tom')
    const again = press('/', {}, document.activeElement!)
    expect(again.defaultPrevented).toBe(true)
    expect(palette()).toBeNull()
    expect(host.value).toBe('')
    // And open again.
    press('/', {}, document.body)
    expect(palette()).not.toBeNull()
  })

  it('Esc closes it and leaves the draft as it was', async () => {
    press('/', {}, document.body)
    press('Escape', {}, document.activeElement!)
    expect(palette()).toBeNull()
    expect(host.value).toBe('')
  })

  it('is only a character in another text field', async () => {
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    const slash = press('/', {}, other)
    expect(slash.defaultPrevented).toBe(false)
    expect(palette()).toBeNull()
    other.remove()
  })
})
