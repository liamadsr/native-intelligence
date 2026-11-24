'use client'

/**
 * Canvases as a card (migration 676): with no canvas open, the workspace's
 * canvases as a views list, as Docs is (docs/plans/views-everywhere.md): the
 * saved views and their tabs, the filters (owner, project, visibility,
 * archived, dates), the display settings, search in the header, the shared
 * rows (the canvas glyph, a private eye, its sharing, project, owner, when it
 * changed) and J/K/Enter. A row's right-click is the one entity actions menu:
 * Copy link, Rename, Share, Make a task, Archive. New canvas stays in the
 * header. With one open (`at.type === 'canvas'`), the editor. The editor is
 * another agent's component (@/components/canvas/canvas-editor, default
 * export); this card only opens it.
 *
 * Opening a canvas, and Back to the list, move the CARD the way a tab moves,
 * through usePagePlace — nothing navigates.
 */
import * as React from 'react'
import { Plus } from 'lucide-react'
import { CardHeaderSlot } from '../card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '../card-header-button'
import { openCreateDialog } from '@/lib/create/open-create'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'

const CanvasEditor = React.lazy(() => import('@/components/canvas/canvas-editor'))

export function CanvasesPageCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const surface = usePageCardSurface(props)
  const openId = place.at?.type === 'canvas' ? place.at.id : null

  if (openId) {
    return (
      <div className="h-full min-h-0">
        <React.Suspense fallback={<Loading />}>
          <CanvasEditor
            canvasId={openId}
            onBack={() => place.go(null)}
            onTitle={(title) => place.go({ type: 'canvas', id: openId, label: title }, place.tab)}
          />
        </React.Suspense>
      </div>
    )
  }
  return (
    <PageCardSurface surface={surface}>
      {/* The card's header names the page (Liam, 11-22: one title, its controls
          in the header); New canvas goes there, beside the list's search. New
          canvas opens the one Create composer on Canvas (create-everything.md);
          the list reads again on what is made there (ni:entity-created). */}
      <CardHeaderSlot side="right">
        <button type="button" onClick={() => openCreateDialog({ type: 'canvas' })} data-new-canvas="" className={CARD_HEADER_PILL_BUTTON}>
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
          New canvas
        </button>
      </CardHeaderSlot>
      <div className="h-full min-h-0" data-canvas-list="">
        <UnifiedViewLayout
          entityType="canvas"
          onItemSelect={(id, title) => place.go({ type: 'canvas', id, ...(title ? { label: title } : {}) })}
        />
      </div>
    </PageCardSurface>
  )
}

function Loading() {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
}

export default function CanvasesCard(props: PageCardProps) {
  return <CanvasesPageCard {...props} />
}
