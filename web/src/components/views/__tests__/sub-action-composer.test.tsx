// @vitest-environment jsdom
/**
 * The shared sub-action composer.
 *
 * This form was previously trapped inside create-dialog.tsx, so the action
 * detail panel offered a bare title input and a sub-action made there could
 * carry none of the properties the dialog collected. It's extracted so both
 * surfaces agree on what creating a sub-action means.
 *
 * The load-bearing decision is that the composer does NOT persist: its two
 * hosts need different things to happen — the dialog queues the draft because
 * its parent action doesn't exist yet, the panel POSTs against a real parent.
 * So what's pinned here is the CONTRACT: every field the user fills reaches
 * `onSubmit`, since a field that silently fails to reach the host is exactly
 * the bug that made this extraction worth doing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { SubActionComposer, type SubActionDraft } from '../sub-action-composer'

const STATES = [
  { id: 's1', name: 'Backlog', category: 'backlog', color: '#888', is_default: true },
  { id: 's2', name: 'In Progress', category: 'started', color: '#3b82f6' },
]
const MEMBERS = [{ id: 'm1', display_name: 'Alice', avatar_url: null }]
const PROJECTS = [{ id: 'p1', name: 'Kanban' }]
const LABELS = [{ id: 'l1', name: 'bug', color: '#ef4444' }]

let container: HTMLDivElement
let root: Root

function render(props: Partial<React.ComponentProps<typeof SubActionComposer>> = {}) {
  act(() => {
    root.render(
      <SubActionComposer
        workflowStates={STATES}
        members={MEMBERS}
        projects={PROJECTS}
        labels={LABELS}
        onSubmit={props.onSubmit ?? (() => {})}
        onCancel={props.onCancel ?? (() => {})}
        {...props}
      />,
    )
  })
}

const composer = () => {
  const el = container.querySelector('[data-sub-action-composer]')
  if (!el) throw new Error('composer not rendered')
  return el
}

const titleInput = () =>
  composer().querySelector<HTMLInputElement>('input[placeholder="Action title"]')!

const button = (label: string) =>
  [...composer().querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

/** Set a controlled input's value the way a real keystroke would. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

describe('SubActionComposer', () => {
  it('renders the title, description and every property pill', () => {
    render()

    expect(titleInput()).toBeTruthy()
    expect(
      composer().querySelector('textarea[placeholder="Add description..."]'),
    ).toBeTruthy()
    // The whole reason for reusing this form rather than a bare title input.
    for (const label of ['Backlog', 'Priority', 'Assignee', 'Project', 'Labels']) {
      expect(button(label), `missing ${label} pill`).toBeTruthy()
    }
  })

  it('will not submit an empty or whitespace-only title', () => {
    const onSubmit = vi.fn()
    render({ onSubmit })

    expect(button('Add sub-action')!.disabled).toBe(true)

    type(titleInput(), '   ')
    expect(button('Add sub-action')!.disabled).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('hands the trimmed title and the field defaults to onSubmit', async () => {
    const onSubmit = vi.fn()
    render({ onSubmit })

    type(titleInput(), '  Write the migration  ')
    await act(async () => {
      button('Add sub-action')!.click()
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const draft = onSubmit.mock.calls[0][0] as SubActionDraft
    expect(draft.title).toBe('Write the migration')
    // Untouched fields must still arrive in a shape the host can persist.
    expect(draft).toMatchObject({
      description: '',
      statusId: null,
      priority: 'none',
      assigneeIds: [],
      projectId: null,
      labelIds: [],
    })
  })

  it('submits on Enter, and treats Escape as cancel', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render({ onSubmit, onCancel })

    type(titleInput(), 'Quick one')
    await act(async () => {
      titleInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)

    act(() => {
      titleInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalled()
  })

  it('closes after a submit, and clears the title for the next one', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render({ onSubmit, onCancel })

    type(titleInput(), 'First')
    await act(async () => {
      button('Add sub-action')!.click()
    })

    // Without "Create more", adding one closes the form — that's the host's
    // cue to go back to the trigger button.
    expect(onCancel).toHaveBeenCalled()
    expect(titleInput().value).toBe('')
  })

  it('waits for a slow host before allowing a second submit', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const onSubmit = vi.fn(() => gate)
    render({ onSubmit })

    type(titleInput(), 'Slow save')
    act(() => {
      button('Add sub-action')!.click()
    })

    // Still in flight: a second click must not double-create.
    expect(button('Add sub-action')!.disabled).toBe(true)
    act(() => {
      button('Add sub-action')!.click()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
      await gate
    })
  })

  it('can hide the Create more switch for one-at-a-time hosts', () => {
    render({ showCreateMore: false })
    expect(composer().textContent).not.toContain('Create more')

    render({ showCreateMore: true })
    expect(composer().textContent).toContain('Create more')
  })

  it('lets the host relabel the confirm button', () => {
    render({ submitLabel: 'Create' })
    expect(button('Create')).toBeTruthy()
  })
})
