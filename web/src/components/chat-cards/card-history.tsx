'use client'

/**
 * Back and Forward inside one card in the chat: what a floating window's pair
 * walked before pages became cards (the window-history plan, PR #557), now per
 * card. A card's history lives in the chat's card store, by the card's id
 * (ChatCardStore.history), so a move to full screen and back, a collapse, or
 * the card remounting (one opened during a turn joining the thread) keeps it;
 * a reload starts it again from where the card was left, which the card store
 * keeps.
 *
 * The history is the only store for where the card is: each entry holds a few
 * named channels (the record open inside it, the page's place, the mail
 * folder and thread…), and the body's hooks read their channel from the
 * current entry. A navigation pushes an entry (dropping Forward), Back and
 * Forward move the cursor, and the hooks redraw from the entry they land on.
 * Every channel's change in one event (opening a suite moves the place too)
 * is one step.
 */
import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CARD_HEADER_ICON_BUTTON } from './card-header-button'

/** As many steps as a window kept (MAX_TAB_HISTORY on main). */
export const MAX_CARD_HISTORY = 50

/** Where a card is: one value per channel (the record open inside it, the page's place…). */
type Entry = Record<string, unknown>

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export class CardHistory {
  private entries: Entry[] = [{}]
  private index = 0
  private version = 0
  private listeners = new Set<() => void>()
  /** Pushes in the same task land in one step. */
  private merging = false
  /** How many times Back or Forward changed each channel (see useCardNav's `restored`). */
  private restoredCount = new Map<string, number>()
  /** What writes a channel back to the card store when Back or Forward moves it. */
  private persisters = new Map<string, (value: unknown) => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = () => this.version

  private emit() {
    this.version++
    for (const listener of this.listeners) listener()
  }

  get canGoBack(): boolean {
    return this.index > 0
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1
  }

  /** How many steps the card holds (for tests and the cap). */
  get length(): number {
    return this.entries.length
  }

  /**
   * A channel's value where the card is now. The first read seeds it: every
   * entry before it was made without it, so it held its first value there.
   */
  read<T>(key: string, init: () => T): T {
    const current = this.entries[this.index]
    if (!(key in current)) {
      const value = init()
      for (const entry of this.entries) if (!(key in entry)) entry[key] = value
    }
    return current[key] as T
  }

  /** A navigation: a new step with `key` moved (Forward is dropped). Moving it where it is does nothing. */
  push(key: string, value: unknown) {
    const current = this.entries[this.index]
    if (key in current && same(current[key], value)) return
    if (this.merging && this.index === this.entries.length - 1 && this.index > 0) {
      this.entries[this.index] = { ...current, [key]: value }
    } else {
      const next = [...this.entries.slice(0, this.index + 1), { ...current, [key]: value }]
      this.entries = next.length > MAX_CARD_HISTORY ? next.slice(next.length - MAX_CARD_HISTORY) : next
      this.index = this.entries.length - 1
      this.merging = true
      queueMicrotask(() => {
        this.merging = false
      })
    }
    this.emit()
  }

  /** Back (-1) or Forward (1); false at either end. */
  go(delta: -1 | 1): boolean {
    const target = this.index + delta
    if (target < 0 || target >= this.entries.length) return false
    const from = this.entries[this.index]
    const to = this.entries[target]
    this.index = target
    this.merging = false
    for (const key of Object.keys(to)) {
      if (same(from[key], to[key])) continue
      this.restoredCount.set(key, (this.restoredCount.get(key) ?? 0) + 1)
      this.persisters.get(key)?.(to[key])
    }
    this.emit()
    return true
  }

  restored(key: string): number {
    return this.restoredCount.get(key) ?? 0
  }

  setPersister(key: string, persist: ((value: unknown) => void) | undefined) {
    if (persist) this.persisters.set(key, persist)
    else this.persisters.delete(key)
  }
}

const CardHistoryContext = React.createContext<CardHistory | null>(null)
export const CardHistoryProvider = CardHistoryContext.Provider

export function useCardHistory(): CardHistory | null {
  return React.useContext(CardHistoryContext)
}

/**
 * One channel of the card's place. `value` is where the card is now; `set`
 * navigates (a new step, kept with the card through `persist`); `restored`
 * counts the times Back or Forward moved it, for a page that reads where it
 * opens only once (key it on `restored` and it opens there again).
 *
 * Outside a card (a page drawn on its own, a test) it is plain state.
 * `{ persist: false }` moves it without writing the store (the store moved first).
 */
export function useCardNav<T>(
  key: string,
  init: () => T,
  persist?: (value: T) => void,
): { value: T; set: (value: T, opts?: { persist?: boolean }) => void; get: () => T; restored: number } {
  const history = useCardHistory()
  const [local, setLocal] = React.useState<T>(() => (history ? (undefined as T) : init()))
  const localRef = React.useRef(local)
  localRef.current = local
  const initRef = React.useRef(init)
  initRef.current = init
  React.useSyncExternalStore(history?.subscribe ?? noopSubscribe, history?.getVersion ?? zero, history?.getVersion ?? zero)
  const persistRef = React.useRef(persist)
  persistRef.current = persist
  React.useEffect(() => {
    if (!history) return
    history.setPersister(key, (value) => persistRef.current?.(value as T))
  }, [history, key])
  const set = React.useCallback(
    (value: T, opts?: { persist?: boolean }) => {
      if (history) history.push(key, value)
      else {
        localRef.current = value
        setLocal(value)
      }
      if (opts?.persist !== false) persistRef.current?.(value)
    },
    [history, key],
  )
  // Where it is right now, between renders (a store listener reads it).
  const get = React.useCallback(() => (history ? history.read(key, () => initRef.current()) : localRef.current), [history, key])
  if (!history) return { value: local, set, get, restored: 0 }
  return { value: history.read(key, init), set, get, restored: history.restored(key) }
}

const noopSubscribe = () => () => {}
const zero = () => 0

/**
 * Keeps a channel in step with the card store, for a value written there from
 * outside the card: chat-panel's openCardHere seeds a reused card (a bot's page
 * opened again on one of its items) without a word to it. `stored` says where
 * the store has the channel, given where the card is (undefined: nothing to
 * say). It runs at mount as well as on every store notice: a collapsed card
 * keeps its history but not its body, so a seed written while the body was
 * away becomes a step the moment it mounts, before it paints, and Back returns
 * to where the card was.
 */
export function useCardNavStoreSync<T>(
  store: { subscribe: (listener: () => void) => () => void },
  nav: { get: () => T; set: (value: T, opts?: { persist?: boolean }) => void },
  stored: (current: T) => T | undefined,
) {
  const storedRef = React.useRef(stored)
  storedRef.current = stored
  const { get, set } = nav
  // The history's own subscription starts after paint (a passive effect): the
  // step made at mount redraws this component itself, before the paint.
  const [, redraw] = React.useReducer((n: number) => n + 1, 0)
  React.useLayoutEffect(() => {
    const sync = () => {
      const current = get()
      const next = storedRef.current(current)
      if (next === undefined || same(next, current)) return
      // The store has it already.
      set(next, { persist: false })
      redraw()
    }
    sync()
    return store.subscribe(sync)
  }, [store, get, set])
}

/** The card a node is in (its inline frame or its full-screen layer), to hold the focus. */
export function cardFrameOf(node: Element | null): HTMLElement | null {
  return (node?.closest('[data-chat-card], [data-chat-card-fullscreen]') as HTMLElement | null) ?? null
}

/**
 * The card header's Back and Forward: the same pair, icons, labels and
 * tooltips a window's header had (window-history.tsx on main), bound to this
 * card's history.
 */
export function CardHistoryButtons({ history }: { history: CardHistory }) {
  React.useSyncExternalStore(history.subscribe, history.getVersion, history.getVersion)
  const groupRef = React.useRef<HTMLDivElement>(null)
  // A button the step disabled while it had the focus (Back pressed to the
  // first step) would drop the focus to <body>, and ⌘/Ctrl+[ with it: it goes
  // to the other button, or to the card's frame when both are off.
  React.useLayoutEffect(() => {
    const buttons = Array.from(groupRef.current?.querySelectorAll('button') ?? [])
    const active = document.activeElement
    const stuck = buttons.find((b) => b === active && b.disabled)
    if (!stuck) return
    const other = buttons.find((b) => b !== stuck && !b.disabled)
    ;(other ?? cardFrameOf(stuck))?.focus({ preventScroll: true })
  })
  return (
    <div ref={groupRef} className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Card history">
      {([-1, 1] as const).map((delta) => {
        const back = delta === -1
        const Icon = back ? ChevronLeft : ChevronRight
        const label = back ? 'Go back' : 'Go forward'
        return (
          <button
            key={delta}
            type="button"
            aria-label={label}
            data-testid={back ? 'card-back' : 'card-forward'}
            title={`${label} (${back ? '⌘/Ctrl+[' : '⌘/Ctrl+]'})`}
            disabled={back ? !history.canGoBack : !history.canGoForward}
            onClick={() => history.go(delta)}
            className={`flex size-7 shrink-0 items-center justify-center ${CARD_HEADER_ICON_BUTTON} disabled:opacity-30 disabled:hover:bg-transparent`}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

/**
 * ⌘/Ctrl+[ and ⌘/Ctrl+] for one card: the one the focus is in, or the one
 * full screen when the focus is in no other card. The Shift variants are the
 * tab bar's (previous/next chat), so a Shift chord is never ours; an ⌥ chord
 * belongs to the OS.
 */
export function cardOwnsHistoryKeys(card: { elements: Array<HTMLElement | null>; fullScreen: boolean }): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (active && card.elements.some((el) => el?.contains(active))) return true
  if (!card.fullScreen) return false
  return !(active instanceof Element && active.closest('[data-chat-card], [data-chat-card-fullscreen]'))
}

export function isHistoryKey(e: KeyboardEvent): -1 | 1 | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null
  if (e.key === '[') return -1
  if (e.key === ']') return 1
  return null
}
