import { relayActor } from '@/lib/cloud-browser/relay-routes'
import { requestBrowserSignIn } from '@/lib/cloud-browser/sign-in-card'

/** POST { url, tabId }: the relay's task reached a sign-in page; raise the card that asks the person to sign in. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await relayActor(request)
  if (actor instanceof Response) return actor
  const { id } = await params
  return requestBrowserSignIn(actor, id, request)
}
