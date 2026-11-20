/**
 * MentionText: a plain body with its mentions drawn. A record's `@label` is a
 * live chip that opens it (its icon, then the resolved label and status); a
 * person's is a highlight; a kind nothing opens, or a label the mentions don't
 * hold, stays words. A record the reader may not see locks (dimmed, no click).
 * Inside a share nothing resolves. Fixture data is made up (Harbor, Sam, Ana).
 */
// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<{ root: Root; container: HTMLElement }> = []
function render(node: ReactElement): { container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(node))
  roots.push({ root, container })
  return { container }
}
function cleanup() {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
}
/** Let the batcher's 30ms window elapse and its answer land. */
async function tick(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

const hoisted = vi.hoisted(() => ({ openMention: vi.fn(async () => true) }))
vi.mock('@/lib/entity-links/open-mention', () => ({
  openMention: hoisted.openMention,
  mentionOpens: (type: string) => type !== 'decision',
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))

const { MentionText } = await import('../mention-text')
const { EntityRefsProvider } = await import('../entity-refs-context')
const { __setMentionFetcher, __resetMentionCache } = await import('../mention-batcher')

beforeEach(() => {
  __resetMentionCache()
  // Default: nothing resolves (every mention stays loading → stored words).
  __setMentionFetcher(async () => ({}))
})
afterEach(() => {
  cleanup()
  __resetMentionCache()
  __setMentionFetcher(null)
  hoisted.openMention.mockClear()
})

describe('MentionText', () => {
  it('draws a record as a chip that opens it, and a person as a highlight', () => {
    const doc = { type: 'document' as const, id: 'd-1', label: 'Harbor plan' }
    const { container } = render(<MentionText text="@Sam Ortiz see @Harbor plan and @nobody" people={['Sam Ortiz']} records={[doc]} from="comment" />)
    const chip = container.querySelector('[data-record-mention="document"]') as HTMLButtonElement
    expect(chip.tagName).toBe('BUTTON')
    // Before the resolve answers, the chip shows the stored words (plus its icon, which has no text).
    expect(chip.textContent).toBe('@Harbor plan')
    expect(container.querySelector('[data-person-mention]')?.textContent).toBe('@Sam Ortiz')
    expect(container.textContent).toBe('@Sam Ortiz see @Harbor plan and @nobody')
    act(() => chip.click())
    expect(hoisted.openMention).toHaveBeenCalledWith(doc, 'comment')
  })

  it('leaves a kind nothing opens as a highlight, and plain words alone', () => {
    const { container } = render(<MentionText text="per @Hold the price" records={[{ type: 'decision', id: 'x-1', label: 'Hold the price' }]} from="comment" />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-person-mention]')?.textContent).toBe('@Hold the price')
    cleanup()
    const plain = render(<MentionText text="no mentions here" from="comment" />)
    expect(plain.container.querySelector('button, [data-person-mention]')).toBeNull()
    expect(plain.container.textContent).toBe('no mentions here')
  })

  it('shows the current label and a status word once the resolve answers', async () => {
    __setMentionFetcher(async () => ({ 'action:a-1': { type: 'action', id: 'a-1', label: 'GEN-42', status: 'in_progress' } }))
    const ref = { type: 'action' as const, id: 'a-1', label: 'GEN-41' }
    const { container } = render(<MentionText text="see @GEN-41 today" records={[ref]} from="comment" />)
    // Stored label first.
    expect((container.querySelector('[data-record-mention="action"]') as HTMLElement).textContent).toBe('@GEN-41')
    await tick()
    const chip = container.querySelector('[data-record-mention="action"]') as HTMLElement
    expect(chip.textContent).toContain('@GEN-42')
    expect(chip.querySelector('[data-mention-status]')?.textContent).toBe('In progress')
  })

  it('locks a record the reader may not see: dimmed, not clickable, the stored words', async () => {
    // The answer comes back without the key → not visible.
    __setMentionFetcher(async () => ({}))
    const ref = { type: 'document' as const, id: 'd-9', label: 'Ana’s private doc' }
    const { container } = render(<MentionText text="see @Ana’s private doc" records={[ref]} from="comment" />)
    await tick()
    const chip = container.querySelector('[data-record-mention="document"]') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip.hasAttribute('data-mention-hidden')).toBe(true)
    expect(chip.textContent).toBe('@Ana’s private doc')
    act(() => (chip as HTMLElement).click())
    expect(hoisted.openMention).not.toHaveBeenCalled()
  })

  it('never resolves inside a share: a static chip with the stored words', async () => {
    const fetcher = vi.fn(async () => ({}))
    __setMentionFetcher(fetcher)
    const doc = { type: 'document' as const, id: 'd-2', label: 'Harbor plan' }
    const { container } = render(
      <EntityRefsProvider enabled={false}>
        <MentionText text="see @Harbor plan" records={[doc]} from="share" />
      </EntityRefsProvider>,
    )
    await tick()
    const chip = container.querySelector('[data-record-mention="document"]') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip.textContent).toBe('@Harbor plan')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
