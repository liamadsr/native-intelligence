/**
 * Copy text to the clipboard without ever rejecting.
 *
 * `navigator.clipboard.writeText` throws NotAllowedError in embedded webviews
 * (Apple Mail's link preview, some in-app browsers) and on pages without
 * clipboard permission; call sites fire it from onClick handlers where a
 * rejection becomes an unhandled-promise error. This wraps it with the legacy
 * execCommand('copy') fallback and resolves `false` when both paths fail.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      textarea.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * Copy text that is still being built (a fetch, a dynamic import) from a click,
 * without losing the click's user activation.
 *
 * WKWebView (the desktop app) and Safari only allow a clipboard write while the
 * click's activation lasts, so `await build(); writeText(text)` fails once the
 * build takes a few round trips. This starts the write synchronously, inside
 * the caller's click, with a ClipboardItem whose value is a promise of the
 * text; the browser holds the write open until the promise settles. Where
 * ClipboardItem is missing (or refuses a promise value) it falls back to
 * copyTextToClipboard once the text is ready.
 *
 * Call it synchronously from the event handler (no await before it). Never
 * rejects: resolves false when nothing was copied, including when `text`
 * rejects.
 */
export async function copyDeferredTextToClipboard(text: Promise<string>): Promise<boolean> {
  const settled = text.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  )

  const canWriteItem =
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  if (canWriteItem) {
    try {
      const blob = settled.then((r) => {
        if (!r.ok) throw new Error('nothing to copy')
        return new Blob([r.value], { type: 'text/plain' })
      })
      // Both calls run before this function's first await: still inside the click.
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      return true
    } catch {
      // Fall through: the text may still be copyable the plain way.
    }
  }

  const r = await settled
  if (!r.ok) return false
  return copyTextToClipboard(r.value)
}

/**
 * Copy a document so it pastes well anywhere (P9, decision 9: the person
 * copies their newsletter into Substack, HubSpot or Mailchimp): the markdown
 * as text/plain, and its HTML as text/html, so a rich editor keeps the
 * headings, lists and links. The HTML may still be rendering: like
 * copyDeferredTextToClipboard, the write starts inside the click. Where a
 * rich write isn't possible, the markdown alone is copied. Never rejects.
 */
export async function copyRichTextToClipboard(markdown: string, html: Promise<string>): Promise<boolean> {
  const canWriteItem =
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  if (canWriteItem) {
    try {
      const htmlBlob = html.then((value) => new Blob([value], { type: 'text/html' }), () => new Blob([markdown], { type: 'text/html' }))
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([markdown], { type: 'text/plain' }), 'text/html': htmlBlob })])
      return true
    } catch {
      // Fall through to the plain text.
    }
  }
  return copyTextToClipboard(markdown)
}
