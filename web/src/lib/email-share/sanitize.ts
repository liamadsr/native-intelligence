import sanitizeHtml from 'sanitize-html'

/** An http(s) or protocol-relative address: something a reader's browser would fetch. */
const REMOTE = /^\s*(?:https?:)?\/\//i
/** A CSS `url(...)`, quoted or not. */
const CSS_URL = /url\s*\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi
/** A CSS `@import`, which fetches whatever it names. */
const CSS_IMPORT = /@import\b[^;]*;?/gi

/**
 * A shared message's HTML, sanitized on the server before it leaves (the
 * reader's view runs it through src/components/email/email-sanitize.ts too):
 * the same tags and attributes that sanitizer keeps, no scripts, no event
 * handlers, no forms, only http(s), mailto, cid and (for images) data links.
 *
 * Nothing remote loads in a reader's browser unless they ask for it (a
 * tracking pixel would tell the sender, or anyone, that the mail was opened
 * and from where): by default an image's remote `src` is dropped (its `alt`
 * stays) and every remote CSS `url(...)`, in a style attribute or a <style>,
 * becomes `none`; `blocked` counts them, so the view can offer "Load images".
 * With `images`, those are kept, and everything else is as strict. A `data:`
 * image inside the mail is kept either way. CSS `@import` is always dropped.
 */
export function sanitizeSharedEmailHtml(html: string, opts: { images?: boolean } = {}): { html: string; blocked: number } {
  const images = opts.images === true
  let blocked = 0
  const css = (text: string): string =>
    text.replace(CSS_IMPORT, '').replace(CSS_URL, (whole: string, _quote: string, url: string) => {
      if (/^\s*data:image\//i.test(url)) return whole
      if (images && REMOTE.test(url)) return whole
      if (REMOTE.test(url)) blocked++
      return 'none'
    })
  // <style> text passes through the sanitizer as-is, so its urls are rewritten first.
  const styled = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m: string, open: string, text: string, close: string) => open + css(text) + close)
  const out = sanitizeHtml(styled, {
    allowedTags: [
      'p', 'div', 'span', 'a', 'br', 'hr', 'table', 'thead', 'tbody',
      'tr', 'td', 'th', 'img', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'font',
      'center', 'small', 'sub', 'sup', 'details', 'summary', 'style',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'title', 'align', 'valign', 'bgcolor', 'color', 'width', 'height', 'border', 'cellpadding', 'cellspacing'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attribs) => {
        if (!images && attribs.src && REMOTE.test(attribs.src)) {
          blocked++
          const { src: _src, ...rest } = attribs
          return { tagName, attribs: rest }
        }
        return { tagName, attribs }
      },
      '*': (tagName, attribs) => (attribs.style ? { tagName, attribs: { ...attribs, style: css(attribs.style) } } : { tagName, attribs }),
    },
    // A <style> is kept (mail lays itself out with one); its text is CSS, never markup.
    allowVulnerableTags: true,
    disallowedTagsMode: 'discard',
  })
  return { html: out, blocked }
}

/** The words of an HTML body, for a preview line or a text-only reader. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: ['style', 'script', 'textarea', 'option', 'title', 'head'] })
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
