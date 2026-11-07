// @vitest-environment jsdom
/**
 * The people consent screen.
 *
 * THREE INVARIANTS, each one a way the dialog could lie about money or yield:
 *
 * 1. **The clamp is the column's** — migration 248 declares
 *    `people_per_company integer CHECK (between 0 and 10)`, so a typed 40 is
 *    corrected in front of the user rather than 400'd behind them. Zero is a
 *    REAL value ("research only"), so an emptied field falls back to the
 *    list's current setting instead of snapping to the floor and silently
 *    turning a people run into a no-op.
 *
 * 2. **The price does not move with the number.** One `category:'people'`
 *    search runs per COMPANY; `people_per_company` caps how many of the
 *    returned people are kept. A dialog whose estimate rose with the slider
 *    would over-quote the cheapest stage by 3× and push users to ask for
 *    fewer people than they want.
 *
 * 3. **Partiality is stated up front** (§7 Stage 4). Exa indexes a fraction of
 *    profiles and `includeDomains` restricts retrieval to pages mentioning the
 *    company, so the realistic yield is 1–3 and sometimes zero. A dialog that
 *    lets a user set 5 and expect 5 turns a working feature into a bug report
 *    on first use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { PeopleDialog, clampPeoplePerCompany } from '../people-dialog'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'
import { LIST } from './fixtures'
import type { Icp } from '@/lib/prospecting/types'

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

const ICP = LIST.icp as Icp

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function input(): HTMLInputElement {
  const el = document.body.querySelector('input[type="number"]')
  if (!el) throw new Error('people-per-company input not rendered')
  return el as HTMLInputElement
}

function confirm(): HTMLButtonElement {
  const dialog = document.body.querySelector('[role="dialog"]')
  if (!dialog) throw new Error('dialog not open')
  const b = Array.from(dialog.querySelectorAll('button')).find(
    // Prefix, not equality: the confirm now carries its own price (C4) —
    // "Find people · $0.14".
    (x) => x.textContent?.trim().startsWith('Find people'),
  )
  if (!b) throw new Error('confirm not rendered')
  return b
}

const onConfirm = vi.fn()

async function render(props: Partial<Parameters<typeof PeopleDialog>[0]> = {}) {
  onConfirm.mockReset()
  await act(async () => {
    root.render(
      <PeopleDialog
        open
        companyCount={12}
        peoplePerCompany={3}
        icp={ICP}
        onCancel={() => {}}
        onConfirm={onConfirm}
        {...props}
      />,
    )
  })
}

/** Type into the controlled number field the way React sees it. */
async function type(value: string) {
  const el = input()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('clampPeoplePerCompany', () => {
  it('holds the 0..10 band migration 248 declares', () => {
    expect(clampPeoplePerCompany('40', 3)).toBe(10)
    expect(clampPeoplePerCompany('-2', 3)).toBe(0)
    expect(clampPeoplePerCompany('4.7', 3)).toBe(4)
  })

  it('treats ZERO as a real value and an EMPTY field as unchanged', () => {
    // 0 means "research only" — a legitimate list setting, not a cancel.
    expect(clampPeoplePerCompany('0', 3)).toBe(0)
    // ...but a half-deleted "3" must not be read as an intentional 0, which
    // would silently turn the run into a no-op.
    expect(clampPeoplePerCompany('', 3)).toBe(3)
    expect(clampPeoplePerCompany('abc', 3)).toBe(3)
  })
})

describe('PeopleDialog', () => {
  it('shows the buyer titles the search will actually anchor to', async () => {
    await render()
    const rendered = text()
    for (const title of ICP.target.buyer_titles) {
      expect(rendered).toContain(title)
    }
  })

  it('states the partial yield rather than implying a full roster', async () => {
    await render({ companyCount: 12, peoplePerCompany: 5 })
    expect(text()).toContain('Expect fewer than')
    expect(text()).toContain('60')
  })

  it('refuses to start at zero people per company, and says why', async () => {
    await render()
    await type('0')
    const button = confirm()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('research only')
  })

  it('confirms with the clamped number', async () => {
    await render()
    await type('40')
    await act(async () => {
      confirm().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledWith(10)
  })

  it('says which part of an over-cap population this press buys', async () => {
    // The parent hands down the CAPPED count, so the price and the yield are
    // already bound to what runs; this sentence names the remainder so the
    // user knows a second press is waiting rather than that rows vanished.
    await render({ companyCount: MAX_ENTRIES_PER_TARGETED_RUN, cappedByRunSize: true })
    const rendered = text()
    expect(rendered).toContain(`Searching the first ${MAX_ENTRIES_PER_TARGETED_RUN}`)
  })

  it('says nothing about a cap when the population fits in one run', async () => {
    await render()
    expect(text()).not.toContain('Searching the first')
  })

  it('degrades honestly when the ICP names no buyer titles', async () => {
    const bare: Icp = { ...ICP, target: { ...ICP.target, buyer_titles: [] } }
    await render({ icp: bare })
    expect(text()).toContain('Your ICP names no buyer titles')
  })
})

