/**
 * The craft cases (content C0): a table of real-shaped post drafts and what
 * the deterministic floor says about each, so a change to the rules, the
 * surfaces or the public-safe screen shows up as a changed verdict. Every
 * case runs checkPost (what lint_post returns) with no model call; what only
 * a reviewer can judge (a weak hook, two ideas, vague hype) is the review's,
 * and is listed in `reviewOnly` so the table says where each rule lives.
 *
 * Each case: the surface, the draft, how many sources it cites, and the
 * expected `ok`, the rules lint must find (and must not), and whether the
 * post link is handed back.
 */
import { describe, expect, it } from 'vitest'
import { checkPost, type PostCheckInput } from '../post-check'
import { blockedPhrases } from '../public-safe'
import { POST_RULES_FULL } from '@/lib/writing/rules'

interface CraftCase {
  name: string
  input: Omit<PostCheckInput, 'sourceCount'> & { sourceCount?: number }
  ok: boolean
  finds?: string[]
  notFinds?: string[]
  link: boolean
  /** What only the reviewer judges here (rule ids from the post rubric). */
  reviewOnly?: string[]
}

const CALL_NAMES = blockedPhrases({ people: [{ full: 'Priya Raman' }], companies: ['Northwind Traders'] })

const CASES: CraftCase[] = [
  {
    name: 'a concrete, cited X post',
    input: { surface: 'x', parts: ['We cut our signup form from 9 fields to 1 this week.\n\nMore people now finish it than drop off. The hard part was deciding what we could stop asking.'] },
    ok: true,
    link: true,
  },
  {
    name: 'launch hype with hashtags',
    input: { surface: 'x', parts: ["Excited to announce our new feature! It's a game-changer for teams. #AI #productivity #startups"] },
    ok: false,
    finds: ['ai_tell', 'hashtags'],
    link: true,
    reviewOnly: ['concrete', 'hook'],
  },
  {
    name: 'engagement bait',
    input: { surface: 'x', parts: ['Most teams waste an hour a day in follow-ups. Let that sink in. RT if you agree.'] },
    ok: false,
    finds: ['bait'],
    link: true,
    reviewOnly: ['hedge'],
  },
  {
    name: 'a link in the middle of an X post',
    input: { surface: 'x', parts: ['Our changelog: https://dial8.ai/changelog\nCSV export shipped this week.'] },
    ok: false,
    finds: ['link_placement'],
    link: true,
  },
  {
    name: 'a markdown link on a plain-text surface',
    input: { surface: 'x', parts: ['CSV export shipped this week. [Read more](https://dial8.ai/changelog)'] },
    ok: false,
    finds: ['link_format'],
    link: true,
  },
  {
    name: 'over 280 on X, even counting the link as 23',
    input: { surface: 'x', parts: [`${'We rebuilt the inbox. '.repeat(13)}\nhttps://dial8.ai/changelog/inbox-rebuild-2026-10`] },
    ok: false,
    finds: ['length'],
    link: true,
  },
  {
    name: 'a long URL that fits once X counts it as 23',
    input: { surface: 'x', parts: [`${'a'.repeat(240)}\nhttps://dial8.ai/changelog/${'b'.repeat(120)}`] },
    ok: true,
    notFinds: ['length'],
    link: true,
  },
  {
    name: 'a customer named, from a call',
    input: { surface: 'x', parts: ['Priya Raman told us the new inbox saved her team an hour a day.'], blockedPhrases: CALL_NAMES },
    ok: false,
    link: false,
  },
  {
    name: "a customer's company named, from a call",
    input: { surface: 'x', parts: ['Northwind Traders now runs every standup through Native Intelligence.'], blockedPhrases: CALL_NAMES },
    ok: false,
    link: false,
  },
  {
    // A cited call's outside people's first names are screened too (review
    // S3), matched only capitalized, as written.
    name: "a cited call's guest by first name",
    input: { surface: 'x', parts: ['Priya told us the new inbox saved her team an hour a day.'], blockedPhrases: CALL_NAMES, blockedWords: ['Priya'] },
    ok: false,
    link: false,
  },
  {
    // Part of a company's name is not screened ("Northwind" from "Northwind
    // Traders"): folded fragments would block ordinary words. That's the
    // reviewer's public_safe rule, a high issue, and the person reads every
    // post before posting it.
    name: 'part of a company name slips past the screen: the reviewer flags it',
    input: { surface: 'x', parts: ['A team at Northwind told us the new inbox saved them an hour a day.'], blockedPhrases: CALL_NAMES, blockedWords: ['Priya'] },
    ok: true,
    link: true,
    reviewOnly: ['public_safe'],
  },
  {
    name: 'a deal size',
    input: { surface: 'linkedin', parts: ['Closed our biggest deal yet this week: $40k a year.'] },
    ok: false,
    link: false,
  },
  {
    name: 'a price from shipped work alone: it could be anyone\'s, so no link',
    input: { surface: 'x', parts: ['Native Intelligence Pro is now $20 a month, with unlimited captures.'] },
    ok: false,
    link: false,
  },
  {
    name: 'our own public price, cited from the product doc: a note, not a block',
    input: { surface: 'x', parts: ['Native Intelligence Pro is now $20 a month, with unlimited captures.'], ownPricingSource: true },
    ok: true,
    finds: ['public_safe'],
    link: true,
  },
  {
    name: 'no sources, not marked an idea: no link',
    input: { surface: 'x', parts: ['Small teams ship faster than big ones.'], sourceCount: 0 },
    ok: false,
    link: false,
  },
  {
    name: 'a slow-week idea, marked as one',
    input: { surface: 'x', parts: ['What is one meeting you would cancel tomorrow if you could?'], sourceCount: 0, idea: true },
    ok: true,
    link: true,
  },
  {
    name: 'a LinkedIn hook past "see more": a note only',
    input: { surface: 'linkedin', parts: ['For a whole year our signup form had nine separate fields, because each one answered a question someone on our team had once asked about who was signing up.\n\nThis week we cut it to one.'] },
    ok: true,
    finds: ['hook'],
    link: true,
  },
  {
    name: 'a thread whose second part is bait',
    input: { surface: 'x', parts: ['We rebuilt onboarding in a week.', 'Day one we cut the form to one field. Follow me for more.'] },
    ok: false,
    finds: ['bait'],
    link: true,
  },
  {
    name: 'a thread on LinkedIn, which takes single posts',
    input: { surface: 'linkedin', parts: ['Part one.', 'Part two.'] },
    ok: false,
    finds: ['length'],
    link: true,
  },
  {
    name: 'Bluesky counts graphemes, and an emoji family is one',
    input: { surface: 'bluesky', parts: [`${'👨‍👩‍👧'.repeat(150)} shipped`] },
    ok: true,
    notFinds: ['length'],
    link: true,
  },
]

describe('the craft cases', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const r = checkPost({ sourceCount: 1, ...c.input })
      const rules = r.lint.map((n) => n.rule)
      expect(r.ok, `${c.name}: ok`).toBe(c.ok)
      for (const rule of c.finds ?? []) expect(rules, `${c.name}: finds ${rule}`).toContain(rule)
      for (const rule of c.notFinds ?? []) expect(rules, `${c.name}: never ${rule}`).not.toContain(rule)
      expect(r.post_link !== null, `${c.name}: link`).toBe(c.link)
      // What only the reviewer judges is in the rubric it reads.
      for (const rule of c.reviewOnly ?? []) expect(POST_RULES_FULL, rule).toContain(`${rule}:`)
    })
  }

  it('every lint rule a post can trip is covered by at least one case', () => {
    const covered = new Set(CASES.flatMap((c) => c.finds ?? []))
    for (const rule of ['ai_tell', 'bait', 'hashtags', 'link_placement', 'link_format', 'length', 'hook', 'public_safe']) expect(covered.has(rule), rule).toBe(true)
  })
})
