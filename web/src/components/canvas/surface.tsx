'use client'

/**
 * The canvas surface: the dot grid, the camera's layer with the items in it,
 * and the pointer, wheel and key events turned into plain inputs for
 * `Interaction`. Panning and zooming move one transformed layer; React draws
 * nothing for them until the view nears the edge of what is mounted.
 */
import * as React from 'react'
import type { CanvasItem } from '@/lib/canvas/types'
import { gridLevels, wheelZoom } from '@/lib/canvas/engine/camera'
import { aabb, boxesIntersect } from '@/lib/canvas/engine/geometry'
import { painted } from '@/lib/canvas/engine/scene'
import { cn } from '@/lib/utils'
import type { Interaction, PointerInput } from './interaction'
import { FarLayer, useFarMode } from './far-layer'
import { ItemView } from './item-view'
import { SelectionOverlay } from './selection-overlay'
import { TextEditor } from './text-editor'
import { useCanvas, useCanvasStore } from './use-canvas'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Did this event physically land on the canvas itself? Not on its floating
 * chrome (toolbar, inspector, header), and not in a menu or popover: those
 * are drawn elsewhere in the page, but React hands their events up to the
 * canvas component as if they were inside it.
 */
function onCanvas(e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const target = e.target as HTMLElement | null
  const root = e.currentTarget as HTMLElement | null
  if (!target || !root || typeof target.closest !== 'function') return false
  return root.contains(target) && !target.closest('[data-canvas-chrome]')
}

/** Is the event's target somewhere keys should be left alone (a field, an editor)? */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

function ItemsLayer({ onMeasure }: { onMeasure: (id: string, w: number, h: number) => void }) {
  const scene = useCanvas((s) => s.scene)
  const cull = useCanvas((s) => s.cull)
  const erasing = useCanvas((s) => s.overlay.erasing)
  const editing = useCanvas((s) => s.editing)
  const far = useCanvas((s) => s.far)
  const list = React.useMemo(() => {
    const all = painted(scene)
    if (!cull) return all
    return all.filter((it) => {
      const b = aabb(it)
      const pad = (it.style.strokeWidth ?? 0) + 16
      return boxesIntersect(cull, { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 })
    })
  }, [scene, cull])
  const dim = React.useMemo(() => new Set(erasing), [erasing])
  return (
    <>
      {list.map((item: CanvasItem) => (
        <ItemView
          key={item.id}
          item={item}
          startTarget={item.kind === 'connector' && item.start.bind ? scene.items[item.start.bind.id] : undefined}
          endTarget={item.kind === 'connector' && item.end.bind ? scene.items[item.end.bind.id] : undefined}
          dim={dim.has(item.id)}
          editing={editing === item.id}
          far={far}
          onMeasure={item.kind === 'text' ? onMeasure : undefined}
        />
      ))}
    </>
  )
}

export function CanvasSurface({ interaction, className, children }: { interaction: Interaction; className?: string; children?: React.ReactNode }) {
  const store = useCanvasStore()
  const rootRef = React.useRef<HTMLDivElement>(null)
  const worldRef = React.useRef<HTMLDivElement>(null)
  const gridRef = React.useRef<HTMLDivElement>(null)
  const grid = useCanvas((s) => s.prefs.grid)
  const editing = useCanvas((s) => s.editing)
  const scene = useCanvas((s) => s.scene)
  const editingItem = editing ? scene.items[editing] : undefined
  const farMode = useFarMode()

  // The camera, applied straight to the DOM.
  const lastScale = React.useRef(1)
  const settle = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const paint = React.useCallback(() => {
    const cam = store.camera
    const world = worldRef.current
    if (world) {
      // A pan at one zoom moves the layer as an image the browser already has;
      // when it stops (or the zoom changes) the layer is drawn afresh, so it is never blurred.
      if (cam.scale === lastScale.current) {
        world.style.willChange = 'transform'
        if (settle.current) clearTimeout(settle.current)
        settle.current = setTimeout(() => {
          if (worldRef.current) worldRef.current.style.willChange = ''
        }, 180)
      } else world.style.willChange = ''
      lastScale.current = cam.scale
      world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`
    }
    const g = gridRef.current
    if (g) {
      if (!store.getState().prefs.grid) {
        g.style.backgroundImage = 'none'
        return
      }
      const levels = gridLevels(cam.scale)
      g.style.backgroundImage = levels.map((l) => `radial-gradient(circle, hsl(var(--foreground) / ${(0.22 * l.opacity).toFixed(3)}) 1px, transparent 1.2px)`).join(', ')
      g.style.backgroundSize = levels.map((l) => `${l.step * cam.scale}px ${l.step * cam.scale}px`).join(', ')
      // A dot sits on each grid point: the tile is centered on the point.
      g.style.backgroundPosition = levels.map((l) => `${cam.x - (l.step * cam.scale) / 2}px ${cam.y - (l.step * cam.scale) / 2}px`).join(', ')
    }
  }, [store])

  React.useLayoutEffect(() => {
    paint()
    return store.subscribeCamera(paint)
  }, [store, paint])
  React.useLayoutEffect(paint, [paint, grid])

  // The view's size.
  React.useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => store.setViewport(el.clientWidth, el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [store])

  const input = React.useCallback((e: { clientX: number; clientY: number; button: number; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; pressure?: number; pointerType?: string }): PointerInput => {
    const rect = rootRef.current!.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: isMac ? e.metaKey : e.ctrlKey,
      pressure: e.pressure ?? 0.5,
      pointerType: e.pointerType ?? 'mouse',
    }
  }, [])

  // Fingers on the glass: two of them pan and pinch in every tool; one belongs to the tool.
  const touches = React.useRef(new Map<number, { x: number; y: number }>())
  const pinch = React.useRef<{ mid: { x: number; y: number }; dist: number } | null>(null)
  const twoFingers = (): { mid: { x: number; y: number }; dist: number } | null => {
    const pts = [...touches.current.values()]
    if (pts.length < 2) return null
    const rect = rootRef.current!.getBoundingClientRect()
    return {
      mid: { x: (pts[0].x + pts[1].x) / 2 - rect.left, y: (pts[0].y + pts[1].y) / 2 - rect.top },
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
    }
  }

  const setCursor = React.useCallback(
    (e: { x: number; y: number }) => {
      if (rootRef.current) rootRef.current.style.cursor = interaction.cursor(e)
    },
    [interaction],
  )

  // The wheel: Ctrl/Cmd zooms about the pointer; plain pans. Not passive, so the page behind never scrolls or zooms.
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-canvas-chrome]')) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      if (e.ctrlKey || e.metaKey) store.setCamera(wheelZoom(store.camera, at, e.deltaY * unit))
      else if (e.shiftKey && !e.deltaX) store.pan(-e.deltaY * unit, 0)
      else store.pan(-e.deltaX * unit, -e.deltaY * unit)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [store])

  // Keys: only while the canvas has the focus and nobody is typing.
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const mine = (e: KeyboardEvent) => !isTyping(e.target) && (el.contains(document.activeElement) || document.activeElement === document.body) && !e.defaultPrevented
    const onDown = (e: KeyboardEvent) => {
      if (!mine(e)) return
      const used = interaction.keyDown({ key: e.key, shift: e.shiftKey, alt: e.altKey, mod: isMac ? e.metaKey : e.ctrlKey, repeat: e.repeat })
      if (used) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onUp = (e: KeyboardEvent) => interaction.keyUp({ key: e.key, shift: e.shiftKey, alt: e.altKey, mod: isMac ? e.metaKey : e.ctrlKey })
    const onBlur = () => {
      interaction.spaceHeld = false
      interaction.cancel()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [interaction])

  const onMeasure = React.useCallback(
    (id: string, w: number, h: number) => {
      const it = store.getState().scene.items[id]
      if (it && it.kind === 'text') store.adjust([{ ...it, w, h }])
    },
    [store],
  )

  return (
    <div
      ref={rootRef}
      data-canvas-surface
      tabIndex={0}
      className={cn('relative h-full w-full touch-none select-none overflow-hidden outline-none', className)}
      onPointerDown={(e) => {
        if (!onCanvas(e)) return
        const el = e.currentTarget
        if (document.activeElement !== el && !isTyping(e.target)) el.focus({ preventScroll: true })
        if (e.button === 1) e.preventDefault()
        if (e.pointerType === 'touch') {
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (touches.current.size >= 2) {
            // A second finger: whatever the first one started is dropped, with nothing left behind.
            interaction.cancel()
            pinch.current = twoFingers()
            return
          }
        }
        const inp = input(e)
        interaction.pointerDown(inp)
        if (interaction.active) el.setPointerCapture(e.pointerId)
        setCursor(inp)
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const now = twoFingers()
          if (now && pinch.current) {
            const was = pinch.current
            store.pan(now.mid.x - was.mid.x, now.mid.y - was.mid.y)
            if (was.dist > 0 && now.dist > 0) store.zoomTo(store.camera.scale * (now.dist / was.dist), now.mid)
            pinch.current = now
            return
          }
        }
        const inp = input(e)
        if (interaction.active) {
          // A pen or a fast mouse reports more points than frames: take them all for ink.
          const native = e.nativeEvent as PointerEvent
          const more = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
          if (more.length > 1 && store.getState().tool === 'pencil') for (const m of more) interaction.pointerMove(input({ ...inp, clientX: m.clientX, clientY: m.clientY, button: 0, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, pressure: m.pressure, pointerType: m.pointerType }))
          else interaction.pointerMove(inp)
        } else if (onCanvas(e)) {
          interaction.hover(inp)
          setCursor(inp)
        }
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'touch') {
          touches.current.delete(e.pointerId)
          if (pinch.current) {
            if (touches.current.size < 2) pinch.current = null
            return
          }
        }
        if (!interaction.active) return
        const inp = input(e)
        interaction.pointerUp(inp)
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        setCursor(inp)
      }}
      onPointerCancel={(e) => {
        touches.current.delete(e.pointerId)
        if (touches.current.size < 2) pinch.current = null
        interaction.cancel()
      }}
      onContextMenu={(e) => {
        // A long press opens the menu too: it takes what is under the finger first, as a right-click does.
        if (!onCanvas(e)) return
        interaction.cancel()
        interaction.contextAt(input({ ...e, button: 2, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }))
      }}
      onDoubleClick={(e) => {
        if (!onCanvas(e)) return
        interaction.doubleClick(input({ ...e, button: 0, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }))
      }}
      onAuxClick={(e) => {
        // No middle-click paste or autoscroll on the canvas.
        if (e.button === 1) e.preventDefault()
      }}
    >
      <div ref={gridRef} data-canvas-grid className="pointer-events-none absolute inset-0" />
      {farMode ? <FarLayer /> : null}
      <div ref={worldRef} data-canvas-world className="absolute left-0 top-0 h-0 w-0" style={{ transformOrigin: '0 0' }}>
        {farMode ? null : <ItemsLayer onMeasure={onMeasure} />}
        {editingItem ? <TextEditor key={editingItem.id} item={editingItem} scene={scene} onFinish={(plain) => {
              interaction.finishEditing(plain)
              // Back to the canvas, so the next key is a shortcut again.
              rootRef.current?.focus({ preventScroll: true })
            }}
          /> : null}
      </div>
      <SelectionOverlay />
      {children}
    </div>
  )
}
