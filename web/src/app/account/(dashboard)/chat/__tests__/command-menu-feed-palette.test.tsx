// @vitest-environment jsdom
/**
 * The palette, opened with nothing typed, leads with the activity feed:
 * Inbox (mentions and assignments) and Recent (what the person touched),
 * drawn in its own rows, each opening its record's card; typing hands the
 * list to the search. A failed feed read draws neither. Fixtures are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { FeedEntry } from '@/lib/entities/feed-model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => [] as unknown[])
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-feed' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/chat-cards/open-card', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-cards/open-card')>()),
  openTarget: (t: unknown) => opened.push(t),
}))

import { SlashCommandPicker } from '../slash-command-picker'

const entry = (type: FeedEntry['type'], id: string, label: string, over: Partial<FeedEntry['last']> = {}): FeedEntry => ({
  type,
  id,
  label,
  context: null,
  count: 1,
  last: {
    id: `ev-${id}`,
    action: 'assigned',
    at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    actor: { kind: 'member', member_id: 'm-maya', name: 'Maya Chen', me: false },
    subject: { member_id: 'm-ana', name: 'Ana Reyes', me: true },
    from: null,
    to: null,
    relation: null,
    other: null,
    ...over,
  },
})

const INBOX = [entry('action', 'a0000000-0000-4000-8000-000000000001', 'Send the Fernhill quote')]
const RECENT = [
  entry('document', 'c0000000-0000-4000-8000-000000000001', 'Q4 renewals plan', {
    action: 'renamed',
    subject: null,
    actor: { kind: 'member', member_id: 'm-ana', name: 'Ana Reyes', me: true },
  }),
]

let container: HTMLDivElement
let root: Root
let feedOk = true

beforeEach(() => {
  opened.length = 0
  feedOk = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/account/feed')) {
        if (!feedOk) return { ok: false, json: async () => ({}) } as Response
        const entries = String(url).includes('assigned_to=me') ? INBOX : RECENT
        return { ok: true, json: async () => ({ entries, next_cursor: null }) } as Response
      }
      return { ok: true, json: async () => ({ commands: [] }) } as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  const anchorRef = { current: null }
  await act(async () => {
    root.render(<SlashCommandPicker variant="palette" open query="" onSelect={() => {}} onDismiss={() => {}} anchorRef={anchorRef} />)
  })
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('[data-command-menu-input]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const groups = () => [...document.querySelectorAll('[role="group"]')].map((el) => el.getAttribute('aria-label'))
const feedRows = () => [...document.querySelectorAll('[data-feed-item]')]

describe('the palette’s Inbox and Recent', () => {
  it('lead the first view, each row saying what happened', async () => {
    await render()
    expect(groups()).toEqual(['Inbox', 'Recent'])
    const [inbox, recent] = feedRows()
    expect(inbox.textContent).toContain('Send the Fernhill quote')
    expect(inbox.textContent).toContain('Assigned to you · Maya Chen')
    expect(recent.textContent).toContain('Q4 renewals plan')
    expect(recent.textContent).toContain('Renamed')
    expect(recent.textContent).not.toContain('Ana Reyes')
  })

  it('open the record’s card', async () => {
    await render()
    act(() => (feedRows()[0] as HTMLButtonElement).click())
    expect(opened).toEqual([{ type: 'action', id: INBOX[0].id, title: 'Send the Fernhill quote' }])
  })

  it('give way once something is typed', async () => {
    await render()
    await search('zzz')
    expect(feedRows()).toHaveLength(0)
  })

  it('draw nothing when the feed can’t be read', async () => {
    feedOk = false
    await render()
    expect(feedRows()).toHaveLength(0)
    expect(groups()).not.toContain('Inbox')
  })
})
