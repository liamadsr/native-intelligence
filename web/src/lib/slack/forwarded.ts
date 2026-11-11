/**
 * The check on a request Vercel Connect forwarded to this app (the events
 * route, and the interactivity route when the request carries a bearer).
 * Connect attaches a Vercel OIDC token; createConnectWebhookVerifier checks
 * it against Vercel's JWKS and requires its project and environment claims to
 * be ours.
 *
 * On Vercel "ours" is the deployment's VERCEL_PROJECT_ID and
 * VERCEL_TARGET_ENV / VERCEL_ENV (the verifier's defaults). Off Vercel those
 * are unset (and must stay unset: other code branches on VERCEL_ENV), so
 * CONNECT_PROJECT_ID and CONNECT_ENVIRONMENT name them explicitly
 * (./config.ts). Either way it fails closed: no project or environment, no
 * request, and a `*` in either setting refuses every request.
 */
import { createConnectWebhookVerifier } from '@vercel/connect/chat'
import { connectForwardTarget } from './config'

/** Throws when the request is not one Connect forwarded for our project and environment. */
export async function verifyConnectForward(request: Request, body: string): Promise<void> {
  const target = connectForwardTarget()
  if (target === 'refuse') throw new Error('CONNECT_PROJECT_ID or CONNECT_ENVIRONMENT holds a *: every forwarded request is refused')
  // Built per request so the settings are read at call time; the JWKS is
  // cached by the OIDC package, not by the verifier.
  await createConnectWebhookVerifier(target)(request, body)
}
