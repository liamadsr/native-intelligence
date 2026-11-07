import { requestBrowserApproval } from '@/lib/cloud-browser/approval-card'
import { relayActor } from '@/lib/cloud-browser/relay-routes'

/** POST { summary, tabId }: the relay's task reached a sensitive step; raise its approval card. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  const { id } = await params
  return requestBrowserApproval(actor, id, request)
}
