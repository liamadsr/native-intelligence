'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { STATUS_DOT_COLORS } from '@/lib/views/property-options'
import { useEntityRefsEnabled } from './entity-refs-context'
import { useEntityRef } from './use-entity-ref'
import type { EntityRefData } from './types'

// Lazy so the quick-edit's dependencies (the property pickers and the tab
// navigation context) stay out of every Markdown bundle — they load only when a
// chip's popover actually opens, which never happens on a disabled (public)
// surface. Keeps the shared Markdown component, and public shares, lean.
const EntityRefQuickEdit = dynamic(
  () => import('./entity-ref-quick-edit').then((m) => m.EntityRefQuickEdit),
  {
    ssr: false,
    loading: () => <div className="p-3 text-xs text-muted-foreground">Loading…</div>,
  },
)

/**
 * `<entity-ref identifier="GEN-297">` — the element the remark plugin
 * (remark-entity-refs.ts) emits for every action-identifier it finds in
 * rendered Markdown. Mapped to this component in the shared Markdown
 * `components` table (components/ui/markdown.tsx).
 *
 * While loading or unresolved it renders the plain identifier text (so an
 * unresolved GEN-9999 / COVID-19 / ISO-8601 reads exactly as written). Once it
 * resolves to a real action it becomes an inline chip: a small status-coloured
 * dot, the identifier, the title on hover, and a click-through popover of quick
 * edits.
 *
 * On a disabled surface (a public share) chips are off — the component renders
 * the plain identifier and never touches the authenticated resolve endpoint.
 */
export function EntityRefChip({ identifier }: { identifier?: string }) {
  const enabled = useEntityRefsEnabled()
  const id = (identifier ?? '').trim()
  if (!enabled || !id) return <>{identifier}</>
  return <ResolvedEntityRefChip identifier={id} />
}

function ResolvedEntityRefChip({ identifier }: { identifier: string }) {
  const { data, status, refresh } = useEntityRef(identifier)
  const [open, setOpen] = useState(false)

  if (status !== 'found' || !data) {
    // Loading or missing → plain text. The faint style while loading avoids a
    // layout jump when it resolves (same glyphs, same box).
    return (
      <span className={cn('entity-ref-plain', status === 'loading' && 'opacity-80')}>
        {identifier}
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={data.title}
          className={cn(
            'mx-px inline-flex items-baseline gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5',
            'align-baseline font-mono text-[0.9em] leading-tight text-foreground',
            'transition-colors hover:border-border hover:bg-muted',
          )}
        >
          <StatusDot data={data} />
          <span>{data.identifier}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <EntityRefQuickEdit data={data} refresh={refresh} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The small workflow-state dot — the state's own colour, else the category's. */
function StatusDot({ data }: { data: EntityRefData }) {
  const color = data.status?.color ?? null
  const category = data.status?.category ?? 'backlog'
  return (
    <span
      aria-hidden
      className={cn(
        'relative top-px h-2 w-2 shrink-0 self-center rounded-full',
        !color && (STATUS_DOT_COLORS[category] || 'bg-gray-400'),
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  )
}
