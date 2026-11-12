/**
 * The robots.txt rules this crawler follows (../robots.ts): the same answers
 * as a standard parser on ordinary files, never a slow check on any file,
 * never a looser answer than the file gives, and the step's time budget.
 */
import robotsParser from 'robots-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditFailure } from '../failure'
import { CRAWLER_TOKEN } from '../limits'
import {
  createRobotsGate,
  MAX_ROBOTS_RULES,
  parseRobotsTxt,
  ROBOTS_YIELD_EVERY,
} from '../robots'

const ORIGIN = 'https://example.com'

afterEach(() => {
  vi.restoreAllMocks()
})

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now()
  const value = fn()
  return { value, ms: performance.now() - started }
}

describe('parseRobotsTxt on an adversarial file', () => {
  // The review's case: one rule of thousands of wildcards against long URLs
  // took about 16 ms a check in the parser we used, 20,000 checks a step.
  it.each([
    // 1,000 a's fit in the URL: the rule matches, and so does its first 8
    // wildcards' worth (a superset), so every URL is disallowed.
    [1_000, false],
    // 3,000 a's can't fit in any URL the crawl reads: the rule never
    // matches, so it is dropped, and every URL is allowed, as before.
    [3_000, true],
  ])(
    'answers 20,000 checks of 2,000-character URLs against `*a` x %i in well under a second, as the full rule would',
    (repeats, expected) => {
      const robots = parseRobotsTxt(
        ORIGIN,
        `User-agent: *\nDisallow: ${'*a'.repeat(repeats)}\n`,
      )
      const urls = Array.from(
        { length: 20_000 },
        (_, i) => `${ORIGIN}/${'a'.repeat(2_000)}/${i}`,
      )
      const { value, ms } = timed(() =>
        urls.map((url) => robots.isAllowed(url)),
      )
      // The parser we used needed about 320 s for this. The bound is loose on
      // purpose: the suite runs beside other work, and only the order matters.
      expect(ms).toBeLessThan(5_000)
      expect(value.every((allowed) => allowed === expected)).toBe(true)
    },
  )

  it('keeps one check within a few milliseconds even at the rule limit', () => {
    const rules = Array.from(
      { length: MAX_ROBOTS_RULES },
      // Eight wildcards each, every one a full search of the URL that fails at the end.
      (_, i) => `Disallow: /*a*a*a*a*a*a*a*b${i}`,
    ).join('\n')
    const robots = parseRobotsTxt(ORIGIN, `User-agent: *\n${rules}\n`)
    const url = `${ORIGIN}/${'a'.repeat(2_000)}`
    robots.isAllowed(`${url}?warm`)
    const { value, ms } = timed(() => robots.isAllowed(url))
    expect(value).toBe(true)
    // A few milliseconds on a quiet machine; loose so a busy one doesn't fail it.
    expect(ms).toBeLessThan(500)
  })

  it('a Disallow of more than 8 wildcards still disallows what it names, and keeps its precedence', () => {
    const disallow = '/x*1*2*3*4*5*6*7*8*9*10'
    const robots = parseRobotsTxt(
      ORIGIN,
      // The Allow is shorter than the Disallow, so the Disallow wins where both match.
      `User-agent: *\nAllow: /x\nDisallow: ${disallow}\n`,
    )
    expect(robots.isAllowed(`${ORIGIN}/x-1-2-3-4-5-6-7-8-9-10`)).toBe(false)
    expect(robots.isAllowed(`${ORIGIN}/x-other`)).toBe(true)
  })

  it('drops an Allow of more than 8 wildcards (stricter), never a Disallow', () => {
    const robots = parseRobotsTxt(
      ORIGIN,
      'User-agent: *\nDisallow: /\nAllow: /p*1*2*3*4*5*6*7*8*9\n',
    )
    expect(robots.isAllowed(`${ORIGIN}/p123456789`)).toBe(false)
  })

  it('ignores a rule longer than any URL the crawl reads (it can never match)', () => {
    const robots = parseRobotsTxt(
      ORIGIN,
      `User-agent: *\nDisallow: /${'b'.repeat(3_000)}\nDisallow: /tmp/\n`,
    )
    expect(robots.isAllowed(`${ORIGIN}/${'b'.repeat(2_000)}`)).toBe(true)
    expect(robots.isAllowed(`${ORIGIN}/tmp/x`)).toBe(false)
  })

  it('refuses a group of more than 5,000 rules as ROBOTS_TOO_COMPLEX; other groups do not count', () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `Disallow: /r${i}/`).join('\n')
    expect(() =>
      parseRobotsTxt(ORIGIN, `User-agent: *\n${lines(MAX_ROBOTS_RULES + 1)}\n`),
    ).toThrow(expect.objectContaining({ code: 'ROBOTS_TOO_COMPLEX' }))
    expect(() =>
      parseRobotsTxt(ORIGIN, `User-agent: *\n${lines(MAX_ROBOTS_RULES)}\n`),
    ).not.toThrow()
    const ours = parseRobotsTxt(
      ORIGIN,
      `User-agent: SomeOtherBot\n${lines(MAX_ROBOTS_RULES + 1)}\n\nUser-agent: ${CRAWLER_TOKEN}\nDisallow: /private/\n`,
    )
    expect(ours.isAllowed(`${ORIGIN}/private/a`)).toBe(false)
    expect(ours.isAllowed(`${ORIGIN}/r1/`)).toBe(true)
  })
})

describe('parseRobotsTxt applies the file to every form of the site’s address', () => {
  it('reads www and http variants of the host with the same rules', () => {
    const robots = parseRobotsTxt(ORIGIN, 'User-agent: *\nDisallow: /private/\n')
    for (const url of [
      'https://example.com/private/a',
      'https://www.example.com/private/a',
      'http://example.com/private/a',
      'http://www.example.com/private/a',
    ]) {
      expect(robots.isAllowed(url), url).toBe(false)
    }
    expect(robots.isAllowed('https://www.example.com/public')).toBe(true)
  })

  it('answers not allowed for an address it cannot read', () => {
    const robots = parseRobotsTxt(ORIGIN, 'User-agent: *\nAllow: /\n')
    expect(robots.isAllowed('not a url')).toBe(false)
    expect(parseRobotsTxt(ORIGIN, null).isAllowed('not a url')).toBe(false)
  })
})

describe('parseRobotsTxt answers as a standard parser does on ordinary files', () => {
  // A seeded generator: the same cases every run.
  function random(seed: number) {
    let state = seed
    return (n: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return state % n
    }
  }

  it('agrees with robots-parser on 2,000 small random files', () => {
    const next = random(42)
    const pick = (alphabet: string, max: number) =>
      Array.from({ length: next(max) }, () => alphabet[next(alphabet.length)]).join('')
    for (let n = 0; n < 2_000; n++) {
      const rules = Array.from({ length: 1 + next(5) }, () => {
        const kind = next(2) ? 'Allow' : 'Disallow'
        const end = next(4) === 0 ? '$' : ''
        return `${kind}: /${pick('ab*/?=', 6)}${end}`
      })
      const groups = next(3)
      const body =
        groups === 0
          ? `User-agent: *\n${rules.join('\n')}\n`
          : groups === 1
            ? `User-agent: *\nDisallow: /a\n\nUser-agent: ${CRAWLER_TOKEN}\n${rules.join('\n')}\n`
            : `User-agent: OtherBot\nDisallow: /\nUser-agent: *\n${rules.join('\n')}\n`
      const theirs = robotsParser(`${ORIGIN}/robots.txt`, body)
      const ours = parseRobotsTxt(ORIGIN, body)
      for (let p = 0; p < 6; p++) {
        const url = `${ORIGIN}/${pick('ab/?=', 8)}`
        expect(ours.isAllowed(url), `${body}\n${url}`).toBe(
          theirs.isAllowed(url, CRAWLER_TOKEN) ?? true,
        )
      }
    }
  })

  it('reads the Sitemap lines of every group', () => {
    expect(
      parseRobotsTxt(
        ORIGIN,
        'User-agent: OtherBot\nSitemap: https://example.com/a.xml\nUser-agent: *\nDisallow: /x\nSitemap: https://example.com/b.xml\n',
      ).sitemapUrls,
    ).toEqual(['https://example.com/a.xml', 'https://example.com/b.xml'])
  })
})

describe('createRobotsGate', () => {
  it('yields to the event loop every few hundred checks', async () => {
    const robots = parseRobotsTxt(ORIGIN, 'User-agent: *\nDisallow: /x\n')
    const yields = vi.spyOn(globalThis, 'setImmediate')
    const allowed = createRobotsGate(robots)
    for (let i = 0; i < ROBOTS_YIELD_EVERY * 3; i++) {
      await allowed(`${ORIGIN}/p${i}`)
    }
    expect(yields.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('fails the step with ROBOTS_TOO_COMPLEX once its robots time is spent', async () => {
    const robots = parseRobotsTxt(ORIGIN, 'User-agent: *\nDisallow: /x\n')
    let clock = 0
    const allowed = createRobotsGate(robots, {
      budgetMs: 10_000,
      now: () => (clock += 3_000),
    })
    // Each check "takes" 3 s on this clock: the fourth passes the 10 s budget.
    await allowed(`${ORIGIN}/a`)
    await allowed(`${ORIGIN}/b`)
    await allowed(`${ORIGIN}/c`)
    const failure = await allowed(`${ORIGIN}/d`).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(AuditFailure)
    expect(failure).toMatchObject({ code: 'ROBOTS_TOO_COMPLEX' })
  })
})
