'use client'

/**
 * A tag as a pill (its color and name) for rows, cards and record headers, and
 * a row of them. A click lists everything with the tag (TAG_OPEN_EVENT), unless
 * the host passes its own handler. Personal tags carry a lock.
 * The pill's look is `.tag-pill` (styles/tailwind.css), shared with the editor's.
 */
import type { CSSProperties, MouseEvent } from 'react'
import { Lock, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { openTag } from '@/components/editor/tag-suggestion'
import { TAG_DEFAULT_COLOR } from '@/lib/tags/palette'

export interface PillTag {
  id: string
  name: string
  color?: string | null
  personal?: boolean
}

export function TagPill({
  tag,
  onClick,
  onRemove,
  className,
}: {
  tag: PillTag
  onClick?: (tag: PillTag) => void
  onRemove?: (tag: PillTag) => void
  className?: string
}) {
  const style = { '--tag-color': tag.color || TAG_DEFAULT_COLOR } as CSSProperties
  const click = (e: MouseEvent) => {
    e.stopPropagation()
    if (onClick) onClick(tag)
    else openTag({ id: tag.id, name: tag.name })
  }
  return (
    <span
      role="button"
      tabIndex={0}
      data-tag-id={tag.id}
      title={tag.personal ? `#${tag.name} (only you)` : `#${tag.name}`}
      className={cn('tag-pill max-w-[12rem] gap-1', className)}
      style={style}
      onClick={click}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          if (onClick) onClick(tag)
          else openTag({ id: tag.id, name: tag.name })
        }
      }}
    >
      {tag.personal && <Lock className="h-2.5 w-2.5 shrink-0" aria-hidden />}
      <span className="truncate">#{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove #${tag.name}`}
          className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(tag)
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  )
}

/** A row of pills, at most `max` shown, then "+N". */
export function TagPills({
  tags,
  max = 3,
  onClick,
  onRemove,
  className,
}: {
  tags: readonly PillTag[]
  max?: number
  onClick?: (tag: PillTag) => void
  onRemove?: (tag: PillTag) => void
  className?: string
}) {
  if (tags.length === 0) return null
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-1', className)} data-tag-pills="">
      {shown.map((t) => (
        <TagPill key={t.id} tag={t} onClick={onClick} onRemove={onRemove} />
      ))}
      {rest > 0 && (
        <span className="text-xs text-muted-foreground" title={tags.slice(max).map((t) => `#${t.name}`).join(' ')}>
          +{rest}
        </span>
      )}
    </span>
  )
}
