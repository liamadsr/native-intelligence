/**
 * lintDraft (src/lib/writing/lint.ts): the deterministic floor.
 *
 * Pinned:
 *   - AI tells, machinery phrases and plain-English swaps match as whole
 *     words, case-insensitively, through curly quotes, fullwidth letters,
 *     Unicode hyphens and invisible characters; a phrase inside a longer one
 *     is reported once;
 *   - the "it's not X, it's Y" frame, without flagging an ordinary "not … but";
 *   - em dashes against the house limit (one per ~500 characters) or the
 *     surface's own;
 *   - the email surface: no hashtags, bare URLs only, never HTML;
 *   - a registered surface's length (in code points), hashtag and link rules;
 *   - ReDoS-safe and bounded: adversarial megabyte inputs finish fast, and
 *     only MAX_LINT_CHARS are scanned;
 *   - fails open, and is deterministic.
 */
import { describe, expect, it } from 'vitest'
import { MAX_LINT_CHARS, MAX_VIOLATIONS, foldForMatch, lintDraft, surfaceLength, type LintResult } from '../lint'
import { EMAIL_SURFACE, registerWritingSurface, writingSurface, writingSurfaceIds, type WritingSurface } from '../surfaces'

const rules = (result: LintResult) => result.violations.map((v) => v.rule)
const find = (result: LintResult, rule: string) => result.violations.find((v) => v.rule === rule)

const CLEAN = 'Hi Sam,\n\nYes, we can lock the price this week. I will confirm by Friday.\n\nLiam'

describe('house rules', () => {
  it('a plain, human draft passes clean', () => {
    expect(lintDraft(CLEAN)).toEqual({ ok: true, violations: [] })
    expect(lintDraft(CLEAN, { surface: 'email' })).toEqual({ ok: true, violations: [] })
  })

  it('finds AI tells whatever the case, and keeps the draft’s own capitals in the quote', () => {
    const result = lintDraft('We are excited to DELVE into a Seamless rollout.')
    expect(result.ok).toBe(false)
    expect(result.violations.filter((v) => v.rule === 'ai_tell').map((v) => v.quote).sort()).toEqual(['DELVE', 'Seamless'])
    expect(find(result, 'ai_tell')?.severity).toBe('medium')
  })

  it('matches whole words only', () => {
    expect(lintDraft('Robustness tests and the Delveshire office.').violations).toEqual([])
    expect(lintDraft('édelve, delve_x and x_robust').violations).toEqual([])
  })

  it('sees through curly quotes, fullwidth letters, Unicode hyphens and invisible characters', () => {
    expect(rules(lintDraft('ｄｅｌｖｅ'))).toEqual(['ai_tell'])
    expect(rules(lintDraft('de​lve'))).toEqual(['ai_tell'])
    expect(rules(lintDraft('a real game‑changer'))).toEqual(['ai_tell'])
    expect(find(lintDraft('In today’s fast-paced world, we ship.'), 'ai_tell')?.quote).toBe("In today's fast-paced world")
    expect(rules(lintDraft('I hope this\n  finds you well'))).toEqual(['ai_tell'])
    expect(foldForMatch('a  b’')).toBe("a b'")
  })

  it('reports a phrase inside a longer one once, and counts repeats', () => {
    const opener = lintDraft('I hope this email finds you well.')
    expect(opener.violations).toHaveLength(1)
    expect(opener.violations[0]).toMatchObject({ rule: 'ai_tell', quote: 'I hope this email finds you well' })
    const repeated = lintDraft('We leverage data. We leverage people. We leverage time.')
    expect(find(repeated, 'ai_tell')).toMatchObject({ quote: 'leverage', count: 3 })
    // Reported under its strongest reading: the hard "as an ai", not the low "ai language model".
    const hard = lintDraft('As an AI language model, I can’t.').violations.filter((v) => v.rule === 'machinery' && v.hard)
    expect(hard).toEqual([{ rule: 'machinery', severity: 'medium', quote: 'As an AI', fix: 'cut it: the draft speaks as the person', hard: true }])
  })

  it('vocabulary tells and ambiguous machinery phrases are low: they count, but pass the draft', () => {
    const vocab = lintDraft('We will leverage a robust plan, touch base Monday and circle back Friday.')
    expect(vocab.ok).toBe(true)
    expect(vocab.violations.map((v) => [v.rule, v.severity])).toEqual(expect.arrayContaining([['ai_tell', 'low']]))
    expect(vocab.violations.every((v) => v.severity === 'low' && !v.hard)).toBe(true)
    const machinery = lintDraft('Our language model writes AI-generated captions; the system prompt and my tools are in the doc.')
    expect(machinery.ok).toBe(true)
    expect(machinery.violations.filter((v) => v.rule === 'machinery').map((v) => v.severity)).toEqual(['low', 'low', 'low', 'low'])
  })

  it('hard rules: the em-dash limit, a link written the wrong way, the writer talking about itself', () => {
    const hardRules = (text: string, surface?: string) =>
      lintDraft(text, surface ? { surface } : {}).violations.filter((v) => v.hard).map((v) => v.rule)
    expect(hardRules('Yes — Friday — works.')).toEqual(['em_dash'])
    expect(hardRules('See [the deck](https://x.co)', 'email')).toEqual(['link_format'])
    expect(hardRules('See <a href="https://x.co">it</a>')).toEqual([])
    expect(hardRules('See <a href="https://x.co">it</a>', 'email')).toEqual(['link_format'])
    expect(hardRules('As an AI, per my instructions, I can draft this.')).toEqual(['machinery', 'machinery'])
    expect(hardRules('I hope this finds you well. Let us delve in.')).toEqual([])
  })

  it('the thread is an allow-list: a phrase the sender used is never flagged', () => {
    const draft = 'Happy to touch base Thursday. I hope this finds you well too. As an AI startup, we use a language model.'
    const thread = 'Hi! I hope this finds you well. Can we touch base Thursday? We are an AI startup (as an AI company, we use a language model).'
    expect(lintDraft(draft).violations.map((v) => v.quote)).toEqual(expect.arrayContaining(['As an AI', 'I hope this finds you well', 'touch base']))
    expect(lintDraft(draft, { allow: thread }).violations).toEqual([])
    // Only the phrase the sender used: anything else is still flagged.
    expect(lintDraft('Let us delve in and touch base.', { allow: thread }).violations.map((v) => v.quote)).toEqual(['delve'])
  })

  it('flags narrating permissions and the machinery', () => {
    expect(find(lintDraft('Based on the context provided, the price holds.'), 'machinery')).toMatchObject({ severity: 'medium' })
    expect(find(lintDraft("Sorry, I don't have access to your calendar."), 'machinery')).toBeDefined()
    expect(lintDraft('I can’t open the doc you shared, can you resend it?').violations).toEqual([])
  })

  it('plain-English swaps are low: reported, but they don’t fail the draft', () => {
    const result = lintDraft('We will utilize the budget in order to ship.')
    expect(result.ok).toBe(true)
    expect(result.violations.map((v) => [v.rule, v.severity, v.quote])).toEqual([
      ['plain_english', 'low', 'in order to'],
      ['plain_english', 'low', 'utilize'],
    ])
  })

  it('the "it\'s not X, it\'s Y" frame', () => {
    for (const text of [
      "It's not a tool, it's a partner.",
      'It’s not just software — it’s a movement.',
      'This isn’t about price; it’s about trust.',
      "It's not about the money. It's about trust.",
      'We are not just a vendor, we are… no: it is not just a vendor, it is a team.',
    ]) {
      expect(find(lintDraft(text), 'not_x_its_y'), text).toMatchObject({ severity: 'medium' })
    }
    for (const text of [
      "It's not ready, but I'll send it Friday.",
      "It's not ready. It's going out Friday.",
      'Not only that: the knot just held.',
      'This is not what we agreed.',
      "That's not a problem. It's the least we can do.",
      "That's not a problem, it's the least we can do.",
      "It's not a big deal. It's a quick fix on our side.",
      "It's not urgent. It's the end of the quarter, so next week works.",
    ]) {
      expect(find(lintDraft(text), 'not_x_its_y'), text).toBeUndefined()
    }
    expect(find(lintDraft("It's not A, it's B. It's not C, it's D."), 'not_x_its_y')?.count).toBe(2)
  })

  it('em dashes: one in a short message, one per ~500 characters in a longer one; a spaced en dash counts', () => {
    expect(find(lintDraft('Yes — Friday works.'), 'em_dash')).toBeUndefined()
    expect(find(lintDraft('Yes — Friday works — see you.'), 'em_dash')).toMatchObject({ severity: 'medium', count: 2 })
    expect(find(lintDraft('Yes – Friday works — see you.'), 'em_dash')?.count).toBe(2)
    const long = `${'word '.repeat(220)}— and — then`
    expect(long.length).toBeGreaterThan(1_000)
    expect(find(lintDraft(long), 'em_dash')).toBeUndefined()
    expect(find(lintDraft(`${long} — again`), 'em_dash')?.fix).toContain('at most 2 em dashes')
  })

  it('caps the violations, highest severity first', () => {
    const everything = [...new Set([
      'delve', 'leverage', 'robust', 'seamless', 'tapestry', 'game-changer', 'cutting-edge', 'synergy', 'holistic', 'pivotal',
      'meticulous', 'deep dive', 'circle back', 'rest assured', 'look no further', 'utilize', 'facilitate', 'commence',
      'prior to', 'furthermore', 'moreover', 'ascertain', 'approximately', 'as an ai', 'my tools', 'system prompt',
    ])].join('. ')
    const result = lintDraft(everything)
    expect(result.violations).toHaveLength(MAX_VIOLATIONS)
    const order = result.violations.map((v) => ({ high: 0, medium: 1, low: 2 })[v.severity])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('is deterministic', () => {
    const text = "Hi — I hope you're well. It's not a tool, it's a partner. Leverage it. #growth https://x.co [here](https://x.co)"
    expect(lintDraft(text, { surface: 'email' })).toEqual(lintDraft(text, { surface: 'email' }))
  })
})

describe('the email surface', () => {
  it('is registered, plain text: no hashtags, bare URLs, never HTML', () => {
    expect(writingSurface('email')).toEqual(EMAIL_SURFACE)
    expect(writingSurfaceIds()).toContain('email')
    expect(find(lintDraft('Big news #launch #growth', { surface: 'email' }), 'hashtags')).toMatchObject({ count: 2, fix: 'no hashtags here' })
    // In plain-text email a '#' is ordinary: it only counts.
    for (const text of ['Your order #A123 shipped.', 'Posted in #general on Slack.']) {
      const result = lintDraft(text, { surface: 'email' })
      expect(result.ok, text).toBe(true)
      expect(find(result, 'hashtags'), text).toMatchObject({ severity: 'low' })
      expect(find(result, 'hashtags')?.hard, text).toBeUndefined()
    }
    expect(find(lintDraft('See [the deck](https://x.co/deck)', { surface: 'email' }), 'link_format')).toMatchObject({ severity: 'medium' })
    expect(find(lintDraft('See <a href="https://x.co">the deck</a>', { surface: 'email' }), 'link_format')).toBeDefined()
    expect(lintDraft('The deck: https://x.co/deck#page-2 (C# and F# both fine)', { surface: 'email' }).violations).toEqual([])
  })

  it('without a surface, hashtags and markdown links are fine; vague link text is low', () => {
    expect(lintDraft('Big news #launch, see [the deck](https://x.co/deck)').violations).toEqual([])
    expect(find(lintDraft('More [here](https://x.co)', { surface: { id: 'doc', label: 'a doc' } }), 'link_format')).toMatchObject({ severity: 'low' })
  })
})

describe('surfaces registered later (the content phase hook)', () => {
  const POST: WritingSurface = { id: 'test_post', label: 'a short post', maxChars: 280, maxHashtags: 1, linkPlacement: 'end', maxEmDashes: 0 }
  registerWritingSurface(POST)

  it('length in code points, a hashtag cap, links on the last line, a fixed em-dash limit', () => {
    expect(lintDraft('😀'.repeat(280), { surface: 'test_post' }).violations).toEqual([])
    const long = lintDraft('a'.repeat(281), { surface: 'test_post' })
    expect(find(long, 'length')).toMatchObject({ severity: 'high', quote: '281 characters' })
    expect(long.ok).toBe(false)
    expect(find(lintDraft('#one #two', { surface: 'test_post' }), 'hashtags')?.count).toBe(2)
    expect(find(lintDraft('Read https://x.co first.\nThen this.', { surface: 'test_post' }), 'link_placement')).toMatchObject({ quote: 'https://x.co' })
    expect(find(lintDraft('Shipped.\nhttps://x.co', { surface: 'test_post' }), 'link_placement')).toBeUndefined()
    expect(find(lintDraft('Shipped — today.', { surface: 'test_post' }), 'em_dash')?.fix).toContain('at most 0 em dashes')
  })

  it('a surface may be passed directly; "none" and a link cap', () => {
    expect(find(lintDraft('https://a.co https://b.co', { surface: { id: 'x', label: 'x', maxLinks: 1 } }), 'link_placement')).toMatchObject({ quote: 'https://b.co', count: 2 })
    expect(find(lintDraft('https://a.co', { surface: { id: 'x', label: 'x', linkPlacement: 'none' } }), 'link_placement')?.fix).toBe('no links on this surface')
  })

  it('an unknown surface id lints by the house rules alone', () => {
    expect(lintDraft('#a #b #c [x](https://x.co)', { surface: 'nope' }).violations).toEqual([])
  })

  it('a bad surface fails at registration, never mid-draft', () => {
    expect(() => registerWritingSurface({ id: 'Bad Id', label: 'x' })).toThrow(/bad surface id/)
    expect(() => registerWritingSurface({ id: 'ok', label: 'x', maxChars: 2.5 })).toThrow(/whole number/)
    expect(() => registerWritingSurface({ id: 'ok', label: 'x', maxHashtags: -1 })).toThrow(/whole number/)
  })
})

describe('bounded, ReDoS-safe, fails open', () => {
  const timed = (text: string, surface?: string) => {
    const start = performance.now()
    const result = lintDraft(text, surface ? { surface } : {})
    return { result, ms: performance.now() - start }
  }

  it.each([
    ['one long word', 'a'.repeat(1_000_000)],
    ['an opener repeated', "it's not ".repeat(120_000)],
    ['brackets that never close', `${'['.repeat(200_000)}](https://`],
    ['hashes', '#'.repeat(500_000)],
    ['dashes', '—'.repeat(300_000)],
    ['near-miss phrases', 'i hope this finds you wel '.repeat(40_000)],
    ['spaces and letters', `${'a '.repeat(300_000)}!`],
    ['lookbehind bait', `${'é'.repeat(300_000)}delve`],
    ['url bait', `https://${'a'.repeat(500_000)}`],
  ])('%s: finishes fast and scans only the bounded head', (_label, text) => {
    const { result, ms } = timed(text, 'email')
    expect(ms).toBeLessThan(1_500)
    expect(result.truncated).toBe(true)
    expect(result.failed).toBeUndefined()
  })

  it('the length limit still sees the whole text', () => {
    const result = lintDraft('a'.repeat(MAX_LINT_CHARS * 3), { surface: 'test_post' })
    expect(find(result, 'length')?.quote).toBe(`${MAX_LINT_CHARS * 3} characters`)
  })

  it('a non-string is an empty draft, and an internal error fails open', () => {
    expect(lintDraft(undefined)).toEqual({ ok: true, violations: [] })
    expect(lintDraft(42 as unknown as string)).toEqual({ ok: true, violations: [] })
    const exploding = { id: 'boom', label: 'x', get maxChars(): number { throw new Error('boom') } } as WritingSurface
    expect(lintDraft('delve', { surface: exploding })).toEqual({ ok: true, violations: [], failed: true })
  })
})

describe('the post surfaces (content C0)', () => {
  const X_CLEAN = 'We shipped voice notes in Native Intelligence this week.\n\nSay what you did after a call and it files the actions for you. Took us three tries to get the timing right.'

  it('a plain post passes clean on every post surface', () => {
    for (const id of ['x', 'linkedin', 'threads', 'bluesky']) expect(lintDraft(X_CLEAN, { surface: id }), id).toEqual({ ok: true, violations: [] })
  })

  it('X counts a link as 23 characters, whatever its length (t.co)', () => {
    const longUrl = `https://example.com/${'a'.repeat(200)}`
    expect(surfaceLength(`${'x'.repeat(250)}\n${longUrl}`, 'x')).toBe(251 + 23)
    expect(find(lintDraft(`${'x'.repeat(250)}\n${longUrl}`, { surface: 'x' }), 'length')).toBeUndefined()
    expect(find(lintDraft(`${'x'.repeat(260)}\n${longUrl}`, { surface: 'x' }), 'length')).toMatchObject({ quote: '284 characters', hard: true })
  })

  it('Bluesky counts graphemes, and a link not at all', () => {
    expect(surfaceLength('👨‍👩‍👧'.repeat(10), 'bluesky')).toBe(10)
    expect(surfaceLength(`${'b'.repeat(299)}\nhttps://example.com/x`, 'bluesky')).toBe(300)
    expect(find(lintDraft(`${'b'.repeat(299)}\nhttps://example.com/x`, { surface: 'bluesky' }), 'length')).toBeUndefined()
    expect(find(lintDraft('b'.repeat(301), { surface: 'bluesky' }), 'length')).toBeDefined()
  })

  it('a surface without urlChars counts the link as written', () => {
    expect(surfaceLength('see https://example.com', 'email')).toBe('see https://example.com'.length)
  })

  it('engagement bait fails a post, and only a post: the same words in an email are not checked', () => {
    const bait = 'We cut our onboarding to one screen. Let that sink in. RT if you agree, and follow me for more.'
    const post = lintDraft(bait, { surface: 'x' })
    expect(post.ok).toBe(false)
    expect(post.violations.filter((v) => v.rule === 'bait').map((v) => v.quote.toLowerCase()).sort()).toEqual(['follow me for more', 'let that sink in', 'rt if you agree'])
    expect(rules(lintDraft(bait, { surface: 'email' }))).not.toContain('bait')
    expect(rules(lintDraft('A thread on how we price:', { surface: 'x' }))).toContain('bait')
  })

  it('LinkedIn: a first line past 140 characters is a low note about the hook, never a failure', () => {
    const longFirst = 'We rebuilt how Native Intelligence files the actions from a call, and the part nobody warned us about was the timing of the very first reminder email we send.\n\nThe rest of the story.'
    const result = lintDraft(longFirst, { surface: 'linkedin' })
    expect(find(result, 'hook')).toMatchObject({ severity: 'low' })
    expect(result.ok).toBe(true)
    expect(find(lintDraft('Short hook.\n\nThe rest of the story.', { surface: 'linkedin' }), 'hook')).toBeUndefined()
  })

  it('X allows two hashtags and Threads one; a link must sit on the last line', () => {
    expect(find(lintDraft('Shipped it #buildinpublic #saas', { surface: 'x' }), 'hashtags')).toBeUndefined()
    expect(find(lintDraft('Shipped it #a #b #c', { surface: 'x' }), 'hashtags')).toMatchObject({ severity: 'medium', count: 3 })
    expect(find(lintDraft('Shipped it #a #b', { surface: 'threads' }), 'hashtags')).toMatchObject({ count: 2 })
    expect(find(lintDraft('Read it: https://nativeintelligence.dev/blog\nIt is good.', { surface: 'x' }), 'link_placement')).toMatchObject({ fix: 'move the link to the last line' })
  })
})
