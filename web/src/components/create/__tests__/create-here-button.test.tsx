// @vitest-environment jsdom
/**
 * "New …" on a record's header opens the Create composer preset to a type
 * and to that place ("Create in <name>"). Made-up records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { CreateHereButton } from '../create-here-button'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let asked: unknown[]
const onAsk = (e: Event) => asked.push((e as CustomEvent).detail)
beforeEach(() => {
  asked = []
  document.addEventListener('open-create', onAsk)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  document.removeEventListener('open-create', onAsk)
  act(() => root.unmount())
  container.remove()
})

const project = { kind: 'project' as const, id: 'p-1', name: 'Website relaunch' }

describe('CreateHereButton', () => {
  it('one type: a + that opens its composer in this place', async () => {
    await act(async () => root.render(h(CreateHereButton, { container: { kind: 'row', id: 'r-1', name: 'Acme renewal' }, types: ['action'] })))
    const button = container.querySelector<HTMLButtonElement>('[data-create-here]')!
    expect(button.getAttribute('aria-label')).toBe('New action in Acme renewal')
    await act(async () => button.click())
    expect(asked).toEqual([{ type: 'action', context: { container: { kind: 'row', id: 'r-1', name: 'Acme renewal' } } }])
  })

  it('several: a menu naming the place and each type', async () => {
    await act(async () => root.render(h(CreateHereButton, { container: project, types: ['action', 'document'] })))
    const trigger = container.querySelector<HTMLButtonElement>('[data-create-here]')!
    expect(trigger.getAttribute('aria-label')).toBe('Create in Website relaunch')
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
    })
    const item = document.body.querySelector<HTMLElement>('[data-create-here-type="document"]')
    expect(item).not.toBeNull()
    await act(async () => item!.click())
    expect(asked).toEqual([{ type: 'document', context: { container: project } }])
  })

  it('no types: nothing', async () => {
    await act(async () => root.render(h(CreateHereButton, { container: project, types: [] })))
    expect(container.innerHTML).toBe('')
  })
})
