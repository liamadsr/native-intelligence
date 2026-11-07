'use client'

/**
 * A side panel card's row, one style for every card (Liam, 10-16, the Claude
 * app's right panel: "you can see things at a high level then you can open
 * them also it lets you drag and switch their position"): the title in plain
 * 13px foreground, a small chevron right after it, and on the far right the
 * card's one-line summary, muted ("2 running", "3 of 7", "4 to reconnect" in
 * amber, the one hue that means "needs you"). The whole row is the toggle: it
 * opens the card's body beneath it (the chevron turns down), remembered per
 * device (side-panel-store.ts setSectionOpen). Its card holds no padding of
 * its own: the row and the body beneath it each keep 12px off the edge.
 *
 * With more than one card showing, a ⋮⋮ handle takes the summary's place on
 * hover, or keyboard focus within the row (focus-visible: a clicked row keeps
 * its summary in a browser that focuses clicked buttons): the summary only
 * fades (it keeps its width, so nothing shifts) and the handle sits over it,
 * out of the flow. Drag it to move the card (card-drag.ts), or focus it and
 * ⌥↑ / ⌥↓. A plain click on it (a press that never became a drag) opens or
 * closes the card, as a click anywhere else on the row does.
 *
 * A card that stands for someone (the computer card: the agent, Liam 10-23,
 * as Dots' agent card) leads with their face (`avatar`): the title and
 * chevron, and the summary on a line under it, as a profile's name and its
 * state. Nothing on the right then but the handle, centred on the row. The
 * face sits beside the toggle rather than in it, so it can be a control of
 * its own (the agent's bot opens its editor). Such a card may also carry an
 * `action` at its far right, always shown (the agent's settings), in place of
 * a handle: it is a card that can't be moved.
 */
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { ChevronRight, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { startCardDrag } from './card-drag'
import { setSectionOpen, type SectionId } from './side-panel-store'

/** The summary's colour: amber for what needs the person, else muted. */
export type SummaryTone = 'muted' | 'attention'

export function CardHeading({
  id,
  title,
  summary,
  tone = 'muted',
  avatar,
  action,
  open,
  bodyId,
  index,
  count,
  onMove,
}: {
  id: SectionId
  title: string
  /** On the far right, one line (the agents running, the plan's steps done, the connectors to fix). */
  summary?: string | null
  tone?: SummaryTone
  /** A face before the title, beside the toggle (it may be a button); the summary then sits under the title. */
  avatar?: ReactNode
  /** A control at the row's far right, always shown (the agent card's settings), where a handle would be: for a card that can't be moved. */
  action?: ReactNode
  open: boolean
  /** The card's body (aria-controls). */
  bodyId: string
  /** Where the card stands among the cards showing, and how many show. */
  index: number
  count: number
  /** Move this card to `to` among the cards showing. */
  onMove: (id: SectionId, to: number) => void
}) {
  const reorderable = count > 1

  const onHandleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const to = index + (e.key === 'ArrowUp' ? -1 : 1)
    if (to >= 0 && to < count) onMove(id, to)
  }
  const onHandlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    startCardDrag(
      e.currentTarget,
      e.pointerId,
      e.clientY,
      (to) => onMove(id, to),
      () => setSectionOpen(id, !open),
    )
  }

  const chevron = (
    <ChevronRight
      aria-hidden
      className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
    />
  )
  const summaryTone = tone === 'attention' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'

  return (
    <div data-side-panel-row={id} className={cn('group/row relative', avatar && 'flex items-stretch pl-3')}>
      {/* A face stands beside the toggle, not in it: it can be a control of its own (the agent's bot opens its look's editor). */}
      {avatar && <span className="flex shrink-0 items-center py-2">{avatar}</span>}
      {/* The toggle takes the rest of the row, its full height and the handle's strip (the handle sits over it). */}
      <h3 className={cn(avatar && 'flex min-w-0 flex-1')}>
        <button
          type="button"
          data-side-panel-section-toggle={id}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setSectionOpen(id, !open)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-xl text-left text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            avatar ? 'py-2 pl-3 pr-10' : cn('px-3', open ? 'pb-1 pt-2.5' : 'py-2.5'),
          )}
        >
          {avatar ? (
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span data-side-panel-section-title="" className="truncate text-[15px] font-semibold">
                  {title}
                </span>
                {chevron}
              </span>
              <span data-side-panel-section-summary="" className={cn('block truncate font-normal', summaryTone)}>
                {summary}
              </span>
            </span>
          ) : (
            <>
              <span data-side-panel-section-title="" className="truncate">
                {title}
              </span>
              {chevron}
              {/* Room for the handle even with nothing to say: it never lands on the title. */}
              <span
                data-side-panel-section-summary=""
                className={cn(
                  'ml-auto min-w-7 truncate pl-3 text-right font-normal tabular-nums transition-opacity duration-150 motion-reduce:transition-none',
                  summaryTone,
                  reorderable && 'group-has-[:focus-visible]/row:opacity-0 group-hover/row:opacity-0',
                )}
              >
                {summary}
              </span>
            </>
          )}
        </button>
      </h3>
      {action && <div className="absolute right-1.5 top-1/2 -translate-y-1/2">{action}</div>}
      {reorderable && !action && (
        <button
          type="button"
          data-side-panel-drag-handle={id}
          aria-label={`Move ${title}, ${index + 1} of ${count}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title="Drag to move, or ⌥↑ ⌥↓"
          onPointerDown={onHandlePointerDown}
          onKeyDown={onHandleKeyDown}
          className={cn(
            // Over the summary's spot (with a face, the row's empty right end), out of the flow; the pointer's only while it shows.
            'pointer-events-none absolute right-1.5 flex size-7 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing motion-reduce:transition-none',
            'group-has-[:focus-visible]/row:pointer-events-auto group-has-[:focus-visible]/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100',
            avatar ? 'top-1/2 -translate-y-1/2' : 'top-1.5',
          )}
        >
          <GripVertical aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  )
}
