'use client'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useEntityRef } from './use-entity-ref'
import { EntityRefQuickEdit } from './entity-ref-quick-edit'

export interface EntityRefClickTarget {
  identifier: string
  /** Viewport-relative rect of the clicked decoration (from getBoundingClientRect). */
  rect: DOMRect
}

/**
 * The single popover host the document panel renders for identifier
 * decorations. The TipTap extension reports a clicked identifier + its rect;
 * this positions a popover at that rect and renders the same quick-edit body
 * the inline chip uses. Decorations only exist for resolved identifiers, so the
 * data is already cached by the time this opens.
 */
export function EntityRefDocPopover({
  target,
  onClose,
}: {
  target: EntityRefClickTarget | null
  onClose: () => void
}) {
  const open = target !== null
  const rect = target?.rect

  return (
    <Popover open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <PopoverAnchor asChild>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: rect ? rect.left : 0,
            top: rect ? rect.top : 0,
            width: rect ? rect.width : 0,
            height: rect ? rect.height : 0,
            pointerEvents: 'none',
          }}
        />
      </PopoverAnchor>
      {target && (
        <PopoverContent className="w-72 p-0" align="start" side="bottom">
          <EntityRefDocPopoverBody identifier={target.identifier} onClose={onClose} />
        </PopoverContent>
      )}
    </Popover>
  )
}

function EntityRefDocPopoverBody({
  identifier,
  onClose,
}: {
  identifier: string
  onClose: () => void
}) {
  const { data, status, refresh } = useEntityRef(identifier)
  if (status !== 'found' || !data) {
    return <div className="p-3 text-xs text-muted-foreground">{identifier}</div>
  }
  return <EntityRefQuickEdit data={data} refresh={refresh} onClose={onClose} />
}
