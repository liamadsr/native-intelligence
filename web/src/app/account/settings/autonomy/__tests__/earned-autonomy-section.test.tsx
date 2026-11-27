// @vitest-environment jsdom
/**
 * Settings › Autonomy's "What the agent has earned" (docs/plans/earned-autonomy.md
 * §6), read-only in phase 1: shown only while the route says enabled, a row per
 * kind with its level, record and what it still needs, and no buttons at all
 * (nothing here changes what runs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { EARNED_AUTONOMY_URL, EarnedAutonomySection } from '../earned-autonomy-section'
import { summarizeKinds } from '@/lib/autonomy/records'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let body: unknown
const urls: string[] = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  urls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return { ok: true, json: async () => body } as Response
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => root.render(h(EarnedAutonomySection)))
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

const NOW = new Date()
const at = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

describe('EarnedAutonomySection', () => {
  it('off (EARNED_AUTONOMY empty): renders nothing', async () => {
    body = { enabled: false, kinds: [] }
    await render()
    expect(urls).toEqual([EARNED_AUTONOMY_URL])
    expect(container.textContent).toBe('')
  })

  it('on with no record yet: says so', async () => {
    body = { enabled: true, kinds: [] }
    await render()
    expect(container.textContent).toContain('What the agent has earned')
    expect(container.textContent).toContain('Nothing yet')
  })

  it('on: a row per kind, its level, record and what it needs; never a button', async () => {
    const kinds = summarizeKinds(
      [
        ...Array.from({ length: 3 }, (_, i) => ({ kind_key: 'offer_times|text|one', outcome: 'approved' as const, edit_ratio: null, created_at: at(i + 0.5) })),
        { kind_key: 'send_payment_link|unknown|one', outcome: 'approved' as const, edit_ratio: null, created_at: at(4) },
      ],
      [],
      NOW,
    )
    body = { enabled: true, kinds }
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Offers of meeting times by text, to one person')
    expect(text).toContain('Asks first')
    expect(text).toContain('3 approved as shown')
    expect(text).toContain('Needs 7 more clean approvals')
    expect(text).toContain('Always asks')
    expect(container.querySelectorAll('button, [role="switch"], input')).toHaveLength(0)
  })

  it('a failed read leaves the rest of the page alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response))
    await render()
    expect(container.textContent).toBe('')
  })
})
