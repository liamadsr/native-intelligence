/**
 * MentionText: a plain body with its mentions drawn. A record's `@label` is a
 * button that opens it; a person's is a highlight; a kind nothing opens, or a
 * label the mentions don't hold, stays words.
 */
// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const hoisted = vi.hoisted(() => ({ openMention: vi.fn(async () => true) }))
vi.mock('@/lib/entity-links/open-mention', () => ({
  openMention: hoisted.openMention,
  mentionOpens: (type: string) => type !== 'decision',
}))

const { MentionText } = await import('../mention-text')

afterEach(() => {
  cleanup()
  hoisted.openMention.mockClear()
})

describe('MentionText', () => {
  it('draws a record as a chip that opens it, and a person as a highlight', () => {
    const doc = { type: 'document' as const, id: 'd-1', label: 'Harbor plan' }
    const { container } = render(<MentionText text="@Sam Ortiz see @Harbor plan and @nobody" people={['Sam Ortiz']} records={[doc]} from="comment" />)
    const chip = container.querySelector('[data-record-mention="document"]') as HTMLButtonElement
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
})
