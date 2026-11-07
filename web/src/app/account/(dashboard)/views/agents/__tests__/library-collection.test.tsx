// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { View, ViewFilter } from '@/lib/views/types'
import type { LibraryCategory, LibraryRow } from '../library-types'
import { LibraryCollection } from '../library-collection'

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'workspace' }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const own = { id: 'own', name: 'My agent', category: 'agent', visibility: 'personal', description: null } as LibraryRow
const shared = { id: 'shared', name: 'Workspace agent', category: 'agent', visibility: 'workspace', description: null } as LibraryRow
const publicAgent = { id: 'public', name: 'Public agent', category: 'agent', visibility: 'public', description: null } as LibraryRow
const skill = { id: 'skill', name: 'My skill', category: 'skill', visibility: 'workspace', description: null } as LibraryRow
const sources = { mine: [own, skill], workspace: [shared, skill], discover: [publicAgent] }
function savedView(overrides: Partial<View>): View {
  return {
    id: 'saved', workspace_id: 'workspace', team_id: null, created_by: 'user',
    name: 'View', description: null, icon: null, color: null, slug: null,
    entity_type: 'agent', visibility: 'personal', layout: 'list',
    filters: [], grouping: null, sub_grouping: null, ordering: [], display_properties: [],
    board_group_by: null, show_completed: true, completed_filter: 'all',
    show_sub_items: true, nested_sub_items: false, show_empty_groups: false,
    is_pinned: false, pin_order: 0, scope_type: null, scope_id: null,
    metadata: {}, created_at: '2026-10-01', updated_at: '2026-10-01',
    ...overrides,
  }
}
let container: HTMLDivElement
let root: Root
let savedViews: View[]
let writes: Record<string, unknown>[]
const noop = () => {}

beforeEach(() => {
  localStorage.clear()
  savedViews = []
  writes = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      writes.push(body)
      const view = savedView({ ...body, id: `view-${savedViews.length}` })
      savedViews.push(view)
      return { ok: true, json: async () => ({ view }) }
    }
    const category = new URL(url, 'http://localhost').searchParams.get('entity_type')
    return { ok: true, json: async () => ({ views: savedViews.filter(v => v.entity_type === category) }) }
  }))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(category: LibraryCategory = 'agent') {
  await act(async () => root.render(
    <LibraryCollection key={category} category={category} sources={sources} search="" onScopeChange={noop}>
      {({ displayedItems, scopeForItem }) => (
        <div data-items>{displayedItems.map(item => <span key={item.id} data-scope={scopeForItem(item)}>{item.name}</span>)}</div>
      )}
    </LibraryCollection>,
  ))
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  expect(found, `Missing button ${label}`).toBeDefined()
  return found!
}
async function click(label: string) { await act(async () => button(label).click()) }
function items() { return container.querySelector('[data-items]')?.textContent }

it('uses the four shared default views while preserving the existing collections', async () => {
  await render()
  expect(items()).toBe('Workspace agentMy agent')
  await click('My agents')
  expect(items()).toBe('My agent')
  expect(container.textContent).not.toContain('Save as new view')
  await click('Workspace agents')
  expect(items()).toBe('Workspace agent')
  await click('Discover agents')
  expect(items()).toBe('Public agent')
  expect(container.querySelector('[data-items] span')?.getAttribute('data-scope')).toBe('discover')
})

it('creates and restores a Discover view through the real shared hooks and toolbar', async () => {
  await render()
  await click('Discover agents')
  await click('Create view')
  expect(container.textContent).toContain('Collection')
  expect(container.textContent).toContain('discover')
  const input = container.querySelector<HTMLInputElement>('input[placeholder="View name..."]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Public catalog')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Save')
  expect(writes).toHaveLength(1)
  expect(writes[0].entity_type).toBe('agent')
  expect(writes[0].filters).toEqual([{ id: '__library_scope', field: 'library_scope', operator: 'is', value: 'discover' }])
  expect(items()).toBe('Public agent')

  // A type switch remounts the collection. Skills have their own views, and
  // switching back restores the saved agent view, including its Add context.
  await render('skill')
  expect(items()).toBe('My skill')
  expect(container.textContent).not.toContain('Public catalog')
  await render('agent')
  expect(items()).toBe('Public agent')
  expect(button('Public catalog').className).toContain('bg-foreground')
  expect(container.querySelector('[data-items] span')?.getAttribute('data-scope')).toBe('discover')
  await click('All agents')
  expect(items()).toBe('Workspace agentMy agent')
  expect(container.textContent).not.toContain('Save as new view')
})

it('keeps the Add context for public items in a combined custom view', async () => {
  const filter: ViewFilter = { id: 'collections', field: 'library_scope', operator: 'is_any_of', value: ['mine', 'discover'] }
  savedViews.push(savedView({ id: 'combined', entity_type: 'agent', name: 'My and public', filters: [filter] }))
  await render()
  await click('My and public')
  expect(items()).toBe('My agentPublic agent')
  const scopes = Array.from(container.querySelectorAll('[data-items] span')).map(el => el.getAttribute('data-scope'))
  expect(scopes).toEqual(['all', 'discover'])
})
