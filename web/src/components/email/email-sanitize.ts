'use client'

import DOMPurify from 'dompurify'
import { emailCanvasMode, luminance, parseCssColor, readBodyPaint, type BodyPaint, type EmailCanvasMode } from './email-colors'

/**
 * CSS an email may not bring, in a <style> block or a style attribute:
 *  - `@import`: a stylesheet fetched from the sender's server, which says the
 *    mail was opened and can change after delivery;
 *  - rules aimed at the shadow host (`:host`, `::slotted`), which would style
 *    our own element instead of the email's;
 *  - `position: fixed | sticky`, which would let it draw over the app (the
 *    host also contains its layout, in buildThemeStyles);
 *  - `behavior`, `-moz-binding` and `expression()`, old script hooks.
 * Everything else stays as the sender wrote it.
 */
export function sanitizeEmailCss(css: string): string {
  return css
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/[^{}]*(?::host\b|::slotted\b)[^{}]*\{[^{}]*\}/gi, '')
    .replace(/position\s*:\s*(?:fixed|sticky)/gi, 'position: static')
    .replace(/(?:behavior|-moz-binding)\s*:[^;}]*/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
}

/**
 * Sanitize raw email HTML with DOMPurify — removes scripts, event handlers, etc.
 */
export function sanitizeEmailHtml(html: string): string {
  if (typeof window === 'undefined') return html

  const clean = DOMPurify.sanitize(html, {
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
  return tightenEmailCss(clean)
}

/** Run every <style> block and style attribute through sanitizeEmailCss. */
function tightenEmailCss(html: string): string {
  if (!/style|@import|position/i.test(html)) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let touched = false
  doc.querySelectorAll('style').forEach((el) => {
    const css = el.textContent || ''
    const next = sanitizeEmailCss(css)
    if (next !== css) {
      el.textContent = next
      touched = true
    }
  })
  doc.querySelectorAll('[style]').forEach((el) => {
    const css = el.getAttribute('style') || ''
    const next = sanitizeEmailCss(css)
    if (next !== css) {
      el.setAttribute('style', next)
      touched = true
    }
  })
  if (!touched) return html
  const headStyles = Array.from(doc.head.querySelectorAll('style'), (el) => el.outerHTML).join('')
  return headStyles + doc.body.innerHTML
}

export interface EmailDisplayOptions {
  /** The page colours the email's own <body> asked for (readBodyPaint, from the raw HTML). */
  bodyPaint?: BodyPaint
}

export interface EmailDisplay {
  html: string
  /** "canvas": drawn as authored on its own page. "adapt": on the theme, to be re-coloured once mounted. */
  mode: EmailCanvasMode
  /** The background the email's text sits on: what adaptEmailColors measures against. */
  pageBackground: string
}

/** Sanitize a raw email and prepare it for the page, in one go. */
export function prepareEmailForDisplay(rawHtml: string, isDark: boolean): EmailDisplay {
  return processEmailDisplay(sanitizeEmailHtml(rawHtml), isDark, { bodyPaint: readBodyPaint(rawHtml) })
}

/**
 * Process sanitized HTML for display inside Shadow DOM:
 * - Collapse quoted text into <details>/<summary>
 * - Remove tracking pixels
 * - Force links to open externally
 * - Inject theme-aware CSS via :host
 */
export function processEmailForDisplay(sanitizedHtml: string, isDark: boolean, options: EmailDisplayOptions = {}): string {
  return processEmailDisplay(sanitizedHtml, isDark, options).html
}

function processEmailDisplay(sanitizedHtml: string, isDark: boolean, options: EmailDisplayOptions): EmailDisplay {
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

  // 5. Which way it is drawn (email-colors): a designed email, or one whose
  // <body> set a page colour, keeps its own page; a plain one takes the theme's.
  const paint = options.bodyPaint ?? {}
  const mode: EmailCanvasMode = paint.background ? 'canvas' : emailCanvasMode(doc)
  const canvas = mode === 'canvas' ? { background: paint.background ?? '#ffffff', color: paint.color } : null
  // The palette follows the page the text is on: the canvas's, else the theme's.
  const canvasColor = canvas ? parseCssColor(canvas.background) : null
  const darkPalette = canvasColor ? luminance(canvasColor) < 0.4 : isDark

  // 6. Build theme-aware CSS for :host (Shadow DOM root)
  const themeStyles = buildThemeStyles(darkPalette, canvas ? { ...canvas, framed: isDark !== darkPalette || !!paint.background } : null)
  // A leading <style> parses into the head; keep the email's own CSS.
  const headStyles = Array.from(doc.head.querySelectorAll('style'), (el) => el.outerHTML).join('')
  const bodyHtml = doc.body.innerHTML

  return {
    html: `${themeStyles}${headStyles}${bodyHtml}`,
    mode,
    pageBackground: canvas?.background ?? (isDark ? THEME_DARK_BG : THEME_LIGHT_BG),
  }
}

const THEME_DARK_BG = '#1a1a1a'
const THEME_LIGHT_BG = '#ffffff'

/**
 * The base stylesheet. `canvas`: the email's own page (its background, its
 * text colour when it set one), framed with a little padding and rounded
 * corners when it differs from the app's theme, so it reads as a sheet of
 * paper and not as a broken panel.
 */
function buildThemeStyles(isDark: boolean, canvas: { background: string; color?: string; framed: boolean } | null = null): string {
  const bg = canvas?.background ?? (isDark ? THEME_DARK_BG : THEME_LIGHT_BG)
  const fg = canvas?.color ?? (isDark ? '#e5e5e5' : '#1a1a1a')
  const fgMuted = isDark ? '#a3a3a3' : '#6b7280'
  const linkColor = isDark ? '#60a5fa' : '#2563eb'
  const borderColor = isDark ? '#374151' : '#d1d5db'
  const quoteBg = isDark ? '#262626' : '#f9fafb'
  const hrColor = isDark ? '#374151' : '#e5e7eb'
  const codeBg = isDark ? '#262626' : '#f3f4f6'

  return `<style>
  :host {
    display: block;
    /* A plain email sits straight on the message card; only a canvas paints a page. */
    background-color: ${canvas ? bg : 'transparent'};
    color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    word-break: break-word;
    overflow-wrap: break-word;
    -webkit-font-smoothing: antialiased;
    padding: ${canvas?.framed ? '16px' : '0'};
    border-radius: ${canvas?.framed ? '8px' : '0'};
    /* The email lays out and paints inside this box: nothing in it can be
       positioned over the app, and its form controls and scrollbars follow
       the page it is on, not the app's theme. */
    contain: content;
    color-scheme: ${isDark ? 'dark' : 'light'};
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
