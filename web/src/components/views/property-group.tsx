import * as React from 'react'

/**
 * Section used to group properties in entity detail panels (actions, contacts,
 * projects, initiatives, …).
 *
 * Previously copy-pasted verbatim into each detail panel; extracted here so the
 * panels share one definition and stay visually consistent.
 *
 * `title` is optional. The main properties group omits it — a heading reading
 * "Properties" above a list of obvious property rows only costs vertical space.
 * Groups that sit alongside others still pass one, since there the heading is
 * what tells them apart ("Projects", "GitHub").
 */
export function PropertyGroup({
  title,
  children,
}: {
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg">
      {title && (
        <div data-properties-heading={title === 'Properties' ? '' : undefined} className="px-3 py-2 text-sm font-medium text-muted-foreground">{title}</div>
      )}
      <div className="min-w-0 pb-2">{children}</div>
    </div>
  )
}
