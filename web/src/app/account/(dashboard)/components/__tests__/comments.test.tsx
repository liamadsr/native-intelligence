// @vitest-environment jsdom
/**
 * Comments — where the viewer's member id comes from.
 *
 * The component used to raw-fetch /api/account/workspace (the heaviest request
 * in the app) in a []-dep effect on EVERY mount, and it is mounted inside the
 * action/contact/project detail panels, which remount per next/back step. Two
 * behaviours are pinned:
 *
 *  - a supplied `currentMemberId` prop skips the workspace lookup entirely
 *    (all three detail panels supply it from the workspace-switcher context),
 *  - the fallback for prop-less callers goes through cachedJson with the
 *    workspace scope — shared SWR cache, not a fresh request per mount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  cachedJson: vi.fn(),
}))

vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: vi.fn() }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
}))
vi.mock('@/lib/cached-fetch', () => ({ cachedJson: hoisted.cachedJson }))

// UI primitives stubbed to structure — radix portals/popovers are not under
// test here. The dropdown renders its content inline so the author-only Edit
// affordance is observable without pointer choreography.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children?: ReactNode }) => h('span', {}, children),
  AvatarFallback: ({ children }: { children?: ReactNode }) => h('span', {}, children),
  AvatarImage: () => null,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    h('button', { type: 'button', ...props }, children),
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => h('span', {}, children),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  DropdownMenuItem: ({ children }: { children?: ReactNode }) =>
    h('button', { type: 'button' }, children),
}))
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? h('div', {}, children) : null,
  AlertDialogAction: ({ children }: { children?: ReactNode }) => h('button', {}, children),
  AlertDialogCancel: ({ children }: { children?: ReactNode }) => h('button', {}, children),
  AlertDialogContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) => h('div', {}, children),
}))

import { Comments } from '../comments'

const COMMENTS = [
  {
    id: 'c-1',
    body: 'Looks good',
    author_id: 'm-1',
    author_name: 'Alice',
    author_avatar: null,
    parent_id: null,
    reply_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    edited_at: null,
  },
]

let fetchCalls: string[] = []

function installFetch() {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      fetchCalls.push(url)
      if (url === '/api/account/actions/act-1/comments') {
        return { ok: true, status: 200, json: async () => ({ comments: COMMENTS }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }),
  )
}

let container: HTMLDivElement
let root: Root

async function mount(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(Comments, { commentableType: 'action', commentableId: 'act-1', ...props }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
  hoisted.cachedJson.mockResolvedValue({ currentMemberId: 'm-1' })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Comments — current member id source', () => {
  it('skips the workspace lookup when currentMemberId is supplied', async () => {
    await mount({ currentMemberId: 'm-1' })

    expect(hoisted.cachedJson).not.toHaveBeenCalled()
    expect(fetchCalls).not.toContain('/api/account/workspace')
    // The supplied id actually flows: Alice's own comment offers Edit.
    expect(container.textContent).toContain('Looks good')
    expect(container.textContent).toContain('Edit')
  })

  it('a non-author viewer gets no Edit affordance', async () => {
    await mount({ currentMemberId: 'm-2' })

    expect(hoisted.cachedJson).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Looks good')
    expect(container.textContent).not.toContain('Edit')
  })

  it('falls back to cachedJson with workspace scope when no prop is supplied', async () => {
    await mount({})

    expect(hoisted.cachedJson).toHaveBeenCalledTimes(1)
    expect(hoisted.cachedJson).toHaveBeenCalledWith('/api/account/workspace', { scope: 'ws-1' })
    // Never a raw fetch of the workspace payload.
    expect(fetchCalls).not.toContain('/api/account/workspace')
    // The fetched id flows the same way the prop does.
    expect(container.textContent).toContain('Edit')
  })
})

/**
 * The composer's shape.
 *
 * The send control used to sit OUTSIDE the bordered field, which read as a
 * field plus a loose button rather than one comment box. It now lives inside
 * the bordered wrapper, and that containment is the thing worth pinning — it's
 * invisible to any text-content assertion, so a refactor could undo it
 * silently.
 */
describe('Comments — composer layout', () => {
  const composer = () => {
    const el = container.querySelector('[data-comment-composer]')
    if (!el) throw new Error('composer not found')
    return el
  }

  it('renders the send button inside the bordered box, not beside it', async () => {
    await mount({ currentMemberId: 'm-1' })

    const box = composer()
    expect(box.querySelector('textarea')).toBeTruthy()
    // The send control is a DESCENDANT of the box — the whole point of the change.
    const send = box.querySelector('button[aria-label="Send comment"]')
    expect(send).toBeTruthy()
  })

  it('keeps the border and focus ring on the wrapper, not the textarea', async () => {
    await mount({ currentMemberId: 'm-1' })

    const box = composer()
    // The wrapper owns the frame so the whole control lights up as one on focus.
    expect(box.className).toContain('border')
    expect(box.className).toContain('focus-within:border-foreground/30')
    // ...and the textarea inside must not draw a competing second border.
    const ta = box.querySelector('textarea')!
    expect(ta.className).not.toContain('border-input')
    expect(ta.className).toContain('resize-none')
  })

  it('disables send until there is something to send', async () => {
    await mount({ currentMemberId: 'm-1' })

    const send = composer().querySelector<HTMLButtonElement>(
      'button[aria-label="Send comment"]',
    )!
    // Empty composer: submitting would post an empty comment.
    expect(send.disabled).toBe(true)
  })
})
