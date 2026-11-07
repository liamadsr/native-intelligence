'use client'

import { cn } from '@/lib/utils'

/** A page's name in its header row (a button when `onClick` is given: a breadcrumb back). */
export function PageTitle({ label, title = label, onClick, as = 'span', className }: {
  label: string
  title?: string
  /** Kept for callers that name their page's icon; pages in cards show none. */
  iconName?: string
  onClick?: () => void
  as?: 'span' | 'h1' | 'h2'
  className?: string
}) {
  const Tag = onClick ? 'button' : as
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-7 max-w-44 shrink-0 items-center text-sm font-medium text-muted-foreground',
        onClick && 'rounded-md transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      <span className="block min-w-0 truncate">{label}</span>
    </Tag>
  )
}
