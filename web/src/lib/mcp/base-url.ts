import { appUrl, appUrlOnHost } from '@/lib/app-url'

/**
 * The address an MCP client reached this server at, for the OAuth metadata,
 * the 401 challenge and the sign-in redirect it gets back. A client checks the
 * `resource` in the metadata against the URL it connected to (RFC 9728), and
 * the hosted app answers on two domains while it moves (src/lib/app-url.ts):
 * a request on either gets that domain, so a client set up on the old one
 * keeps working after NEXT_PUBLIC_APP_URL names the new one. Any other host
 * (a preview, local dev) gets `fallback`.
 */
export function mcpBaseUrl(request: Request, fallback: string = appUrl()): string {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))?.split(',')[0]?.trim()
  return appUrlOnHost(host, fallback)
}
