// @vitest-environment jsdom
/**
 * A post draft card (F3 post_drafts): Post opens X's compose page in the
 * person's own browser (review Q4) and only then settles the card; when X
 * can't be opened the card stays (N4). Copy puts the text on the clipboard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const open = vi.hoisted(() => ({ system: vi.fn(async () => true) }))
vi.mock('sonner', () => ({ toast }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [{ id: 'ws-1', name: 'Dial8' }], currentId: 'ws-1' }) }))
vi.mock('@/lib/open-external', async (orig) => ({ ...(await orig<typeof import('@/lib/open-external')>()), openInSystemBrowser: open.system }))

import { AttentionCard } from '../attention-card'
import type { AttentionItem } from '@/hooks/use-attention-items'

const TEXT = 'We cut onboarding to a single step. Activation doubled.'
const card: AttentionItem = {
  id: 'post-1',
  workspace_id: 'ws-1',
  member_id: 'm-1',
  kind: 'question',
  title: `Post on X: “${TEXT}”`,
  why: 'Based on a theme from your Tuesday call',
  payload: { post_draft: { text: TEXT, surface: 'x', chars: TEXT.length, limit: 280, based_on: 'a theme', notes: [] } },
  proposal_id: null,
  source_flow_run_id: null,
  status: 'pending',
  expires_at: null,
  created_at: new Date().toISOString(),
} as unknown as AttentionItem

let container: HTMLDivElement
let root: Root
const onAccept = vi.fn(async () => ({ ok: true }))

function render(item: AttentionItem = card) {
  act(() => {
    root.render(
      h(AttentionCard, {
        item,
        editable: true,
        members: [],
        aiMembers: [],
        projects: [],
        onEdit: vi.fn(),
        onAccept,
        onStart: vi.fn(async () => ({ ok: true })),
        onDismiss: vi.fn(async () => {}),
      } as never),
    )
  })
}

const postButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Post') as HTMLButtonElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the post draft card', () => {
  it("Post opens X's compose page in the system browser with the text, then settles the card", async () => {
    open.system.mockResolvedValue(true)
    render()
    await act(async () => {
      postButton().click()
    })
    expect(open.system).toHaveBeenCalledWith(`https://x.com/intent/post?text=${encodeURIComponent(TEXT)}`)
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it("when X can't be opened, the card is not settled (review N4)", async () => {
    open.system.mockResolvedValue(false)
    render()
    await act(async () => {
      postButton().click()
    })
    expect(onAccept).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  describe('with Typefully connected (C2a, P9 review B2)', () => {
    const LONG = `${TEXT} The trick was asking one question instead of nine, and letting the rest wait until people had a reason to answer.`
    const tf = { ...card, payload: { post_draft: { text: LONG, surface: 'x', chars: LONG.length, limit: 280, notes: [], typefully: true, typefully_account: '@liam', typefully_account_id: 7 } } } as unknown as AttentionItem
    const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined

    it('offers Post now and Queue only on the opened card, where the whole post shows', () => {
      render(tf)
      expect(button('Post now')).toBeUndefined()
      expect(button('Queue')).toBeUndefined()
      act(() => (container.querySelector('[aria-label="Show details"]') as HTMLButtonElement).click())
      expect(button('Post now')).toBeDefined()
      expect(button('Queue')).toBeDefined()
    })

    it('Post now asks once more with the FULL text and the account; only that second click posts', async () => {
      render(tf)
      act(() => (container.querySelector('[aria-label="Show details"]') as HTMLButtonElement).click())
      act(() => button('Post now')!.click())
      expect(onAccept).not.toHaveBeenCalled()
      const confirm = container.querySelector('[data-post-confirm]')!
      expect(confirm.textContent).toContain('Post this as @liam on X now?')
      expect(confirm.textContent).toContain(LONG)
      await act(async () => {
        ;[...confirm.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Post now')!.click()
      })
      expect(onAccept).toHaveBeenCalledWith('post-1', { publish: 'now' })
    })

    it('Queue is one click (it can be undone in Typefully)', async () => {
      render(tf)
      act(() => (container.querySelector('[aria-label="Show details"]') as HTMLButtonElement).click())
      await act(async () => button('Queue')!.click())
      expect(onAccept).toHaveBeenCalledWith('post-1', { publish: 'next_free_slot' })
    })
  })
})
