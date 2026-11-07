// @vitest-environment jsdom
/**
 * "By angle" — per-angle telemetry under the run history popover.
 *
 * WHAT IT IS FOR. Every discovery round fires four angles (§7) and bills for
 * all four, but they do not perform alike: on a narrow ICP two of them
 * reliably return the same handful of companies the other two already found,
 * and the user pays for that every round with no way to see it. The
 * found → new → saved funnel makes it visible, and the actionable reading is
 * the shape rather than any single number — a big `found` with a zero `saved`
 * is noise the ICP is inviting, and the fix is an ICP edit, not another round.
 *
 * THE DEGRADATION MATTERS AS MUCH AS THE TABLE. This is a reference surface
 * consulted for four seconds before pressing Find. An angles read that failed
 * must cost the SECTION, not the popover: the run list is what the popover
 * exists for, and taking it down over an aggregate query would trade the
 * feature for the footnote.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchRuns = vi.fn()
const fetchAngles = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchAngles: (listId: string) => fetchAngles(listId),
  }
})

import { RunHistoryPanel } from '../run-history'
import { run } from './run-fixtures'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchRuns.mockReset()
  fetchAngles.mockReset()
  fetchRuns.mockResolvedValue([run({ status: 'completed', is_live: false })])
  fetchAngles.mockResolvedValue([
    { angle: 'Companies using a data warehouse', found: 40, new: 18, saved: 6 },
    { angle: 'Series B fintech in the US', found: 22, new: 3, saved: 0 },
  ])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Radix portals the popover content out of `container`. */
function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Open the popover — the history and the angles are both fetched on open. */
/** The panel fetches on MOUNT — it is mounted when the user reaches it
 *  through the list's settings popover and unmounted when they leave, which
 *  is the old popover's "fetched on open, every open" in a new frame. */
async function open() {
  await act(async () => {
    root.render(<RunHistoryPanel listId="list-1" />)
  })
  await act(async () => {})
  await act(async () => {})
}

describe('RunHistory — By angle', () => {
  it('is fetched for this list when the popover opens', async () => {
    await open()
    expect(fetchAngles).toHaveBeenCalledWith('list-1')
  })

  it('renders the angle, its funnel headers and each row’s numbers', async () => {
    await open()
    const rendered = text()

    expect(rendered).toContain('By angle')
    expect(rendered).toContain('Found')
    expect(rendered).toContain('New')
    expect(rendered).toContain('Saved')

    expect(rendered).toContain('Companies using a data warehouse')
    expect(rendered).toContain('40')
    expect(rendered).toContain('18')

    // The angle that is generating noise: 22 found, 3 kept, nothing saved.
    // This row is the whole reason the section exists.
    expect(rendered).toContain('Series B fintech in the US')
    expect(rendered).toContain('22')
  })

  it('renders no section at all when there is no angle data', async () => {
    // A list whose candidates predate the `discovery_angle` column. An empty
    // table with four headers claims a fact ("no angle found anything") that
    // the absence of rows does not support.
    fetchAngles.mockResolvedValue([])
    await open()
    expect(text()).not.toContain('By angle')
  })

  it('a failed angles read costs the section, never the run list', async () => {
    fetchAngles.mockRejectedValue(new Error('boom'))
    await open()

    const rendered = text()
    expect(rendered).not.toContain('By angle')
    // The popover still does its actual job.
    expect(rendered).toContain('Runs')
    expect(rendered).toContain('Completed')
  })
})
