/**
 * Lightweight custom event system for cross-component navigation.
 * Used by DeepLinkHandler (root layout) to communicate with
 * SettingsOverlayProvider (dashboard layout) without hard navigations.
 */

export interface OAuthCallbackDetail {
  success: boolean
  provider: string
  capability: string
  error?: string
}

export interface SoftNavigateDetail {
  path: string
}

/** Fire when an OAuth integration callback completes (desktop deep link) */
export function emitOAuthCallback(detail: OAuthCallbackDetail) {
  window.dispatchEvent(new CustomEvent('ni:oauth-callback', { detail }))
}

/** Fire to request soft navigation (avoids window.location.href) */
export function emitSoftNavigate(detail: SoftNavigateDetail) {
  window.dispatchEvent(new CustomEvent('ni:soft-navigate', { detail }))
}

/** Subscribe to OAuth callbacks */
export function onOAuthCallback(handler: (detail: OAuthCallbackDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<OAuthCallbackDetail>).detail)
  window.addEventListener('ni:oauth-callback', listener)
  return () => window.removeEventListener('ni:oauth-callback', listener)
}

/**
 * A desktop MCP connector connect this window started: its claim began
 * ('claiming', the deep link arrived), or it ended ('done', with the claim's
 * answer). `state` names the flow, so a listener acts on its own only.
 */
export type McpOAuthCallbackDetail =
  | { state: string; phase: 'claiming' }
  | {
      state: string
      phase: 'done'
      success: boolean
      /** The connector's name, on success. */
      name?: string
      error?: string
    }

/** Fire when a desktop MCP connect's claim settles (desktop-oauth-claims.ts). */
export function emitMcpOAuthCallback(detail: McpOAuthCallbackDetail) {
  window.dispatchEvent(new CustomEvent('ni:mcp-oauth-callback', { detail }))
}

/** Subscribe to desktop MCP connect outcomes. */
export function onMcpOAuthCallback(handler: (detail: McpOAuthCallbackDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<McpOAuthCallbackDetail>).detail)
  window.addEventListener('ni:mcp-oauth-callback', listener)
  return () => window.removeEventListener('ni:mcp-oauth-callback', listener)
}

/** Subscribe to soft navigation requests */
export function onSoftNavigate(handler: (detail: SoftNavigateDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<SoftNavigateDetail>).detail)
  window.addEventListener('ni:soft-navigate', listener)
  return () => window.removeEventListener('ni:soft-navigate', listener)
}
