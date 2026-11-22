'use client'

/**
 * The other people on a spreadsheet: for each of them, their selected cell or
 * range in their colour on the sheet they are on (an overlay drawn in the
 * sheet's content space, so it scrolls with the cells), and their faces in the
 * header. The look matches the canvas's presence (components/canvas/presence-layer.tsx).
 */
import * as React from 'react'
import type { CellRange } from '@/lib/spreadsheets/a1'
import type { SheetLayout } from '@/lib/spreadsheets/controller'
import type { SheetPeer, SheetPeerList } from './presence'

export function useSheetPeers(list: SheetPeerList | null): readonly SheetPeer[] {
  const subscribe = React.useCallback((fn: () => void) => (list ? list.subscribe(fn) : () => undefined), [list])
  const get = React.useCallback(() => (list ? list.get() : EMPTY), [list])
  return React.useSyncExternalStore(subscribe, get, get)
}
const EMPTY: readonly SheetPeer[] = []

/** A range in the sheet's content space, clamped to what the layout reaches. */
function rectOf(layout: SheetLayout, range: CellRange): { left: number; top: number; width: number; height: number } {
  const left = layout.columnStarts[Math.min(range.c1, layout.columns) - 1] ?? 0
  const top = layout.rowStarts[Math.min(range.r1, layout.rows) - 1] ?? 0
  const right = layout.columnStarts[Math.min(range.c2, layout.columns)] ?? left
  const bottom = layout.rowStarts[Math.min(range.r2, layout.rows)] ?? top
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(100,116,139,${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/**
 * Each peer on the sheet now on screen: a faint tint of their colour over their
 * range, a 2px border around it, a stronger outline on their active cell, and a
 * name tag at the range's top-right corner (just above, flipping below when the
 * range starts at row 1 so it stays inside the grid). No pointer events, hidden
 * from screen readers, above the cell text but under the local selection.
 */
export function PresenceOverlay({ peers, sheetId, layout }: { peers: readonly SheetPeer[]; sheetId: number; layout: SheetLayout }) {
  const here = peers.filter((p) => p.sheetId === sheetId)
  if (!here.length) return null
  return (
    <div data-spreadsheet-presence aria-hidden className="pointer-events-none absolute left-0 top-0 z-[5]">
      {here.map((p) => {
        const box = rectOf(layout, p.range)
        if (box.width <= 0 || box.height <= 0) return null
        const active = rectOf(layout, { r1: p.active.row, c1: p.active.column, r2: p.active.row, c2: p.active.column })
        const flip = p.range.r1 <= 1
        return (
          <React.Fragment key={p.key}>
            <div className="absolute" style={{ ...box, backgroundColor: hexToRgba(p.color, 0.1) }} />
            <div className="absolute" style={{ ...box, border: `2px solid ${p.color}` }} />
            {active.width > 0 && active.height > 0 && <div className="absolute" style={{ ...active, boxShadow: `inset 0 0 0 2px ${p.color}` }} />}
            <div className="absolute" style={{ left: box.left + box.width, top: box.top, transform: flip ? 'translate(-100%, 0)' : 'translate(-100%, -100%)' }}>
              <span
                data-spreadsheet-peer={p.userId}
                className="inline-block max-w-[12rem] truncate whitespace-nowrap rounded-[3px] px-1 py-px text-[11px] font-medium leading-tight text-white shadow-sm"
                style={{ background: p.color }}
              >
                {p.name}
              </span>
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

/** Who is here, as initials in the header. One face per person, however many tabs. */
export function PeerFaces({ peers }: { peers: readonly SheetPeer[] }) {
  const people = [...new Map(peers.map((p) => [p.userId, p])).values()]
  if (!people.length) return null
  return (
    <span data-spreadsheet-peers className="flex shrink-0 items-center pl-1" title={people.map((p) => p.name).join(', ')}>
      {people.slice(0, 4).map((p) => (
        <span key={p.userId} className="-ml-1 flex h-5 w-5 items-center justify-center rounded-full border border-background text-[10px] font-semibold text-white first:ml-0" style={{ background: p.color }}>
          {(p.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      ))}
      {people.length > 4 ? <span className="pl-1 text-[11px] text-muted-foreground">+{people.length - 4}</span> : null}
    </span>
  )
}
