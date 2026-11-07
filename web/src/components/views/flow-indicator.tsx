/**
 * FlowIndicator — a small ⚡ badge shown on any status surface (board column
 * header, list group header, team-settings workflow-state row) that has one or
 * more enabled flows triggering on entry to that status.
 *
 * Hovering names the flow(s); clicking opens the first flow's editor as a
 * Flows card in the chat (lib/chat-cards/open-card.ts). The component is
 * intentionally context-free (no tabs/router dependency): the card request
 * is a window event the dashboard answers, so it can render inside the
 * shared, reused view components without coupling them to the shell.
 */

'use client'

import * as React from 'react'
import { Zap } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openTarget } from '@/lib/chat-cards/open-card'
import type { FlowRef } from './hooks/use-flow-status-ids'

/** Open this flow's editor, as a Flows card in the chat. */
function openFlow(flowId: string, title: string) {
  openTarget({ type: 'flow', id: flowId, title }, { from: 'flow' })
}

interface FlowIndicatorProps {
  flows: FlowRef[]
  className?: string
  /**
   * When true (default) the badge is a button: clicking opens the flow as a
   * card. Set false in contexts with no chat (e.g. the settings shell), where
   * the badge is purely informational.
   */
  clickable?: boolean
}

export function FlowIndicator({ flows, className, clickable = true }: FlowIndicatorProps) {
  if (flows.length === 0) return null

  const label =
    flows.length === 1
      ? `Flow: ${flows[0].name}`
      : `${flows.length} flows on this status`

  const iconClass = cn(
    'inline-flex shrink-0 items-center justify-center rounded text-amber-500 transition-colors',
    clickable && 'hover:text-amber-400',
    className,
  )

  return (
    // Self-contained provider so the badge works in any context — the dashboard
    // shell has its own TooltipProvider, but the settings shell does not.
    // Nesting providers is harmless with Radix.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {clickable ? (
            <button
              type="button"
              aria-label={label}
              onClick={(e) => {
                // Don't trigger the surrounding header's click (collapse / drag).
                e.stopPropagation()
                e.preventDefault()
                openFlow(flows[0].id, flows[0].name)
              }}
              className={iconClass}
            >
              <Zap className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          ) : (
            <span aria-label={label} className={iconClass}>
              <Zap className="h-3.5 w-3.5" fill="currentColor" />
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56">
          {flows.length === 1 ? (
            <span>
              Flow: <span className="font-medium">{flows[0].name}</span>
            </span>
          ) : (
            <div className="space-y-0.5">
              <p className="font-medium">{flows.length} flows on this status</p>
              <ul className="text-muted-foreground">
                {flows.map((f) => (
                  <li key={f.id}>{f.name}</li>
                ))}
              </ul>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
