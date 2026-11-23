// @vitest-environment jsdom
/**
 * `;` in a plain text box (use-textarea-snippets.ts), through MentionTextarea:
 * typing `;query` opens the snippet menu with that query (and not the `@`
 * menu); Enter puts the snippet's words, fill-ins filled, where `;query` was;
 * Esc closes it until the caret leaves the `;`; mid-word it never opens. The
 * menu is a light stand-in (its looks are the real one's, checked in the app):
 * it shows the query and takes Enter and Esc as the real one does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useImperativeHandle, useState } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/(dashboard)/chat/command-menu', () => ({
  CommandMenu: ({ open }: { open: boolean }) => (open ? h('div', { 'data-at-menu': '' }) : null),
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@/components/snippets/snippet-menu', () => ({
  SnippetMenu: function Stand(props: {
    open: boolean
    query: string
    snippets: Array<{ shortcut: string }>
    onPick: (s: unknown) => void
    onDismiss: () => void
    menuRef: React.Ref<{ handleKey: (e: KeyboardEvent) => boolean }>
  }) {
    const rows = props.snippets.filter((s) => s.shortcut.startsWith(props.query))
    useImperativeHandle(props.menuRef, () => ({
      handleKey: (e: KeyboardEvent) => {
        if (!props.open || !rows.length) return false
        if (e.key === 'Enter') {
          props.onPick(rows[0])
          return true
        }
        if (e.key === 'Escape') {
          props.onDismiss()
          return true
        }
        return false
      },
    }))
    return props.open && rows.length ? h('div', { 'data-snippet-menu': '', 'data-query': props.query }) : null
  },
}))

import { MentionTextarea } from '@/components/mentions/mention-textarea'
import { setSnippets } from '../use-snippets'
import type { Snippet } from '@/lib/snippets/types'

const snippet = (shortcut: string, body: string): Snippet => ({
  id: shortcut,
  name: shortcut,
  shortcut,
  body,
  visibility: 'personal',
  mine: true,
  canEdit: true,
  updatedAt: '2026-11-23T00:00:00Z',
})

let container: HTMLDivElement
let root: Root
const keys: string[] = []

function Host() {
  const [value, setValue] = useState('')
  return h(MentionTextarea, {
    value,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => keys.push(e.key),
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
function press(key: string) {
  act(() => {
    ta().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

beforeEach(() => {
  keys.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ snippets: [] }))))
  setSnippets([snippet('sig', 'Best,\n{{my_first_name}}'), snippet('thanks', 'Thanks!')], 'Rosa Lind')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(Host)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('`;` in a text box', () => {
  it('opens on ;query, and Enter puts the words in with fill-ins filled', async () => {
    type('Cheers ;si')
    await settle()
    expect(container.querySelector('[data-snippet-menu]')?.getAttribute('data-query')).toBe('si')
    press('Enter')
    await settle()
    expect(ta().value).toBe('Cheers Best,\nRosa')
    expect(keys).not.toContain('Enter')
    expect(container.querySelector('[data-snippet-menu]')).toBeNull()
  })

  it('never opens mid-word, and the `@` menu steps aside for it', async () => {
    type('a;s')
    await settle()
    expect(container.querySelector('[data-snippet-menu]')).toBeNull()
    act(() => root.render(h(Host, { key: 'again' })))
    type('@Maya ;th')
    await settle()
    expect(container.querySelector('[data-snippet-menu]')).toBeTruthy()
    expect(container.querySelector('[data-at-menu]')).toBeNull()
  })

  it('Esc closes it while the ; is typed on; the host gets keys when nothing matches', async () => {
    type(';t')
    await settle()
    press('Escape')
    await settle()
    expect(container.querySelector('[data-snippet-menu]')).toBeNull()
    type('h')
    await settle()
    expect(container.querySelector('[data-snippet-menu]')).toBeNull()
    type(' ;zz')
    await settle()
    press('Enter')
    expect(keys).toContain('Enter')
  })
})
