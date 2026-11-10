// @vitest-environment jsdom
/**
 * "History" renders nothing until there is something to show (none yet,
 * loading, or a failed read), then one row per event, newest first, saying
 * what happened and who did it; a mention or link opens the other record.
 * It asks the feed for this one record. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FeedRecordEvent } from '@/lib/entities/feed-model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => [] as unknown[])
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: (t: unknown) => opened.push(t) }))

import { RecordHistory, recordHistoryUrl } from '../record-history'

const TASK = 'a0000000-0000-4000-8000-000000000001'
const DOC = 'c0000000-0000-4000-8000-000000000001'

const event = (over: Partial<FeedRecordEvent>): FeedRecordEvent => ({
  id: 'e1',
  action: 'created',
  at: new Date(Date.now() - 3_600_000).toISOString(),
  actor: { kind: 'member', member_id: 'm-maya', name: 'Maya Chen', me: false },
  subject: null,
  from: null,
  to: null,
  relation: null,
  other: null,
  type: 'action',
  entity_id: TASK,
  label: 'Send the Fernhill quote',
  context: null,
  ...over,
})

let container: HTMLDivElement
let root: Root
let answer: { status: number; body: unknown }
let urls: string[]

beforeEach(() => {
  opened.length = 0
  urls = []
  answer = { status: 200, body: { events: [] } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(answer.body), { status: answer.status })
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
  await act(async () => root.render(<RecordHistory entityType="action" entityId={TASK} />))
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('RecordHistory', () => {
  it('asks the feed for this one record’s events', async () => {
    await render()
    expect(urls).toEqual([recordHistoryUrl('action', TASK)])
    expect(urls[0]).toContain(`entity=action%3A${TASK}`)
    expect(urls[0]).toContain('group=none')
  })

  it('renders nothing when nothing has happened yet', async () => {
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the read fails', async () => {
    answer = { status: 500, body: { error: 'x' } }
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('lists what happened, who did it, and opens the record a mention came from', async () => {
    answer = {
      status: 200,
      body: {
        events: [
          event({ id: 'e3', action: 'mentioned', other: { type: 'document', id: DOC, label: 'Q4 renewals plan', context: null } }),
          event({ id: 'e2', action: 'status_changed', to: 'In progress', actor: { kind: 'member', member_id: 'm-me', name: 'Ana Reyes', me: true } }),
          event({ id: 'e1', action: 'assigned', subject: { member_id: 'm-me', name: 'Ana Reyes', me: true }, actor: { kind: 'agent', member_id: 'm-maya', name: 'Maya Chen', me: false } }),
        ],
      },
    }
    await render()
    const rows = [...container.querySelectorAll('[data-history-action]')]
    expect(rows.map((r) => r.getAttribute('data-history-action'))).toEqual(['mentioned', 'status_changed', 'assigned'])
    expect(rows[0].textContent).toContain('Mentioned in Q4 renewals plan')
    expect(rows[0].textContent).toContain('Maya Chen')
    expect(rows[1].textContent).toContain('Moved to In progress')
    expect(rows[1].textContent).toContain('You')
    expect(rows[2].textContent).toContain('Assigned to you')
    expect(rows[2].textContent).toContain("Maya Chen's agent")
    expect(container.textContent).toContain('History')

    await act(async () => (rows[0].querySelector('button') as HTMLButtonElement).click())
    expect(opened).toEqual([{ type: 'document', id: DOC, title: 'Q4 renewals plan' }])
    // A row naming no other record is not a button.
    expect(rows[1].querySelector('button')).toBeNull()
  })
})
