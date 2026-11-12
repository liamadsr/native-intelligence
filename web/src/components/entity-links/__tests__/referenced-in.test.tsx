// @vitest-environment jsdom
/**
 * "Referenced in" renders nothing until there is something to show (none,
 * loading, or a failed read), then one row per source that opens its card.
 * Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => [] as unknown[])
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: (t: unknown) => opened.push(t) }))

import { ReferencedIn } from '../referenced-in'

let container: HTMLDivElement
let root: Root
let answer: { status: number; body: unknown }

beforeEach(() => {
  opened.length = 0
  answer = { status: 200, body: { references: [] } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status })))
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
  await act(async () => root.render(<ReferencedIn entityType="company" entityId="d-1" />))
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('ReferencedIn', () => {
  it('renders nothing when nothing references the record', async () => {
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the read fails', async () => {
    answer = { status: 500, body: { error: 'x' } }
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('lists each source, its place and how it links, and opens it', async () => {
    answer = {
      status: 200,
      body: {
        references: [
          { type: 'team_chat_message', id: 'm-1', label: 'Can someone own @Fernhill renewal?', relations: ['mentions'], created_at: new Date().toISOString(), context: '#sales' },
          { type: 'document', id: 'doc-1', label: 'Q4 renewals plan', relations: ['mentions', 'related_to'], created_at: new Date().toISOString(), context: null },
        ],
      },
    }
    await render()
    expect(container.textContent).toContain('Referenced in')
    expect(container.textContent).toContain('#sales · Mentioned')
    expect(container.textContent).toContain('Mentioned · Related')
    const rows = container.querySelectorAll('[data-reference]')
    expect(rows).toHaveLength(2)
    act(() => (rows[1] as HTMLButtonElement).click())
    expect(opened).toEqual([{ type: 'document', id: 'doc-1', title: 'Q4 renewals plan' }])
  })

  it("right-click on a row opens the source's own actions (the one entity actions menu)", async () => {
    answer = {
      status: 200,
      body: {
        references: [
          { type: 'document', id: 'doc-1', label: 'Q4 renewals plan', relations: ['mentions'], created_at: new Date().toISOString(), context: null },
        ],
      },
    }
    await render()
    const row = container.querySelector('[data-reference="document"]') as HTMLElement
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    const items = [...document.querySelectorAll('[data-entity-action]')].map((el) => el.getAttribute('data-entity-action'))
    // No chat here to open cards in: no Open; the rest of a document's menu.
    expect(items).toEqual(['copy_link', 'copy_id', 'rename', 'share', 'make_task', 'archive'])
  })
})
