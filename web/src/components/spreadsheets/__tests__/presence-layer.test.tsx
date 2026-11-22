// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SheetLayout } from '@/lib/spreadsheets/controller'
import type { SheetPeer } from '../presence'
import { PeerFaces, PresenceOverlay } from '../presence-layer'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Rows 24px tall, columns 90px wide, four of each: starts [0,90,180,270,360].
function layout(): SheetLayout {
  const rowStarts = new Float64Array(5)
  const columnStarts = new Float64Array(5)
  for (let i = 1; i <= 4; i++) {
    rowStarts[i] = rowStarts[i - 1] + 24
    columnStarts[i] = columnStarts[i - 1] + 90
  }
  return { rows: 4, columns: 4, rowStarts, columnStarts }
}

const peer = (extra: Partial<SheetPeer>): SheetPeer => ({
  key: 'k1', userId: 'u1', name: 'Mara Quill', color: '#112233', sheetId: 1, range: { r1: 2, c1: 2, r2: 3, c2: 3 }, active: { row: 2, column: 2 }, at: 0, ...extra,
})

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

describe('the presence overlay', () => {
  it("draws a peer's range and tag on the sheet it is on, at the layout's coordinates", () => {
    act(() => root.render(<PresenceOverlay peers={[peer({})]} sheetId={1} layout={layout()} />))
    const tag = container.querySelector('[data-spreadsheet-peer="u1"]') as HTMLElement
    expect(tag.textContent).toBe('Mara Quill')
    // The border rectangle is B2:C3 → left 90, top 24, width 180, height 48.
    const border = [...container.querySelectorAll('div')].find((d) => /2px solid/.test(d.style.border)) as HTMLElement
    expect(border.style.left).toBe('90px')
    expect(border.style.top).toBe('24px')
    expect(border.style.width).toBe('180px')
    expect(border.style.height).toBe('48px')
    // The active cell (B2) carries the stronger inset outline.
    const act2 = [...container.querySelectorAll('div')].find((d) => /inset/.test(d.style.boxShadow)) as HTMLElement
    expect(act2.style.left).toBe('90px')
    expect(act2.style.width).toBe('90px')
  })

  it('draws nothing for a peer on another sheet', () => {
    act(() => root.render(<PresenceOverlay peers={[peer({ sheetId: 9 })]} sheetId={1} layout={layout()} />))
    expect(container.querySelector('[data-spreadsheet-presence]')).toBeNull()
  })

  it('flips the tag below when the range starts at row 1', () => {
    act(() => root.render(<PresenceOverlay peers={[peer({ range: { r1: 1, c1: 1, r2: 2, c2: 2 }, active: { row: 1, column: 1 } })]} sheetId={1} layout={layout()} />))
    const wrap = (container.querySelector('[data-spreadsheet-peer="u1"]') as HTMLElement).parentElement as HTMLElement
    expect(wrap.style.transform).toBe('translate(-100%, 0)')
  })
})

describe('the header faces', () => {
  it('shows one face per person however many tabs, capping at four', () => {
    const peers: SheetPeer[] = [
      peer({ key: 'a', userId: 'u1', name: 'Ana' }),
      peer({ key: 'b', userId: 'u1', name: 'Ana' }), // same person, second tab
      peer({ key: 'c', userId: 'u2', name: 'Bo' }),
      peer({ key: 'd', userId: 'u3', name: 'Cy' }),
      peer({ key: 'e', userId: 'u4', name: 'Di' }),
      peer({ key: 'f', userId: 'u5', name: 'Ed' }),
    ]
    act(() => root.render(<PeerFaces peers={peers} />))
    const faces = container.querySelectorAll('[data-spreadsheet-peers] > span:not(.text-muted-foreground)')
    expect(faces).toHaveLength(4)
    expect(container.querySelector('[data-spreadsheet-peers]')?.getAttribute('title')).toBe('Ana, Bo, Cy, Di, Ed')
    expect(container.textContent).toContain('+1')
  })

  it('shows nothing when nobody else is here', () => {
    act(() => root.render(<PeerFaces peers={[]} />))
    expect(container.querySelector('[data-spreadsheet-peers]')).toBeNull()
  })
})
