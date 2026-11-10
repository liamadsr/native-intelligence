// @vitest-environment jsdom
/**
 * The unsaved-filters ribbon on a narrow card (a phone, an inline card): the
 * chips take the row and wrap, and Cancel / Save as new view sit in a group of
 * their own that drops under them, never over them (the live check at 375px
 * found the buttons drawn over three chips).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'
import type { ViewEntityType } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ViewToolbar } from '../view-toolbar'

function makeConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return {
    filters: [],
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
    ...over,
  } as ViewConfig
}

let container: HTMLDivElement
let root: Root
let onScopeReset: ReturnType<typeof vi.fn>
let onConfigChange: ReturnType<typeof vi.fn>
let onViewChange: ReturnType<typeof vi.fn>

beforeEach(() => {
  onScopeReset = vi.fn()
  onConfigChange = vi.fn()
  onViewChange = vi.fn()
  // The Assignee chip's picker loads the workspace's members on mount. Left to
  // the real fetch, that request goes through the app's /api/ interceptor
  // (src/lib/workspace-fetch.ts), which first imports the Supabase client for
  // a token; on a slow machine it settled after the file's jsdom was torn
  // down, and the picker's state update threw "window is not defined" as an
  // unhandled rejection that failed the run. Answered here at once, nothing
  // outlives the test.
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

async function renderToolbar(props: {
  entityType?: ViewEntityType
  teamId?: string
  config?: ViewConfig
}) {
  await act(async () => {
    root.render(
      h(ViewToolbar, {
        entityType: props.entityType ?? 'action',
        teamId: props.teamId,
        views: [],
        activeViewId: null,
        onViewChange,
        onCreateView: vi.fn(),
        onUpdateView: vi.fn(),
        onDuplicateView: vi.fn(),
        onDeleteView: vi.fn(),
        config: props.config ?? makeConfig(),
        onConfigChange,
        onScopeReset,
        isDirty: true,
        overrides: {},
        onSaveDraft: vi.fn(),
        onDiscardDraft: vi.fn(),
      }),
    )
  })
}

describe('the unsaved-filters ribbon', () => {
  it('wraps, with the chips and the buttons in groups of their own', async () => {
    await renderToolbar({ config: makeConfig({ filters: [{ field: 'priority', operator: 'is', value: 1 }, { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] }, { field: 'assignee_id', operator: 'is', value: '@me' }] as never }) })
    const ribbon = container.querySelector<HTMLElement>('[data-filter-ribbon]')
    expect(ribbon).not.toBeNull()
    expect(ribbon!.className).toContain('flex-wrap')
    const save = [...ribbon!.querySelectorAll('button')].find((b) => b.textContent?.includes('Save as new view'))!
    const cancel = [...ribbon!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    // Both buttons share one group, which is not the chips' group, and may wrap below it.
    expect(save.parentElement).toBe(cancel.parentElement)
    expect(save.parentElement).not.toBe(ribbon)
    expect(save.parentElement!.className).toContain('ml-auto')
    expect(ribbon!.firstElementChild!.className).toMatch(/min-w-0/)
  })
})
