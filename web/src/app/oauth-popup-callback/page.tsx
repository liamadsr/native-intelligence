'use client'

/**
 * Lightweight page that OAuth popup windows land on after the server callback
 * redirects here. Reads query params, posts a message to the opener window,
 * and closes itself. No layout chrome needed — the user never really sees this.
 */
export default function OAuthPopupCallback() {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    const message = {
      type: 'dial8:oauth-popup-result',
      success: params.get('integration_success') === 'true',
      provider: params.get('provider') || '',
      capability: params.get('capability') || '',
      error: params.get('error') || undefined,
    }

    if (window.opener) {
      window.opener.postMessage(message, window.location.origin)
      window.close()
    } else {
      // Fallback: if opener is gone (e.g. user closed the tab), redirect to Connectors
      window.location.replace('/account/settings/connectors?' + params.toString())
    }
  }

  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      Completing connection...
    </div>
  )
}
