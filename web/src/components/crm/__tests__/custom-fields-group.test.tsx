// @vitest-environment jsdom
/**
 * The field editor on any kind's panel (phase 6): it asks the values route
 * for the record's kind, renders nothing while the kind has no fields (hide
 * empty widgets), shows each field editable, and shows values as text with
 * no form when the record is the person's to view only. The settings page's
 * kind picker offers exactly the registry's kinds. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CUSTOM_FIELD_ENTITIES } from '@/lib/crm/custom-fields'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { CustomFieldsGroup } from '../custom-fields-group'
import { CustomFieldKindPicker, CustomFieldsSettingsView } from '@/app/account/settings/custom-fields/custom-fields-settings-view'

const TASK = 'a0000000-0000-4000-8000-000000000001'

let container: HTMLDivElement
let root: Root
let answer: unknown
let urls: string[]

beforeEach(() => {
  urls = []
  answer = { fields: [], definitions: [], editable: true }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
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

async function render(node: React.ReactNode) {
  await act(async () => root.render(node))
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

const taskFields = {
  fields: [
    { key: 'customer', label: 'Customer', field_type: 'text', value: 'Fernhill Studio' },
    { key: 'tier', label: 'Tier', field_type: 'select', value: null },
  ],
  definitions: [
    { key: 'customer', options: [] },
    { key: 'tier', options: ['Gold', 'Silver'] },
  ],
}

describe('CustomFieldsGroup on a task', () => {
  it('asks for the task’s fields, and renders nothing while tasks have none', async () => {
    await render(<CustomFieldsGroup entityType="action" recordId={TASK} />)
    expect(urls).toEqual([`/api/account/custom-fields/values?entity_type=action&id=${TASK}`])
    expect(container.innerHTML).toBe('')
  })

  it('shows each field, editable, with a way to add one', async () => {
    answer = { ...taskFields, editable: true }
    await render(<CustomFieldsGroup entityType="action" recordId={TASK} />)
    const rows = [...container.querySelectorAll('[data-custom-field]')]
    expect(rows.map((r) => r.getAttribute('data-custom-field'))).toEqual(['customer', 'tier'])
    expect((rows[0].querySelector('input') as HTMLInputElement).value).toBe('Fernhill Studio')
    expect([...rows[1].querySelectorAll('option')].map((o) => o.textContent)).toEqual(['—', 'Gold', 'Silver'])
    expect(container.textContent).toContain('Add a field')
  })

  it('shows values as text, with no inputs and no form, when the record is view-only', async () => {
    answer = { ...taskFields, editable: false }
    await render(<CustomFieldsGroup entityType="document" recordId={TASK} />)
    expect(container.querySelectorAll('input, select')).toHaveLength(0)
    expect(container.textContent).toContain('Fernhill Studio')
    expect(container.textContent).toContain('Empty')
    expect(container.textContent).not.toContain('Add a field')
  })

  it('tells open lists and boards the values the server stored after a save', async () => {
    answer = { ...taskFields, editable: true }
    await render(<CustomFieldsGroup entityType="action" recordId={TASK} />)
    const updates: unknown[] = []
    const listen = (e: Event) => updates.push((e as CustomEvent).detail)
    window.addEventListener('ni:entity-updated', listen)
    try {
      answer = { custom_fields: { customer: 'Fernhill Studio', tier: 'Gold', estimate_hours: 4 } }
      const select = container.querySelector('[data-custom-field="tier"] select') as HTMLSelectElement
      await act(async () => {
        select.value = 'Gold'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
      expect(updates).toEqual([
        { entityType: 'action', id: TASK, fields: { custom_fields: { customer: 'Fernhill Studio', tier: 'Gold', estimate_hours: 4 } } },
      ])
    } finally {
      window.removeEventListener('ni:entity-updated', listen)
    }
  })

  it('a view-only deal with no fields offers no form either', async () => {
    answer = { fields: [], definitions: [], editable: false }
    await render(<CustomFieldsGroup entityType="deal" recordId={TASK} showAddWhenEmpty />)
    expect(container.innerHTML).toBe('')
  })
})

describe('the settings kind picker', () => {
  it('offers exactly the registry’s kinds, by the names people use', async () => {
    await render(<CustomFieldKindPicker value="action" onChange={() => {}} />)
    const pills = [...container.querySelectorAll('[data-kind]')]
    expect(pills.map((p) => p.getAttribute('data-kind'))).toEqual([...CUSTOM_FIELD_ENTITIES])
    expect(pills.map((p) => p.textContent)).toEqual(['Documents', 'Contacts', 'Projects', 'Tasks', 'Initiatives', 'Companies', 'Deals'])
    expect(pills.find((p) => p.getAttribute('aria-selected') === 'true')?.getAttribute('data-kind')).toBe('action')
  })

  it('lists the picked kind’s fields and switches kind', async () => {
    answer = { fields: [{ id: 'd1', key: 'customer', label: 'Customer', field_type: 'text', options: [], position: 0, workspace_id: 'w', entity_type: 'action' }] }
    await render(<CustomFieldsSettingsView />)
    expect(urls).toEqual(['/api/account/custom-fields?entity_type=action'])
    expect(container.querySelector('[data-custom-field="customer"]')?.textContent).toContain('Text')
    answer = { fields: [] }
    await act(async () => (container.querySelector('[data-kind="project"]') as HTMLButtonElement).click())
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(urls.at(-1)).toBe('/api/account/custom-fields?entity_type=project')
    expect(container.textContent).toContain('No fields on projects yet.')
  })
})
