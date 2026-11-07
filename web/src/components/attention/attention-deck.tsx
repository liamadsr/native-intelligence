'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { Check } from 'lucide-react'
import { AttentionCard, type CardSurface } from './attention-card'
import { ReviewCard } from './review-card'
import { isReviewCard, type DeckCard, type DeckPager } from './rail-cards'
import type { AttentionItem, AttentionPayload, AcceptCorrections, AcceptResult } from '@/hooks/use-attention-items'
import type { RailAiMember, RailMember, RailProject, RailPickerData } from '@/hooks/use-rail-picker-data'
import type { WorkRunPlace } from '@/lib/attention/work-place'

/**
 * The attention DECK (loop-closure Phase 2, Workstream D) — a one-at-a-time
 * card deck the user flips through, replacing the scroll list. Only the top
 * card is interactive; behind it, up to two "peek" edges show there's a stack.
 *
 * Interaction:
 *   • Act (accept / dismiss / start / got-it) on the top card → the hook removes
 *     it from `items`; the deck advances to the next automatically. The peeled
 *     card animates OFF (accept → right, dismiss → left) and the stack shifts
 *     forward (the deck-shuffle feel).
 *   • Skip with the ‹ › arrows → browse WITHOUT acting. Nothing is removed; the
 *     cursor moves and the peeled card slides toward the arrow direction while
 *     the new top slides in from the opposite edge.
 *
 * The card internals, editing, and accept/dismiss plumbing all live in
 * AttentionCard — this component only owns the deck presentation + cursor.
 *
 * Two kinds of card share the deck (rail-cards.ts): an attention card and a
 * review card — a work item waiting on the user (ACTIVITY-AND-REVIEW-DESIGN
 * §4.4), rendered by ReviewCard with the item's own verbs (Reviewed → the
 * accept flourish, Dismiss → the dismiss exit).
 *
 * Its hosts (bots-v4.md Phase 3): a bot's bubble (one item's cards at a
 * time: a card, a run's cards, or one review) and a bot's page (its For
 * you). `surface` rides every card event; `narrow` (a
 * bot's ~320 px column) wraps the pills, lets a card grow, and drops the side
 * gutter while there are no peeks to make room for; `cardMotion: false` (the
 * bubble, which slides its own cards) puts the next card in without the
 * deck's own slide; `onRefine` is the host's chat with its bot. A host keeps
 * the deck mounted while `onResolvingChange` says the flourish is playing, so
 * the receipt paints after the last card goes.
 */

// How many cards behind the top one show as peek edges. Two, so the deck can
// show one on EACH side of the top card.
const PEEK = 2
// Per-depth transform for the peek stack (index 0 = top card). The deck fans
// SIDEWAYS: the next card peeks out past the top card's right edge, the one
// after that past its left. Each is scaled down from its own outer edge so only
// a sliver shows and its top/bottom tuck behind the top card.
const PEEK_X = [0, 14, 12] // px pushed OUT past the top card's edge
const PEEK_SCALE = [1, 0.94, 0.89]
const PEEK_OPACITY = [1, 1, 0.8]
// Which side each depth fans to. Depth 1 (the NEXT card) goes RIGHT — the
// direction the pager advances — and depth 2 balances it on the left.
const PEEK_SIDE: Array<'right' | 'left'> = ['right', 'right', 'left']
/**
 * Side gutter the deck stage reserves so the fanned peek edges aren't clipped.
 * Exported because the RAIL has to widen by this much on each side to keep the
 * top card at its intended width — the deck can't bleed past its container
 * (that box scrolls, and overflow clips on both axes).
 */
export const DECK_SIDE_GUTTER_PX = Math.max(...PEEK_X) + 2
const PEEK_GUTTER = DECK_SIDE_GUTTER_PX

// Top-card transition — direction-aware "rise from the deck". `dir` is the custom
// value from AnimatePresence (+1 = forward, −1 = back).
//   • enter  — forward: start in the first peek slot (below, smaller) and rise;
//              back: descend from just above the deck.
//   • center — settle in place; y/scale spring, opacity snaps in fast so the new
//              card is solid quickly (minimizes the both-cards-visible window).
//   • exit   — forward: the old card peels UP off the top; back: sinks back DOWN
//              into the deck. Opacity clears fast so it's gone almost at once.
const cardVariants: Variants = {
  enter: (dir: number) => ({
    opacity: 0,
    // Come IN from the side the card is being drawn from: advancing pulls the
    // next card in from the right peek slot, going back from the left one.
    x: dir > 0 ? PEEK_X[1] + 10 : -(PEEK_X[2] + 10),
    scale: PEEK_SCALE[1],
  }),
  center: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: {
      x: { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 },
      scale: { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 },
      opacity: { duration: 0.12, ease: 'easeOut' },
    },
  },
  exit: (dir: number) => ({
    opacity: 0,
    // …and leave toward the OPPOSITE side, so the pair reads as the deck
    // sliding across rather than two cards crossfading in place.
    x: dir > 0 ? -(PEEK_X[2] + 10) : PEEK_X[1] + 10,
    scale: PEEK_SCALE[1],
    transition: {
      x: { duration: 0.2, ease: 'easeIn' },
      scale: { duration: 0.2, ease: 'easeIn' },
      opacity: { duration: 0.1, ease: 'easeIn' },
    },
  }),
}

// How long the resolved-state flourish sits over the card slot after an accept,
// before it fades out and the deck reveals the next card (WS-1c).
const RESOLVED_MS = 1200

// Stable empties for a card whose workspace hasn't loaded its picker lists yet.
// Module-level so the card gets the SAME array identity every render instead of
// a fresh `[]` per pass.
const NO_MEMBERS: RailMember[] = []
const NO_AI_MEMBERS: RailAiMember[] = []
const NO_PROJECTS: RailProject[] = []

/** The one-line confirmation shown in the resolved-state flourish. */
function deckReceiptLabel(item: AttentionItem, result: AcceptResult): string {
  if (result.status === 'started') return result.identifier ? `${result.identifier} started` : 'Started'
  if (result.status === 'draft_ready') return 'Draft ready'
  if (item.kind === 'question') return 'Got it'
  if (result.identifier) {
    const verb = item.payload?.change_type === 'update' ? 'Updated' : 'Created'
    return `${verb} ${result.identifier}`
  }
  return 'Done'
}

interface AttentionDeckProps {
  items: DeckCard[]
  /** The picker lists (projects / members / agents) for a card's OWN workspace,
   *  or null while that workspace hasn't been fetched. The rail keeps one set per
   *  workspace in the queue — the rail is cross-workspace, so these are per-CARD,
   *  not per-deck (see useRailPickerData). A card whose workspace has loaded gets
   *  editable pills; one still loading renders them read-only. */
  pickerFor: (workspaceId: string) => RailPickerData | null
  onEdit: (id: string, patch: Partial<AttentionPayload>) => void
  onAccept: (
    id: string,
    corrections?: AcceptCorrections,
    targetEntityId?: string | null,
  ) => Promise<AcceptResult>
  onStart: (id: string, runIn?: WorkRunPlace | null) => Promise<AcceptResult>
  onDismiss: (id: string) => Promise<void>
  /** A review card's verbs — the work item's Mark reviewed / Dismiss, keyed by
   *  the WORK item id (not the deck card id). */
  onReviewed: (workId: string) => Promise<{ ok: boolean }>
  onDismissReview: (workId: string) => Promise<void>
  /** Signals the parent rail whether a resolving flourish is currently playing.
   *  When the LAST card is accepted/started the hook empties `items` in the same
   *  tick, but the flourish still needs to paint — the rail keeps the deck mounted
   *  while this is true. (FIX 6) */
  onResolvingChange?: (active: boolean) => void
  /** Where the deck is shown, on every card event (bots-v4.md Phase 3). */
  surface?: CardSurface
  /** "Refine in chat" to the host's bot (absent: the main chat). */
  onRefine?: (item: AttentionItem) => void
  /** A bot's narrow column: pills wrap, cards grow, no side gutter without peeks. */
  narrow?: boolean
  /** The deck's own slide between cards (false: the next card just takes the top). */
  cardMotion?: boolean
  /** A review card's chevron opened its item (a bot's bubble closes then). */
  onItemOpened?: () => void
}

export function AttentionDeck({
  items,
  pickerFor,
  onEdit,
  onAccept,
  onStart,
  onDismiss,
  onReviewed,
  onDismissReview,
  onResolvingChange,
  surface,
  onRefine,
  narrow = false,
  cardMotion = true,
  onItemOpened,
}: AttentionDeckProps) {
  // Which card is on top — tracked by ITEM ID, not array position. The items
  // list re-sorts newest-first on every realtime insert (see useAttentionItems),
  // so a positional cursor would silently swap which card is shown when an
  // unrelated verdict run lands a new card mid-browse. Anchoring to the id keeps
  // "the card you're looking at" stable across re-sorts and removals.
  const [cursorId, setCursorId] = useState<string | null>(null)
  // Direction the last transition went, so the peeled card exits the right way.
  // +1 = forward/right, -1 = back/left.
  const [dir, setDir] = useState(1)
  // The resolved-state flourish shown over the card slot right after an accept
  // (WS-1c). `label` is unset during the in-flight phase (shows "Applying…") and
  // set to the receipt line once the accept resolves.
  const [resolving, setResolving] = useState<{ item: DeckCard; label?: string } | null>(null)
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resolveTimer.current) clearTimeout(resolveTimer.current)
  }, [])

  // Lift the flourish's active/idle signal to the parent rail so it can keep the
  // deck mounted while the flourish plays over an already-emptied list. Reset to
  // idle on unmount. (FIX 6)
  //
  // Covering is ALSO said at once, in the click itself (`cover`): the hook
  // removes the card optimistically in that same click, so the host's next
  // render already has no cards, and a signal that waited for this effect
  // would come after the host had unmounted the deck, flourish and all
  // (bots-v4.md Phase 3: the receipt paints after the last card goes).
  const flourishActive = resolving !== null
  // What the host was last told (null: nothing yet), so each change is said once.
  const told = useRef<boolean | null>(null)
  const tell = useCallback(
    (active: boolean) => {
      if (told.current === active) return
      told.current = active
      onResolvingChange?.(active)
    },
    [onResolvingChange],
  )
  const cover = useCallback(
    (item: DeckCard) => {
      setResolving({ item })
      tell(true)
    },
    [tell],
  )
  useEffect(() => {
    tell(flourishActive)
  }, [flourishActive, tell])
  useEffect(
    () => () => {
      // Gone: the next mount (or host) starts from nothing said.
      told.current = null
      onResolvingChange?.(false)
    },
    [onResolvingChange],
  )

  // Resolve the cursor to a live index every render (clamped inline, so we never
  // read out of bounds even before an effect fires). If the tracked id is gone
  // (removed elsewhere) or unset, fall back to the first card.
  const rawIndex = cursorId ? items.findIndex((it) => it.id === cursorId) : -1
  const cursor = rawIndex >= 0 ? rawIndex : 0

  // Repair the tracked id when it's missing/stale (initial mount, or the tracked
  // card was removed by another device). Points it at whatever card is now shown.
  useEffect(() => {
    if (items.length === 0) {
      if (cursorId !== null) setCursorId(null)
      return
    }
    const stillPresent = cursorId && items.some((it) => it.id === cursorId)
    if (!stillPresent) setCursorId(items[Math.min(cursor, items.length - 1)]?.id ?? null)
  }, [items, cursorId, cursor])

  const goPrev = useCallback(() => {
    setDir(-1)
    setCursorId((id) => {
      const i = items.findIndex((it) => it.id === id)
      const next = Math.max(0, (i < 0 ? 0 : i) - 1)
      return items[next]?.id ?? id
    })
  }, [items])

  const goNext = useCallback(() => {
    setDir(1)
    setCursorId((id) => {
      const i = items.findIndex((it) => it.id === id)
      const next = Math.min(items.length - 1, (i < 0 ? 0 : i) + 1)
      return items[next]?.id ?? id
    })
  }, [items])

  // Wrap accept/dismiss so the peeled card exits in the semantic direction:
  // accept → right (+1), dismiss → left (-1). The hook removes the item; the
  // repair effect then re-anchors the cursor onto whatever card is now shown.
  const handleAccept = useCallback(
    async (id: string, corrections?: AcceptCorrections, targetEntityId?: string | null) => {
      setDir(1)
      const accepted = items.find((it) => it.id === id)
      // Cover the card slot with a resolving→resolved flourish so the accept reads
      // as "done" instead of the card just vanishing on the hook's optimistic
      // removal. Set synchronously so it covers the whole in-flight accept. (WS-1c)
      if (accepted) cover(accepted)
      const result = await onAccept(id, corrections, targetEntityId)
      if (accepted && !isReviewCard(accepted) && result.ok) {
        setResolving({ item: accepted, label: deckReceiptLabel(accepted, result) })
        if (resolveTimer.current) clearTimeout(resolveTimer.current)
        resolveTimer.current = setTimeout(() => setResolving(null), RESOLVED_MS)
      } else {
        // Failed / already-gone / draft-retry (the hook re-added the card) → clear
        // the overlay so the re-added or next card shows without a stale flourish.
        setResolving(null)
      }
      return result
    },
    [items, onAccept, cover],
  )
  // Start mirrors accept's flourish: cover the slot while the run dispatches,
  // then show the "<id> started" receipt before revealing the next card.
  const coverWhileStarting = useCallback(
    async (id: string, run: () => Promise<AcceptResult>) => {
      setDir(1)
      const started = items.find((it) => it.id === id)
      if (started) cover(started)
      const result = await run()
      if (started && !isReviewCard(started) && result.ok) {
        setResolving({ item: started, label: deckReceiptLabel(started, result) })
        if (resolveTimer.current) clearTimeout(resolveTimer.current)
        resolveTimer.current = setTimeout(() => setResolving(null), RESOLVED_MS)
      } else {
        setResolving(null)
      }
      return result
    },
    [items, cover],
  )
  const handleStart = useCallback(
    (id: string, runIn?: WorkRunPlace | null) => coverWhileStarting(id, () => onStart(id, runIn)),
    [coverWhileStarting, onStart],
  )
  const handleDismiss = useCallback(
    async (id: string) => {
      setDir(-1)
      await onDismiss(id)
    },
    [onDismiss],
  )
  // A review card's verbs. Reviewed plays the accept flourish with a fixed
  // receipt (nothing was created — the item just stopped waiting); dismiss
  // exits left like any other dismiss. Both are keyed by the work item id.
  const handleReviewed = useCallback(
    async (workId: string) => {
      setDir(1)
      const card = items.find((it) => isReviewCard(it) && it.work.id === workId)
      if (card) cover(card)
      const result = await onReviewed(workId)
      if (card && result.ok) {
        setResolving({ item: card, label: 'Reviewed' })
        if (resolveTimer.current) clearTimeout(resolveTimer.current)
        resolveTimer.current = setTimeout(() => setResolving(null), RESOLVED_MS)
      } else {
        setResolving(null)
      }
      return result
    },
    [items, onReviewed, cover],
  )
  const handleDismissReview = useCallback(
    async (workId: string) => {
      setDir(-1)
      await onDismissReview(workId)
    },
    [onDismissReview],
  )

  // Nothing left AND no flourish in flight → the deck (and, above it, the whole
  // rail) unmounts as before. But while a resolving flourish is still playing —
  // e.g. the LAST card was just accepted and the hook optimistically emptied the
  // list in the same tick — keep the deck mounted and paint the flourish
  // STANDALONE, so the "Applying…" → receipt beat doesn't get skipped by an
  // instant unmount. When the RESOLVED_MS timer clears `resolving`, this branch
  // stops matching and everything tears down. (FIX 6)
  if (items.length === 0) {
    if (!resolving) return null
    return (
      <div className="flex flex-col gap-2">
        <div className="grid w-full" style={{ gridTemplateAreas: '"stack"', gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <AnimatePresence>
            <motion.div
              key="attention-resolved"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="min-w-0"
              style={{ gridArea: 'stack' }}
            >
              <ResolvedCard item={resolving.item} label={resolving.label} narrow={narrow} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    )
  }

  const top = items[cursor]
  if (!top) return null

  // Only the top card is mounted, so only ITS workspace's lists are needed here
  // (a review card has no property pills, so it asks for none).
  const topPicker = isReviewCard(top) ? null : pickerFor(top.workspace_id)

  // The peek cards behind the top (next few in the deck).
  const peeks = items.slice(cursor + 1, cursor + 1 + PEEK)

  // A narrow column keeps no gutter while nothing peeks out to need it.
  const gutter = narrow && peeks.length === 0 ? 0 : PEEK_GUTTER

  const atStart = cursor === 0
  const atEnd = cursor >= items.length - 1

  // Browse state handed to the top card, which renders it in its own control
  // bar. Built here because the deck owns the cursor; the card just draws it.
  const pager: DeckPager = {
    position: cursor + 1,
    total: items.length,
    onPrev: goPrev,
    onNext: goNext,
    atStart,
    atEnd,
  }

  return (
    <div className="flex flex-col gap-2">
      {/* No deck header: the feature name is gone and the stepper moved INTO the
          top card's own control bar (`pager` below), so the stack reads as one
          contained object rather than a card with chrome floating above it. */}

      {/* Deck stage — a grid stack: every layer occupies the same cell, so they
          share the TOP card's height (the tallest child). Peek edges scale down
          and push OUT sideways so only a vertical sliver shows past the top
          card's left and right edges — the visible "deck" depth. Side padding
          reserves room for those fanned edges so the rail's fixed width doesn't
          clip them; the top card itself stays inset by the same gutter, so it
          keeps its position and only the deck grows outward. */}
      <div
        className="grid w-full"
        style={{
          gridTemplateAreas: '"stack"',
          // minmax(0, 1fr): the single stack column is exactly the container
          // width and clamps its children — without this, `auto` columns grow to
          // content and the card overflows the rail (long assignee → clipped edge).
          gridTemplateColumns: 'minmax(0, 1fr)',
          // Side padding INSIDE the rail rather than a negative-margin bleed:
          // the rail lives in an overflow-y-auto box, and overflow clips on both
          // axes, so anything pushed past its edge would be cut off. The rail's
          // own width already reserves this gutter (DECK_SIDE_GUTTER_PX), so the
          // top card still lands at its full width.
          paddingLeft: gutter,
          paddingRight: gutter,
        }}
      >
        {/* Peek edges (static, behind the top card), furthest first. Each is a
            full-height card-shaped layer pushed OUT past one side of the top
            card and scaled down from THAT side, so its outer edge clears the top
            card while its top and bottom tuck behind — the visible deck sliver,
            one on the right and one on the left. */}
        {peeks
          .map((item, i) => ({ item, depth: i + 1 }))
          .reverse()
          .map(({ item, depth }) => {
            const side = PEEK_SIDE[depth]
            const dx = side === 'right' ? PEEK_X[depth] : -PEEK_X[depth]
            return (
              <div
                key={item.id}
                aria-hidden
                // Wears the top card's own translucent skin rather than an opaque
                // `bg-card`: against the light-mode page a solid white slab with
                // its own shadow reads as a stray gray shape under the card, not
                // as deck depth. No shadow here either — the top card's is the
                // only one that should show.
                className="pointer-events-none self-stretch rounded-xl border border-border/60 bg-background/70 backdrop-blur-md dark:border-white/20 dark:bg-neutral-700/70"
                style={{
                  gridArea: 'stack',
                  transform: `translateX(${dx}px) scale(${PEEK_SCALE[depth]})`,
                  // Anchor the scale to the side the card fans toward, so it
                  // shrinks AWAY from its outer edge — that edge stays put and
                  // the sliver reads as a consistent width.
                  transformOrigin: side === 'right' ? 'right center' : 'left center',
                  opacity: PEEK_OPACITY[depth],
                  zIndex: PEEK - depth,
                }}
              />
            )
          })}

        {/* Top card — the only interactive one. On advance it RISES from the
            deck: going forward, the new card starts at the peek position below
            (small + pushed down) and springs up into place while the old card
            sinks back into the stack; going back, the reverse. A soft spring
            settles it, so it reads as the deck shuffling rather than a fling. */}
        <div className="min-w-0" style={{ gridArea: 'stack', zIndex: PEEK + 1 }}>
          <AnimatePresence initial={false} mode="popLayout" custom={dir}>
            <motion.div
              key={top.id}
              custom={dir}
              variants={cardMotion ? cardVariants : undefined}
              initial={cardMotion ? 'enter' : false}
              animate="center"
              exit={cardMotion ? 'exit' : undefined}
              className="min-w-0"
              style={{ transformOrigin: 'center' }}
            >
              {isReviewCard(top) ? (
                <ReviewCard
                  card={top}
                  pager={pager}
                  onReviewed={handleReviewed}
                  onDismiss={handleDismissReview}
                  surface={surface}
                  narrow={narrow}
                  onItemOpened={onItemOpened}
                />
              ) : (
                <AttentionCard
                  item={top}
                  pager={pager}
                  editable={!!topPicker?.loaded}
                  members={topPicker?.members ?? NO_MEMBERS}
                  aiMembers={topPicker?.aiMembers ?? NO_AI_MEMBERS}
                  projects={topPicker?.projects ?? NO_PROJECTS}
                  onEdit={onEdit}
                  onAccept={handleAccept}
                  onStart={handleStart}
                  onDismiss={handleDismiss}
                  surface={surface}
                  onRefine={onRefine}
                  narrow={narrow}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Resolved-state flourish (WS-1c) — a brief confirmation over the card
            slot after an accept, above the top card, that fades out to reveal the
            next card. A SEPARATE AnimatePresence so it never entangles the deck's
            own card motion. */}
        <AnimatePresence>
          {resolving && (
            <motion.div
              key="attention-resolved"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="min-w-0"
              style={{ gridArea: 'stack', zIndex: PEEK + 2 }}
            >
              <ResolvedCard item={resolving.item} label={resolving.label} narrow={narrow} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** The card-slot confirmation shown after an accept (WS-1c): a spinner while the
 *  accept is in flight, then a check + the receipt line for ~1.2s. Matches the
 *  card's footprint so it reads as the card resolving in place. */
function ResolvedCard({ item, label, narrow = false }: { item: DeckCard; label?: string; narrow?: boolean }) {
  return (
    <div
      data-attention-resolved={label ? 'done' : 'applying'}
      className={
        narrow
          ? 'flex h-full min-h-[196px] w-full min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/90 px-3.5 py-3 text-center dark:bg-neutral-800/95'
          : 'flex h-[196px] w-full min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/80 px-3.5 py-3 text-center hud-surface-shadow backdrop-blur-md'
      }
    >
      {label ? (
        <>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Check className="h-5 w-5" strokeWidth={2.5} />
          </div>
          <p className="text-sm font-medium text-foreground/90">{label}</p>
        </>
      ) : (
        <>
          <ThinkingOrb state="searching" size={20} theme="auto" />
          <p className="text-xs text-muted-foreground">Applying…</p>
        </>
      )}
      <p className="line-clamp-1 max-w-full px-2 text-[11px] text-muted-foreground/60">{item.title}</p>
    </div>
  )
}
