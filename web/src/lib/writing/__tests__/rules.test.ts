/**
 * The house writing standard (src/lib/writing/rules.ts): one source of truth.
 *
 * Pinned:
 *   - the phrase lists are plain lower-case literals, each listed once, and
 *     the full rubric names every one of them (what the reviewer reads is
 *     what lint matches);
 *   - the short rules stay short, and every example they give is a phrase
 *     lint knows;
 *   - the chat agent's standing instructions (which can't import src/) carry
 *     the same short rules: the examples, em dashes, "don't narrate your
 *     permissions" and links as plain markdown;
 *   - writingRulesFor adds the surface's own notes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_TELL_PHRASES,
  BARE_LINK_RULE_FULL,
  BARE_LINK_RULE_SHORT,
  LINK_RULE_FULL,
  LINK_RULE_SHORT,
  HOUSE_WRITING_RULES_FULL,
  HOUSE_WRITING_RULES_SHORT,
  MACHINERY_PHRASES,
  PLAIN_ENGLISH_SWAPS,
  POST_BAIT_PHRASES,
  POST_RULES_FULL,
  POST_RULES_SHORT,
  WRITING_RULES,
  houseEmDashLimit,
} from '../rules'
import { writingRulesFor, writingSurface, writingSurfaceIds } from '../surfaces'

const ALL = [...AI_TELL_PHRASES, ...PLAIN_ENGLISH_SWAPS, ...MACHINERY_PHRASES, ...POST_BAIT_PHRASES]
const HOUSE = [...AI_TELL_PHRASES, ...PLAIN_ENGLISH_SWAPS, ...MACHINERY_PHRASES]
/** Rule ids only the post rubric judges. */
const POST_ONLY_RULES = ['bait', 'hook']

/** The AI-tell examples the short rules (and the chat agent) quote. */
const SHORT_EXAMPLES = ['delve', 'leverage', 'robust', 'seamless', 'tapestry', 'game-changer', "in today's fast-paced world", 'i hope this finds you well']

describe('phrase lists', () => {
  it('are trimmed, lower-case, single-spaced literals, each listed once across all three lists', () => {
    const seen = new Set<string>()
    for (const { phrase, fix } of ALL) {
      expect(phrase, phrase).toBe(phrase.trim().toLowerCase())
      expect(phrase, phrase).not.toMatch(/\s{2,}|[“”‘’]/)
      expect(fix.length, phrase).toBeGreaterThan(0)
      expect(seen.has(phrase), `${phrase} listed twice`).toBe(false)
      seen.add(phrase)
    }
  })

  it('severities: vocabulary and ambiguous machinery are low, swaps are low, only self-referential machinery is hard', () => {
    const severity = (phrase: string) => ALL.find((p) => p.phrase === phrase)?.severity
    for (const phrase of ['leverage', 'robust', 'touch base', 'circle back', 'seamless', 'language model', 'ai-generated', 'system prompt', 'my tools', 'utilize']) {
      expect(severity(phrase), phrase).toBe('low')
    }
    for (const phrase of ['delve', 'tapestry', 'i hope this finds you well', "in today's fast-paced world", 'the context provided']) {
      expect(severity(phrase), phrase).toBe('medium')
    }
    expect(ALL.filter((p) => p.hard).map((p) => p.phrase).sort()).toEqual(
      ['as an ai', 'i have been instructed', 'i was instructed', 'my instructions', 'untrusted content'],
    )
    expect(ALL.filter((p) => p.hard).every((p) => p.severity === 'medium' && MACHINERY_PHRASES.includes(p))).toBe(true)
  })

  it('the full rubric lists every phrase lint matches, and every rule id', () => {
    for (const { phrase } of HOUSE) expect(HOUSE_WRITING_RULES_FULL, phrase).toContain(`"${phrase}"`)
    for (const id of Object.keys(WRITING_RULES).filter((id) => !['length', 'hashtags', 'link_placement', ...POST_ONLY_RULES].includes(id))) {
      expect(HOUSE_WRITING_RULES_FULL, id).toContain(`${id}:`)
    }
    expect(HOUSE_WRITING_RULES_FULL).toContain('[NEEDS INPUT')
  })
})

describe('the short rules', () => {
  it('stay a few lines, and quote only phrases lint knows', () => {
    expect(HOUSE_WRITING_RULES_SHORT.split('\n').length).toBeLessThanOrEqual(7)
    expect(HOUSE_WRITING_RULES_SHORT.length).toBeLessThan(1_000)
    const known = new Set(AI_TELL_PHRASES.map((p) => p.phrase))
    for (const example of SHORT_EXAMPLES) {
      expect(known.has(example), example).toBe(true)
      expect(HOUSE_WRITING_RULES_SHORT.toLowerCase()).toContain(`"${example}"`)
    }
    expect(HOUSE_WRITING_RULES_SHORT).toMatch(/Never narrate your permissions/)
    expect(HOUSE_WRITING_RULES_SHORT).toMatch(/Links as plain markdown/)
    expect(HOUSE_WRITING_RULES_SHORT).toMatch(/Em dashes rarely/)
  })

  it('the em-dash limit: one per ~500 characters, at least one', () => {
    expect(houseEmDashLimit(0)).toBe(1)
    expect(houseEmDashLimit(499)).toBe(1)
    expect(houseEmDashLimit(1_000)).toBe(2)
  })
})

describe('the chat agent carries the same short rules', () => {
  const md = readFileSync(join(process.cwd(), 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
  const from = md.indexOf('Writing (your answers, and every draft you write for the person):')
  const section = md.slice(from, md.indexOf('Suggest, don', from))

  it('has a Writing section', () => {
    expect(from).toBeGreaterThan(-1)
    expect(section.length).toBeGreaterThan(0)
  })

  it('quotes the same AI tells, the em-dash rule, "never narrate your permissions" and plain markdown links', () => {
    for (const example of SHORT_EXAMPLES) expect(section.toLowerCase(), example).toContain(`"${example}"`)
    expect(section).toContain(`"it's not X, it's Y"`)
    expect(section).toMatch(/Em dashes rarely/)
    expect(section).toMatch(/Never narrate your permissions/)
    // One rule per place, never two that contradict: markdown in chat, bare URLs in email.
    expect(section).toMatch(/in your answers, plain markdown, \[name\]\(url\); in an email draft, the bare URL/)
    expect(section).not.toMatch(/Links as plain markdown, \[name\]\(url\)\. Never/)
  })
})

describe('writingRulesFor', () => {
  it('a plain-text surface (email) gets the bare-URL link rule INSTEAD of the markdown one, in both sizes', () => {
    const short = writingRulesFor('email', 'short')
    expect(short).toBe(`${HOUSE_WRITING_RULES_SHORT.replace(LINK_RULE_SHORT, BARE_LINK_RULE_SHORT)}\n- Plain-text email: no markdown formatting and no hashtags.`)
    expect(short).not.toContain(LINK_RULE_SHORT)
    expect(short).not.toContain('[name](url)')
    const full = writingRulesFor('email', 'full')
    expect(full).toContain(BARE_LINK_RULE_FULL)
    expect(full).not.toContain(LINK_RULE_FULL)
    expect(full).toContain('no hashtags')
  })

  it('a markdown surface keeps the markdown link rule; an unknown surface gets the house rules alone', () => {
    expect(HOUSE_WRITING_RULES_SHORT).toContain(LINK_RULE_SHORT)
    expect(HOUSE_WRITING_RULES_FULL).toContain(LINK_RULE_FULL)
    expect(writingRulesFor('zine', 'short')).toBe(HOUSE_WRITING_RULES_SHORT)
    expect(writingRulesFor(undefined, 'full')).toBe(HOUSE_WRITING_RULES_FULL)
  })
})

describe('the post rules (content C0)', () => {
  it('the post rubric lists every bait phrase lint matches, and judges hook, bait, hedging and public-safety by id', () => {
    for (const { phrase } of POST_BAIT_PHRASES) expect(POST_RULES_FULL, phrase).toContain(`"${phrase}"`)
    for (const id of [...POST_ONLY_RULES, 'one_idea', 'concrete', 'hedge', 'public_safe']) expect(POST_RULES_FULL, id).toContain(`${id}:`)
    // Bait is never a person's own wording the house rules would excuse: medium, never hard.
    expect(POST_BAIT_PHRASES.every((p) => p.severity === 'medium' && !p.hard)).toBe(true)
  })

  it('every post surface gets the post rules on top of the house rules, a private surface never does', () => {
    const posts = writingSurfaceIds().filter((id) => writingSurface(id)?.kind === 'post')
    expect(posts.sort()).toEqual(['bluesky', 'linkedin', 'threads', 'x'])
    for (const id of posts) {
      expect(writingRulesFor(id, 'short'), id).toContain(POST_RULES_SHORT)
      expect(writingRulesFor(id, 'full'), id).toContain(POST_RULES_FULL)
      // Plain text everywhere: the bare-URL link rule, never the markdown one.
      expect(writingRulesFor(id, 'short'), id).toContain(BARE_LINK_RULE_SHORT)
    }
    expect(writingRulesFor('email', 'full')).not.toContain(POST_RULES_FULL)
    expect(writingRulesFor('email', 'short')).not.toContain(POST_RULES_SHORT)
  })

  it('the writer is told to cite, to hedge what is only plausible, and to keep it public-safe', () => {
    expect(POST_RULES_SHORT).toMatch(/cited/)
    expect(POST_RULES_SHORT).toMatch(/plausible or an assumption stays hedged/)
    expect(POST_RULES_SHORT).toMatch(/Public-safe/)
    expect(POST_RULES_SHORT.split('\n').length).toBeLessThanOrEqual(6)
  })

  it("each surface's limits reach the writer: X counts a link as 23, Bluesky not at all, LinkedIn's hook is 140", () => {
    expect(writingRulesFor('x', 'short')).toContain('At most 280 characters.')
    expect(writingRulesFor('x', 'short')).toContain('A link counts as 23 characters.')
    expect(writingRulesFor('bluesky', 'short')).toContain('At most 300 characters (graphemes).')
    expect(writingRulesFor('bluesky', 'short')).toContain("A link doesn't count toward the limit.")
    expect(writingRulesFor('linkedin', 'short')).toContain('At most 3,000 characters.')
    expect(writingRulesFor('linkedin', 'short')).toContain('The first 140 characters show before "see more".')
    expect(writingRulesFor('threads', 'short')).toContain('At most 1 hashtag.')
  })
})
