'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUpRight } from 'lucide-react'
import {
  StatusPanelField,
  MemberPanelField,
  PriorityPanelField,
  DatePanelField,
  type WorkflowStateOption,
  type MemberOption,
} from '@/components/views/properties'
import { useCanOpenCards } from '@/app/account/(dashboard)/main-chat/main-chat-context'
import { openTarget } from '@/lib/chat-cards/open-card'
import { cn } from '@/lib/utils'
import type { EntityRefData } from './types'

/**
 * The quick-edit body shared by the inline chip's popover and the document
 * decoration's popover host. Every control here edits the action DIRECTLY —
 * these are the person's own edits, not suggestions — through the existing
 * PATCH /api/account/actions/[id]. The action may live in a workspace other
 * than the current one, so every request (the status/member lookups AND the
 * PATCH) carries `x-workspace-id: data.workspace_id`; the route resolves the
 * workspace from that header and verifies membership, so an edit to an action
 * in any workspace the user belongs to just works. After a successful edit we
 * toast with an Undo that restores the previous value and refresh the chip.
 */
export function EntityRefQuickEdit({
  data,
  refresh,
  onClose,
}: {
  data: EntityRefData
  refresh: () => Promise<void> | void
  /** Called after "Open" so the host can dismiss its popover. */
  onClose?: () => void
}) {
  const [states, setStates] = useState<WorkflowStateOption[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])
  const [loading, setLoading] = useState(true)
  const canOpen = useCanOpenCards()

  const workspaceId = data.workspace_id
  const teamId = data.team_id

  // A ref so the picker onChange closures always patch against the freshest id,
  // not a stale render's.
  const actionIdRef = useRef(data.id)
  actionIdRef.current = data.id

  useEffect(() => {
    let cancelled = false
    const headers = { 'x-workspace-id': workspaceId }
    const statesReq = teamId
      ? fetch(`/api/account/workflow-states?team_id=${encodeURIComponent(teamId)}`, { headers })
          .then((r) => (r.ok ? r.json() : { states: [] }))
          .catch(() => ({ states: [] }))
      : Promise.resolve({ states: [] })
    const membersReq = fetch('/api/account/workspace/members', { headers })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .catch(() => ({ members: [] }))

    Promise.all([statesReq, membersReq]).then(([statesData, membersData]) => {
      if (cancelled) return
      setStates(
        (statesData.states || []).map(
          (s: { id: string; name: string; category: string; color: string | null; team_id?: string }) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            color: s.color,
            team_id: s.team_id,
          }),
        ),
      )
      setMembers(
        (membersData.members || []).map(
          (m: { id: string; display_name: string | null; avatar_url: string | null }) => ({
            id: m.id,
            display_name: m.display_name || 'Unknown',
            avatar_url: m.avatar_url,
          }),
        ),
      )
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [workspaceId, teamId])

  /**
   * Apply `updates`, then toast with an Undo that re-applies `undo`. Both go
   * through the same cross-workspace-aware PATCH.
   */
  async function patch(
    updates: Record<string, unknown>,
    undo: Record<string, unknown>,
    label: string,
  ) {
    const ok = await sendPatch(actionIdRef.current, workspaceId, updates)
    if (!ok) {
      toast.error(`Couldn't update ${data.identifier}`)
      return
    }
    await refresh()
    toast.success(label, {
      action: {
        label: 'Undo',
        onClick: async () => {
          const undone = await sendPatch(actionIdRef.current, workspaceId, undo)
          if (undone) await refresh()
          else toast.error(`Couldn't undo ${data.identifier}`)
        },
      },
    })
  }

  return (
    <div className="w-72 p-1">
      {/* Header — identifier + title */}
      <div className="flex items-start gap-2 px-2 pb-1 pt-1.5">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{data.identifier}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={data.title}>
          {data.title}
        </span>
      </div>

      <div className="border-t border-border/60 pt-1">
        {/* Status */}
        <StatusPanelField
          value={data.status?.id ?? null}
          workflowStates={states}
          onChange={(stateId) =>
            patch({ status_id: stateId }, { status_id: data.status?.id ?? null }, `Status updated`)
          }
        />
        {/* Assignee (human members only) */}
        <MemberPanelField
          value={data.assignee?.id ?? null}
          members={members}
          onChange={(memberId) =>
            patch({ assignee_id: memberId }, { assignee_id: data.assignee?.id ?? null }, `Assignee updated`)
          }
          placeholder={loading ? 'Loading…' : 'Assignee'}
        />
        {/* Priority */}
        <PriorityPanelField
          value={data.priority}
          onChange={(value) =>
            patch({ priority: value }, { priority: data.priority ?? 'none' }, `Priority updated`)
          }
        />
        {/* Due date */}
        <DatePanelField
          value={data.due_date}
          granularity="day"
          onChange={(iso) =>
            patch({ due_at: iso }, { due_at: data.due_date }, iso ? `Due date set` : `Due date cleared`)
          }
          overdueSensitive
        />
      </div>

      {canOpen && (
        <div className="border-t border-border/60 pt-1">
          <button
            type="button"
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground',
              'transition-colors hover:bg-muted/50 hover:text-foreground',
            )}
            onClick={() => {
              // The action's own card, in its own workspace (switched to first).
              openTarget({ type: 'action', id: data.id, title: data.title }, { from: 'chip', workspaceId })
              onClose?.()
            }}
          >
            <ArrowUpRight className="h-4 w-4 shrink-0" />
            Open
          </button>
        </div>
      )}
    </div>
  )
}

async function sendPatch(
  actionId: string,
  workspaceId: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/account/actions/${actionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify(updates),
    })
    return res.ok
  } catch {
    return false
  }
}
