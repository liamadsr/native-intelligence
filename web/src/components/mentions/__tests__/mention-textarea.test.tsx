// @vitest-environment jsdom
/**
 * MentionTextarea: a plain textarea with the one `@` picker. Typing `@word`
 * opens the shared menu with that query; picking a record replaces `@word`
 * with `@label ` in the text and hands the ref to `onMention`. Plain text in,
 * plain text out. The menu itself (CommandMenu) is stubbed — its own search is
 * covered elsewhere — so this pins MentionTextarea's token detection and the
 * replacement it makes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A light CommandMenu: it shows the query when open and offers one pick that
// calls onMentionRecord with a fake row.
vi.mock('@/app/account/(dashboard)/chat/command-menu', () => ({
  CommandMenu: ({ open, query, onMentionRecord, menuRef }: Record<string, unknown>) => {
    if (menuRef) (menuRef as { current: unknown }).current = { handleKey: () => false }
    return (open as boolean)
      ? h(
          'div',
          { 'data-menu': '', 'data-query': query as string },
          h('button', { type: 'button', 'data-pick': '', onClick: () => (onMentionRecord as (r: unknown) => void)({}) }, 'pick'),
        )
      : null
  },
}))
// The fake row maps to a known ref.
vi.mock('@/lib/search/menu-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/search/menu-search')>()),
  menuRowMention: () => ({ type: 'contact', id: 'c-maya', label: 'Maya Chen' }),
}))

import { MentionTextarea } from '../mention-textarea'

let container: HTMLDivElement
let root: Root
const mentions: Array<{ type: string; id: string; label: string }> = []

function Host() {
  const [value, setValue] = useState('')
  return h(MentionTextarea, {
    value,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value),
    onMention: (ref: { type: string; id: string; label: string }) => mentions.push(ref),
  })
}

const ta = () => container.querySelector('textarea') as HTMLTextAreaElement
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
function type(text: string) {
  act(() => ta().focus())
  for (const ch of text) {
    act(() => {
      const el = ta()
      const { selectionStart: s, selectionEnd: e, value } = el
      setter.call(el, value.slice(0, s) + ch + value.slice(e))
      el.setSelectionRange(s + 1, s + 1)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

beforeEach(() => {
  mentions.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(Host)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MentionTextarea', () => {
  it('opens the menu on @word with that query, and keeps plain text otherwise', async () => {
    type('hello ')
    await settle()
    expect(container.querySelector('[data-menu]')).toBeNull()

    type('@Ma')
    await settle()
    const menu = container.querySelector('[data-menu]')
    expect(menu).toBeTruthy()
    expect(menu?.getAttribute('data-query')).toBe('Ma')
  })

  it('a pick replaces @word with @label and hands over the ref', async () => {
    type('cc @Ma')
    await settle()
    act(() => container.querySelector<HTMLButtonElement>('[data-pick]')!.click())
    await settle()
    expect(ta().value).toBe('cc @Maya Chen ')
    expect(mentions).toEqual([{ type: 'contact', id: 'c-maya', label: 'Maya Chen' }])
    // The menu closes once the token is replaced (the caret sits past it).
    expect(container.querySelector('[data-menu]')).toBeNull()
  })
})
