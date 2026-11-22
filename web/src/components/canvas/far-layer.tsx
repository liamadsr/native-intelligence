'use client'

/**
 * A big board seen from far away. Past a few hundred items and zoomed out
 * until words are specks, thousands of page elements cost more than the
 * drawing itself, so everything is painted onto one bitmap instead: the same
 * shapes, colors, order and connectors, without the words. Zoom back in and
 * the real elements return. Picking, selecting and dragging are the engine's
 * and do not change.
 */
import * as React from 'react'
import type { CanvasItem, ConnectorItem } from '@/lib/canvas/types'
import { hexColor } from '@/lib/canvas/engine/colors'
import { headShape, routePath, type RoutePath } from '@/lib/canvas/engine/connectors'
import { aabb, boxesIntersect } from '@/lib/canvas/engine/geometry'
import { viewBox } from '@/lib/canvas/engine/camera'
import { painted, type Scene } from '@/lib/canvas/engine/scene'
import { FAR_SCALE } from './store'
import { useCanvas, useCanvasStore } from './use-canvas'

/** From this many items, a far view is painted as one bitmap. */
export const FAR_ITEMS = 600

export function useFarMode(): boolean {
  const far = useCanvas((s) => s.far)
  const many = useCanvas((s) => Object.keys(s.scene.items).length >= FAR_ITEMS)
  const editing = useCanvas((s) => s.editing !== null)
  return far && many && !editing
}

const routes = new WeakMap<ConnectorItem, { s: CanvasItem | undefined; e: CanvasItem | undefined; path: RoutePath; p2d: Path2D }>()
function routeOf(scene: Scene, it: ConnectorItem) {
  const s = it.start.bind ? scene.items[it.start.bind.id] : undefined
  const e = it.end.bind ? scene.items[it.end.bind.id] : undefined
  const hit = routes.get(it)
  if (hit && hit.s === s && hit.e === e) return hit
  const path = routePath(scene, it)
  const made = { s, e, path, p2d: new Path2D(path.d) }
  routes.set(it, made)
  return made
}

function dash(ctx: CanvasRenderingContext2D, style: string | undefined, w: number): void {
  if (style === 'dashed') ctx.setLineDash([w * 3, w * 2.5])
  else if (style === 'dotted') ctx.setLineDash([0.01, w * 2.2])
  else ctx.setLineDash([])
  ctx.lineCap = style === 'dotted' ? 'round' : 'butt'
}

/** Paint the scene. Exported for tests: it only needs a 2D context. */
export function paintFar(ctx: CanvasRenderingContext2D, scene: Scene, cam: { x: number; y: number; scale: number }, size: { w: number; h: number }, dpr: number, theme: 'light' | 'dark', dim: ReadonlySet<string>): number {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, size.w * dpr, size.h * dpr)
  ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y)
  const view = viewBox(cam, size.w, size.h)
  const col = (c: string | undefined) => hexColor(c, theme)
  const ink = col('theme:ink')
  let drawn = 0
  for (const it of painted(scene)) {
    const b = aabb(it)
    const pad = (it.style.strokeWidth ?? 0) + 12
    if (!boxesIntersect(view, { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 })) continue
    drawn++
    ctx.globalAlpha = (it.style.opacity ?? 1) * (dim.has(it.id) ? 0.25 : 1)
    if (it.kind === 'connector') {
      const r = routeOf(scene, it)
      const w = it.style.strokeWidth ?? 2
      ctx.strokeStyle = ctx.fillStyle = col(it.style.stroke) === 'transparent' ? ink : col(it.style.stroke)
      ctx.lineWidth = w
      ctx.lineJoin = 'round'
      dash(ctx, it.style.strokeStyle, w)
      ctx.stroke(r.p2d)
      ctx.setLineDash([])
      const ends: Array<[ConnectorItem['startHead'], number, number]> = [
        [it.startHead, 0, r.path.startAngle],
        [it.endHead, r.path.poly.length - 1, r.path.endAngle],
      ]
      for (const [head, at, angle] of ends) {
        const h = headShape(head, r.path.poly[at], angle, w)
        if (h.kind === 'none') continue
        ctx.beginPath()
        if (h.kind === 'dot') {
          ctx.arc(h.center.x, h.center.y, h.r, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.moveTo(h.points[0].x, h.points[0].y)
          ctx.lineTo(h.points[1].x, h.points[1].y)
          ctx.lineTo(h.points[2].x, h.points[2].y)
          if (h.kind === 'filled') ctx.fill()
          ctx.stroke()
        }
      }
      continue
    }
    ctx.save()
    ctx.translate(it.x + it.w / 2, it.y + it.h / 2)
    if (it.rotation) ctx.rotate(it.rotation)
    const x = -it.w / 2
    const y = -it.h / 2
    if (it.kind === 'rectangle' || it.kind === 'ellipse') {
      ctx.beginPath()
      if (it.kind === 'ellipse') ctx.ellipse(0, 0, it.w / 2, it.h / 2, 0, 0, Math.PI * 2)
      else {
        const r = Math.min(it.style.radius ?? 0, it.w / 2, it.h / 2)
        if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, it.w, it.h, r)
        else ctx.rect(x, y, it.w, it.h)
      }
      const fill = col(it.style.fill)
      if (fill !== 'transparent') {
        ctx.fillStyle = fill
        ctx.fill()
      }
      const w = it.style.strokeWidth ?? 0
      const stroke = col(it.style.stroke)
      if (w > 0 && stroke !== 'transparent') {
        ctx.strokeStyle = stroke
        ctx.lineWidth = w
        dash(ctx, it.style.strokeStyle, w)
        ctx.stroke()
        ctx.setLineDash([])
      }
    } else if (it.kind === 'pencil') {
      // From here ink is a line through its points.
      const kx = it.w0 ? it.w / it.w0 : 1
      const ky = it.h0 ? it.h / it.h0 : 1
      ctx.beginPath()
      it.points.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * kx, y + py * ky) : ctx.moveTo(x + px * kx, y + py * ky)))
      if (it.points.length === 1) ctx.lineTo(x + it.points[0][0] * kx + 0.01, y + it.points[0][1] * ky)
      ctx.strokeStyle = col(it.style.stroke) === 'transparent' ? ink : col(it.style.stroke)
      ctx.lineWidth = it.style.strokeWidth ?? 4
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    } else if (it.kind === 'text') {
      ctx.globalAlpha *= 0.25
      ctx.fillStyle = col(it.text.color) === 'transparent' ? ink : col(it.text.color)
      ctx.fillRect(x, y, it.w, it.h)
    } else {
      // A picture, a video, a card: its place, as a soft block.
      ctx.fillStyle = theme === 'dark' ? '#3f3f46' : '#e4e4e7'
      ctx.fillRect(x, y, it.w, it.h)
      ctx.strokeStyle = theme === 'dark' ? '#52525b' : '#d4d4d8'
      ctx.lineWidth = 1 / cam.scale
      ctx.strokeRect(x, y, it.w, it.h)
    }
    ctx.restore()
  }
  ctx.globalAlpha = 1
  return drawn
}

export function FarLayer() {
  const store = useCanvasStore()
  const scene = useCanvas((s) => s.scene)
  const erasing = useCanvas((s) => s.overlay.erasing)
  const ref = React.useRef<HTMLCanvasElement>(null)
  const sceneRef = React.useRef(scene)
  sceneRef.current = scene
  const dimRef = React.useRef<ReadonlySet<string>>(new Set())
  dimRef.current = React.useMemo(() => new Set(erasing), [erasing])
  const pending = React.useRef(0)

  const draw = React.useCallback(() => {
    pending.current = 0
    const el = ref.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const { w, h } = store.viewport
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
    }
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    el.dataset.canvasFarDrawn = String(paintFar(ctx, sceneRef.current, store.camera, { w, h }, dpr, theme, dimRef.current))
  }, [store])
  const request = React.useCallback(() => {
    if (!pending.current) pending.current = requestAnimationFrame(draw)
  }, [draw])

  React.useEffect(() => {
    request()
    const off = store.subscribeCamera(request)
    // The theme can change under it.
    const mo = new MutationObserver(request)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      off()
      mo.disconnect()
      if (pending.current) cancelAnimationFrame(pending.current)
      pending.current = 0
    }
  }, [store, request])
  React.useEffect(request, [request, scene, erasing])

  return <canvas ref={ref} data-canvas-far className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
}
