import { claimBrowserCommand } from '@/lib/browser-agent/command-handlers'
import { touchCloudBrowser } from '@/lib/cloud-browser/host'
import { relayActor } from '@/lib/cloud-browser/relay-routes'
import { ringComputer } from '@/lib/browser-agent/queue'

/** POST: the relay claims one command for its sandbox's browser (the shared compare-and-set). A claim is activity. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  const { id } = await params
  const response = await claimBrowserCommand(actor, id)
  if (response.ok) {
    await touchCloudBrowser({ userId: actor.userId, workspaceId: actor.workspaceId }).catch(() => {})
    // The computer card shows Working / Ready (C3).
    await ringComputer({ userId: actor.userId, workspaceId: actor.workspaceId }, 'computer-changed')
  }
  return response
}
