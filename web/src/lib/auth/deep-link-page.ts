/**
 * The HTML page a server route returns to hand the user back to the desktop app
 * on a `dial8desktop://` URL (meta refresh + script) while showing what
 * happened, with a visible "click here" fallback (/auth/desktop-callback).
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A page that opens `deepLink` (meta refresh + script) and shows `body` (trusted HTML). */
export function deepLinkPage({ title, deepLink, body }: { title: string; deepLink: string; body: string }): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta http-equiv="refresh" content="0;url=${escapeHtml(deepLink)}">
</head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #000; color: #fff;">
  <div style="text-align: center;">
    ${body}
  </div>
  <script>window.location.href = ${JSON.stringify(deepLink).replace(/</g, '\\u003c')};</script>
</body>
</html>`
}
