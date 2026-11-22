/**
 * A record's kind, drawn: the kind's own glyph in the kind's own colour
 * (src/lib/entities/entity-identity.ts). The one way a kind is shown, so a
 * doc, a meeting or a table looks the same in the search palette, an `@`
 * picker, a mention chip, a card's header and a notification.
 *
 * Small and tinted, never a filled tile. Decorative: it always stands beside
 * the record's name, so it is hidden from a screen reader.
 *
 * A kind with no identity draws `fallback` (a neutral glyph in the muted ink),
 * or nothing when there is none.
 */
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ENTITY_COLOR_TEXT, entityIdentity, resolveEntityIdentityKind } from '@/lib/entities/entity-identity'

/** `xs`: inside a line of text (12px); `sm`: a chip or a dense row (14px); `md`: a menu row (16px); `lg`: a palette row or a header (18px); `xl`: a page's title (20px). */
export const ENTITY_ICON_SIZES = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-[18px]',
  xl: 'size-5',
} as const
export type EntityIconSize = keyof typeof ENTITY_ICON_SIZES

export function EntityIcon({
  kind,
  size = 'md',
  className,
  fallback,
  muted = false,
  strokeWidth = 1.75,
}: {
  /** The kind, by any of its names ('document', 'data_table' or 'table', 'recipe' or 'agent'). */
  kind: string | null | undefined
  size?: EntityIconSize
  className?: string
  /** What to draw for a kind with no identity. */
  fallback?: LucideIcon
  /** The glyph without its colour, in the ink around it (a dimmed or locked row). */
  muted?: boolean
  strokeWidth?: number
}) {
  const identity = entityIdentity(kind)
  const Icon = identity?.icon ?? fallback
  if (!Icon) return null
  return (
    <Icon
      aria-hidden
      data-entity-icon={resolveEntityIdentityKind(kind) ?? 'unknown'}
      data-entity-color={identity && !muted ? identity.color : undefined}
      strokeWidth={strokeWidth}
      className={cn(
        'shrink-0',
        ENTITY_ICON_SIZES[size],
        identity && !muted ? ENTITY_COLOR_TEXT[identity.color] : !identity ? 'text-muted-foreground' : null,
        className,
      )}
    />
  )
}
