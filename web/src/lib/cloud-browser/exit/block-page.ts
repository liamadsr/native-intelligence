/**
 * A page that turns the browser away rather than showing the site
 * (docs/plans/cloud-browser.md, C4), read from what the agent observes:
 * - `blocked`: the site refused this address (Akamai "Access Denied",
 *   Cloudflare's block or challenge, Imperva). On the cloud exit, the relay
 *   remembers the site as needing the person's Mac and stops: the agent never
 *   solves a challenge or a CAPTCHA.
 * - `agent_ban`: the site forbids AI agents outright. Never automated again.
 * Signatures are the pages' own titles, or their fixed wording on a page that
 * is little else (a block page is short): a long page that merely quotes them
 * (an article, a forum thread) is never one.
 */
export type BlockKind = 'blocked' | 'agent_ban'

const TITLES: RegExp[] = [
  /^access denied$/i,
  /^attention required! \| cloudflare$/i,
  /^just a moment\.{3}$/i,
  /^pardon our interruption/i,
  /^request rejected$/i,
  /^access to this page has been denied\.?$/i,
]
const TEXTS: [RegExp, BlockKind][] = [
  [/unauthorized ai agent violates/i, 'agent_ban'],
  [/you don't have permission to access .{1,200} on this server/i, 'blocked'],
  [/sorry, you have been blocked/i, 'blocked'],
  [/request unsuccessful\. incapsula incident id/i, 'blocked'],
  [/verify you are human by completing the action below/i, 'blocked'],
  [/press (?:&|and) hold to confirm you are a human/i, 'blocked'],
]
/** A block page says its piece and little else. */
const SHORT_PAGE = 1500

export function blockPage(observation: { title?: string; text?: string }): BlockKind | null {
  const title = (observation.title ?? '').trim()
  const text = (observation.text ?? '').trim()
  const titled = TITLES.some(pattern => pattern.test(title))
  // The wording counts on a short page, or under a block page's own title.
  const said = text.length <= SHORT_PAGE || titled ? TEXTS.find(([pattern]) => pattern.test(text))?.[1] ?? null : null
  if (said === 'agent_ban') return said
  return titled ? 'blocked' : said
}
