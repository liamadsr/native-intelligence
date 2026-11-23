/**
 * Imported text is someone else's text (docs/plans/imports.md, "Untrusted
 * files"): a Notion page, a Linear description, a CSV cell. Before it becomes
 * a document body or a task description:
 *
 *   HTML      every tag is removed (its words stay), outside code. Notion
 *             puts callouts (`<aside>`), toggles (`<details>`) and the odd
 *             `<img>` or `<br>` in its Markdown. The document editor reads
 *             markdown only and never renders raw HTML, so nothing is lost
 *             but the markup: an `<img src="https://…">` becomes a markdown
 *             image, a `<br>` a line break. Stricter than a paste, which
 *             keeps a safe subset; there is no subset an import needs.
 *   links     only http(s), mention:// and the import's own placeholders
 *             (`{{ref:…}}`, `{{asset:…}}`) survive. Any other target
 *             (javascript:, data:, file:, mailto:, a relative path that
 *             resolved to nothing) keeps its words and loses the link; an
 *             image with such a target is dropped.
 *
 * Pure and client-safe.
 */

const ALLOWED_TARGET = /^(https?:\/\/|mention:\/\/[a-z_]+\/[0-9a-fA-F-]{36}$|\{\{(ref|asset):[a-z_]+:\d+\}\}$)/i

export function allowedLinkTarget(target: string): boolean {
  return ALLOWED_TARGET.test(target.trim())
}

/** Split markdown into code (fenced blocks and inline spans, left alone) and prose. */
function mapProse(markdown: string, fn: (prose: string) => string): string {
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g)
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join('')
}

function stripHtml(prose: string): string {
  return prose
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi, (_m, src: string) => (/^https?:\/\//i.test(src) ? `![](${src})` : ''))
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<\/(p|div|aside|details|summary|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
}

const LINK = /(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g

function filterLinks(prose: string): string {
  return prose.replace(LINK, (whole, bang: string, text: string, target: string) => {
    const url = target.trim().split(/\s+/)[0].replace(/^<|>$/g, '')
    if (allowedLinkTarget(url)) return whole
    return bang ? '' : text
  })
}

/** Imported markdown made safe to store as a body (see the header). */
export function sanitizeImportedMarkdown(markdown: string): string {
  return mapProse(markdown, (prose) => filterLinks(stripHtml(prose)))
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}
