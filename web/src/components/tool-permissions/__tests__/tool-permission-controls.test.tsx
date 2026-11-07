// @vitest-environment jsdom
/**
 * The shared Tool permissions group (the connector page's and the People
 * tab's): a count, collapsible, a row per tool with ✓ / ✋ / ⊘, the chosen one
 * checked, a click sets that tool, and Always allow can be held back for one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToolPermissionGroup, rowsPermission, type ToolPermissionRow } from '../tool-permission-controls'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const rows: ToolPermissionRow[] = [
  { name: 'get_calendar_events', label: 'Calendar events', value: 'allow' },
  { name: 'create_calendar_event', label: 'Create event', value: 'ask', allowDisabled: true, allowDisabledReason: 'Always asks' },
]

describe('ToolPermissionGroup', () => {
  it('reads a group as one permission, or mixed', () => {
    expect(rowsPermission(rows)).toBe('mixed')
    expect(rowsPermission([rows[0]])).toBe('allow')
    expect(rowsPermission([])).toBeNull()
  })

  it('shows each tool with its permission, and a click sets that tool', async () => {
    const onSetTool = vi.fn()
    await act(async () => root.render(<ToolPermissionGroup title="Calendar" rows={rows} value="mixed" onSetGroup={() => {}} onSetTool={onSetTool} />))
    expect(host.textContent).toContain('Calendar')
    expect(host.textContent).toContain('2')
    const first = host.querySelector('[data-tool-row="get_calendar_events"]')!
    expect(first.querySelector('[aria-checked="true"]')!.getAttribute('aria-label')).toBe('Always allow')
    await act(async () => (first.querySelector('[aria-label="Blocked"]') as HTMLButtonElement).click())
    expect(onSetTool).toHaveBeenCalledWith('get_calendar_events', 'blocked')
    const second = host.querySelector('[data-tool-row="create_calendar_event"]')!
    const allow = second.querySelector('[aria-label="Always allow"]') as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    expect(allow.title).toBe('Always asks')
  })

  it('starts closed when asked, and opens on its heading', async () => {
    await act(async () => root.render(<ToolPermissionGroup title="Calendar" rows={rows} value="mixed" defaultOpen={false} onSetGroup={() => {}} onSetTool={() => {}} />))
    const list = host.querySelector('ul')!
    expect(list.hidden).toBe(true)
    await act(async () => (host.querySelector('[aria-expanded]') as HTMLButtonElement).click())
    expect(list.hidden).toBe(false)
  })
})
