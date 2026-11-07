'use client'

import DOMPurify from 'dompurify'

/**
 * Sanitize raw email HTML with DOMPurify — removes scripts, event handlers, etc.
 */
export function sanitizeEmailHtml(html: string): string {
  if (typeof window === 'undefined') return html

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'div', 'span', 'a', 'br', 'hr', 'table', 'thead', 'tbody',
      'tr', 'td', 'th', 'img', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'font',
      'center', 'small', 'sub', 'sup', 'details', 'summary', 'style',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'style', 'class', 'width', 'height',
      'border', 'cellpadding', 'cellspacing', 'align', 'valign', 'bgcolor', 'color',
      'target', 'rel',
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
    // Keep a <style> from the email's <head> (or its first tag): without it
    // the parser puts it in the head, and only the body comes back.
    FORCE_BODY: true,
  })
}

/**
 * Process sanitized HTML for display inside Shadow DOM:
 * - Collapse quoted text into <details>/<summary>
 * - Remove tracking pixels
 * - Force links to open externally
 * - Inject theme-aware CSS via :host
 */
export function processEmailForDisplay(sanitizedHtml: string, isDark: boolean): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(sanitizedHtml, 'text/html')

  // 1. Force all links to open in new tab
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })

  // 2. Remove tracking pixels (1x1 images)
  doc.querySelectorAll('img').forEach((img) => {
    const w = img.getAttribute('width')
    const h = img.getAttribute('height')
    if ((w === '1' || w === '0') && (h === '1' || h === '0')) {
      img.remove()
      return
    }
    // Also check style for display:none / font-size:0 (preheader hacks)
    const style = img.getAttribute('style') || ''
    if (style.includes('display:none') || style.includes('display: none')) {
      img.remove()
    }
  })

  // 3. Remove hidden preheader content
  doc.querySelectorAll('div, span').forEach((el) => {
    const style = (el.getAttribute('style') || '').toLowerCase()
    if (
      (style.includes('display:none') || style.includes('display: none')) &&
      (style.includes('font-size:0') || style.includes('font-size: 0') || style.includes('max-height:0') || style.includes('max-height: 0'))
    ) {
      el.remove()
    }
  })

  // 4. Collapse quoted text (Gmail-style blockquotes and .gmail_quote)
  doc.querySelectorAll('blockquote, .gmail_quote, .yahoo_quoted, .moz-cite-prefix').forEach((quote) => {
    // Don't nest collapsibles
    if (quote.closest('details')) return

    const details = doc.createElement('details')
    details.className = 'quoted-toggle'

    const summary = doc.createElement('summary')
    summary.textContent = 'Show quoted text'
    details.appendChild(summary)

    // Move quote content into details
    const wrapper = doc.createElement('div')
    wrapper.className = 'quoted-content'
    wrapper.innerHTML = quote.innerHTML
    details.appendChild(wrapper)

    quote.replaceWith(details)
  })

  // 5. Build theme-aware CSS for :host (Shadow DOM root)
  const themeStyles = buildThemeStyles(isDark)
  // A leading <style> parses into the head; keep the email's own CSS.
  const headStyles = Array.from(doc.head.querySelectorAll('style'), (el) => el.outerHTML).join('')
  const bodyHtml = doc.body.innerHTML

  return `${themeStyles}${headStyles}${bodyHtml}`
}

function buildThemeStyles(isDark: boolean): string {
  const bg = isDark ? '#1a1a1a' : '#ffffff'
  const fg = isDark ? '#e5e5e5' : '#1a1a1a'
  const fgMuted = isDark ? '#a3a3a3' : '#6b7280'
  const linkColor = isDark ? '#60a5fa' : '#2563eb'
  const borderColor = isDark ? '#374151' : '#d1d5db'
  const quoteBg = isDark ? '#262626' : '#f9fafb'
  const hrColor = isDark ? '#374151' : '#e5e7eb'
  const codeBg = isDark ? '#262626' : '#f3f4f6'

  return `<style>
  :host {
    display: block;
    background-color: ${bg};
    color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    word-break: break-word;
    overflow-wrap: break-word;
    -webkit-font-smoothing: antialiased;
    padding: 0;
  }

  /* Reset email styles that may conflict */
  * {
    max-width: 100%;
    box-sizing: border-box;
  }

  /* Typography */
  p { margin: 0 0 1em 0; }
  h1, h2, h3, h4, h5, h6 {
    color: ${fg};
    margin: 0 0 0.5em 0;
  }

  /* Links */
  a {
    color: ${linkColor};
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  a:hover {
    text-decoration-thickness: 2px;
  }

  /* Images */
  img {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }

  /* Tables (common in email layouts) */
  table {
    border-collapse: collapse;
    max-width: 100%;
  }
  td, th {
    vertical-align: top;
  }

  /* Horizontal rules */
  hr {
    border: none;
    border-top: 1px solid ${hrColor};
    margin: 1em 0;
  }

  /* Code */
  pre, code {
    background-color: ${codeBg};
    border-radius: 4px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 13px;
  }
  pre {
    padding: 12px;
    overflow-x: auto;
  }
  code {
    padding: 2px 4px;
  }

  /* Blockquotes */
  blockquote {
    border-left: 3px solid ${borderColor};
    padding-left: 12px;
    margin: 0.5em 0;
    color: ${fgMuted};
  }

  /* Quoted text toggle (collapsed by default) */
  details.quoted-toggle {
    margin-top: 1em;
    border-left: 2px solid ${borderColor};
    padding-left: 12px;
  }
  details.quoted-toggle summary {
    cursor: pointer;
    color: ${fgMuted};
    font-size: 12px;
    user-select: none;
    padding: 4px 0;
  }
  details.quoted-toggle summary:hover {
    color: ${linkColor};
  }
  details.quoted-toggle .quoted-content {
    margin-top: 8px;
    color: ${fgMuted};
  }

  /* Lists */
  ul, ol {
    padding-left: 1.5em;
    margin: 0.5em 0;
  }
  li { margin: 0.25em 0; }

  /* Font tag fallback */
  font { font-family: inherit !important; }
</style>`
}
