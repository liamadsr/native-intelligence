'use client'

/**
 * The far-left mark on an action row: WHOSE item is this?
 *
 * An action is a Native Intelligence item by default, and stays one until somebody sends it
 * somewhere. That sentence is the whole component:
 *
 *   no links  → the Native Intelligence mark. Not a placeholder and not an empty state — it
 *               is the true answer, and it is what makes the icon a stable
 *               column rather than a thing that appears once you push.
 *   one link  → that provider's own brand mark, so a glance down a list reads
 *               "this one lives in Jira" without opening anything.
 *   two+      → an overlapping stack of the marks, up to three, with the count
 *               of the rest. The same action legitimately lives in several
 *               trackers (`action_external_task` is UNIQUE per action+PROVIDER),
 *               and a row that showed only the first would quietly lie about the
 *               other two.
 *
 * It is a BUTTON wherever a push is possible, and inert text otherwise (a
 * read-only capture, a row whose action doesn't exist and can't be created).
 * The button case carries `stopPropagation` on both click and pointer-down,
 * because every surface it mounts in has a gesture of its own underneath it:
 * the list row opens the detail panel, the board card is a drag source. That is
 * the same belt-and-braces the bulk-select checkbox uses two elements away
 * (view-board.tsx), and it is copied rather than invented for exactly that
 * reason.
 *
 * WHAT IT DOES NOT DO: fetch. Links arrive as a prop, from the row payload the
 * view query already joined (`external_links`) or from the menu that already
 * owns them. A component that fetched per row would put one request behind
 * every line of a 500-row board.
 */

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { AsanaIcon, JiraIcon, LinearIcon } from '@/components/brand-icons'
import { cn } from '@/lib/utils'

/**
 * THE NI MARK — the app icon, painted as a mask.
 *
 * `Mark` from `@/components/logo` is the constellation-of-dots used on the
 * marketing site. The mark that means "this is a Native Intelligence item" is the one the
 * product wears: `public/icon.png`, the same file `src/app/layout.tsx` serves as
 * the favicon and the apple-touch icon. Sitting in a row beside the Jira, Asana
 * and Linear brand marks, the icon has to be the one a user recognises from the
 * tab strip and the dock — anything else reads as a fourth vendor.
 *
 * IT IS A MASK, NOT AN <img>. The PNG is solid black with a transparent ground
 * (its vector source is `public/brand/ni-mark.svg`). A raw <img> would be invisible against a dark
 * sidebar and unable to dim with the row. Painting `currentColor` THROUGH the
 * PNG's alpha channel gives an SVG's tinting behaviour from a raster source: it
 * inherits `text-*` like every sibling glyph, so one `text-muted-foreground/70`
 * covers light mode, dark mode and the disabled state at once.
 *
 * Both the un-prefixed and `-webkit-` properties are set: `mask-image` is
 * unprefixed in every current engine, but WebKit still needs the prefixed
 * `-webkit-mask-*` and React will not infer one from the other.
 */
const NI_MARK_STYLE: React.CSSProperties = {
  backgroundColor: 'currentColor',
  WebkitMaskImage: "url('/icon.png')",
  maskImage: "url('/icon.png')",
  WebkitMaskSize: 'contain',
  maskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
}

/**
 * The Native Intelligence app mark, tinted by `currentColor`.
 *
 * `data-ni-mark` is the handle the tests assert through — the glyph is a
 * styled span rather than an identifiable element, and pinning the mask url in a
 * test would pin the asset path rather than the fact that the app mark is drawn.
 */
export function NiMark({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block shrink-0', className)}
      style={NI_MARK_STYLE}
      data-ni-mark=""
      aria-hidden="true"
    />
  )
}

/**
 * The providers this icon can draw a mark for.
 *
 * Deliberately the same hand-maintained literal as PushToTrackerMenu's
 * LINK_PROVIDERS rather than an import from `@/lib/tasks/*-config`: those
 * modules reach for the service-role Supabase client, which must never enter a
 * client bundle. A provider missing here still renders — as the generic dot
 * below — so the failure mode is a dull icon, never a hole in the row.
 */
export type PlatformProvider = 'asana' | 'jira' | 'linear'

/** The minimum a link has to carry for this icon to draw it. */
export interface PlatformLink {
  provider: string
}

/** How many marks the stack shows before it starts counting instead. */
const MAX_STACKED = 3

const PROVIDER_NAMES: Record<string, string> = {
  asana: 'Asana',
  jira: 'Jira',
  linear: 'Linear',
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider
}

function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  if (provider === 'asana') return <AsanaIcon className={className} />
  if (provider === 'jira') return <JiraIcon className={className} />
  if (provider === 'linear') return <LinearIcon className={className} />
  // A provider we have no brand mark for is still a real link, so it gets a
  // neutral dot rather than disappearing from the stack and making the count
  // disagree with what is drawn.
  return (
    <span
      className={cn('rounded-full bg-muted-foreground/60', className)}
      aria-hidden="true"
    />
  )
}

/**
 * Render order for the stack, so the same action looks the same everywhere.
 *
 * The link lists reaching this component are ordered three different ways: the
 * row payload's embedded join has no ORDER BY (heap order, and link rows get
 * updated by webhook read-back, so not even stable across refreshes), the menu's
 * loadLinks flattens in LINK_PROVIDERS order, and a push prepends the new link
 * while the entity-bus republish appends it. Normalising at the one component
 * that DRAWS the stack collapses all of them — and any future source — instead
 * of chasing each one.
 */
const PROVIDER_RANK: Record<string, number> = { asana: 0, jira: 1, linear: 2 }

/**
 * De-duplicate by provider, then order canonically.
 *
 * `UNIQUE (action_id, provider)` means the database cannot hold two links for
 * one provider — but a row payload can be patched optimistically from two
 * sources at once (the push response and a realtime echo), and a stack that
 * drew Jira twice would be the visible symptom of a bug nobody would connect to
 * its cause.
 */
function distinctProviders(links: PlatformLink[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const link of links) {
    const provider = link?.provider
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (seen.has(provider)) continue
    seen.add(provider)
    out.push(provider)
  }
  // Stable sort, so an unknown provider keeps its first-seen position relative
  // to other unknowns and simply sorts after the three we draw marks for.
  return out.sort((a, b) => (PROVIDER_RANK[a] ?? 99) - (PROVIDER_RANK[b] ?? 99))
}

/** The tooltip/aria sentence for a given set of providers. */
export function platformIconLabel(providers: string[]): string {
  if (providers.length === 0) return 'Native Intelligence action — send it to a task app'
  const names = providers.map(providerDisplayName)
  if (names.length === 1) return `In ${names[0]}`
  const last = names[names.length - 1]
  return `In ${names.slice(0, -1).join(', ')} and ${last}`
}

export interface ActionPlatformIconProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** This action's external links. Empty (or absent) = an NI-only action. */
  links?: PlatformLink[] | null
  /**
   * Is `links` the TRUTH, or has nobody asked yet?
   *
   * Defaults to true, which is what every surface that reads the row payload
   * means. Pass false when the link state is genuinely unknown — a compact menu
   * that defers its fetch to first open — and the mark hedges instead of
   * claiming NI-only. The distinction matters because zero providers is an
   * affirmative claim ("this is in no tracker"), and making it about an action
   * that may already be in Jira is the icon telling a lie at a glance.
   */
  known?: boolean
  /**
   * Make the mark a button. Omit to render it as inert decoration — a read-only
   * capture, or any surface where a push is not on offer.
   *
   * Usually `() => {}`: the mark is nearly always handed to a
   * `DropdownMenuTrigger asChild`, which supplies the real open handler through
   * the spread props below. The callback exists for the surfaces that open
   * something of their own, and its PRESENCE is what says "this is interactive".
   */
  onOpen?: () => void
  /** The caller has work in flight for this row, so there is nothing to open. */
  disabled?: boolean
  /** Extra classes for the outer element (spacing owned by the caller). */
  className?: string
  /** Mark size. 16px is the row default; the board card runs a touch smaller. */
  size?: 'sm' | 'md'
  /**
   * Draw "Native Intelligence"/the provider name and a chevron beside the mark.
   *
   * Off by default: the list and board rows put this in a fixed-width column
   * (see entity-row.tsx) so a growing label would misalign every row's title
   * beside it. The capture proposal card has no such column — it is the one
   * surface wide enough, and the one Liam is looking at when he asks the mark
   * to read as an obviously-clickable control rather than a bare glyph.
   */
  showLabel?: boolean
}

export const ActionPlatformIcon = React.forwardRef<HTMLButtonElement, ActionPlatformIconProps>(
  function ActionPlatformIcon(
    {
      links,
      known = true,
      onOpen,
      disabled = false,
      className,
      size = 'md',
      showLabel = false,
      // Radix's `asChild` trigger injects its own handlers, aria-* and data-state
      // here. Forwarding them (and the ref) is what makes this usable AS a
      // trigger rather than merely inside one. The two gesture handlers are
      // pulled out by name so ours can run ALONGSIDE rather than replace them —
      // a plain `{...rest}` spread would have one silently win.
      onPointerDown,
      onClick,
      ...rest
    },
    ref,
  ) {
    const providers = distinctProviders(links ?? [])
    // An unknown link state answers neither "which trackers" nor "none" — it
    // hedges. Visually it hedges the same way the zero-providers case does,
    // toward the Native Intelligence mark: a compact row that has not been opened yet is far
    // more often an NI-only action than one already sitting in a tracker, and
    // the alternative (a bare "..." glyph) read as decoration rather than as a
    // control with something behind it.
    const label = known ? platformIconLabel(providers) : 'Task app options'
    const markSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'
    const iconState = known ? providers.join(',') || 'dial8' : 'unknown'

    const shown = providers.slice(0, MAX_STACKED)
    const overflow = providers.length - shown.length
    const isNiOnly = !known || providers.length === 0

    const glyph = isNiOnly ? (
      // `text-*` rather than `fill-*`: the mark is a currentColor-filled MASK of
      // the app icon, not an svg whose paths take a fill. See NiMark.
      <NiMark className={cn(markSize, 'text-muted-foreground/70')} />
    ) : (
        <span className="flex items-center -space-x-1.5">
          {shown.map((provider) => (
            <ProviderMark
              key={provider}
              provider={provider}
              // The ring is what keeps overlapping marks legible against each
              // other; it matches the assignee-avatar stack in entity-row.tsx.
              className={cn(markSize, 'shrink-0 rounded-[3px] ring-1 ring-background')}
            />
          ))}
          {overflow > 0 && (
            <span className="pl-2 text-[10px] font-medium text-muted-foreground">+{overflow}</span>
          )}
        </span>
      )

    // The text half of the label, when there's room to draw one: "NI" (the short name) for
    // the unresolved/unlinked state, the single provider's name when there is
    // exactly one (a stack of 2+ has no one name to show and stays icon-only —
    // the overflow count already speaks for it).
    const labelText = isNiOnly ? 'NI' : shown.length === 1 ? providerDisplayName(shown[0]) : null
    const showChevron = showLabel && labelText !== null

    if (!onOpen) {
      return (
        <span
          className={cn('inline-flex shrink-0 items-center gap-1', className)}
          title={label}
          aria-label={label}
          data-platform-icon={iconState}
        >
          {glyph}
          {showLabel && labelText && (
            <span className="text-xs text-muted-foreground/70">{labelText}</span>
          )}
        </span>
      )
    }

    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded transition-opacity',
          disabled ? 'cursor-default opacity-50' : 'hover:opacity-80',
          className,
        )}
        title={label}
        aria-label={label}
        data-platform-icon={iconState}
        disabled={disabled}
        // Both gestures, because the two surfaces swallow different halves: the
        // list row acts on click, the board card starts a drag on POINTER-DOWN.
        // Stopping only one leaves the other surface hijacked — the board card
        // would begin dragging the moment the icon is pressed.
        //
        // The injected handler still runs: Radix opens its menu on pointer-down,
        // and dropping it here would make the mark inert as a trigger.
        onPointerDown={(e) => {
          e.stopPropagation()
          onPointerDown?.(e)
        }}
        onClick={(e) => {
          // NOT preventDefault: an `asChild` trigger's own click handler runs
          // right below, and cancelling the event would cancel the menu it is
          // about to open.
          e.stopPropagation()
          onClick?.(e)
          if (!disabled) onOpen()
        }}
      >
        {glyph}
        {showLabel && labelText && (
          <span className="text-xs text-muted-foreground/70">{labelText}</span>
        )}
        {showChevron && (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        )}
      </button>
    )
  },
)
