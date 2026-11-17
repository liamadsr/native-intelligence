import { relayActor } from '@/lib/cloud-browser/relay-routes'
import { allowSignInFill } from '@/lib/cloud-browser/sign-in-card'

/** POST { url }: may the relay fill the person's saved login into this sign-in page now? The server holds no login: it only says yes or no. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await relayActor(request)
  if (actor instanceof Response) return actor
  const { id } = await params
  return allowSignInFill(actor, id, request)
}
