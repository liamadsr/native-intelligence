'use client'

/** The other people on the canvas: where each one's cursor is and what they have selected. */
import * as React from 'react'
import { toScreen } from '@/lib/canvas/engine/camera'
import { frameScreen } from './selection-frame'
import type { Peer, PeerList } from './live'
import { useCamera, useCanvas } from './use-canvas'

export function usePeers(list: PeerList | null): readonly Peer[] {
  const subscribe = React.useCallback((fn: () => void) => (list ? list.subscribe(fn) : () => undefined), [list])
  const get = React.useCallback(() => (list ? list.get() : EMPTY), [list])
  return React.useSyncExternalStore(subscribe, get, get)
}
const EMPTY: readonly Peer[] = []

export function PresenceLayer({ peers }: { peers: readonly Peer[] }) {
  const cam = useCamera()
  const scene = useCanvas((s) => s.scene)
  if (!peers.length) return null
  return (
    <div data-canvas-presence className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      <svg className="absolute inset-0 h-full w-full">
        {peers.flatMap((p) =>
          p.selection.slice(0, 40).map((id) => {
            const it = scene.items[id]
            if (!it || it.kind === 'group' || it.kind === 'connector') return null
            const fs = frameScreen(it, cam)
            return <polygon key={`${p.key}:${id}`} points={fs.corners.map((c) => `${c.x},${c.y}`).join(' ')} fill="none" stroke={p.color} strokeWidth={1.5} strokeOpacity={0.8} />
          }),
        )}
      </svg>
      {peers.map((p) => {
        if (!p.cursor) return null
        const at = toScreen(cam, p.cursor)
        return (
          <div key={p.key} data-canvas-peer={p.userId} className="absolute left-0 top-0 transition-transform duration-75 ease-linear motion-reduce:transition-none" style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
            <svg width="14" height="18" viewBox="0 0 14 18" className="block drop-shadow-sm">
              <path d="M1 1 L1 14.5 L4.8 11 L7.4 17 L9.6 16 L7 10.2 L12.5 10.2 Z" fill={p.color} stroke="white" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span className="ml-3 -mt-1 inline-block max-w-[10rem] truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-tight text-white shadow-sm" style={{ background: p.color }}>
              {p.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Who is here, as initials in the header. */
export function PeerFaces({ peers }: { peers: readonly Peer[] }) {
  // One face per person, however many tabs they have open.
  const people = [...new Map(peers.map((p) => [p.userId, p])).values()]
  if (!people.length) return null
  return (
    <span data-canvas-peers className="flex shrink-0 items-center pl-1" title={people.map((p) => p.name).join(', ')}>
      {people.slice(0, 4).map((p) => (
        <span key={p.userId} className="-ml-1 flex h-5 w-5 items-center justify-center rounded-full border border-background text-[10px] font-semibold text-white first:ml-0" style={{ background: p.color }}>
          {(p.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      ))}
      {people.length > 4 ? <span className="pl-1 text-[11px] text-muted-foreground">+{people.length - 4}</span> : null}
    </span>
  )
}
