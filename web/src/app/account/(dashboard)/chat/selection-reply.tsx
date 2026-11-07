'use client'

/**
 * Reply to exactly the words selected (Liam, 2026-10-20: "reply to specific
 * lines from the agent's conversation"): select some of an agent message's
 * words in the thread and a Reply pill comes up over them; pressing it puts
 * those words in the composer's Reply chip, in quotation marks
 * (message-reply.ts, `part: true`), the pill flying into it.
 *
 * One listener for the whole thread (`selectionchange`, read once it settles
 * for SETTLE_MS: a timer, not a frame, so a window drawn in the background
 * still reads it), shown only once the pointer is up, so dragging a
 * selection never chases it. Only a selection inside one agent message's bubbles counts: across two
 * messages, in the person's own, or anywhere else, nothing shows. It goes
 * when the selection does, and on any scroll (the words moved).
 */
import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Reply } from 'lucide-react'
import { clipQuote } from '@/lib/chat/message-reply'
import { MessageInteractionsContext } from './message-interactions'

interface Picked {
  messageId: string
  text: string
  /** Where the pill goes (viewport px): over the selection's middle, or under it near the window's top. */
  left: number
  top: number
}

/** How long a selection holds still before it is read (ms). */
const SETTLE_MS = 60

/** The pill's height and its gap from the words (px). */
const PILL_H = 32
const PILL_GAP = 8

/** The agent message `node` sits in a bubble of, as its row (chat-message-list.tsx), or null. */
function bubbleRow(node: Node | null, thread: HTMLElement): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement
  if (!el?.closest('.chat-message-bubble')) return null
  const row = el.closest<HTMLElement>('[data-message-row]')
  return row && thread.contains(row) && row.dataset.messageRole === 'assistant' ? row : null
}

/** What the selection picks out of one agent message in `thread`, or null. */
function pickedIn(thread: HTMLElement): Picked | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const row = bubbleRow(sel.anchorNode, thread)
  if (!row || bubbleRow(sel.focusNode, thread) !== row) return null
  const text = clipQuote(sel.toString())
  if (!text) return null
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (rect.width < 1 && rect.height < 1) return null
  const above = rect.top - PILL_H - PILL_GAP
  return {
    messageId: row.dataset.messageRow ?? '',
    text,
    left: Math.min(window.innerWidth - 56, Math.max(56, rect.left + rect.width / 2)),
    top: above >= 8 ? above : rect.bottom + PILL_GAP,
  }
}

export function SelectionReply({ thread }: { thread: HTMLElement | null }) {
  const interactions = useContext(MessageInteractionsContext)
  const [picked, setPicked] = useState<Picked | null>(null)
  const pillRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!thread || !interactions) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let pointerDown = false
    const read = () => {
      timer = null
      setPicked(pointerDown ? null : pickedIn(thread))
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(read, SETTLE_MS)
    }
    const onDown = (e: PointerEvent) => {
      if (pillRef.current?.contains(e.target as Node)) return
      pointerDown = true
      setPicked(null)
    }
    const onUp = () => {
      if (!pointerDown) return
      pointerDown = false
      schedule()
    }
    const onScroll = () => setPicked(null)
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerdown', onDown, { passive: true })
    document.addEventListener('pointerup', onUp, { passive: true })
    // The thread's scroller (its parent) moves the words; capture catches it from here.
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [thread, interactions])

  if (!picked || !interactions || typeof document === 'undefined') return null
  return createPortal(
    <button
      ref={pillRef}
      type="button"
      data-selection-reply=""
      // A press must not take the selection away before the click reads it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        interactions.reply({ messageId: picked.messageId, role: 'assistant', quote: picked.text, part: true, selected: true }, pillRef.current)
        window.getSelection()?.removeAllRanges()
        setPicked(null)
      }}
      style={{ left: picked.left, top: picked.top }}
      className="ph-no-capture fixed z-[55] flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/70 bg-background/90 px-3 text-[13px] font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur-xl transition-colors animate-in fade-in-0 zoom-in-95 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-white/10"
    >
      <Reply className="h-3.5 w-3.5" />
      Reply
    </button>,
    document.body,
  )
}
