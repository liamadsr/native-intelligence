/**
 * The robots.txt rules this crawler follows, read so that no file can make a
 * check slow, and no shortcut is ever looser than the file.
 *
 * Only the group that applies to us is kept: our own token's, else `*`
 * (rules of every group naming the same agent add up, as in robots-parser).
 * Each of its rules is then made cheap to match:
 *
 *   - a run of `*` is one wildcard (the same rule);
 *   - a rule whose literal text is longer than any URL the crawl reads is
 *     dropped: it can never match;
 *   - a rule of more than 8 wildcards is made stricter, never looser: a
 *     Disallow keeps its pattern up to the 8th wildcard (it then matches
 *     everything it named, and more), an Allow is dropped.
 *
 * Every rule keeps the precedence of the pattern as written (its length), so
 * a shortened Disallow still beats every Allow it beat before. A group of
 * more than 5,000 rules is refused (ROBOTS_TOO_COMPLEX).
 *
 * Matching is greedy over a rule's literal pieces (one string search each,
 * left to right), which is exact for patterns of `*` and an ending `$`: a
 * rule costs at most 9 searches of a URL of at most 2,048 characters, where
 * the dynamic matching robots-parser does cost one step per pattern
 * character per path position. The answers are robots-parser's; the tests
 * compare the two on random files.
 *
 * Only the path and query are matched: robots.txt is read from the audit's
 * origin, and every URL asked about is that site's (www or not, http or
 * https), so the scheme, host and port are the robots file's by definition.
 * A URL that can't be read is not allowed.
 */
import { AuditFailure } from './failure'
import { CRAWLER_TOKEN, MAX_URL_CHARS } from './limits'

/** Rules one group may have, after the cheap-to-match pass. */
export const MAX_ROBOTS_RULES = 5_000
/** Wildcards one rule may keep. */
const MAX_RULE_WILDCARDS = 8
/** Time one audit step may spend in robots checks. */
export const ROBOTS_STEP_BUDGET_MS = 10_000
/** Checks between two yields to the event loop. */
export const ROBOTS_YIELD_EVERY = 256
/** Answers remembered per path (pages link to the same URLs again and again). */
const MEMO_ENTRIES = 10_000

const TOO_COMPLEX =
  'This site’s robots.txt has more rules than the audit can follow, so it wasn’t crawled.'

export interface RobotsResult {
  /** Whether the crawler may fetch `url`. A URL that can't be read: no. */
  isAllowed: (url: string) => boolean
  sitemapUrls: string[]
}

interface Rule {
  allow: boolean
  /** The literal pieces between wildcards; the first is anchored at the start of the path. */
  pieces: string[]
  /** The pattern ended in `$`: the last piece must end the path. */
  anchored: boolean
  /** The pattern's length as written: the longest matching rule wins, Allow on a tie. */
  priority: number
}

/** Lower case, without a version ("Bot/1.0" is "bot"), as robots-parser reads agents. */
function formatUserAgent(value: string): string {
  const lower = value.toLowerCase()
  const slash = lower.indexOf('/')
  return (slash > -1 ? lower.slice(0, slash) : lower).trim()
}

function urlEncodeToUpper(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (match) => match.toUpperCase())
}

function normaliseEncoding(pattern: string): string {
  try {
    return urlEncodeToUpper(encodeURI(pattern).replace(/%25/g, '%'))
  } catch {
    return pattern
  }
}

/** A rule made cheap to match, or null when it is dropped (see the header). */
function compileRule(pattern: string, allow: boolean): Rule | null {
  const normalised = normaliseEncoding(pattern)
  const anchored = normalised.endsWith('$')
  const body = anchored ? normalised.slice(0, -1) : normalised
  const split = body.split('*')
  // A run of `*` leaves empty pieces between its stars: drop them.
  let pieces =
    split.length === 1
      ? split
      : [split[0], ...split.slice(1, -1).filter(Boolean), split[split.length - 1]]
  let literal = 0
  for (const piece of pieces) literal += piece.length
  if (literal > MAX_URL_CHARS) return null
  let ends = anchored
  if (pieces.length - 1 > MAX_RULE_WILDCARDS) {
    if (allow) return null
    pieces = [...pieces.slice(0, MAX_RULE_WILDCARDS), '']
    ends = false
  }
  return { allow, pieces, anchored: ends, priority: normalised.length }
}

function ruleMatches(rule: Rule, path: string): boolean {
  const { pieces } = rule
  const first = pieces[0]
  if (!path.startsWith(first)) return false
  if (pieces.length === 1) return !rule.anchored || path.length === first.length
  let at = first.length
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = path.indexOf(pieces[i], at)
    if (found < 0) return false
    at = found + pieces[i].length
  }
  const last = pieces[pieces.length - 1]
  if (rule.anchored)
    return path.length - last.length >= at && path.endsWith(last)
  return path.indexOf(last, at) >= 0
}

/** The path and query robots rules are matched against, or null for a URL the crawl can't read. */
function robotsPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null
    const path = urlEncodeToUpper(parsed.pathname + parsed.search)
    return path.length <= MAX_URL_CHARS ? path : null
  } catch {
    return null
  }
}

/**
 * Deterministic: same text in, same result out. Null text (no robots.txt)
 * allows everything. Throws ROBOTS_TOO_COMPLEX for a group of more than
 * 5,000 rules.
 */
export function parseRobotsTxt(
  _origin: string,
  text: string | null,
): RobotsResult {
  if (text === null)
    return { isAllowed: (url) => robotsPath(url) !== null, sitemapUrls: [] }

  const ourAgent = formatUserAgent(CRAWLER_TOKEN)
  let ours: Rule[] | null = null
  let star: Rule[] | null = null
  const sitemapUrls: string[] = []
  let agents: string[] = []
  // A User-agent line after any other line starts a new group.
  let afterOtherLine = true
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf('#')
    const line = hash > -1 ? raw.slice(0, hash) : raw
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    if (!key) continue
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      if (afterOtherLine) agents = []
      if (value) agents.push(formatUserAgent(value))
    } else if (key === 'allow' || key === 'disallow' || key === 'crawl-delay') {
      const forUs = agents.includes(ourAgent)
      const forStar = agents.includes('*')
      if (forUs) ours ??= []
      if (forStar) star ??= []
      if (key !== 'crawl-delay' && value && (forUs || forStar)) {
        const rule = compileRule(value, key === 'allow')
        if (rule) {
          if (forUs) ours!.push(rule)
          if (forStar) star!.push(rule)
        }
      }
    } else if (key === 'sitemap') {
      if (value) sitemapUrls.push(value)
    }
    afterOtherLine = key !== 'user-agent'
  }

  const rules: Rule[] = ours ?? star ?? []
  if (rules.length > MAX_ROBOTS_RULES)
    throw new AuditFailure('ROBOTS_TOO_COMPLEX', TOO_COMPLEX)

  const memo = new Map<string, boolean>()
  return {
    isAllowed: (url: string) => {
      const path = robotsPath(url)
      if (path === null) return false
      const known = memo.get(path)
      if (known !== undefined) return known
      let best: Rule | null = null
      for (const rule of rules) {
        if (
          best &&
          (rule.priority < best.priority ||
            (rule.priority === best.priority && (best.allow || !rule.allow)))
        )
          continue
        if (ruleMatches(rule, path)) best = rule
      }
      const allowed = !best || best.allow
      if (memo.size >= MEMO_ENTRIES) memo.clear()
      memo.set(path, allowed)
      return allowed
    },
    sitemapUrls,
  }
}

/**
 * Robots checks for one audit step: the step's whole time in them is held to
 * a budget (past it the audit fails ROBOTS_TOO_COMPLEX), and every few
 * hundred checks the loop yields so the worker keeps answering.
 */
export function createRobotsGate(
  robots: RobotsResult,
  {
    budgetMs = ROBOTS_STEP_BUDGET_MS,
    now = () => performance.now(),
  }: { budgetMs?: number; now?: () => number } = {},
): (url: string) => Promise<boolean> {
  let spent = 0
  let checks = 0
  return async (url) => {
    checks += 1
    if (checks % ROBOTS_YIELD_EVERY === 0)
      await new Promise<void>((resolve) => setImmediate(resolve))
    const started = now()
    const allowed = robots.isAllowed(url)
    spent += now() - started
    if (spent > budgetMs) throw new AuditFailure('ROBOTS_TOO_COMPLEX', TOO_COMPLEX)
    return allowed
  }
}
