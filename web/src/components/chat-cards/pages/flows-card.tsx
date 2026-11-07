'use client'

/**
 * Flows as a card: the real FlowsView. Inline it is the list; the canvas
 * editor (FlowCanvasEditor) opens in full screen only, so a row clicked
 * inline takes the card full screen with that flow open. Which flow is open
 * is kept with the card, so it survives the move between the two.
 */
import * as React from 'react'
import { FlowsView } from '@/app/account/(dashboard)/views/flows-view'
import { PageCardSurface, usePageCardSurface, type PageCardProps } from './page-card'

export default function FlowsCard(props: PageCardProps) {
  const { toolCallId, store, fullScreen } = props
  const surface = usePageCardSurface(props)
  const [editing, setEditing] = React.useState<string | null>(() => (fullScreen ? (store.state(toolCallId).editing ?? null) : null))
  // The card stays mounted across the move (show-tool-card.tsx), so the move
  // itself opens the kept flow (full screen) or puts the list back (inline).
  const [wasFullScreen, setWasFullScreen] = React.useState(fullScreen)
  if (wasFullScreen !== fullScreen) {
    setWasFullScreen(fullScreen)
    setEditing(fullScreen ? (store.state(toolCallId).editing ?? null) : null)
  }
  // The run it was opened on lands once, with the flow it belongs to.
  const [run] = React.useState<string | null>(() => store.state(toolCallId).editingRun ?? null)
  const card = React.useMemo(
    () => ({
      editing,
      run: editing && editing === store.state(toolCallId).editing ? run : null,
      onEdit: (flow: string | null) => {
        store.update(toolCallId, { editing: flow, editingRun: null }, { touch: true })
        if (flow && !fullScreen) store.enterFullScreen(toolCallId)
        else setEditing(flow)
      },
    }),
    [editing, run, fullScreen, store, toolCallId],
  )
  return (
    <PageCardSurface surface={surface}>
      <div className="h-full min-h-0">
        <FlowsView card={card} />
      </div>
    </PageCardSurface>
  )
}
