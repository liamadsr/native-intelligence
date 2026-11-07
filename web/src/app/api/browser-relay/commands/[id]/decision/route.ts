import { decideBrowserStep } from '@/lib/browser-agent/command-handlers'
import { relayActor } from '@/lib/cloud-browser/relay-routes'

export const maxDuration = 20

/** POST: a task's next action for the relay that holds its lease (the shared handler, all checks as for a desktop). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = performance.now()
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  const { id } = await params
  return decideBrowserStep(actor, id, request, started, Math.max(0, Math.round(performance.now() - started)))
}
