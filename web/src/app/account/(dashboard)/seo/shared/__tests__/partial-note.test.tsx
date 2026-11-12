// @vitest-environment jsdom
/**
 * The partial answer's quiet line: the server's note as a muted line, never
 * an alert, and nothing at all when the answer is whole.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PartialNote, partialNoteText } from '../partial-note'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const render = (node: React.ReactNode) => act(() => root.render(node))

describe('PartialNote', () => {
  it('shows the note as one muted line, not an alert', () => {
    render(<PartialNote partial={{ missing: ['related'], note: '  Related searches could not be added just now.  ' }} className="mt-1" />)
    const line = container.querySelector<HTMLElement>('[data-seo-partial]')!
    expect(line.tagName).toBe('P')
    expect(line.textContent).toBe('Related searches could not be added just now.')
    expect(line.className).toContain('text-muted-foreground')
    expect(line.className).toContain('mt-1')
    expect(line.className).not.toMatch(/amber|red|destructive/)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('draws nothing for a whole answer or an empty note', () => {
    render(<PartialNote partial={null} />)
    expect(container.innerHTML).toBe('')
    render(<PartialNote partial={undefined} />)
    expect(container.innerHTML).toBe('')
    render(<PartialNote partial={{ missing: ['ideas'], note: '   ' }} />)
    expect(container.innerHTML).toBe('')
  })

  it('partialNoteText trims, and is null when there is nothing to say', () => {
    expect(partialNoteText({ missing: ['top_pages'], note: ' Its top pages couldn’t be read just now. ' })).toBe('Its top pages couldn’t be read just now.')
    expect(partialNoteText({ missing: [], note: '' })).toBeNull()
    expect(partialNoteText(null)).toBeNull()
    expect(partialNoteText(undefined)).toBeNull()
  })
})
