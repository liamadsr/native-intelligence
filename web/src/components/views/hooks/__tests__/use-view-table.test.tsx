// @vitest-environment jsdom
/**
 * A table's saved view round trip (Tables, phase 4): its widths, hidden
 * columns and layout picks come out of the view's `metadata.table` into the
 * config, a change to them is a draft like a filter, Update saves them back
 * into the metadata beside whatever else it holds, and with `drafts:
 * 'memory'` nothing of the draft reaches localStorage (a detour through
 * another view keeps it for the visit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'member-1',
}))

import { useViewConfig, type ViewConfig } from '../use-view'
import type { View } from '@/lib/views/types'

let container: HTMLDivElement
let root: Root

const view = (id: string, metadata: Record<string, unknown>): View => ({
  id,
  workspace_id: 'ws-1',
  team_id: null,
  created_by: 'user-1',
  name: 'Pipeline',
  description: null,
  icon: null,
  color: null,
  slug: null,
  entity_type: 'data_row',
  visibility: 'workspace',
  layout: 'board',
  filters: [],
  grouping: { field: 'custom_fields.stage', direction: 'asc' },
  sub_grouping: null,
  ordering: [{ field: 'custom_fields.price', direction: 'desc' }],
  display_properties: ['price', 'stage'],
  board_group_by: null,
  show_completed: true,
  completed_filter: 'all',
  show_sub_items: true,
  nested_sub_items: false,
  show_empty_groups: false,
  is_pinned: false,
  pin_order: 0,
  scope_type: 'data_table',
  scope_id: 't-1',
  metadata,
  created_at: '',
  updated_at: '',
})

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('a table’s view in useViewConfig', () => {
  it('reads its settings, drafts a change in memory, and saves it into the metadata', async () => {
    const saved: Array<{ id: string; updates: Partial<View> }> = []
    const api: { config?: ViewConfig; dirty?: boolean; update?: (u: Partial<ViewConfig>) => void; save?: () => Promise<void> } = {}
    const PIPELINE = view('v-1', { note: 'kept', table: { widths: { title: 300 }, total_key: 'price' } })
    const OTHER = view('v-2', {})
    let active: View = PIPELINE
    function Harness() {
      const v = useViewConfig(active, 'data_row', (id, updates) => void saved.push({ id, updates }), true, undefined, 'workspace', undefined, 'memory')
      api.config = v.config
      api.dirty = v.isDirty
      api.update = v.updateConfig
      api.save = v.saveOverrides
      return null
    }
    act(() => root.render(h(Harness)))
    expect(api.config).toMatchObject({ layout: 'board', display_properties: ['price', 'stage'], table: { widths: { title: 300 }, total_key: 'price' } })
    expect(api.dirty).toBe(false)

    act(() => api.update!({ table: { ...api.config!.table, widths: { title: 300, price: 140 }, hidden: ['notes'] } }))
    expect(api.dirty).toBe(true)
    expect(api.config!.table).toEqual({ widths: { title: 300, price: 140 }, hidden: ['notes'], total_key: 'price' })
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('ni:view-draft'))).toEqual([])

    // A detour through another view and back keeps the draft for the visit.
    active = OTHER
    act(() => root.render(h(Harness)))
    expect(api.dirty).toBe(false)
    active = PIPELINE
    act(() => root.render(h(Harness)))
    expect(api.dirty).toBe(true)

    await act(async () => api.save!())
    expect(saved).toEqual([
      { id: 'v-1', updates: { metadata: { note: 'kept', table: { widths: { title: 300, price: 140 }, hidden: ['notes'], total_key: 'price' } } } },
    ])
    expect(api.dirty).toBe(false)
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('ni:view-draft'))).toEqual([])
  })

  it('a column order and a sort save as the view’s own columns', async () => {
    const saved: Array<Partial<View>> = []
    const api: { update?: (u: Partial<ViewConfig>) => void; save?: () => Promise<void> } = {}
    const V = view('v-1', {})
    function Harness() {
      const v = useViewConfig(V, 'data_row', (_id, updates) => void saved.push(updates), true, undefined, 'workspace', undefined, 'memory')
      api.update = v.updateConfig
      api.save = v.saveOverrides
      return null
    }
    act(() => root.render(h(Harness)))
    act(() => api.update!({ display_properties: ['stage', 'price'], ordering: [{ field: 'title', direction: 'asc' }] }))
    await act(async () => api.save!())
    expect(saved).toEqual([{ display_properties: ['stage', 'price'], ordering: [{ field: 'title', direction: 'asc' }] }])
  })
})
