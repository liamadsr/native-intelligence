// @vitest-environment jsdom
/**
 * The owner marks (work-owner-mark.tsx). No faces, no initials: every agent
 * wears the one agent mark (AgentIcon, lucide's Boxes) on a muted chip; a
 * lane keeps its own mark. Marks are decorative: hidden from assistive tech,
 * since the name stands beside them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LaneMark, OwnerMark, TeammateMark } from '../work-owner-mark'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(el: ReactElement) {
  act(() => root.render(el))
}

describe('TeammateMark', () => {
  it('draws the agent mark on a muted chip, decorative, in the 20px box, with no letters or pictures', () => {
    render(h(TeammateMark))
    const chip = container.querySelector('[data-teammate-mark]') as HTMLElement
    for (const cls of ['h-5', 'w-5', 'bg-muted']) expect(chip.classList).toContain(cls)
    expect(chip.getAttribute('aria-hidden')).toBe('true')
    expect(chip.querySelector('[data-agent-icon]')!.getAttribute('class')).toContain('text-muted-foreground')
    expect(container.textContent).toBe('')
    expect(container.querySelector('img, canvas')).toBeNull()
  })

  it('has a large size for a roster figure', () => {
    render(h(TeammateMark, { size: 'lg' }))
    expect((container.querySelector('[data-teammate-mark]') as HTMLElement).classList).toContain('h-10')
  })
})

describe('OwnerMark', () => {
  it('draws the agent mark for a teammate, and a lane’s own mark for a lane', () => {
    render(h(OwnerMark, { owner: { type: 'teammate', key: 'tm:t1', id: 't1', name: 'Quill' } }))
    expect(container.querySelector('[data-agent-icon]')).not.toBeNull()
    expect(container.textContent).toBe('')
    render(h(OwnerMark, { owner: { type: 'lane', key: 'lane:prospecting', kind: 'prospecting', label: 'Prospecting' } }))
    expect(container.querySelector('[data-agent-icon]')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('marks an agent’s work lane with the agent mark too', () => {
    render(h(LaneMark, { kind: 'work_run' }))
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('lucide-boxes')
  })
})
