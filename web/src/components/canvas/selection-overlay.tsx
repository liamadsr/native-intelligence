'use client'

/**
 * What is drawn over the canvas in screen pixels, so it stays the same size
 * at every zoom: the selection's frame and handles, the marquee, alignment
 * guides, a connector's tie points, the eraser's trail.
 */
import * as React from 'react'
import { toScreen } from '@/lib/canvas/engine/camera'
import { anchorPoint, BIND_ANCHORS } from '@/lib/canvas/engine/connectors'
import { aabb } from '@/lib/canvas/engine/geometry'
import { leavesOf } from '@/lib/canvas/engine/scene'
import { frameScreen, selectionFrame } from './selection-frame'
import { useCamera, useCanvas } from './use-canvas'

const ACCENT = 'hsl(var(--primary))'

export function SelectionOverlay() {
  const cam = useCamera()
  const scene = useCanvas((s) => s.scene)
  const selection = useCanvas((s) => s.selection)
  const overlay = useCanvas((s) => s.overlay)
  const readOnly = useCanvas((s) => s.readOnly)
  const editing = useCanvas((s) => s.editing)
  const tool = useCanvas((s) => s.tool)

  const frame = tool === 'select' && !editing ? selectionFrame(scene, selection) : null
  const parts: React.ReactNode[] = []

  if (frame && frame.kind !== 'connector') {
    const fs = frameScreen(frame.pose, cam)
    const pts = fs.corners.map((p) => `${p.x},${p.y}`).join(' ')
    // In a group or a multi-selection, each member gets a faint outline of its own.
    if (frame.kind === 'box') {
      const leaves = leavesOf(scene, selection)
      if (leaves.length <= 60) {
        for (const leaf of leaves) {
          if (leaf.kind === 'connector') continue
          const lf = frameScreen(leaf, cam)
          parts.push(<polygon key={`m-${leaf.id}`} points={lf.corners.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ACCENT} strokeOpacity={0.45} strokeWidth={1} />)
        }
      }
    }
    parts.push(<polygon key="frame" points={pts} fill="none" stroke={ACCENT} strokeWidth={1.25} strokeDasharray={frame.kind === 'box' ? '4 3' : undefined} />)
    if (!readOnly) {
      const top = { x: (fs.corners[0].x + fs.corners[1].x) / 2, y: (fs.corners[0].y + fs.corners[1].y) / 2 }
      parts.push(<line key="stem" x1={top.x} y1={top.y} x2={fs.knob.x} y2={fs.knob.y} stroke={ACCENT} strokeWidth={1} />)
      parts.push(<circle key="knob" data-canvas-handle="rotate" cx={fs.knob.x} cy={fs.knob.y} r={5} className="fill-background" stroke={ACCENT} strokeWidth={1.25} />)
      fs.corners.forEach((p, i) =>
        parts.push(
          <rect
            key={`c${i}`}
            data-canvas-handle={`corner-${i}`}
            x={p.x - 4}
            y={p.y - 4}
            width={8}
            height={8}
            rx={1.5}
            className="fill-background"
            stroke={ACCENT}
            strokeWidth={1.25}
            transform={fs.rotation ? `rotate(${(fs.rotation * 180) / Math.PI} ${p.x} ${p.y})` : undefined}
          />,
        ),
      )
    }
  }
  if (frame && frame.kind === 'connector') {
    for (const which of ['start', 'end'] as const) {
      const p = toScreen(cam, frame[which])
      parts.push(<circle key={which} data-canvas-handle={`end-${which}`} cx={p.x} cy={p.y} r={5} className="fill-background" stroke={ACCENT} strokeWidth={1.5} />)
    }
  }

  if (overlay.bind) {
    const target = scene.items[overlay.bind.id]
    if (target) {
      for (const anchor of BIND_ANCHORS) {
        const p = toScreen(cam, anchorPoint(target, anchor))
        const active = overlay.bind.anchor === anchor
        if (active) parts.push(<circle key={`halo-${anchor}`} cx={p.x} cy={p.y} r={11} fill={ACCENT} fillOpacity={0.2} />)
        parts.push(<circle key={`a-${anchor}`} cx={p.x} cy={p.y} r={active ? 4.5 : 3.5} className="fill-background" stroke={ACCENT} strokeWidth={1.5} />)
      }
      const b = aabb(target)
      const tl = toScreen(cam, { x: b.x, y: b.y })
      parts.push(<rect key="bind-box" x={tl.x} y={tl.y} width={b.w * cam.scale} height={b.h * cam.scale} fill="none" stroke={ACCENT} strokeOpacity={0.35} strokeWidth={1} />)
    }
  }

  for (let i = 0; i < overlay.guides.length; i++) {
    const g = overlay.guides[i]
    const a = toScreen(cam, g.axis === 'x' ? { x: g.at, y: g.from } : { x: g.from, y: g.at })
    const b = toScreen(cam, g.axis === 'x' ? { x: g.at, y: g.to } : { x: g.to, y: g.at })
    parts.push(<line key={`g${i}`} data-canvas-guide={g.axis} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#f43f5e" strokeWidth={1} strokeDasharray="4 3" />)
  }

  if (overlay.marquee) {
    const m = overlay.marquee
    const tl = toScreen(cam, { x: m.x, y: m.y })
    parts.push(<rect key="marquee" data-canvas-marquee x={tl.x} y={tl.y} width={m.w * cam.scale} height={m.h * cam.scale} fill={ACCENT} fillOpacity={0.08} stroke={ACCENT} strokeWidth={1} />)
  }

  if (overlay.eraser.length > 1) {
    const pts = overlay.eraser.map((p) => toScreen(cam, p))
    parts.push(<polyline key="eraser" points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" className="stroke-foreground/25" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />)
  }

  if (!parts.length) return null
  return (
    <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden>
      {parts}
    </svg>
  )
}
