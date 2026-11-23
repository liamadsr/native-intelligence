'use client'

import { PageTitle } from '@/components/views/page-title'
import * as React from 'react'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { CardHeaderSlot, CardHeaderTrail, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { CARD_HEADER_ICON_BUTTON } from '@/components/chat-cards/card-header-button'
import { cn } from '@/lib/utils'

/**
 * EntityDetailHeader — the ONE header shell for full-page entity detail
 * surfaces (sequence detail, flow editor). Extracted so the two pages cannot
 * drift apart again. Layout contract:
 *
 *   [viewTitle › name (inline-editable)] [⋯] ······ [status pill] [actions]
 *
 * Deliberate choices (from the convergence review):
 *   - a real BREADCRUMB back-link on the left — never a bare ✕ button,
 *   - NO entity icon before the name (redundant with the breadcrumb),
 *   - the name is an inline-editable input styled as text (border/background
 *     appear only on focus), sized to its content by `field-sizing-content` so
 *     the ⋯ menu sits IMMEDIATELY after the name rather than across a gap —
 *     the old `ch` estimate measured in DIGIT-ZERO widths, which on this
 *     proportional font left the box visibly wider than the text inside it,
 *   - the ⋯ overflow menu comes right after the name,
 *   - the status pill is pinned FAR RIGHT (ml-auto on the right group), with
 *     the primary actions outermost,
 *   - NO bottom border here — that's the caller's call via className: the
 *     flow editor's translucent glass overlay needs `border-b border-border`
 *     to separate the header from the canvas beneath it, while sequence
 *     detail sits on an opaque page and stays borderless like ViewHeader.
 *
 * Row metrics mirror ViewHeader (h-12, px-5) so detail pages line up with the
 * list pages they're opened from.
 */

/**
 * Bounds on the name input's content-driven width, as Tailwind classes so the
 * declarative path needs no inline style at all: narrow enough that an empty
 * name still has a clickable placeholder, wide enough that a long name
 * scrolls inside the box instead of pushing the status pill off-screen.
 */
const NAME_WIDTH_BOUNDS = 'min-w-[6ch] max-w-[42ch]'

interface EntityDetailHeaderProps {
  /** Parent view's title — the breadcrumb back-link ('Sequences', 'Flows'). */
  viewTitle: string
  /**
   * The UNSHORTENED parent title, for the crumb's tooltip and its aria-label.
   *
   * Most callers pass a fixed view name and want neither. A caller whose crumb
   * is a specific entity's name (an eval case's suite, say) shortens
   * `viewTitle` with `truncateBreadcrumbTitle` so it cannot starve the title
   * beside it, and passes the whole name here so nothing is actually lost.
   */
  viewTitleFull?: string
  /** Breadcrumb click — a real history step back to the list. */
  onBack: () => void
  /** Entity name, inline-editable. */
  name: string
  onNameChange: (name: string) => void
  namePlaceholder?: string
  /** Items for the ⋯ menu (DropdownMenuItem nodes); omit to hide the menu. */
  menuItems?: React.ReactNode
  /** Status pill, pinned far right — just before the primary actions. */
  statusPill?: React.ReactNode
  /** Primary actions, outermost right. */
  actions?: React.ReactNode
  className?: string
  /**
   * In a card whose title is not `viewTitle` (an eval case: the card says
   * Evals, the crumb is the case's suite): the page the card's title goes
   * back to. The crumb then stays in the header's breadcrumb, before the name.
   * Without it the crumb IS the card's title, and its press is `onBack`.
   */
  page?: { title: string; onBack: () => void }
}

export function EntityDetailHeader({
  viewTitle,
  viewTitleFull,
  onBack,
  name,
  onNameChange,
  namePlaceholder = 'Untitled',
  menuItems,
  statusPill,
  actions,
  className,
  page,
}: EntityDetailHeaderProps) {
  // In a card the breadcrumb is its header's (Liam, 11-22: "the back button
  // should just be the breadcrumb"): the card's title is the way back, the
  // name after it, renamed in place, and the status, actions and ⋯ at the
  // header's end.
  const inCard = useCardHeaderSlots() !== null
  // In a floating content window, the header carries the window's close button.
  const rowRef = React.useRef<HTMLDivElement>(null)
  /**
   * The `field-sizing-content` fallback, and nothing more. On an engine that
   * supports it the browser has already sized the box to its own text and this
   * effect never runs; on one that does not (Safari before 18.4, jsdom) an
   * off-screen mirror rendered with the input's own computed font measures the
   * text and writes the width back. `min-w`/`max-w` still clamp it either way,
   * so this only ever picks the number BETWEEN those bounds.
   */
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'))
      return
    const cs = getComputedStyle(el)
    const mirror = document.createElement('span')
    mirror.textContent = name || namePlaceholder
    mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px'
    mirror.style.font = cs.font
    mirror.style.letterSpacing = cs.letterSpacing
    document.body.appendChild(mirror)
    // The borders and horizontal padding are chrome around the text, so the
    // measured text width alone would clip the last glyph.
    const chrome =
      parseFloat(cs.paddingLeft || '0') +
      parseFloat(cs.paddingRight || '0') +
      parseFloat(cs.borderLeftWidth || '0') +
      parseFloat(cs.borderRightWidth || '0')
    const width = mirror.getBoundingClientRect().width || mirror.offsetWidth
    mirror.remove()
    // An environment with no layout at all (jsdom) measures every string as 0.
    // Writing `width: 0px` there would collapse the box past its `min-w`, so
    // leave the declarative sizing alone and let the classes decide.
    if (width <= 0) return
    el.style.width = `${width + chrome}px`
  }, [name, namePlaceholder])

  if (inCard) {
    const crumb = viewTitleFull ?? viewTitle
    return (
      <>
        <CardHeaderTrail onBack={page ? page.onBack : onBack} backLabel={`Back to ${(page ? page.title : crumb).toLowerCase()}`}>
          {page && (
            <>
              <button
                type="button"
                onClick={onBack}
                title={crumb}
                aria-label={`Back to ${crumb}`}
                data-entity-detail-crumb=""
                className="max-w-[10rem] shrink-0 truncate rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {viewTitle}
              </button>
              <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
            </>
          )}
          {/* As wide as the name (an invisible copy sizes it), renamed in place. */}
          <span className="inline-grid min-w-0 grid-cols-[minmax(0,auto)]">
            <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre px-1 font-medium">{name || namePlaceholder}</span>
            <input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder={namePlaceholder}
              aria-label={`${crumb.replace(/s$/, '')} name`}
              data-entity-detail-name=""
              className="col-start-1 row-start-1 w-full min-w-0 truncate rounded bg-transparent px-1 font-medium text-foreground outline-none placeholder:text-muted-foreground hover:bg-foreground/[0.06] focus:bg-foreground/[0.06]"
            />
          </span>
        </CardHeaderTrail>
        {(statusPill || actions || menuItems) && (
          <CardHeaderSlot side="right">
            <div data-entity-detail-controls="" className="flex items-center gap-1.5">
              {statusPill && <div className="flex shrink-0 items-center">{statusPill}</div>}
              {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
              {menuItems && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="More actions" className={cn('grid size-6 shrink-0 place-items-center', CARD_HEADER_ICON_BUTTON)}>
                      <MoreHorizontal className="size-4" strokeWidth={1.75} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </CardHeaderSlot>
        )}
      </>
    )
  }

  return (
    <>
      <div
        ref={rowRef}
        className={cn('relative flex h-12 shrink-0 items-center gap-2 px-5', className)}
      >
        <nav className="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
          <PageTitle label={viewTitle} title={viewTitleFull ?? viewTitle} onClick={onBack} />
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={namePlaceholder}
            aria-label={`${(viewTitleFull ?? viewTitle).replace(/s$/, '')} name`}
            className={cn(
              'h-7 shrink border-transparent bg-transparent px-1 text-sm font-semibold shadow-none focus-visible:border-border focus-visible:bg-card',
              // `w-auto` beats the Input primitive's own `w-full`, which would
              // otherwise pin the box to the nav's width and make
              // `field-sizing-content` a no-op.
              'field-sizing-content w-auto',
              NAME_WIDTH_BOUNDS,
            )}
          />
          {menuItems && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">{menuItems}</DropdownMenuContent>
            </DropdownMenu>
          )}
        </nav>

        {/* Right group carries ml-auto (the house idiom — see ViewHeader's
            actions slot) so the pill/actions hold the FAR-RIGHT edge no matter
            how the breadcrumb's name input shrinks; the nav deliberately has no
            flex-1, which would make the pill's position depend on the input's
            shrink behavior instead of pinning it. */}
        {(statusPill || actions) && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {statusPill && <div className="flex shrink-0 items-center">{statusPill}</div>}
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
          </div>
        )}
      </div>
    </>
  )
}
