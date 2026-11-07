// @vitest-environment jsdom
/**
 * The trailing "open" button on the project and initiative panel rows.
 *
 * These rows follow the Participants/Attachments shape: the row body edits the
 * value (opens the picker), and a sibling button acts on it (jumps to the
 * linked entity). Two things make that worth pinning:
 *
 *  - the button is CONDITIONAL — it appears only when a value is set AND the
 *    host wired onOpen. A row with no project has nothing to open, and mount
 *    sites that never pass onOpen (row cells, embedded pickers) must keep
 *    rendering exactly one control;
 *  - the two buttons must stay distinct. If the open button were nested inside
 *    the popover trigger, clicking it would also open the picker — the row
 *    would both navigate away and pop a dropdown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ProjectPanelField } from '../project-picker'
import { InitiativePanelField } from '../initiative-picker'

const PROJECTS = [{ id: 'p1', name: 'Acme Redesign', icon: null }]
const INITIATIVES = [{ id: 'i1', name: 'Q3 Platform Goals', icon: null }]

let container: HTMLDivElement
let root: Root

async function mount(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui)
  })
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The open button is the one carrying an "Open …" aria-label. */
function openButton() {
  return container.querySelector('button[aria-label^="Open "]')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('ProjectPanelField — open button', () => {
  it('calls onOpen with the linked project', async () => {
    const onOpen = vi.fn()
    await mount(
      <ProjectPanelField value="p1" projects={PROJECTS} onChange={vi.fn()} onOpen={onOpen} />,
    )

    await click(openButton()!)

    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen.mock.calls[0][0]).toBe('p1')
    expect(onOpen.mock.calls[0][1]).toBe('Acme Redesign')
  })

  it('is absent when no project is set — there is nothing to open', async () => {
    await mount(
      <ProjectPanelField value={null} projects={PROJECTS} onChange={vi.fn()} onOpen={vi.fn()} />,
    )

    expect(openButton()).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })

  it('is absent when the host wired no onOpen', async () => {
    await mount(<ProjectPanelField value="p1" projects={PROJECTS} onChange={vi.fn()} />)

    expect(openButton()).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })

  it('does not fire onChange — opening is not editing', async () => {
    const onChange = vi.fn()
    await mount(
      <ProjectPanelField value="p1" projects={PROJECTS} onChange={onChange} onOpen={vi.fn()} />,
    )

    await click(openButton()!)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the picker trigger as a separate control', async () => {
    await mount(
      <ProjectPanelField value="p1" projects={PROJECTS} onChange={vi.fn()} onOpen={vi.fn()} />,
    )

    // Exactly two: the picker trigger and the open button — the latter is not
    // nested inside the former.
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(openButton()!.contains(container.querySelector('button')!)).toBe(false)
  })
})

/**
 * The panels use two row-padding conventions — px-3 (capture, document) and
 * px-2 (action, initiative, contact). These shared fields are mounted in both
 * families, so the padding has to come from the host; hardcoding either one
 * leaves the field visibly out of line with its neighbours in the other family.
 */
describe('panel fields — padding follows the host panel', () => {
  it('defaults to px-2, the PropertyGroup convention', async () => {
    await mount(<ProjectPanelField value="p1" projects={PROJECTS} onChange={vi.fn()} />)

    const trigger = container.querySelector('button')!
    expect(trigger.className).toContain('px-2')
    expect(trigger.className).not.toContain('px-3')
  })

  it('takes px-3 for the capture/document panels', async () => {
    await mount(
      <ProjectPanelField value="p1" projects={PROJECTS} onChange={vi.fn()} padding="px-3" />,
    )

    const trigger = container.querySelector('button')!
    expect(trigger.className).toContain('px-3')
    expect(trigger.className).not.toContain('px-2')
  })

  it('applies to the initiative field too', async () => {
    await mount(
      <InitiativePanelField
        value="i1"
        initiatives={INITIATIVES}
        onChange={vi.fn()}
        padding="px-3"
      />,
    )

    const trigger = container.querySelector('button')!
    expect(trigger.className).toContain('px-3')
    expect(trigger.className).not.toContain('px-2')
  })

  it('keeps the padding when the open button is present', async () => {
    await mount(
      <ProjectPanelField
        value="p1"
        projects={PROJECTS}
        onChange={vi.fn()}
        padding="px-3"
        onOpen={vi.fn()}
      />,
    )

    // The trigger is the first button; the open button is the second.
    expect(container.querySelector('button')!.className).toContain('px-3')
  })
})

describe('InitiativePanelField — open button', () => {
  it('calls onOpen with the linked initiative', async () => {
    const onOpen = vi.fn()
    await mount(
      <InitiativePanelField
        value="i1"
        initiatives={INITIATIVES}
        onChange={vi.fn()}
        onOpen={onOpen}
      />,
    )

    await click(openButton()!)

    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen.mock.calls[0][0]).toBe('i1')
    expect(onOpen.mock.calls[0][1]).toBe('Q3 Platform Goals')
  })

  it('is absent when no initiative is set', async () => {
    await mount(
      <InitiativePanelField
        value={null}
        initiatives={INITIATIVES}
        onChange={vi.fn()}
        onOpen={vi.fn()}
      />,
    )

    expect(openButton()).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })

  it('is absent when the host wired no onOpen', async () => {
    await mount(
      <InitiativePanelField value="i1" initiatives={INITIATIVES} onChange={vi.fn()} />,
    )

    expect(openButton()).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
})
