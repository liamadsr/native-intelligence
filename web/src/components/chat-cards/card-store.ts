/**
 * The cards in one chat (docs/plans/one-agent-and-chat-pages.md, "The card"):
 * which show cards the conversation holds and their numbers, which are live,
 * which one is full screen, and what each shows the person now.
 *
 * The chat panel owns one store and feeds it the conversation's show results
 * (setCards). The cards read their state from it and report what they show
 * back to it; the transport asks it for the turn's card context
 * (contextEntries) at send time, so a send always carries what the person is
 * looking at that moment.
 *
 *   - A card's number is its place among the chat's cards: card 1 is the
 *     first the agent showed (or the person opened from `/`). The server maps
 *     it back through the entries.
 *   - Only the newest three cards are live; older ones collapse to their pill
 *     and mount again when the person expands one.
 *   - One card at most is full screen.
 *
 * Subscribers hear only what changes how cards draw (live, collapsed, full
 * screen, docked). What a card shows (its query, count and rows) is kept
 * quietly: the next send reads it.
 *
 * A page the person opened (from `/`, a chip, a notification…) is not drawn in
 * the chat: it opens full screen, and closing it puts it away. Its
 * ShowToolCard is mounted by the chat's kept-card host (chat/kept-card-host.tsx,
 * hostedIds) only while it is full screen, docked beside the chat (the live
 * capture's), or one of the LIVE_CARDS pages visited last (keptPages, by
 * `visitedAt`), parked out of sight between visits so opening it again never
 * loads it again. Every other opened page costs nothing until it is opened.
 *
 * Every card subscribes with a key of its own draw state (drawKey), and the
 * host with the cards it mounts (hostedKey), so a change to one redraws that
 * one only, however many the chat holds.
 */
import { buildCardContextEntry, MAX_CONTEXT_CARDS, queryOfSpec, type CardContextEntry } from '@/lib/chat-cards/context'
import { isPageCard, type CardSpec } from '@/lib/chat-cards/kinds'
import { pageBaseQuery } from '@/lib/chat-cards/pages'
import { browserTimeZone } from '@/lib/chat-cards/calendar'
import { readCardState, sweepCardStates, writeCardState, type StoredCardState } from './card-storage'
import { CardHistory } from './card-history'

/** How many of the newest cards stay live, and how many opened pages stay mounted (keptPages). */
export const LIVE_CARDS = 3

/** The most the turn's cards may take in the request header, as UTF-8 bytes of JSON. */
export const MAX_CONTEXT_CHARS = 6000

/** UTF-8 bytes, what a header actually carries (a title in Greek or Thai is several per character). */
function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export interface StoreCard {
  id: string
  n: number
  spec: CardSpec
  /** The person opened it from `/` (lib/chat-cards/opened-card.ts), not the agent with `show`. */
  opened?: boolean
}

export class ChatCardStore {
  private cards: StoreCard[] = []
  private byId = new Map<string, StoreCard>()
  /** Each card's place in the thread, for isLive and the kept pages' tie-break. */
  private indexById = new Map<string, number>()
  private states = new Map<string, StoredCardState>()
  /** Each card's Back and Forward, by its id: kept here so a card that remounts keeps its steps. */
  private histories = new Map<string, CardHistory>()
  private fullScreenId: string | null = null
  /** Older cards the person expanded this session: live again until collapsed. */
  private reopened = new Set<string>()
  private listeners = new Set<() => void>()
  private version = 0
  /** Bumped per card when it is told to redraw: part of its draw key. */
  private stamps = new Map<string, number>()
  /** The opened cards by last visit (openedByVisit), until a visit or the cards change. */
  private openedCache: StoreCard[] | null = null
  /**
   * The live capture's card, docked beside the chat while it records
   * (chat/live-capture-dock.tsx): always mounted, never one of the kept
   * pages. And the one just let go, still in the dock while it slides away.
   */
  private dockedId: string | null = null
  private releasedDockId: string | null = null

  constructor() {
    if (typeof window !== 'undefined') sweepCardStates()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private notify(): void {
    this.version += 1
    this.openedCache = null
    for (const listener of this.listeners) listener()
  }

  private stamp(id: string): void {
    this.stamps.set(id, (this.stamps.get(id) ?? 0) + 1)
  }

  /**
   * The conversation's show cards, in the order they appear, each with the
   * number its show result was stamped with (stable for the conversation,
   * whatever the chat trims from its front). A result with none numbers on from
   * the highest so far.
   */
  setCards(list: ReadonlyArray<{ id: string; spec: CardSpec; number?: number | null; opened?: boolean }>): void {
    const same =
      list.length === this.cards.length && list.every((c, i) => this.cards[i]?.id === c.id && (c.number == null || this.cards[i]?.n === c.number))
    if (same) return
    let highest = 0
    const used = new Set<number>()
    this.cards = list.map((c) => {
      const stamped = c.number != null && c.number > 0 && !used.has(c.number) ? c.number : null
      const n = stamped ?? highest + 1
      highest = Math.max(highest, n)
      used.add(n)
      return { id: c.id, n, spec: c.spec, ...(c.opened ? { opened: true } : {}) }
    })
    this.byId = new Map(this.cards.map((c) => [c.id, c]))
    this.indexById = new Map(this.cards.map((c, i) => [c.id, i]))
    // A card gone from the chat (another conversation loaded) is full screen no more.
    if (this.fullScreenId && !this.byId.has(this.fullScreenId)) this.fullScreenId = null
    for (const id of [...this.reopened]) if (!this.byId.has(id)) this.reopened.delete(id)
    this.notify()
  }

  card(id: string): StoreCard | undefined {
    return this.byId.get(id)
  }

  /** The newest card that matches (a card to bring back rather than open again). */
  newestWhere(match: (spec: CardSpec, card: StoreCard) => boolean): string | null {
    for (let i = this.cards.length - 1; i >= 0; i--) if (match(this.cards[i].spec, this.cards[i])) return this.cards[i].id
    return null
  }

  /**
   * The cards the person opened, by when they last visited each
   * (`visitedAt`), the latest last. A page opened before visits were kept
   * stays in its place in the thread, ahead of every visited one.
   */
  openedByVisit(): StoreCard[] {
    if (!this.openedCache) {
      this.openedCache = this.cards
        .map((card, i) => ({ card, i, at: this.state(card.id).visitedAt }))
        .filter((e) => e.card.opened)
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.i - b.i)
        .map((e) => e.card)
    }
    return this.openedCache
  }

  /**
   * The LIVE_CARDS pages the person opened and visited last: kept mounted, so
   * opening one again never loads it again. By visit rather than isLive's
   * place in the thread: reopening an old page would otherwise keep it (and
   * every other reopened) mounted for good.
   */
  keptPages(): StoreCard[] {
    // The docked card is mounted as itself (hostedIds), never one of these.
    return this.openedByVisit()
      .filter((card) => card.id !== this.dockedId)
      .slice(-LIVE_CARDS)
  }

  /**
   * The opened cards whose ShowToolCard the kept-card host mounts
   * (chat/kept-card-host.tsx), in thread order: the one full screen, the
   * docked one and the kept pages. No other opened page is mounted at all, so
   * the chat costs the same however many pages it holds.
   */
  hostedIds(): string[] {
    const ids = new Set(this.keptPages().map((c) => c.id))
    if (this.fullScreenId && this.byId.get(this.fullScreenId)?.opened) ids.add(this.fullScreenId)
    // The live capture's card, in its dock: one card, whatever else it is.
    if (this.dockedId && this.byId.get(this.dockedId)?.opened) ids.add(this.dockedId)
    return [...ids].sort((a, b) => (this.indexById.get(a) ?? 0) - (this.indexById.get(b) ?? 0))
  }

  hostedKey = (): string => this.hostedIds().join('\n')

  /**
   * One card's draw state as a string: full screen, folded, live, docked. A
   * card subscribed with it redraws only when its own state changes, not on
   * every change to any card.
   */
  drawKey(id: string): string {
    return [
      this.fullScreenId === id ? 'F' : '',
      this.isCollapsed(id) ? 'C' : '',
      this.isLive(id) ? 'L' : '',
      this.stamps.get(id) ?? 0,
      this.dockedId === id ? 'D' : this.releasedDockId === id ? 'd' : '',
    ].join('|')
  }

  /** The cards that match (the browser's, to put back). */
  idsWhere(match: (spec: CardSpec) => boolean): string[] {
    return this.cards.filter((c) => match(c.spec)).map((c) => c.id)
  }

  /** The highest card number in the chat (0 with none): a card opened from `/` takes the next. */
  highestNumber(): number {
    return this.cards.reduce((max, c) => Math.max(max, c.n), 0)
  }

  state(id: string): StoredCardState {
    let s = this.states.get(id)
    if (!s) {
      s = typeof window === 'undefined' ? {} : readCardState(id)
      this.states.set(id, s)
    }
    return s
  }

  /**
   * The card's Back and Forward (card-history.tsx), one per card id, for the
   * life of the chat panel: a card opened while a turn is out draws outside
   * the thread and mounts again inside it once the turn settles, and its steps
   * must survive that. In memory only; a reload starts again from `state`.
   */
  history(id: string): CardHistory {
    let h = this.histories.get(id)
    if (!h) {
      h = new CardHistory()
      this.histories.set(id, h)
    }
    return h
  }

  /** Among the newest LIVE_CARDS, or reopened by the person. */
  isLive(id: string): boolean {
    const index = this.indexById.get(id)
    if (index === undefined) return true // not in the list yet (it is streaming in): the newest
    return index >= this.cards.length - LIVE_CARDS || this.reopened.has(id)
  }

  /** Drawn as its one-line pill: collapsed by the person, or no longer live. */
  isCollapsed(id: string): boolean {
    if (this.fullScreenId === id) return false
    return !!this.state(id).collapsed || !this.isLive(id)
  }

  fullScreen(): string | null {
    return this.fullScreenId
  }

  /**
   * Keep what the card shows or what the person changed. `touch` marks a
   * change by hand (the last touched card leads the agent's note); `redraw`
   * tells the cards to draw again.
   */
  update(id: string, patch: Partial<StoredCardState>, opts: { touch?: boolean; redraw?: boolean } = {}): void {
    const next: StoredCardState = { ...this.state(id), ...patch, ...(opts.touch ? { touchedAt: Date.now() } : {}) }
    this.states.set(id, next)
    if (typeof window !== 'undefined') writeCardState(id, next)
    if ('visitedAt' in patch) this.openedCache = null
    if (opts.redraw) {
      this.stamp(id)
      this.notify()
    }
  }

  expand(id: string): void {
    if (!this.isLive(id)) this.reopened.add(id)
    this.update(id, { collapsed: false }, { touch: true, redraw: true })
  }

  collapse(id: string): void {
    this.reopened.delete(id)
    if (this.fullScreenId === id) this.fullScreenId = null
    this.update(id, { collapsed: true }, { redraw: true })
  }

  /** Full screen, and a visit to the card: an opened page is one of the kept pages from now (keptPages). */
  enterFullScreen(id: string): void {
    this.fullScreenId = id
    if (!this.isLive(id)) this.reopened.add(id)
    this.update(id, { collapsed: false, visitedAt: Date.now() }, { touch: true, redraw: true })
  }

  exitFullScreen(): void {
    if (!this.fullScreenId) return
    this.fullScreenId = null
    this.notify()
  }

  // ── The live capture's dock (chat/live-capture-dock.tsx) ────────────────

  /** The card docked beside the chat, if any. */
  docked(): string | null {
    return this.dockedId
  }

  /** The card just let go of the dock (it stays in the panel while that slides away), until another docks. */
  dockReleased(): string | null {
    return this.releasedDockId
  }

  /**
   * Dock a card (the live capture's), or let the docked one go (null). Docked,
   * it is mounted whatever else is (hostedIds) and is never one of the kept
   * pages. It may dock before it is one of the chat's cards (opened while its
   * message is on its way): it counts once it is.
   */
  setDocked(id: string | null): void {
    if (id === null) {
      this.releaseDock()
      return
    }
    if (this.dockedId === id) return
    const was = this.dockedId
    this.dockedId = id
    this.releasedDockId = null
    if (was) this.stamp(was)
    this.stamp(id)
    this.notify()
  }

  /**
   * The capture ended: its card leaves the dock as a page like any other, the
   * one visited last, so it stays mounted (a kept page) and opens again at
   * once.
   */
  private releaseDock(): void {
    const id = this.dockedId
    if (!id) return
    this.dockedId = null
    this.releasedDockId = id
    if (this.byId.get(id)?.opened) this.update(id, { visitedAt: Date.now() })
    this.stamp(id)
    this.notify()
  }

  /**
   * The turn's cards, newest first, at most MAX_CONTEXT_CARDS: what read_card
   * re-runs and the agent's note is written from (server side).
   */
  contextEntries(): CardContextEntry[] {
    const entries = this.allEntries()
    // The turn context rides in a request header: keep the cards bounded,
    // dropping the oldest first (the note's three come from the newest anyway).
    // A card on screen or touched by hand goes last.
    while (entries.length > 1 && byteSize(entries) > MAX_CONTEXT_CHARS) {
      let drop = entries.length - 1
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i].fs && !entries[i].t) {
          drop = i
          break
        }
      }
      entries.splice(drop, 1)
    }
    // One card alone too big (a long value list): it still goes, as its number
    // and title only; read_card then says to show it again more narrowly.
    if (entries.length === 1 && byteSize(entries) > MAX_CONTEXT_CHARS) {
      const { n, id, kind, title, entity, record, fs, t, at, tab, u } = entries[0]
      entries[0] = {
        n, id, kind, title: title.slice(0, 120),
        ...(entity ? { entity } : {}), ...(record ? { record } : {}), ...(fs ? { fs } : {}), ...(t ? { t } : {}),
        // A page card keeps where it is: read_card must not read another place.
        ...(at ? { at } : {}), ...(tab ? { tab } : {}),
        ...(u ? { u } : {}),
      }
    }
    return entries
  }

  private allEntries(): CardContextEntry[] {
    return [...this.cards]
      .reverse()
      .slice(0, MAX_CONTEXT_CARDS)
      .map((c) => {
        const s = this.state(c.id)
        const spec = c.spec
        return buildCardContextEntry({
          n: c.n,
          id: c.id,
          spec: isPageCard(spec)
            ? {
                kind: spec.kind,
                title: spec.title,
                target: spec.target,
                tab: spec.tab,
                // A team board's list is there before the card mounts.
                entity: s.entity ?? (spec.kind === 'team_board' && s.at === undefined ? 'action' : undefined),
                base: s.base ?? (spec.kind === 'team_board' ? pageBaseQuery(spec) : undefined),
              }
            : spec.kind === 'list'
              ? { kind: 'list', title: spec.title, entity_type: spec.entity_type, base: s.base ?? queryOfSpec(spec) }
              : spec.kind === 'calendar'
                ? { kind: 'calendar', title: spec.title, base: spec.calendar }
                : spec.kind === 'mail'
                  ? { kind: 'mail', title: spec.title, base: spec.mail }
                  : { kind: 'record', title: spec.title, record: spec.record },
          cur: spec.kind === 'list' ? (s.cur ?? s.base ?? queryOfSpec(spec)) : isPageCard(spec) ? (s.cur ?? s.base) : undefined,
          calendar: spec.kind === 'calendar' ? (s.cal ?? spec.calendar) : undefined,
          // The zone the card draws its days in, so read_card counts the same ones.
          timeZone: spec.kind === 'calendar' ? browserTimeZone() : undefined,
          mail: spec.kind === 'mail' ? (s.mail ?? spec.mail) : undefined,
          count: s.count,
          rows: s.rows,
          fullScreen: this.fullScreenId === c.id,
          touchedAt: s.touchedAt,
          open: s.open ?? null,
          ...(isPageCard(spec) ? { at: s.at, tab: s.tab ?? null } : {}),
          opened: c.opened,
        })
      })
  }
}
