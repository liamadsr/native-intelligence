'use client'

/**
 * `openOutputOrItem` (src/lib/work/open-output.ts) wired to the shell: a
 * delivered item opens its primary deliverable through the work item panel's
 * opener (openDeliverable: a card in the chat, the desktop-safe link opener),
 * else the item where any item opens (useOpenWorkItem).
 */
import { useCallback, useRef } from 'react'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { deliverableContextFor, openDeliverable } from '@/lib/work/open-deliverable'
import { openOutputOrItem, type DeliveredItem } from '@/lib/work/open-output'

export function useOpenOutput(): (item: DeliveredItem) => Promise<'output' | 'item'> {
  const openWorkItem = useOpenWorkItem()
  const { currentId } = useWorkspaces()
  // Read at click time, so the callback's identity doesn't follow a workspace switch.
  const current = useRef(currentId)
  current.current = currentId
  return useCallback(
    (item: DeliveredItem) =>
      openOutputOrItem(item, {
        currentWorkspaceId: current.current,
        contextFor: (workId, d) => deliverableContextFor(workId, d),
        openDeliverable,
        openItem: (it) => {
          openWorkItem(it.workItemId, it.teammateId ? [it.teammateId] : [], {
            workspaceId: it.workspaceId,
            title: it.title ?? null,
            // Unknown (undefined) and none (null) differ: unknown lets the item's lookup say.
            ...(it.teammateId !== undefined ? { teammateId: it.teammateId } : {}),
          })
        },
      }),
    [openWorkItem],
  )
}
