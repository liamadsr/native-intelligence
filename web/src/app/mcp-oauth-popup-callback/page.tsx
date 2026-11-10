'use client'

/**
 * Landing page for the popup window (web) or system-browser tab (desktop)
 * after an external MCP server OAuth flow completes.
 *
 *   - Web:     window.opener is the Native Intelligence tab → postMessage and close.
 *   - Desktop: opener is null because the auth happened in the system
 *              browser. Show a "you can close this tab" message; the
 *              Native Intelligence desktop window has its own focus-based refetcher.
 */
import { useEffect, useState } from 'react'

export default function McpOAuthPopupCallback() {
  const [done, setDone] = useState<{ success: boolean; name: string; error?: string } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const message = {
      type: 'ni:mcp-oauth-popup-result',
      success: params.get('success') === 'true',
      name: params.get('name') || '',
      tool_count: Number(params.get('tool_count') || 0),
      error: params.get('error') || undefined,
    }

    if (window.opener) {
      window.opener.postMessage(message, window.location.origin)
      window.close()
    } else {
      // System-browser path (desktop). The Native Intelligence window already polls
      // on focus, so we don't need to deep-link back — just tell the
      // user they can close this tab.
      setDone({
        success: message.success,
        name: message.name,
        error: message.error,
      })
    }
  }, [])

  return (
    <div className="flex h-screen items-center justify-center px-6">
      {done ? (
        <div className="text-center max-w-sm">
          {done.success ? (
            <>
              <h1 className="text-lg font-semibold">
                {done.name ? `Connected ${done.name}` : 'Connected'}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                You can close this tab and return to Native Intelligence.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-red-600">Connection failed</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {done.error || 'The MCP server did not approve the connection.'}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                You can close this tab and try again from Native Intelligence.
              </p>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Completing MCP connection…</p>
      )}
    </div>
  )
}
