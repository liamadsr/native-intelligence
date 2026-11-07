'use client'

/**
 * Flows view — the workspace automation surface.
 *
 * Management is powered by the shared views system (UnifiedViewLayout with
 * entityType="flow"), so flows get the same searchable/filterable/groupable/
 * saved-views experience as Projects, Actions, and Captures. Group-by-status
 * (Active/Paused) is the default.
 *
 * Editing happens in a full-screen n8n-style canvas (FlowCanvasEditor), opened
 * by clicking a row or "New flow". The backend contract is unchanged — one
 * status-change trigger → one HTTP POST — and AI-created flows appear here
 * automatically.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Plus, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { FlowCanvasEditor } from './flows/flow-canvas-editor'
import { ViewHeader } from './view-header'
import type { PausedFlow } from '@/lib/flows/paused-flows'

const NEW_FLOW_LABEL = 'New flow'

/**
 * Flows in a chat card (src/components/chat-cards/pages/flows-card.tsx), the
 * only place the page renders. The card owns which flow the canvas edits,
 * since the canvas opens in full screen only (a flow opened from anywhere
 * else is a Flows card seeded with it: lib/chat-cards/open-card.ts).
 */
export interface FlowsCardMode {
  editing: string | '__new__' | null
  /** The run of `editing` the editor lands on (a notification about one run); null for an ordinary open. */
  run?: string | null
  onEdit: (flow: string | '__new__' | null) => void
}

export function FlowsView({ card }: { card: FlowsCardMode }) {
  // Which flow the canvas is editing: a flow id, '__new__' to create, or null.
  // No team gate here: only status-change flows are team-scoped — schedule /
  // capture_processed flows are workspace-scoped, so a teamless workspace can
  // still create them (the editor enforces "Team is required" per trigger).
  const editing = card.editing
  const cardRef = useRef(card)
  cardRef.current = card
  const setEditing = useCallback((next: string | '__new__' | null) => cardRef.current.onEdit(next), [])

  // WS-4b visual — loops the AI usage limit has PAUSED. A dead engine must look
  // dead (F5): the per-flow rows are rendered by the shared views system (not
  // this component), so the paused signal surfaces as a header banner here,
  // naming the affected loops. Fetched once, cheaply (a compact derivation off
  // recent failed runs); silent on error (no banner).
  const [pausedFlows, setPausedFlows] = useState<PausedFlow[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/account/flows/paused')
      .then((r) => (r.ok ? r.json() : { paused_flows: [] }))
      .then((j) => {
        if (!cancelled) setPausedFlows(Array.isArray(j.paused_flows) ? j.paused_flows : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleRowSelect = useCallback((itemId: string) => {
    setEditing(itemId)
  }, [setEditing])

  return (
    <div className="relative flex h-full flex-col">
      {/* Page header — title + create. The views toolbar (search/filter/group/
          sort/layout) renders just below, inside UnifiedViewLayout. The create
          control matches the shared "+" icon button used on the other list
          pages (docs, CRM). */}
      <ViewHeader
        title="Flows"
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing('__new__')}
            title={NEW_FLOW_LABEL}
            aria-label={NEW_FLOW_LABEL}
          >
            <Plus className="h-4 w-4" />
          </Button>
        }
      />

      {pausedFlows.length > 0 && (
        <div className="mx-3 mt-1 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium">Paused — AI usage limit:</span>{' '}
            {pausedFlows.map((f) => f.flow_name).join(', ')}. Loops resume when the limit resets or
            is raised.
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <UnifiedViewLayout
          entityType="flow"
          onItemSelect={handleRowSelect}
          selectedItemId={editing && editing !== '__new__' ? editing : null}
        />
      </div>

      {editing !== null && (
        // An inner layer of a chat card: Esc closes it before the card's own
        // full screen (show-tool-card's anotherLayerOpen).
        <div data-chat-card-layer="" className="contents">
        <FlowCanvasEditor
          flowId={editing === '__new__' ? null : editing}
          initialRunId={editing === '__new__' ? null : (card.run ?? null)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            /* List updates live via entity-events emitted by the canvas. */
          }}
        />
        </div>
      )}
    </div>
  )
}
