'use client'

/**
 * The empty main chat's rotating placeholder (Liam, 2026-10-09): the default
 * hint ("@ to mention") for 3 s, then one of the
 * first-run starters (lib/chat/starters.ts), led by a small "Tab" keycap, for 5 s
 * (time to read it and press Tab), then the hint again, then the next
 * starter, and so on, with a calm ~300 ms crossfade between. Tab while a starter
 * shows types it out and sends it (ChatInput).
 *
 * A native placeholder can't animate, so this is an overlay laid exactly where
 * the textarea's placeholder sits: its box and type are copied from the
 * textarea's computed style (padding, font, line height, letter spacing), so
 * the text lands on the same pixels. While it draws, the textarea has no
 * native placeholder at all (ChatInput passes `placeholder=""`) and carries
 * the default hint as `aria-placeholder`, so there is only ever ONE visible
 * line and screen readers still get the hint. The overlay draws the hint
 * itself between suggestions, and is aria-hidden: rotations are never
 * announced.
 *
 * Cost: one setTimeout, alive only while the box is empty (ChatInput mounts
 * this only then), it is active and the document is visible.
 * Nothing per frame: the crossfade is a CSS opacity transition between two
 * stacked layers (none under prefers-reduced-motion), and only this small
 * component re-renders on a rotation, never the composer.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MutableRefObject, type RefObject } from 'react'

/** How long the default hint stays between suggestions. */
export const HINT_HOLD_MS = 3000
/** How long each suggestion stays (time to read it and press Tab). */
export const SUGGESTION_HOLD_MS = 5000
/** PromptInputTextarea's own rule: no placeholder in a field narrower than this. */
const PLACEHOLDER_MIN_WIDTH = 220

/** A shuffled copy (Fisher–Yates). */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The order suggestions come up in: shuffled, none repeated until every one
 * has shown, then a fresh shuffle (never starting on the one just shown). A
 * new list starts a new deck. Lives as long as the composer, so typing and
 * clearing the box moves on to a new suggestion rather than replaying.
 */
export interface SuggestionDeck {
  next(list: readonly string[]): string | null
}

export function createSuggestionDeck(random: () => number = Math.random): SuggestionDeck {
  let key: string | null = null
  let order: string[] = []
  let index = 0
  let last: string | null = null
  return {
    next(list) {
      if (list.length === 0) return null
      const listKey = list.join('\n')
      if (listKey !== key) {
        key = listKey
        order = []
        index = 0
      }
      if (index >= order.length) {
        order = shuffled(list, random)
        if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1], order[0]]
        index = 0
      }
      last = order[index++]
      return last
    },
  }
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const documentVisible = () => document.visibilityState !== 'hidden'
const serverVisible = () => true

/** Whether the person asked for less motion (read when it matters, not subscribed). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

interface FieldBox {
  /** Wide enough for a placeholder at all (as PromptInputTextarea). */
  wide: boolean
  /** The textarea's content box and type, for the overlay to sit on it exactly. */
  style: CSSProperties
  /** One line's height (the line box the placeholder text sits in). */
  lineHeight: string
}

/**
 * The textarea's placement and type, read from its computed style on mount and
 * whenever it resizes (no per-frame work), so the overlay's text sits exactly
 * where the native placeholder's did, whatever the breakpoint or theme.
 */
function useFieldBox(hostRef: RefObject<HTMLElement | null>): FieldBox | null {
  const [box, setBox] = useState<FieldBox | null>(null)
  useEffect(() => {
    const field = hostRef.current?.querySelector('textarea')
    if (!field) return
    let lastKey = ''
    const update = () => {
      const cs = getComputedStyle(field)
      const lineHeight = cs.lineHeight && cs.lineHeight !== 'normal' ? cs.lineHeight : '1.25rem'
      const next: FieldBox = {
        wide: field.clientWidth >= PLACEHOLDER_MIN_WIDTH,
        lineHeight,
        style: {
          left: field.offsetLeft + (parseFloat(cs.borderLeftWidth) || 0),
          top: field.offsetTop + (parseFloat(cs.borderTopWidth) || 0),
          width: field.clientWidth,
          paddingLeft: cs.paddingLeft,
          paddingRight: cs.paddingRight,
          paddingTop: cs.paddingTop,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          letterSpacing: cs.letterSpacing,
          lineHeight,
        },
      }
      const key = JSON.stringify(next)
      if (key === lastKey) return
      lastKey = key
      setBox(next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(field)
    return () => observer.disconnect()
  }, [hostRef])
  return box
}

/** Two stacked layers, the front one opaque: a change writes the back one and swaps (the crossfade). */
interface Layers {
  texts: [string | null, string | null]
  front: 0 | 1
}
const RESET_LAYERS: Layers = { texts: [null, null], front: 0 }

export function ComposerSuggestionOverlay({
  hint,
  suggestions,
  deck,
  active,
  currentRef,
  hostRef,
}: {
  /** The default hint (the textarea's own placeholder). */
  hint: string
  /** The gated starter prompts. */
  suggestions: readonly string[]
  deck: SuggestionDeck
  /** The composer's tab is the visible, active one (ChatInput's isActive). */
  active: boolean
  /** The suggestion showing right now, or null on the hint: what Tab accepts. */
  currentRef: MutableRefObject<string | null>
  /** The textarea's host: the overlay is measured and placed against it. */
  hostRef: RefObject<HTMLElement | null>
}) {
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, serverVisible)
  const box = useFieldBox(hostRef)
  const wide = box?.wide ?? true
  const running = active && visible && wide
  const [layers, setLayers] = useState<Layers>(RESET_LAYERS)
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  const listKey = suggestions.join('\n')

  useEffect(() => {
    // Every (re)start begins on the hint: after a pause, or a new list.
    setLayers(RESET_LAYERS)
    currentRef.current = null
    if (!running) return
    let onSuggestion = false
    let timer: ReturnType<typeof setTimeout>
    const step = () => {
      onSuggestion = !onSuggestion
      const next = onSuggestion ? deck.next(suggestionsRef.current) : null
      currentRef.current = next
      setLayers((prev) => {
        const back: 0 | 1 = prev.front === 0 ? 1 : 0
        const texts: [string | null, string | null] = [...prev.texts]
        texts[back] = next
        return { texts, front: back }
      })
      timer = setTimeout(step, onSuggestion ? SUGGESTION_HOLD_MS : HINT_HOLD_MS)
    }
    timer = setTimeout(step, HINT_HOLD_MS)
    return () => {
      clearTimeout(timer)
      currentRef.current = null
    }
  }, [running, listKey, deck, currentRef])

  if (!wide) return null
  return (
    <div
      aria-hidden
      data-composer-suggestions
      // Until the first measure, the textarea's own classes (its host's px-1,
      // then its px-3 py-1.5 and type); then its computed box exactly.
      className="pointer-events-none absolute inset-x-1 top-0 select-none px-3 py-1.5 text-base text-muted-foreground md:text-sm"
      style={box ? { ...box.style, right: 'auto' } : undefined}
    >
      <div className="relative" style={{ height: box?.lineHeight ?? '1.25rem' }}>
        {layers.texts.map((text, i) => (
          <div
            key={i}
            data-composer-suggestion-layer={i === layers.front ? 'front' : 'back'}
            className="absolute inset-0 flex min-w-0 items-center gap-2 whitespace-nowrap transition-opacity duration-300 ease-in-out motion-reduce:transition-none"
            style={{ opacity: i === layers.front ? 1 : 0 }}
          >
            {text === null ? (
              <span className="truncate">{hint}</span>
            ) : (
              // The keycap leads, its left edge on the hint's first letter
              // (both start at the field's own padding), then the suggestion.
              // A hairline of the text colour at 10%: as faint in dark as in
              // light (the border token at 60% vanishes on light's white).
              <>
                <kbd className="shrink-0 rounded-[5px] border border-foreground/10 px-1 font-sans text-[10px] font-medium leading-4 tracking-normal text-muted-foreground/80">
                  Tab
                </kbd>
                <span data-composer-suggestion className="min-w-0 truncate">
                  {text}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
