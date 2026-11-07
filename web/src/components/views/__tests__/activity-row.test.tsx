// @vitest-environment jsdom
/**
 * Activity as a collapsible property row.
 *
 * This replaced a standalone card that always showed the full created/updated
 * timeline, so the thing most worth pinning is that the detail is still
 * REACHABLE — a collapsed row that cannot open would simply have deleted the
 * activity history from the panel.
 *
 * The collapsed summary carries the latest event rather than the bare word
 * "Activity": the row is the only place the panel surfaces this, and a label
 * that hides its own content costs a click to learn anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ActivityRow } from '../activity-row'

const CREATED = '2026-08-01T10:00:00.000Z'
const UPDATED = '2026-08-05T10:00:00.000Z'

/** Stand-in for each panel's local formatter — distinct, greppable output. */
const fmt = (d: string) => (d === CREATED ? '1d ago' : '11m ago')

let container: HTMLDivElement
let root: Root

async function mount(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui)
  })
}

function toggle() {
  return act(async () => {
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
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

describe('ActivityRow', () => {
  it('summarises the most recent event when collapsed', async () => {
    await mount(
      <ActivityRow createdAt={CREATED} updatedAt={UPDATED} formatRelativeTime={fmt} />,
    )

    expect(container.textContent).toContain('Updated · 11m ago')
    // The full timeline is not rendered yet — one line, not two.
    expect(container.textContent).not.toContain('Created')
  })

  it('expands to the full created/updated timeline', async () => {
    await mount(
      <ActivityRow createdAt={CREATED} updatedAt={UPDATED} formatRelativeTime={fmt} />,
    )
    await toggle()

    expect(container.textContent).toContain('Updated · 11m ago')
    expect(container.textContent).toContain('Created · 1d ago')
  })

  it('collapses again on a second click', async () => {
    await mount(
      <ActivityRow createdAt={CREATED} updatedAt={UPDATED} formatRelativeTime={fmt} />,
    )
    await toggle()
    await toggle()

    expect(container.textContent).not.toContain('Created')
  })

  it('shows only creation when the entity was never updated', async () => {
    await mount(
      <ActivityRow createdAt={CREATED} updatedAt={CREATED} formatRelativeTime={fmt} />,
    )

    // Summary falls back to Created — there is no later event to report.
    expect(container.textContent).toContain('Created · 1d ago')
    expect(container.textContent).not.toContain('Updated')

    await toggle()
    expect(container.textContent).toContain('Created · 1d ago')
    expect(container.textContent).not.toContain('Updated')
  })

  it('uses the padding the host panel asks for', async () => {
    await mount(
      <ActivityRow
        createdAt={CREATED}
        updatedAt={UPDATED}
        formatRelativeTime={fmt}
        padding="px-3"
      />,
    )

    const row = container.querySelector('button')!
    expect(row.className).toContain('px-3')
    expect(row.className).not.toContain('px-2')
  })

  it('defaults to px-2, the PropertyGroup convention', async () => {
    await mount(
      <ActivityRow createdAt={CREATED} updatedAt={UPDATED} formatRelativeTime={fmt} />,
    )

    expect(container.querySelector('button')!.className).toContain('px-2')
  })

  it('keeps the timeline connector aligned with the dots at each padding', async () => {
    // The connector is absolutely positioned; if it stayed pinned to the px-3
    // offset it would sit beside the dots rather than through them.
    await mount(
      <ActivityRow createdAt={CREATED} updatedAt={UPDATED} formatRelativeTime={fmt} />,
    )
    await toggle()
    expect(container.querySelector('.absolute')!.className).toContain('left-[17px]')

    await act(async () => root.render(<div />))
    await mount(
      <ActivityRow
        createdAt={CREATED}
        updatedAt={UPDATED}
        formatRelativeTime={fmt}
        padding="px-3"
      />,
    )
    await toggle()
    expect(container.querySelector('.absolute')!.className).toContain('left-[21px]')
  })
})
