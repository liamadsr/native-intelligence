// @vitest-environment jsdom
/**
 * The field editor's new types (Tables, phase 2): option chips for a
 * multi-select, a checkbox, a member picker, linked records by name, and an
 * amount without its field's own code. Made-up fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { CustomFieldsGroup } from '../custom-fields-group'

const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const MEMBER = 'a0000000-0000-4000-8000-000000000001'
const DEAL = 'd0000000-0000-4000-8000-000000000001'

let container: HTMLDivElement
let root: Root
let posts: unknown[]

const answer = {
  fields: [
    { key: 'tags', label: 'Tags', field_type: 'multi_select', value: ['Gold'] },
    { key: 'vip', label: 'VIP', field_type: 'checkbox', value: true },
    { key: 'owner', label: 'Owner', field_type: 'person', value: MEMBER },
    { key: 'deals', label: 'Deals', field_type: 'relation', value: [DEAL] },
    { key: 'budget', label: 'Budget', field_type: 'currency', value: { amount: 1200, currency: 'EUR' } },
  ],
  definitions: [
    { key: 'tags', options: ['Gold', 'Silver'], config: {} },
    { key: 'vip', options: [], config: {} },
    { key: 'owner', options: [], config: {} },
    { key: 'deals', options: [], config: { target: { kind: 'flow' }, multiple: true } },
    { key: 'budget', options: [], config: { currency: 'EUR' } },
  ],
  editable: true,
  labels: { [MEMBER]: 'Robin', [DEAL]: 'Fernhill renewal' },
  members: [{ id: MEMBER, name: 'Robin' }],
}

beforeEach(() => {
  posts = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ custom_fields: {} }), { status: 200 })
      }
      return new Response(JSON.stringify(answer), { status: 200 })
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('CustomFieldsGroup, the new types', () => {
  it('shows each with its own editor', async () => {
    await act(async () => root.render(<CustomFieldsGroup entityType="contact" recordId={CONTACT} />))
    await settle()
    const field = (key: string) => container.querySelector(`[data-custom-field="${key}"]`)!
    const chips = [...field('tags').querySelectorAll('button')]
    expect(chips.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Gold', 'true'], ['Silver', 'false']])
    expect((field('vip').querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
    expect((field('owner').querySelector('select') as HTMLSelectElement).value).toBe(MEMBER)
    expect(field('deals').textContent).toContain('Fernhill renewal')
    expect((field('budget').querySelector('input') as HTMLInputElement).value).toBe('1200')
  })

  it('saves a chip as the whole list, and a removed link as what is left', async () => {
    await act(async () => root.render(<CustomFieldsGroup entityType="contact" recordId={CONTACT} />))
    await settle()
    const silver = [...container.querySelectorAll('[data-custom-field="tags"] button')].find((b) => b.textContent === 'Silver') as HTMLButtonElement
    await act(async () => silver.click())
    await settle()
    const remove = container.querySelector(`[data-linked-record="${DEAL}"] button`) as HTMLButtonElement
    await act(async () => remove.click())
    await settle()
    expect(posts).toEqual([
      { entity_type: 'contact', id: CONTACT, values: { tags: ['Gold', 'Silver'] } },
      { entity_type: 'contact', id: CONTACT, values: { deals: [] } },
    ])
  })

  it('reads as text, by name, when the record is view-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...answer, editable: false }), { status: 200 })))
    await act(async () => root.render(<CustomFieldsGroup entityType="contact" recordId={CONTACT} />))
    await settle()
    const text = container.textContent ?? ''
    for (const words of ['Gold', 'Yes', 'Robin', 'Fernhill renewal', '€1,200.00']) expect(text).toContain(words)
    expect(container.querySelectorAll('input, select')).toHaveLength(0)
  })
})
