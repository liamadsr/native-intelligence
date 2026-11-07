'use client'

import * as React from 'react'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { cn } from '@/lib/utils'
import { isForeignWorkspace, rowWorkspace, type RowWorkspace } from './row-workspace'

/**
 * The "this row lives in another workspace" marker, drawn on list rows and
 * board cards in My Actions and Projects while the workspace menu's "Show all
 * workspaces" switch is on.
 *
 * ONE component for both surfaces, and it decides for itself whether to draw:
 * the call sites are a single line each and can't drift apart on the rule for
 * when a badge is owed. It renders NOTHING for a row in the active workspace —
 * which is every row in the default scope, so the ordinary list pays one
 * context read and no DOM.
 *
 * The rule itself lives in `row-workspace.ts`, shared with the request paths,
 * so what the user SEES marked as foreign and what the app TREATS as foreign
 * are the same answer.
 *
 * Small and muted on purpose: the row's own identity (identifier, title,
 * status) is what the user is scanning, and the workspace is the answer to
 * "wait, where is this one from?" — a question they only ask about rows that
 * surprise them.
 */
export function RowWorkspaceBadge({
  item,
  className,
}: {
  item: Record<string, unknown>
  className?: string
}) {
  const activeWorkspaceId = useWorkspaceId()
  const workspace = rowWorkspace(item)
  if (!isForeignWorkspace(workspace, activeWorkspaceId)) return null
  const ws = workspace as RowWorkspace

  return (
    <span
      data-workspace-badge={ws.id}
      title={ws.name}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-0.5 pr-1.5 align-middle text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      {ws.logo_url ? (
        <img src={ws.logo_url} alt="" aria-hidden className="h-3.5 w-3.5 rounded-full object-cover" />
      ) : (
        <span
          aria-hidden
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted text-[8px] font-semibold uppercase text-muted-foreground"
        >
          {ws.name.charAt(0)}
        </span>
      )}
      <span className="max-w-[9rem] truncate">{ws.name}</span>
    </span>
  )
}
