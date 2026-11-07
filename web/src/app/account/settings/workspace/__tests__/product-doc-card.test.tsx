// @vitest-environment jsdom
/**
 * Settings → Workspace "Product facts": members see the designated doc
 * read-only (no Change, no Clear, no picker); owners/admins manage it; a member
 * with nothing set sees nothing (an empty widget renders nothing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children?: ReactNode; className?: string }) =>
    h('a', { href, className }, children),
}))
// Radix Popover needs pointer APIs jsdom lacks; the picker's trigger row is
// what these tests look for, so it is a plain marker.
const picker = vi.hoisted(() => ({ documents: [] as Array<{ id: string; title: string }>, onOpenChange: null as null | ((o: boolean) => void) }))
vi.mock('@/components/documents/document-search-picker', () => ({
  DocumentSearchPicker: ({ label, documents, onOpenChange }: { label?: string; documents: Array<{ id: string; title: string }>; onOpenChange: (o: boolean) => void }) => {
    picker.documents = documents
    picker.onOpenChange = onOpenChange
    return h('div', { 'data-testid': 'doc-picker' }, label)
  },
}))

import { ProductDocCard } from '../product-doc-card'

let productDoc: unknown
let loadFails = false
let documentsList: unknown[] = []
const calls: Array<{ url: string; method: string }> = []

beforeEach(() => {
  calls.length = 0
  productDoc = null
  loadFails = false
  documentsList = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      // Docs only (migration 367): reports and preps never reach the picker.
      if (String(url) === '/api/account/documents?kind=doc') {
        return { ok: true, status: 200, json: async () => ({ documents: documentsList }) } as unknown as Response
      }
      if (loadFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as unknown as Response
      return { ok: true, status: 200, json: async () => ({ product_doc: productDoc }) } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function render(canManage: boolean) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(h(ProductDocCard, { canManage }))
  })
  await act(async () => {})
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount()
        container.remove()
      }),
  }
}

const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')].map((b) => b.textContent?.trim())

describe('ProductDocCard', () => {
  const SET = { document_id: 'doc-1', title: 'Pricing & plans', updated_at: '2026-10-02T00:00:00Z', available: true }

  it('a member sees the designated doc read-only', async () => {
    productDoc = SET
    const { container, unmount } = await render(false)
    expect(container.textContent).toContain('Product facts')
    expect(container.textContent).toContain('Your agent states product facts only from this doc on calls.')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/account/wiki/doc-1')
    expect(link?.textContent).toBe('Pricing & plans')
    expect(buttons(container)).not.toContain('Change')
    expect(buttons(container)).not.toContain('Clear')
    expect(container.querySelector('[data-testid="doc-picker"]')).toBeNull()
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    await unmount()
  })

  it('a member with nothing set sees nothing', async () => {
    const { container, unmount } = await render(false)
    expect(container.querySelector('[data-testid="product-doc-card"]')).toBeNull()
    await unmount()
  })

  it('an admin sees Change and Clear on a designated doc', async () => {
    productDoc = SET
    const { container, unmount } = await render(true)
    expect(buttons(container)).toEqual(expect.arrayContaining(['Change', 'Clear']))
    await unmount()
  })

  it('an admin with nothing set gets the picker', async () => {
    const { container, unmount } = await render(true)
    expect(container.querySelector('[data-testid="doc-picker"]')?.textContent).toBe('Choose a document')
    await unmount()
  })

  it('a failed load tells an admin instead of showing "nothing set" silently', async () => {
    loadFails = true
    const { container, unmount } = await render(true)
    expect(container.textContent).toContain('Couldn’t load the product doc')
    await unmount()
  })

  it('a failed load still hides the card from a member', async () => {
    loadFails = true
    const { container, unmount } = await render(false)
    expect(container.querySelector('[data-testid="product-doc-card"]')).toBeNull()
    await unmount()
  })

  it('the picker leaves out the docs the server refuses (drafts, spec pages, meeting preps)', async () => {
    documentsList = [
      { id: 'ok', title: 'Pricing', published_status: 'published', type: 'page', frontmatter: null },
      { id: 'draft', title: 'Draft', published_status: 'draft', type: 'page' },
      { id: 'spec', title: 'Spec', published_status: 'published', type: 'spec' },
      { id: 'prep', title: 'Prep', published_status: 'published', type: 'page', frontmatter: { meeting_prep: { event_id: 'e1' } } },
    ]
    const { unmount } = await render(true)
    await act(async () => {
      picker.onOpenChange?.(true)
    })
    await act(async () => {})
    expect(picker.documents.map((d) => d.id)).toEqual(['ok'])
    await unmount()
  })

  it('Clear sends DELETE and empties the card', async () => {
    productDoc = SET
    const { container, unmount } = await render(true)
    const clear = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Clear')!
    await act(async () => {
      clear.click()
    })
    expect(calls).toContainEqual({ url: '/api/account/workspace/product-doc', method: 'DELETE' })
    expect(container.querySelector('a')).toBeNull()
    await unmount()
  })
})
