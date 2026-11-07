/** Schemes that run code or read local data in the browser: never a redirect target. */
export const UNSAFE_REDIRECT_SCHEMES: ReadonlySet<string> = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'])

/**
 * RFC 8252 redirect rules for an MCP OAuth client (registered by
 * register/route.ts, or published in a client metadata document): https
 * anywhere, plain http only to a loopback host, or a native app's
 * private-use scheme (cursor://, vscode://…). The consent page sends the
 * browser to this URI, so a script/data scheme is rejected.
 */
export function isAllowedRedirectUri(uri: unknown): boolean {
  if (typeof uri !== 'string') return false
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (UNSAFE_REDIRECT_SCHEMES.has(url.protocol)) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  }
  return true
}

/** A loopback http callback: an app on the person's own computer. */
export function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
