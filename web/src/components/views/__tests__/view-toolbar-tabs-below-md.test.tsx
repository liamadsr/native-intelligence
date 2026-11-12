// @vitest-environment jsdom
/**
 * A page's card whose sub-nav beside the rail holds its views (My Actions'
 * full-screen card; Liam, 11-11: "did you actually clean up the old one and
 * remove it from the panel complely or did you do something the lazy way?"):
 * its view tabs exist only below `md` (the phone's layout, no rail, no
 * sub-nav), in CSS from the first render, so nothing shows then goes. The
 * filter and settings buttons and the unsaved-filters ribbon (Save as new
 * view) stay at every width. Elsewhere the tabs are as they were.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'

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

async function renderToolbar(tabsBelowMdOnly?: boolean) {
  await act(async () => {
    root.render(
      h(ViewToolbar, {
        entityType: 'action',
        views: [],
        activeViewId: null,
        onViewChange: vi.fn(),
        onCreateView: vi.fn(),
        onUpdateView: vi.fn(),
        onDuplicateView: vi.fn(),
        onDeleteView: vi.fn(),
        config,
        onConfigChange: vi.fn(),
        onScopeReset: vi.fn(),
        isDirty: true,
        overrides: {},
        onSaveDraft: vi.fn(),
        onDiscardDraft: vi.fn(),
        tabsBelowMdOnly,
      }),
    )
  })
}

const tabs = () => container.querySelector<HTMLElement>('[data-view-tabs]')!

describe('the view tabs, beside a page’s sub-nav', () => {
  it('only below `md`, in CSS from the first render; the ribbon’s Save as new view stays', async () => {
    await renderToolbar(true)
    expect(tabs().className.split(' ')).toEqual(['contents', 'md:hidden'])
    expect(tabs().textContent).toContain('Assigned to me')
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Save as new view'))!
    expect(save).toBeDefined()
    expect(save.closest('[data-view-tabs]')).toBeNull()
  })

  it('elsewhere: the tabs at every width', async () => {
    await renderToolbar()
    expect(tabs().className).toBe('contents')
    expect(tabs().textContent).toContain('Assigned to me')
  })
})
