import { settleBrowserCommand } from '@/lib/browser-agent/command-handlers'
import { touchCloudBrowser } from '@/lib/cloud-browser/host'
import { relayActor } from '@/lib/cloud-browser/relay-routes'
import { ringComputer } from '@/lib/browser-agent/queue'

/** POST: the relay reports a command it claimed (the shared handler: its own device's rows only). Settling is activity. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  const { id } = await params
  const response = await settleBrowserCommand(actor, id, request)
  if (response.ok) {
    await touchCloudBrowser({ userId: actor.userId, workspaceId: actor.workspaceId }).catch(() => {})
    // The computer card shows Working / Ready (C3).
    await ringComputer({ userId: actor.userId, workspaceId: actor.workspaceId }, 'computer-changed')
  }
  return response
}
