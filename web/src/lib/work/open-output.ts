/**
 * A delivered item opens to its OUTPUT, not to the process (Liam, 10-15:
 * "when something is delivered to me, it should go to that artifact"). A
 * teammate's report in the chat and a review card in the chat's For you
 * column open the item's primary deliverable on its own surface (the
 * document, the draft in Mail, the capture, the link) through the opener the
 * work item panel uses (./open-deliverable.ts openDeliverable). With nothing
 * to open (a question, a failure, a review whose result is its summary), or
 * when the output can't be opened, the item opens where any item opens
 * (useOpenWorkItem: its bot's page, beside its run's chat).
 *
 * Pure orchestration over injected openers, so it is unit-tested without the
 * shell; src/hooks/use-open-output.ts wires it.
 */
import type { DeliverableContext, DeliverableNav } from './open-deliverable'
import type { WorkDeliverable } from './types'

export interface DeliveredItem {
  workItemId: string
  /** The item's workspace (null: unknown, the one on screen). */
  workspaceId: string | null
  title?: string | null
  /** Its teammate: null, none; left out, unknown (the item's lookup says). */
  teammateId?: string | null
  /** Its primary deliverable (presentation.ts primaryDeliverable), or null. */
  output: WorkDeliverable | null
}

export interface OpenOutputDeps {
  /** The workspace on screen. */
  currentWorkspaceId: string | null
  contextFor: (workId: string, d: WorkDeliverable) => Promise<DeliverableContext>
  openDeliverable: (d: WorkDeliverable, ctx: DeliverableContext, nav: DeliverableNav) => Promise<boolean>
  /** Open the item itself (its run's chat). */
  openItem: (item: DeliveredItem) => void
}

/** Open the item's output, else the item. Says which opened. */
export async function openOutputOrItem(item: DeliveredItem, deps: OpenOutputDeps): Promise<'output' | 'item'> {
  const output = item.output
  if (output) {
    const workspaceId = output.workspace_id || item.workspaceId || deps.currentWorkspaceId || ''
    const foreign = !!deps.currentWorkspaceId && !!workspaceId && workspaceId !== deps.currentWorkspaceId
    try {
      const ctx = await deps.contextFor(item.workItemId, output)
      const opened = await deps.openDeliverable(output, ctx, { workspaceId, foreignWorkspaceId: foreign ? workspaceId : null })
      if (opened) return 'output'
    } catch {
      // Couldn't open the output: the item still opens, where it says what it made.
    }
  }
  deps.openItem(item)
  return 'item'
}
