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
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
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
    body = { enabled: true, mode: 'record', kinds: [] }
    await render()
    expect(container.textContent).toContain('What the agent has earned')
    expect(container.textContent).toContain('Nothing yet')
  })

  it('record: a row per kind, its level, record and what it needs; never a button', async () => {
    const kinds = summarizeKinds(
      [
        ...Array.from({ length: 3 }, (_, i) => ({ kind_key: 'offer_times|text|one', outcome: 'approved' as const, edit_ratio: null, created_at: at(i + 0.5) })),
        { kind_key: 'send_payment_link|unknown|one', outcome: 'approved' as const, edit_ratio: null, created_at: at(4) },
      ],
      [],
      NOW,
    )
    body = { enabled: true, mode: 'record', kinds }
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Offers of meeting times by text, to one person')
    expect(text).toContain('Asks first')
    expect(text).toContain('3 approved as shown')
    expect(text).toContain('Needs 7 more clean approvals')
    expect(text).toContain('Always asks')
    expect(container.querySelectorAll('button, [role="switch"], input')).toHaveLength(0)
  })

  it('graduate: Hand it over on an earned kind posts the decision; a granted kind can be taken back; a hard-limited one has no button', async () => {
    const earned = summarizeKinds(
      Array.from({ length: 10 }, (_, i) => ({ kind_key: 'offer_times|text|one', outcome: 'approved' as const, edit_ratio: null, created_at: at(0.1 + i * 0.9) })),
      [{ kind_key: 'book_quote|customer|one', level: 'tell', pinned_ask: false, granted_at: at(3), demoted_at: null, offer_declined_at: null }],
      NOW,
    )
    const limited = summarizeKinds([{ kind_key: 'send_payment_link|unknown|one', outcome: 'approved' as const, edit_ratio: null, created_at: at(1) }], [], NOW)
    body = { enabled: true, mode: 'graduate', kinds: [...earned, ...limited], actions: [{ id: 'a1', title: 'Invite Dana', status: 'scheduled', run_at: new Date().toISOString(), ran_at: null, card_id: 'card-1', reason: null }] }
    const posts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) posts.push({ url, body: JSON.parse(String(init.body)) })
      return { ok: true, json: async () => body } as Response
    }))
    await render()
    const buttons = () => Array.from(container.querySelectorAll('button'))
    const labels = buttons().map((b) => b.textContent)
    expect(labels).toEqual(['Hand it over', 'Not now', 'Always ask', 'Take it back', 'Stop'])
    expect(container.textContent).toContain('What I did on my own today')
    await act(async () => buttons()[0].click())
    expect(posts[0]).toEqual({ url: EARNED_AUTONOMY_URL, body: { kind_key: 'offer_times|text|one', decision: 'hand_over' } })
    await act(async () => buttons().find((b) => b.textContent === 'Stop')!.click())
    expect(posts.at(-1)).toEqual({ url: '/api/account/attention-items', body: { id: 'card-1', action: 'dismiss' } })
  })

  it('a failed read leaves the rest of the page alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response))
    await render()
    expect(container.textContent).toBe('')
  })
})
