/**
 * The quiet label on what an agent learned or wrote after reading untrusted
 * outside text (decision 16 as apply with undo): nothing waits to be
 * accepted, so the label is how the person spots what rests on outside text
 * and removes or reverts it. "learned from a web page" on a teammate's memory
 * entry, "(from a web page)" on a canon edit's digest line and history.
 * Which tools count as outside text is outside-text.ts's one definition; this
 * only words it. Pure and client-safe: no imports.
 */

const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'research_my_company'])
const FILE_TOOLS = new Set(['get_attachment_content', 'ingest_reference', 'ingest_source'])

/**
 * What outside text these tools brought, in a few words ("a web page", "an
 * outside email"): the first kind found, web before mail before a connected
 * app before a file; "outside text" when the tools say no more (a subagent,
 * an unknown tool, or none named).
 */
export function outsideReadLabel(tools: readonly string[]): string {
  const names = tools.map((t) => (typeof t === 'string' ? t.replace(/^dial8_/, '') : ''))
  if (names.some((t) => WEB_TOOLS.has(t) || t.includes('browser') || t.includes('prospect'))) return 'a web page'
  if (names.some((t) => t.includes('email'))) return 'an outside email'
  if (names.some((t) => t.startsWith('mcp__'))) return 'a connected app'
  if (names.some((t) => FILE_TOOLS.has(t))) return 'a file'
  return 'outside text'
}

/** An outside source a canon edit named, in a few words, with only a domain for a page or a mail ("a web page on acme.com"). */
export function outsideSourceLabel(source: { kind: string; url?: string; domain?: string }): string {
  switch (source.kind) {
    case 'web': {
      const domain = source.domain ?? domainOf(source.url)
      return domain ? `a web page on ${domain}` : 'a web page'
    }
    case 'email':
      return source.domain ? `an outside email from ${source.domain}` : 'an outside email'
    case 'message':
      return 'a message from outside the workspace'
    case 'file':
      return 'a file'
    case 'connected_app':
      return 'a connected app'
    default:
      return 'outside text'
  }
}

/** The domain of an email sender as given ("Ana <ana@Acme.com>", "ana@acme.com"), lower-cased, or null. */
export function emailDomain(from: string | undefined): string | null {
  const m = from ? /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(from) : null
  return m ? m[1].toLowerCase() : null
}

/** A URL's host, without "www.", or null. */
export function domainOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null
  } catch {
    return null
  }
}
