// @vitest-environment jsdom
/**
 * ReviewCard (ACTIVITY-AND-REVIEW-DESIGN §4.4): a work item waiting on the user,
 * on the rail with the item's own verbs and nothing else.
 *
 *   • reads title, the review line, the kind chip and a workspace badge when
 *     the item is not in the active workspace;
 *   • the primary button opens the first pending deliverable on its own
 *     surface through openDeliverable — for a draft, after resolving its
 *     thread through the item route — with the card's workspace as the
 *     foreign one; with nothing to open it opens the item's panel instead;
 *   • Reviewed / Dismiss call the deck's handlers with the WORK item id;
 *   • a delivered item's chevron opens its output (Liam, 10-15) on every
 *     surface, the item moving to the caret menu's Open chat; the chevron and
 *     the primary with nothing to open open the item where any item opens
 *     (bots-v4.md Phase 3, useOpenWorkItem): its bot's page, else over the
 *     Inbox, in its own workspace; a host hears it opened;
 *   • a review you've opened already wears "Seen".
 *
 * Standalone createRoot mount, mirroring attention-card-cross-workspace.test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { WorkItem } from '@/lib/work/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  toastError: vi.fn(),
  openDeliverable: vi.fn(async () => true),
  navigate: vi.fn(),
  openInWorkspace: vi.fn(async () => {}),
  currentId: 'ws-1' as string | null,
  openWorkItem: vi.fn((_id: string, _ids: readonly string[], _known?: unknown) => ({ kind: 'item' })),
}))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => hoisted.openWorkItem }))
vi.mock('sonner', () => ({ toast: { error: hoisted.toastError, success: vi.fn() } }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))
vi.mock('@/lib/work/open-deliverable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/open-deliverable')>()),
  openDeliverable: hoisted.openDeliverable,
}))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, dp: unknown) => ({ location: { kind: 'view', view }, view, detailPanel: dp }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({
    workspaces: [
      { id: 'ws-1', name: 'Dial8' },
      { id: 'ws-2', name: 'Acme Corp' },
    ],
    currentId: hoisted.currentId,
  }),
}))

import { ReviewCard } from '../review-card'
import { reviewCardOf } from '../rail-cards'

let container: HTMLDivElement
let root: Root

function work(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'w1',
    workspace_id: 'ws-2',
    member_id: 'm-2',
    kind: 'email_drafts',
    title: 'Reply to Dana',
    status: 'needs_review',
    actor: 'loop',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: pricing' }],
    needs: { kind: 'review', verb: 'send' },
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: '2026-09-18T08:00:00.000Z',
    started_at: '2026-09-18T08:00:00.000Z',
    finished_at: '2026-09-18T08:05:00.000Z',
    reviewed_at: null,
    last_beat_at: '2026-09-18T08:05:00.000Z',
    deadline_at: null,
    ...over,
  }
}

const onReviewed = vi.fn(async () => ({ ok: true }))
const onDismiss = vi.fn(async () => {})

function mount(item: WorkItem) {
  act(() => {
    root.render(h(ReviewCard, { card: reviewCardOf(item), onReviewed, onDismiss }))
  })
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

function button(text: string): HTMLButtonElement {
  // By its words first (the control bar's primary), then by title (an icon
  // button: the chevron is titled with the output it opens, as the primary reads).
  const b =
    buttons().find((el) => (el.textContent ?? '').trim() === text) ?? buttons().find((el) => el.getAttribute('title') === text)
  if (!b) throw new Error(`no button "${text}" among: ${buttons().map((el) => el.textContent?.trim() || el.title).join(' | ')}`)
  return b
}

/** Dismiss now lives behind the control bar's caret menu, not as a bare button
 *  on the card, so a test that wants it has to open the menu first. Radix
 *  renders the menu in a portal, so the item is searched for document-wide. */
function openMenu() {
  act(() => {
    (container.querySelector('button[aria-label="More actions"]') as HTMLButtonElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }),
    )
  })
}

function menuItem(text: string): HTMLElement {
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
  const el = items.find((it) => (it.textContent ?? '').trim() === text)
  if (!el) throw new Error(`no menu item "${text}" among: ${items.map((i) => i.textContent?.trim()).join(' | ')}`)
  return el
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  hoisted.currentId = 'ws-1'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ drafts: { d1: { provider_thread_id: 't-1', folder: 'drafts', status: 'draft' } } }), {
        status: 200,
      }),
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('ReviewCard', () => {
  it('reads the item: title, review line, kind chip, the deliverable verb, and a badge when foreign', () => {
    mount(work())
    const text = container.textContent ?? ''
    expect(text).toContain('Reply to Dana')
    expect(text).toContain('Send 1 draft')
    expect(text).toContain('Email assistant')
    expect(text).toContain('Acme Corp')
    expect(button('Review draft')).toBeTruthy()
    expect(button('Mark reviewed').textContent?.trim()).toBe('Reviewed')
    openMenu()
    expect(menuItem('Dismiss')).toBeTruthy()
  })

  it('marks an unattended attempt, and only an attempt', () => {
    mount(work({ origin: 'attempt' }))
    expect(container.textContent).toContain('Attempted')
    act(() => root.unmount())
    root = createRoot(container)
    mount(work({ origin: 'user' }))
    expect(container.textContent).not.toContain('Attempted')
  })

  it('shows no badge for a card in the active workspace', () => {
    mount(work({ workspace_id: 'ws-1' }))
    expect(container.textContent).not.toContain('Dial8')
  })

  it('the primary button opens the draft on its surface, thread resolved through the item route', async () => {
    mount(work())
    await act(async () => {
      button('Review draft').click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/activity/w1')
    expect(hoisted.openDeliverable).toHaveBeenCalledTimes(1)
    const [d, ctx, nav] = hoisted.openDeliverable.mock.calls[0] as unknown as [
      { type: string; id: string },
      { drafts?: Record<string, { provider_thread_id: string | null }> },
      { workspaceId: string; foreignWorkspaceId: string | null },
    ]
    expect(d).toMatchObject({ type: 'email_draft', id: 'd1' })
    expect(ctx.drafts?.d1.provider_thread_id).toBe('t-1')
    expect(nav.workspaceId).toBe('ws-2')
    expect(nav.foreignWorkspaceId).toBe('ws-2')
    expect(hoisted.toastError).not.toHaveBeenCalled()
  })

  it('a non-draft deliverable opens without the item route; nothing openable toasts', async () => {
    hoisted.openDeliverable.mockResolvedValueOnce(false)
    mount(work({ deliverables: [{ type: 'pr', id: 'https://github.com/x/y/pull/1', label: 'PR #1' }], needs: { kind: 'review', verb: 'approve' } }))
    expect(container.textContent).toContain('Approve 1 pull request')
    await act(async () => {
      button('Open pull request').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(hoisted.openDeliverable).toHaveBeenCalledTimes(1)
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
  })

  it('with no pending deliverable the primary opens the item where any item opens, in the card workspace', async () => {
    mount(work({ deliverables: [], workspace_id: 'ws-2' }))
    expect(container.textContent).toContain('Send the result')
    await act(async () => {
      button('Open').click()
      await Promise.resolve()
    })
    expect(hoisted.openDeliverable).not.toHaveBeenCalled()
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('w1', [], { workspaceId: 'ws-2', title: 'Reply to Dana', teammateId: null })
    expect(hoisted.openInWorkspace).not.toHaveBeenCalled()
  })

  it('with nothing to open, the chevron opens the item on its teammate’s bot’s page (useOpenWorkItem), and tells a host it opened', () => {
    hoisted.openWorkItem.mockClear()
    const onItemOpened = vi.fn()
    const card = reviewCardOf(work({ workspace_id: 'ws-1', ai_team_member_id: 'corr', deliverables: [] }))
    act(() => {
      root.render(h(ReviewCard, { card, onReviewed, onDismiss, onItemOpened }))
    })
    act(() => {
      button('Open it').click()
    })
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('w1', ['corr'], { workspaceId: 'ws-1', title: 'Reply to Dana', teammateId: 'corr' })
    expect(onItemOpened).toHaveBeenCalledTimes(1)
    expect(hoisted.navigate).not.toHaveBeenCalled()
    expect(hoisted.openInWorkspace).not.toHaveBeenCalled()
  })

  describe('a delivered item opens to its output (Liam, 10-15), as in the chat’s For you column', () => {
    function mountColumn(item: WorkItem) {
      act(() => {
        root.render(h(ReviewCard, { card: reviewCardOf(item), onReviewed, onDismiss, surface: 'column' }))
      })
    }
    const chevron = () => container.querySelector('[data-review-card-opens]') as HTMLButtonElement

    it('the chevron opens the primary deliverable, not the run’s chat', async () => {
      mountColumn(work({ workspace_id: 'ws-1', ai_team_member_id: 'corr', deliverables: [{ type: 'document', id: 'doc-1', label: 'Acme brief' }], needs: { kind: 'review', verb: 'check' } }))
      expect(chevron().getAttribute('data-review-card-opens')).toBe('document')
      expect(chevron().title).toBe('Open document')
      await act(async () => {
        chevron().click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(hoisted.openDeliverable).toHaveBeenCalledTimes(1)
      const [d, , nav] = hoisted.openDeliverable.mock.calls[0] as unknown as [{ type: string; id: string }, unknown, { workspaceId: string; foreignWorkspaceId: string | null }]
      expect(d).toMatchObject({ type: 'document', id: 'doc-1' })
      expect(nav).toEqual({ workspaceId: 'ws-1', foreignWorkspaceId: null })
      expect(hoisted.openWorkItem).not.toHaveBeenCalled()
    })

    it('the review’s named deliverable wins over the first one', async () => {
      mountColumn(
        work({
          deliverables: [
            { type: 'document', id: 'doc-1', label: 'Notes' },
            { type: 'document', id: 'doc-2', label: 'Brief' },
          ],
          needs: { kind: 'review', verb: 'check', deliverable: 1 },
        }),
      )
      await act(async () => {
        chevron().click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect((hoisted.openDeliverable.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ id: 'doc-2' })
    })

    it('a foreign card opens its output in its own workspace', async () => {
      mountColumn(work({ workspace_id: 'ws-2', deliverables: [{ type: 'capture', id: 'cap-1', label: 'Call' }] }))
      await act(async () => {
        chevron().click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect((hoisted.openDeliverable.mock.calls as unknown as unknown[][])[0][2]).toEqual({ workspaceId: 'ws-2', foreignWorkspaceId: 'ws-2' })
    })

    it('an output that won’t open falls back to the item', async () => {
      hoisted.openDeliverable.mockResolvedValueOnce(false)
      mountColumn(work({ workspace_id: 'ws-1', ai_team_member_id: 'corr', deliverables: [{ type: 'document', id: 'doc-1', label: 'Brief' }] }))
      await act(async () => {
        chevron().click()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(hoisted.openWorkItem).toHaveBeenCalledWith('w1', ['corr'], { workspaceId: 'ws-1', title: 'Reply to Dana', teammateId: 'corr' })
    })

    it('the run’s chat is the caret menu’s Open chat', () => {
      mountColumn(work({ workspace_id: 'ws-1', ai_team_member_id: 'corr', deliverables: [{ type: 'document', id: 'doc-1', label: 'Brief' }] }))
      openMenu()
      act(() => menuItem('Open chat').click())
      expect(hoisted.openWorkItem).toHaveBeenCalledWith('w1', ['corr'], { workspaceId: 'ws-1', title: 'Reply to Dana', teammateId: 'corr' })
      expect(hoisted.openDeliverable).not.toHaveBeenCalled()
    })

    it('with nothing to open, the chevron opens the item and the menu adds no Open chat', () => {
      mountColumn(work({ workspace_id: 'ws-1', deliverables: [] }))
      expect(chevron().getAttribute('data-review-card-opens')).toBe('item')
      act(() => chevron().click())
      expect(hoisted.openWorkItem).toHaveBeenCalledTimes(1)
      openMenu()
      expect(() => menuItem('Open chat')).toThrow()
    })
  })

  it('a bot’s bubble or page opens the output the same way, and tells its host something opened', async () => {
    for (const surface of ['bubble', 'bot_page'] as const) {
      hoisted.openDeliverable.mockClear()
      hoisted.openWorkItem.mockClear()
      const onItemOpened = vi.fn()
      const card = reviewCardOf(work({ workspace_id: 'ws-1', deliverables: [{ type: 'document', id: 'doc-1', label: 'Brief' }] }))
      act(() => {
        root.render(h(ReviewCard, { card, onReviewed, onDismiss, surface, onItemOpened }))
      })
      const chevron = container.querySelector('[data-review-card-opens]') as HTMLButtonElement
      expect(chevron.getAttribute('data-review-card-opens')).toBe('document')
      await act(async () => {
        chevron.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(hoisted.openDeliverable).toHaveBeenCalledTimes(1)
      expect(hoisted.openWorkItem).not.toHaveBeenCalled()
      expect(onItemOpened).toHaveBeenCalledTimes(1)
      openMenu()
      expect(menuItem('Open chat')).toBeTruthy()
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('a review you’ve opened already wears “Seen”; a new one doesn’t', () => {
    act(() => {
      root.render(h(ReviewCard, { card: reviewCardOf(work(), { seen: true }), onReviewed, onDismiss }))
    })
    expect(container.querySelector('[data-review-card-seen]')!.textContent).toContain('Seen')
    act(() => {
      root.render(h(ReviewCard, { card: reviewCardOf(work()), onReviewed, onDismiss }))
    })
    expect(container.querySelector('[data-review-card-seen]')).toBeNull()
  })

  it('Reviewed and Dismiss hand the deck the work item id', async () => {
    mount(work())
    await act(async () => {
      button('Mark reviewed').click()
      await Promise.resolve()
    })
    expect(onReviewed).toHaveBeenCalledWith('w1')
    openMenu()
    await act(async () => {
      menuItem('Dismiss').click()
      await Promise.resolve()
    })
    expect(onDismiss).toHaveBeenCalledWith('w1')
  })
})
