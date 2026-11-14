import sanitizeHtml from 'sanitize-html'

/**
 * A shared message's HTML, sanitized on the server before it leaves (the
 * reader's view runs it through src/components/email/email-sanitize.ts too):
 * the same tags and attributes that sanitizer keeps, no scripts, no event
 * handlers, no forms, only http(s), mailto and cid links and images.
 */
export function sanitizeSharedEmailHtml(html: string): string {
  return sanitizeHtml(html, {
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
    allowedSchemesByTag: { img: ['http', 'https', 'cid'] },
    allowProtocolRelative: false,
    // A <style> is kept (mail lays itself out with one); its text is CSS, never markup.
    allowVulnerableTags: true,
    disallowedTagsMode: 'discard',
  })
}

/** The words of an HTML body, for a preview line or a text-only reader. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: ['style', 'script', 'textarea', 'option', 'title', 'head'] })
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
