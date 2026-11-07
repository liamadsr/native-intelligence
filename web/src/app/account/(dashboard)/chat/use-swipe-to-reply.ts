'use client'

/**
 * Swipe a message to the right to reply to it (Liam, 2026-10-20: "kind of
 * like iMessage how you slide to the right and you apply reply"): a
 * trackpad's sideways two-finger swipe, or a finger on a touch screen. The
 * message follows, a reply arrow coming up in the space it leaves; past
 * SWIPE_REPLY_PX the arrow pops, and letting go there replies
 * (message-reply.ts) to that bubble. Only the bubble moves (Liam, 10-20: "I
 * just want the message to swipe", not the tool steps around it: a turn draws
 * several bubbles, message-bubbles.ts), with its reaction under it and the
 * toolbar over it when it is on that bubble (message-toolbar.tsx; left behind,
 * it "looks weird"), and the arrow comes up beside it, at its middle, clear of
 * the time in the gutter. A swipe that starts on a tool step, or anywhere but a bubble, is
 * none. Short of the threshold, the bubble slides back and nothing happens.
 *
 * One listener of each kind on the thread, whatever its length: a wheel
 * listener (passive: it never holds the page's scroll) and the pointer
 * events of a touch. The bubble moves by its style alone, no render per frame,
 * and the arrow is an element added for the swipe and gone after it. A
 * swipe that starts in something that scrolls sideways itself (a code block,
 * a wide table) is that thing's, never a reply. The thread's scroller keeps
 * sideways overscroll to itself (`overscroll-x-none`, chat-panel.tsx), so the
 * browser's "back" swipe never fires under it.
 */
import { useEffect } from 'react'

/** How far the message must go for letting go to reply (px). */
export const SWIPE_REPLY_PX = 56
/** The farthest it goes (px), with some give past SWIPE_REPLY_PX. */
const SWIPE_MAX_PX = 84
/** The give past SWIPE_REPLY_PX: each px of swipe moves it this much. */
const SWIPE_GIVE = 0.35
/** A trackpad swipe has ended when no wheel event came for this long (ms). */
const WHEEL_END_MS = 140
/** After one ends, the trackpad's momentum tail is ignored for this long (ms). */
const WHEEL_COOLDOWN_MS = 450
/** A finger has to go this far sideways, mostly sideways, before it is a swipe (px). */
const TOUCH_SLOP_PX = 10

/** How far the message shows for `dx` of swipe: 1:1 up to the threshold, then with give, to the max. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0
  if (dx <= SWIPE_REPLY_PX) return dx
  return Math.min(SWIPE_MAX_PX, SWIPE_REPLY_PX + (dx - SWIPE_REPLY_PX) * SWIPE_GIVE)
}

/** True when something between `target` and `row` scrolls sideways itself (the swipe is its). */
function scrollsSideways(target: EventTarget | null, row: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== row; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth + 1) continue
    const overflow = getComputedStyle(el).overflowX
    if (overflow === 'auto' || overflow === 'scroll') return true
  }
  return false
}

/** The agent's message row `target` is in, in `thread`: what a swipe replies to (the person's own aren't swiped). */
function replyRow(target: EventTarget | null, thread: HTMLElement): HTMLElement | null {
  const row = target instanceof Element ? target.closest<HTMLElement>('[data-message-row]') : null
  return row && thread.contains(row) && row.dataset.messageRole === 'assistant' ? row : null
}

const ARROW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>'

/** Something that moves with the bubble, and the transform it has of its own (the toolbar's place). */
interface Mover {
  el: HTMLElement
  base: string
}

interface Swipe {
  row: HTMLElement
  /** The bubble it started on: what moves, with its reaction and toolbar (`moving`). */
  bubble: HTMLElement
  moving: Mover[]
  arrow: HTMLElement
  dx: number
  armed: boolean
}

/** The bubble `target` is in, in `row`, or null (a tool step, the gap between bubbles). */
function bubbleOf(target: EventTarget | null, row: HTMLElement): HTMLElement | null {
  const bubble = target instanceof Element ? target.closest<HTMLElement>('.chat-message-bubble') : null
  return bubble && row.contains(bubble) ? bubble : null
}

/** The arrow's size (px): it centres on the bubble's left edge, and on its middle. */
const ARROW_PX = 28

function startSwipe(row: HTMLElement, bubble: HTMLElement): Swipe {
  const arrow = document.createElement('span')
  arrow.setAttribute('aria-hidden', 'true')
  arrow.setAttribute('data-swipe-reply-arrow', '')
  arrow.innerHTML = ARROW_SVG
  // The reply arrow in the sky's ink (the line the thread's hooks use), round, beside the bubble.
  arrow.className =
    'pointer-events-none absolute flex h-7 w-7 items-center justify-center rounded-full bg-[hsl(var(--sky-ink)/0.1)] text-[hsl(var(--sky-ink)/0.75)]'
  // In the bubble's own frame (its column: chat-message.tsx), at its left edge and its middle.
  arrow.style.left = `${bubble.offsetLeft - ARROW_PX / 2}px`
  arrow.style.top = `${bubble.offsetTop + bubble.offsetHeight / 2 - ARROW_PX / 2}px`
  arrow.style.opacity = '0'
  bubble.parentElement?.append(arrow)
  // Its reaction rides with it (message-reaction-controls.tsx ReactionBadge, its next sibling),
  // and so does the toolbar when it is on this bubble (chat-message.tsx placeToolbar: data-bubble).
  const badge = bubble.nextElementSibling instanceof HTMLElement && bubble.nextElementSibling.hasAttribute('data-message-reaction') ? bubble.nextElementSibling : null
  const toolbar = row.querySelector<HTMLElement>('[data-message-toolbar]')
  const index = [...row.querySelectorAll('.chat-message-bubble')].indexOf(bubble)
  const onThis = toolbar && toolbar.dataset.bubble === String(index) ? toolbar : null
  const moving = [bubble, badge, onThis].filter((el): el is HTMLElement => !!el).map((el) => ({ el, base: el.style.transform }))
  for (const { el } of moving) el.style.willChange = 'transform'
  return { row, bubble, moving, arrow, dx: 0, armed: false }
}

function moveSwipe(s: Swipe, dx: number): void {
  s.dx = Math.max(0, dx)
  const x = swipeOffset(s.dx)
  for (const { el, base } of s.moving) el.style.transform = x ? `${base} translateX(${x}px)`.trim() : base
  const p = Math.min(1, x / SWIPE_REPLY_PX)
  // In the space the bubble leaves: its middle, as the bubble moves.
  s.arrow.style.transform = `translateX(${x / 2}px) scale(${0.5 + p * 0.5})`
  s.arrow.style.opacity = String(p)
  const armed = x >= SWIPE_REPLY_PX
  if (armed && !s.armed && typeof s.arrow.animate === 'function') {
    // It pops as it arms, so the person knows letting go now replies.
    s.arrow.animate([{ scale: '1' }, { scale: '1.25' }, { scale: '1' }], { duration: 220, easing: 'ease-out' })
  }
  s.armed = armed
}

/** The swipe let go: the bubble slides back (springing), the arrow goes, and true when it was armed. */
function endSwipe(s: Swipe): boolean {
  const { moving, arrow, armed } = s
  arrow.remove()
  for (const { el, base } of moving) {
    const from = el.style.transform
    el.style.transform = base
    el.style.willChange = ''
    if (from !== base && typeof el.animate === 'function') {
      el.animate([{ transform: from }, { transform: `${base} translateX(-3px)`.trim(), offset: 0.7 }, { transform: base || 'none' }], {
        duration: 280,
        easing: 'cubic-bezier(0.2, 0, 0.2, 1)',
      })
    }
  }
  return armed
}

/**
 * Swipe-to-reply on the bubbles of `thread`'s rows of the agent's messages
 * (`[data-message-row]` with `data-message-role="assistant"`): `onReply(row,
 * bubble)` when one is let go armed. Off while `enabled` is false.
 */
export function useSwipeToReply(thread: HTMLElement | null, onReply: (row: HTMLElement, bubble: HTMLElement) => void, enabled: boolean): void {
  useEffect(() => {
    if (!thread || !enabled) return
    let wheel: Swipe | null = null
    let wheelTimer: ReturnType<typeof setTimeout> | null = null
    let cooldownUntil = 0

    const finishWheel = () => {
      wheelTimer = null
      const s = wheel
      wheel = null
      if (!s) return
      cooldownUntil = performance.now() + WHEEL_COOLDOWN_MS
      if (endSwipe(s)) onReply(s.row, s.bubble)
    }

    const onWheel = (e: WheelEvent) => {
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (!wheel) {
        if (!sideways || e.deltaX === 0 || performance.now() < cooldownUntil || e.ctrlKey) return
        const row = replyRow(e.target, thread)
        const bubble = row ? bubbleOf(e.target, row) : null
        if (!row || !bubble || scrollsSideways(e.target, row)) return
        wheel = startSwipe(row, bubble)
      }
      // Natural scrolling (macOS's default): fingers right give a negative deltaX.
      // WebKit says when it isn't inverted; the rest assume it is.
      const inverted = (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice
      const delta = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX
      if (sideways) moveSwipe(wheel, wheel.dx + (inverted === false ? delta : -delta))
      if (wheelTimer) clearTimeout(wheelTimer)
      wheelTimer = setTimeout(finishWheel, WHEEL_END_MS)
    }

    // A finger: tracked from its press, a swipe once it goes far enough sideways.
    let touch: { id: number; x: number; y: number; row: HTMLElement; bubble: HTMLElement; swipe: Swipe | null } | null = null
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || touch) return
      const row = replyRow(e.target, thread)
      const bubble = row ? bubbleOf(e.target, row) : null
      if (!row || !bubble || scrollsSideways(e.target, row)) return
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY, row, bubble, swipe: null }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return
      const dx = e.clientX - touch.x
      const dy = e.clientY - touch.y
      if (!touch.swipe) {
        if (Math.abs(dy) > TOUCH_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
          touch = null
          return
        }
        if (dx < TOUCH_SLOP_PX || dx < Math.abs(dy) * 1.5) return
        touch.swipe = startSwipe(touch.row, touch.bubble)
      }
      moveSwipe(touch.swipe, dx - TOUCH_SLOP_PX)
    }
    const onPointerEnd = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return
      const { swipe, row, bubble } = touch
      touch = null
      if (swipe && endSwipe(swipe) && e.type === 'pointerup') onReply(row, bubble)
    }

    thread.addEventListener('wheel', onWheel, { passive: true })
    thread.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerEnd, { passive: true })
    window.addEventListener('pointercancel', onPointerEnd, { passive: true })
    return () => {
      thread.removeEventListener('wheel', onWheel)
      thread.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      if (wheelTimer) clearTimeout(wheelTimer)
      if (wheel) endSwipe(wheel)
      if (touch?.swipe) endSwipe(touch.swipe)
    }
  }, [thread, onReply, enabled])
}
