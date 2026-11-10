// @vitest-environment jsdom
/**
 * Views by custom field, in the chrome: the workspace's own fields join the
 * filter picker (under "Custom fields"), the chips, the settings popover's
 * sort / group / column lists and the row cells, all from ONE read of the
 * definitions per kind, made only when a surface needs it, and nothing at
 * all when the kind has no fields (hide empty widgets).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// cmdk (the field picker's Command list) needs both; jsdom has neither.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
}

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-fernhill' }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { FilterFieldPicker } from '../filters/filter-field-picker'
import { FilterChip } from '../filters/filter-chip'
import { ViewSettingsPopover } from '../view-settings-popover'
import { CustomFieldCell } from '../list/custom-field-cell'
import { __resetCustomFieldDefinitionsCache } from '../hooks/use-custom-field-definitions'
import { announceCustomFieldsChanged } from '@/lib/views/custom-field-columns'
import type { ViewConfig } from '../hooks/use-view'

const DEFS = [
  { id: 'f1', workspace_id: 'ws-fernhill', entity_type: 'deal', key: 'project_type', label: 'Project type', field_type: 'select', options: ['Brand', 'Website', 'Packaging'], position: 0 },
  { id: 'f2', workspace_id: 'ws-fernhill', entity_type: 'deal', key: 'retainer_months', label: 'Retainer (months)', field_type: 'number', options: [], position: 1 },
]

let fields: unknown[] = DEFS
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/account/custom-fields?')) {
    return { ok: true, json: async () => ({ fields }) } as Response
  }
  return { ok: false, json: async () => ({}) } as Response
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  __resetCustomFieldDefinitionsCache()
  fields = DEFS
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const customFieldReads = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/account/custom-fields?'))

describe('the filter picker', () => {
  it('lists the kind’s custom fields under their own heading', async () => {
    await act(async () => {
      root.render(h(FilterFieldPicker, { entityType: 'deal', onSelect: vi.fn() }))
    })
    await flush()
    expect(customFieldReads().map(([u]) => u)).toEqual(['/api/account/custom-fields?entity_type=deal'])
    expect(container.textContent).toContain('Custom fields')
    expect(container.textContent).toContain('Project type')
    expect(container.textContent).toContain('Retainer (months)')
  })

  it('shows no custom heading when the workspace has none', async () => {
    fields = []
    await act(async () => {
      root.render(h(FilterFieldPicker, { entityType: 'action', onSelect: vi.fn() }))
    })
    await flush()
    expect(container.textContent).not.toContain('Custom fields')
  })

  it('never asks for a kind that takes no fields', async () => {
    await act(async () => {
      root.render(h(FilterFieldPicker, { entityType: 'capture', onSelect: vi.fn() }))
    })
    await flush()
    expect(customFieldReads()).toEqual([])
    expect(container.textContent).not.toContain('Custom fields')
  })

  it('reads again when a field is added somewhere', async () => {
    fields = []
    await act(async () => {
      root.render(h(FilterFieldPicker, { entityType: 'deal', onSelect: vi.fn() }))
    })
    await flush()
    expect(container.textContent).not.toContain('Custom fields')
    fields = DEFS
    act(() => announceCustomFieldsChanged())
    await flush()
    expect(customFieldReads()).toHaveLength(2)
    expect(container.textContent).toContain('Project type')
  })

  it('shares one read between surfaces', async () => {
    await act(async () => {
      root.render(
        h('div', null,
          h(FilterFieldPicker, { entityType: 'deal', onSelect: vi.fn() }),
          h(FilterFieldPicker, { entityType: 'deal', onSelect: vi.fn() }),
        ),
      )
    })
    await flush()
    expect(customFieldReads()).toHaveLength(1)
  })
})

describe('a custom filter chip', () => {
  it('draws with the field’s name; a built-in chip never reads the definitions', async () => {
    await act(async () => {
      root.render(
        h('div', null,
          h(FilterChip, {
            entityType: 'deal',
            filter: { id: 'a', field: 'custom_fields.project_type', operator: 'is', value: 'Website' },
            onUpdate: vi.fn(),
            onRemove: vi.fn(),
          }),
        ),
      )
    })
    await flush()
    expect(container.textContent).toContain('Project type')
    expect(container.textContent).toContain('is')
    expect(container.textContent?.toLowerCase()).toContain('website')

    act(() => root.unmount())
    __resetCustomFieldDefinitionsCache()
    fetchMock.mockClear()
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(FilterChip, {
          entityType: 'deal',
          filter: { id: 'b', field: 'name', operator: 'contains', value: 'Kiln' },
          onUpdate: vi.fn(),
          onRemove: vi.fn(),
        }),
      )
    })
    await flush()
    expect(customFieldReads()).toEqual([])
    expect(container.textContent).toContain('Name')
  })
})

describe('view settings', () => {
  const CONFIG = {
    filters: [],
    grouping: null,
    sub_grouping: null,
    ordering: [{ field: 'created_at', direction: 'desc' }],
    display_properties: ['stage', 'value'],
    layout: 'list',
  } as unknown as ViewConfig

  it('reads nothing until opened, then offers each field as a column', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(h(TooltipProvider, null, h(ViewSettingsPopover, { config: CONFIG, entityType: 'deal', onChange })))
    })
    await flush()
    expect(customFieldReads()).toEqual([])

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(customFieldReads()).toHaveLength(1)
    const chip = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retainer (months)')
    expect(chip).toBeTruthy()
    act(() => chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onChange).toHaveBeenCalledWith({ display_properties: ['stage', 'value', 'custom_fields.retainer_months'] })
  })
})

describe('a custom column cell', () => {
  it('formats the value for its type, with the field’s name on hover', async () => {
    await act(async () => {
      root.render(
        h(CustomFieldCell, {
          item: { id: 'd1', custom_fields: { retainer_months: 12, project_type: 'Website' } },
          property: 'custom_fields.retainer_months',
          entityType: 'deal',
        }),
      )
    })
    await flush()
    const cell = container.querySelector('[data-custom-field-cell="retainer_months"]') as HTMLElement
    expect(cell.textContent).toBe('12')
    expect(cell.title).toBe('Retainer (months): 12')
  })

  it('renders nothing for a record without the value', async () => {
    await act(async () => {
      root.render(
        h(CustomFieldCell, {
          item: { id: 'd2', custom_fields: {} },
          property: 'custom_fields.retainer_months',
          entityType: 'deal',
        }),
      )
    })
    await flush()
    expect(container.innerHTML).toBe('')
  })
})
