// @vitest-environment jsdom
/**
 * A page's card whose sub-nav beside the rail holds its scope tabs (My
 * Actions' full-screen card; Liam, 11-11: "did you actually clean up the old
 * one and remove it from the panel complely or did you do something the lazy
 * way?"): those scope tabs exist only below `md` (the phone's layout, no
 * rail, no sub-nav), in CSS from the first render, so nothing shows then
 * goes. Its saved views and the create button stay in the toolbar at every
 * width (Liam, 11-20: "saved views used to show up over here on the left
 * side"), as do the filter and settings buttons and the unsaved-filters
 * ribbon (Save as new view). Elsewhere the tabs are as they were. Fixtures
 * are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'
import type { View } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ViewToolbar } from '../view-toolbar'

const config = {
  filters: [{ field: 'priority', operator: 'is', value: 1 }],
  grouping: null,
  sub_grouping: null,
  ordering: [],
  display_properties: [],
  layout: 'list',
  board_group_by: null,
  show_completed: true,
  completed_filter: 'all',
  show_sub_items: true,
  nested_sub_items: false,
  show_empty_groups: false,
  action_scope: 'assigned',
  workspace_scope: 'workspace',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as ViewConfig

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ members: [] }) })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const savedView = { id: 'v-1', name: 'Fernhill launch', filters: [] } as unknown as View

const otherView = { id: 'v-2', name: 'Bugs this week', filters: [] } as unknown as View
const handlers = { onSaveDraft: vi.fn(), onEditView: vi.fn(), onDeleteView: vi.fn() }

async function renderToolbar(scopeTabsBelowMdOnly?: boolean, over: { activeViewId?: string | null; isDirty?: boolean; alignToContent?: boolean } = {}) {
  await act(async () => {
    root.render(
      h(ViewToolbar, {
        entityType: 'action',
        views: [savedView, otherView],
        activeViewId: over.activeViewId ?? null,
        onViewChange: vi.fn(),
        onCreateView: vi.fn(),
        onUpdateView: vi.fn(),
        onDuplicateView: vi.fn(),
        onDeleteView: handlers.onDeleteView,
        config,
        onConfigChange: vi.fn(),
        onScopeReset: vi.fn(),
        isDirty: over.isDirty ?? true,
        overrides: {},
        onSaveDraft: handlers.onSaveDraft,
        onDiscardDraft: vi.fn(),
        scopeTabsBelowMdOnly,
        alignToContent: over.alignToContent,
      }),
    )
  })
}

const tabs = () => container.querySelector<HTMLElement>('[data-view-tabs]')!
const scopeTabs = () => container.querySelector<HTMLElement>('[data-view-scope-tabs]')!
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

describe('the view tabs, beside a page’s sub-nav', () => {
  it('its scope tabs only below `md`, in CSS from the first render; the saved views, the create button and the ribbon’s Save as new view stay', async () => {
    await renderToolbar(true)
    expect(scopeTabs().className.split(' ')).toEqual(['contents', 'md:hidden'])
    expect(scopeTabs().textContent).toContain('Assigned to me')
    // The strip itself shows at every width; only the scope tabs are hidden from `md` up.
    expect(tabs().className).toBe('contents')
    const saved = button('Fernhill launch')
    expect(saved.closest('[data-view-tabs]')).not.toBeNull()
    expect(saved.closest('[data-view-scope-tabs]')).toBeNull()
    const create = container.querySelector<HTMLButtonElement>('button[aria-label="Create view"]')!
    expect(create.closest('[data-view-tabs]')).not.toBeNull()
    expect(create.closest('[data-view-scope-tabs]')).toBeNull()
    const save = button('Save as new view')
    expect(save).toBeDefined()
    expect(save.closest('[data-view-tabs]')).toBeNull()
  })

  it('elsewhere: every tab at every width', async () => {
    await renderToolbar()
    expect(tabs().className).toBe('contents')
    expect(scopeTabs().className).toBe('contents')
    expect(scopeTabs().textContent).toContain('Assigned to me')
    expect(button('Fernhill launch')).toBeDefined()
  })
})

/** Right-click a tab, as the browser does; the menu it opens (a portal on <body>). */
async function rightClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  })
  for (let i = 0; i < 3; i++) await act(async () => {})
}
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((m) => m.textContent?.trim())

describe('a saved view’s right-click menu (Liam, 11-20: "right click the views name and see avaiable option like delete or update")', () => {
  it('the open view with unsaved changes: Update view first, which saves them into it; then Edit view, Duplicate, Delete', async () => {
    handlers.onSaveDraft.mockClear()
    await renderToolbar(true, { activeViewId: 'v-1', isDirty: true })
    await rightClick(button('Fernhill launch'))
    expect(menuItems()).toEqual(['Update view', 'Edit view', 'Duplicate', 'Delete'])
    const update = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === 'Update view')!
    await act(async () => update.click())
    expect(handlers.onSaveDraft).toHaveBeenCalledTimes(1)
  })

  it('no Update view on another view’s tab, nor on the open one with nothing unsaved', async () => {
    await renderToolbar(true, { activeViewId: 'v-1', isDirty: true })
    await rightClick(button('Bugs this week'))
    expect(menuItems()).toEqual(['Edit view', 'Duplicate', 'Delete'])
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await renderToolbar(true, { activeViewId: 'v-1', isDirty: false })
    await rightClick(button('Fernhill launch'))
    expect(menuItems()).not.toContain('Update view')
  })
})

describe('the toolbar over a views layout (alignToContent)', () => {
  it('its view tabs on the content line whatever the layout: one padding, never the layout’s', async () => {
    await renderToolbar(true, { alignToContent: true })
    const row = container.querySelector<HTMLElement>('[data-view-toolbar-row]')!
    expect(row.className).toContain('pl-10')
    expect(row.className).not.toMatch(/\bpx-/)
  })
})
