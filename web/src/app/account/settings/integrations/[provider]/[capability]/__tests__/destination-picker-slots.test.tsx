// @vitest-environment jsdom
/**
 * The three shared destination-picker slots.
 *
 * These render inside all three provider sections, so the three destination
 * suites already prove they LOOK right in situ. What those suites can't state
 * is the contract the slots owe their callers — in particular
 * SearchableOptionList's span adjacency, which jira-destination.test.tsx
 * depends on ONLY implicitly, by matching a project button's concatenated
 * textContent ("GROGrowth"). Put a space, a separator or a wrapper between the
 * key and the name spans and that suite fails with a message about a missing
 * button, pointing nowhere near the cause. This file says it out loud.
 *
 * Rendered standalone with createRoot/act (no @testing-library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import {
  PickerLoadError,
  ReconnectBanner,
  SearchableOptionList,
} from '../destination-picker-slots'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(node: Parameters<Root['render']>[0]) {
  act(() => root.render(node))
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')] as HTMLButtonElement[]
}

function button(label: string): HTMLButtonElement {
  const btn = buttons().find((b) => b.textContent?.trim() === label)
  expect(btn, `button "${label}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

function text(): string {
  return container.textContent ?? ''
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ---- ReconnectBanner --------------------------------------------------------

describe('ReconnectBanner', () => {
  it('names the provider in the heading, the body and the button', async () => {
    // All three suites assert on the heading string verbatim; the button label
    // is matched by exact textContent.
    render(
      h(ReconnectBanner, {
        provider: 'Asana',
        pickerList: 'the workspace, project and section pickers',
        onReconnect: () => {},
        connecting: false,
      }),
    )

    expect(text()).toContain('Reconnect Asana to manage the destination')
    // A STRAIGHT apostrophe: the JSX writes `can&apos;t`, and the three
    // provider suites match this copy as rendered.
    expect(text()).toContain(
      "Dial8 can no longer use your stored Asana authorization, so the workspace, project and section pickers can't load.",
    )
    expect(button('Reconnect Asana')).toBeTruthy()
  })

  it('takes the picker list from its caller — the cascades genuinely differ', async () => {
    render(
      h(ReconnectBanner, {
        provider: 'Linear',
        pickerList: 'the team and project pickers',
        onReconnect: () => {},
        connecting: false,
      }),
    )

    expect(text()).toContain("the team and project pickers can't load")
    expect(text()).not.toContain('section')
  })

  it('fires onReconnect when pressed', async () => {
    const onReconnect = vi.fn()
    render(
      h(ReconnectBanner, {
        provider: 'Jira',
        pickerList: 'the site and project pickers',
        onReconnect,
        connecting: false,
      }),
    )

    act(() => button('Reconnect Jira').click())
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('disables the button while a connect is already in flight', async () => {
    render(
      h(ReconnectBanner, {
        provider: 'Jira',
        pickerList: 'the site and project pickers',
        onReconnect: () => {},
        connecting: true,
      }),
    )

    expect(buttons()[0].disabled).toBe(true)
  })
})

// ---- PickerLoadError --------------------------------------------------------

describe('PickerLoadError', () => {
  it('shows the message beside a Retry', async () => {
    render(h(PickerLoadError, { message: 'Failed to list Asana projects', onRetry: () => {} }))

    expect(text()).toContain('Failed to list Asana projects')
    expect(button('Retry')).toBeTruthy()
  })

  it('fires onRetry when Retry is pressed', async () => {
    const onRetry = vi.fn()
    render(h(PickerLoadError, { message: 'Upstream is down', onRetry }))

    act(() => button('Retry').click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

// ---- SearchableOptionList ---------------------------------------------------

describe('SearchableOptionList', () => {
  const OPTIONS = [
    { id: 'p-1', name: 'Engineering' },
    { id: 'p-2', name: 'Growth' },
  ]

  it('renders one button per option and marks the selected one', async () => {
    render(
      h(SearchableOptionList, {
        query: '',
        onQueryChange: () => {},
        loading: false,
        options: OPTIONS,
        selectedId: 'p-2',
        onSelect: () => {},
        emptyMessage: 'No projects found.',
      }),
    )

    // `hover:bg-accent` is on every row, so the selected marker is the BARE
    // `bg-accent` class token rather than a substring of the class string.
    const classTokens = (b: HTMLButtonElement) => b.className.split(/\s+/)
    expect(classTokens(button('Growth'))).toContain('bg-accent')
    expect(classTokens(button('Engineering'))).not.toContain('bg-accent')
    // …and the selected row alone carries the check mark.
    expect(button('Growth').querySelector('svg')).toBeTruthy()
    expect(button('Engineering').querySelector('svg')).toBeNull()
  })

  it('reports the picked option’s id', async () => {
    const onSelect = vi.fn()
    render(
      h(SearchableOptionList, {
        query: '',
        onQueryChange: () => {},
        loading: false,
        options: OPTIONS,
        selectedId: null,
        onSelect,
        emptyMessage: 'No projects found.',
      }),
    )

    act(() => button('Growth').click())
    expect(onSelect).toHaveBeenCalledWith('p-2')
  })

  it('reports every keystroke — the caller re-queries the API, it does not filter here', async () => {
    // The list is the SERVER's answer for the current query (Asana's typeahead,
    // Jira's /project/search). Filtering client-side too would hide results the
    // server matched on a field the label doesn't show.
    const onQueryChange = vi.fn()
    render(
      h(SearchableOptionList, {
        query: 'Gro',
        onQueryChange,
        loading: false,
        options: OPTIONS,
        selectedId: null,
        onSelect: () => {},
        emptyMessage: 'No projects found.',
      }),
    )

    const input = container.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('Gro')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    act(() => {
      setter.call(input, 'Grow')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onQueryChange).toHaveBeenCalledWith('Grow')
    // Both options are still rendered: narrowing them is the next fetch's job.
    expect(buttons()).toHaveLength(2)
  })

  it('shows the empty message only once loading has finished', async () => {
    render(
      h(SearchableOptionList, {
        query: '',
        onQueryChange: () => {},
        loading: true,
        options: [],
        selectedId: null,
        onSelect: () => {},
        emptyMessage: 'No projects found.',
      }),
    )
    // Mid-fetch, "No projects found." would be a claim the component can't make.
    expect(text()).not.toContain('No projects found.')

    render(
      h(SearchableOptionList, {
        query: '',
        onQueryChange: () => {},
        loading: false,
        options: [],
        selectedId: null,
        onSelect: () => {},
        emptyMessage: 'No projects found.',
      }),
    )
    expect(text()).toContain('No projects found.')
  })

  /**
   * The load-bearing DOM contract. jira-destination.test.tsx finds a project
   * button by its CONCATENATED textContent ("GROGrowth"), so the key and name
   * must be adjacent spans with no separator and no whitespace between them.
   */
  it('renders key and name as ADJACENT spans with no separator', async () => {
    render(
      h(SearchableOptionList, {
        query: '',
        onQueryChange: () => {},
        loading: false,
        options: [{ id: '20000', key: 'GRO', name: 'Growth' }],
        selectedId: null,
        onSelect: () => {},
        emptyMessage: 'No projects found.',
      }),
    )

    const btn = buttons()[0]
    expect(btn.textContent).toBe('GROGrowth')
    const spans = [...btn.children] as HTMLElement[]
    expect(spans).toHaveLength(2)
    expect(spans[0].textContent).toBe('GRO')
    expect(spans[0].className).toContain('font-mono')
    expect(spans[1].textContent).toBe('Growth')
  })

  it('omits the key span entirely when an option has none', async () => {
    // Asana projects carry no key; an empty leading span would still change the
    // button's child count and could pick up a separator later.
    render(
      h(SearchableOptionList, {
        query: '',
        onQueryChange: () => {},
        loading: false,
        options: [{ id: 'p-1', name: 'Engineering' }],
        selectedId: null,
        onSelect: () => {},
        emptyMessage: 'No projects found.',
      }),
    )

    const btn = buttons()[0]
    expect(btn.textContent).toBe('Engineering')
    expect([...btn.children]).toHaveLength(1)
  })
})
