/**
 * The house writing standard: one set of rules for every surface Dial8 writes
 * on (email drafts first; posts and generated docs later). Plan:
 * docs/plans/eve-templates-lessons.md §3b P3, content-skill-set.md §2 row 12.
 *
 * One source of truth, three consumers:
 *   - the writers' system prompts get HOUSE_WRITING_RULES_SHORT (a few lines);
 *   - the reviewer (utility kind `draft_review`) gets HOUSE_WRITING_RULES_FULL
 *     as its rubric;
 *   - lintDraft (./lint.ts) matches the phrase lists below, with no model call.
 *
 * The eve agents can't import src/, so the chat agent's standing instructions
 * (agents/chat-agent/instructions.md, "Writing:") carry their own few lines;
 * src/lib/writing/__tests__/rules.test.ts keeps them in step with this file.
 *
 * Phrases are plain literals, lower case, matched as whole words and
 * case-insensitively (curly quotes and fullwidth letters fold to ASCII first).
 * Never put regex syntax here: lint escapes every character.
 */

export type WritingSeverity = 'high' | 'medium' | 'low'

/** Stable rule ids, shared by the lint and the reviewer's rubric. */
export const WRITING_RULES = {
  ai_tell: 'AI-tell words and phrases',
  not_x_its_y: 'The "it\'s not X, it\'s Y" frame',
  em_dash: 'Em-dash overuse',
  plain_english: 'Plain-English swaps',
  machinery: 'Narrating permissions or the machinery behind the draft',
  link_format: 'Links as plain markdown or bare URLs, never HTML',
  length: 'Over the surface\'s length limit',
  hashtags: 'Too many hashtags for the surface',
  link_placement: 'A link where the surface doesn\'t allow one',
  // Post surfaces only (POST_RULES_FULL; content-skill-set.md appendix).
  bait: 'Engagement bait, or a hook that promises what the post doesn\'t deliver',
  hook: 'A weak first line, or one too long to show before "see more"',
} as const

export type WritingRuleId = keyof typeof WRITING_RULES

export interface PhraseRule {
  /** Lower-case literal, matched as a whole word or phrase. */
  phrase: string
  /** The plainer thing to write instead. */
  fix: string
  /**
   * How much it matters. 'medium' fails lint (ok: false); 'low' (vocabulary a
   * person also writes, phrases with an innocent reading) only counts toward
   * a draft's score.
   */
  severity: WritingSeverity
  /**
   * A hard rule: lint finding it alone forces the one rewrite, even when the
   * reviewer said ready. Only phrases no person writes about themselves in an
   * email ("as an AI", "my instructions").
   */
  hard?: true
}

function group(phrases: readonly string[], fix: string, severity: WritingSeverity = 'medium', hard = false): PhraseRule[] {
  return phrases.map((phrase) => ({ phrase, fix, severity, ...(hard ? { hard: true as const } : {}) }))
}

/** Vocabulary tells: people write these too, so they score low and never force a rewrite. */
function vocab(phrases: readonly string[], fix: string): PhraseRule[] {
  return group(phrases, fix, 'low')
}

/** Words and phrases that make a draft read as machine-written. */
export const AI_TELL_PHRASES: readonly PhraseRule[] = [
  ...group(['delve', 'delves', 'delved', 'delving'], 'look at, dig into, or cut it'),
  ...vocab(['leverage', 'leverages', 'leveraged', 'leveraging'], 'use'),
  ...vocab(['robust'], 'strong, or say what makes it so'),
  ...vocab(['seamless', 'seamlessly'], 'smooth, or say what works'),
  ...group(['tapestry'], 'cut it'),
  ...group(['game-changer', 'game changer', 'game-changing'], 'say what changes'),
  ...vocab(['cutting-edge'], 'new, or name it'),
  ...vocab(['synergy', 'synergies'], 'say what works together'),
  ...vocab(['holistic'], 'whole, complete'),
  ...group(['paradigm shift'], 'say what changed'),
  ...group(['unlock the power of', 'unleash the power of'], 'say what it does'),
  ...group(['navigate the complexities', 'navigating the complexities'], 'deal with'),
  ...vocab(['pivotal', 'crucial role', 'plays a vital role'], 'key, or say why it matters'),
  ...vocab(['in the realm of'], 'in'),
  ...vocab(['embark on'], 'start'),
  ...vocab(['meticulous', 'meticulously'], 'careful'),
  ...vocab(['deep dive'], 'close look'),
  ...vocab(['circle back', 'touch base'], 'follow up, talk'),
  ...group(['a testament to', 'stands as a testament'], 'shows'),
  ...group(['rest assured'], 'cut it'),
  ...group(['look no further'], 'cut it'),
  ...group(
    [
      "in today's fast-paced world", "in today's fast-paced", "in today's digital age",
      'in an ever-evolving', 'ever-evolving landscape', 'ever-changing landscape',
    ],
    'cut it; start with the point',
  ),
  ...group(["it's worth noting", 'it is worth noting', 'it bears mentioning', 'needless to say'], 'cut it; just say the thing'),
  ...group(
    [
      'i hope this email finds you well', 'i hope this message finds you well', 'i hope this finds you well',
      'hope this email finds you well', 'hope this finds you well', 'i trust this email finds you well',
      'i trust this finds you well', "i hope you're doing well", 'i hope you are doing well',
      "hope you're doing well", 'hope you are doing well', "i hope you're well", "hope you're well",
    ],
    'cut it; open with the point',
  ),
  ...group(
    [
      "please don't hesitate to", 'please do not hesitate to', "don't hesitate to reach out",
      'do not hesitate to reach out', 'feel free to reach out',
    ],
    '"Any questions, just reply," or cut it',
  ),
  ...group(['i wanted to reach out', 'just wanted to reach out', "i'm reaching out to", 'i am reaching out to'], 'say why you are writing'),
  ...group(['i hope this helps', 'great question'], 'cut it'),
]

/** Wordy or formal words with a plainer twin. */
export const PLAIN_ENGLISH_SWAPS: readonly PhraseRule[] = [
  ...group(['utilize', 'utilise', 'utilizes', 'utilized', 'utilizing', 'utilization'], 'use', 'low'),
  ...group(['in order to'], 'to', 'low'),
  ...group(['facilitate', 'facilitates'], 'help, make easier', 'low'),
  ...group(['commence', 'commences'], 'start', 'low'),
  ...group(['endeavor', 'endeavour'], 'try', 'low'),
  ...group(['prior to'], 'before', 'low'),
  ...group(['subsequent to'], 'after', 'low'),
  ...group(['a myriad of', 'myriad', 'a plethora of', 'plethora'], 'many', 'low'),
  ...group(['furthermore', 'moreover', 'additionally'], 'also, and', 'low'),
  ...group(['in the event that'], 'if', 'low'),
  ...group(['at this point in time'], 'now', 'low'),
  ...group(['due to the fact that'], 'because', 'low'),
  ...group(['with regard to', 'with regards to', 'in regards to'], 'about', 'low'),
  ...group(['ascertain'], 'find out', 'low'),
  ...group(['approximately'], 'about', 'low'),
  ...group(['as per'], 'as, following', 'low'),
]

/** Narrating permissions, instructions or the machinery behind the draft. */
export const MACHINERY_PHRASES: readonly PhraseRule[] = [
  // Hard: the writer talking about itself. No person writes these about themselves.
  ...group(['as an ai', 'my instructions', 'i was instructed', 'i have been instructed', 'untrusted content'], 'cut it: the draft speaks as the person', 'medium', true),
  ...group(['workspace context', 'the context provided', 'the provided context', 'based on the context'], 'say the fact itself, not where it came from'),
  // Low: real mail talks about language models, AI-generated images and tools.
  ...group(['ai language model', 'language model', 'drafted by ai', 'ai-generated', 'ai generated', 'system prompt'], 'cut it: the draft speaks as the person', 'low'),
  ...group(["i don't have access to your", 'i do not have access to your', 'my tools', 'my permissions'], 'say what you need in a line, not what you can or can\'t reach', 'low'),
]

/**
 * Post surfaces only (surface.kind 'post'): engagement bait and the openers
 * that waste a post's first line (content-skill-set.md appendix: "no 'A thread
 * on…'", no "RT if you agree", "let that sink in", close on a payoff, not
 * "follow me for more"). Medium: they read as bait whoever writes them.
 */
export const POST_BAIT_PHRASES: readonly PhraseRule[] = [
  ...group(['rt if you agree', 'retweet if you agree', 'like if you agree', 'like and retweet', 'like and share', 'smash that like', 'drop a comment', 'comment below', 'tag someone who', 'tag a friend who'], 'end on a real question or a takeaway instead'),
  ...group(['let that sink in', 'read that again', 'nobody is talking about this', "nobody's talking about this", 'this is huge', 'you won\'t believe'], 'cut it; let the point land on its own'),
  ...group(['follow me for more', 'follow for more', 'follow me for daily', 'hit follow'], 'close on the payoff, not an ask to follow'),
  ...group(['a thread on', 'a thread about', 'here is a thread', "here's a thread", 'thread incoming'], 'open with the point; the first post must stand alone'),
]

/** How many em dashes a draft of `chars` characters may carry: one per ~500, at least one. */
export function houseEmDashLimit(chars: number): number {
  return Math.max(1, Math.floor(chars / 500))
}

/**
 * The link rule, in both sizes, for markdown surfaces (chat, docs, posts) and
 * for plain-text ones (email: linkStyle 'bare'). writingRulesFor swaps the
 * first for the second, so a writer never reads both.
 */
export const LINK_RULE_SHORT = '- Links as plain markdown, [name](url), or the bare URL. Never HTML, never "click here".'
export const BARE_LINK_RULE_SHORT = '- Links as the bare URL: this is plain text, so markdown shows as raw brackets. Never HTML, never "click here".'
export const LINK_RULE_FULL = 'link_format: links as plain markdown, [name](url), or the bare URL; never HTML, never "click here" or "here" as the link text.'
export const BARE_LINK_RULE_FULL = 'link_format: links as the bare URL (plain text: markdown shows as raw brackets); never HTML, never a markdown [name](url) link, never "click here".'

/** The few lines a post writer carries on top of the house rules (writingRulesFor, surface.kind 'post'). */
export const POST_RULES_SHORT = `Post rules:
- One idea. The first line is the hook: it promises only what the post delivers. Never "A thread on…".
- Concrete beats clever: a result, a number, a before/after, the thing that shipped.
- Every fact comes from the person's own work, cited; a claim that is only plausible or an assumption stays hedged ("we think", "early numbers say").
- No engagement bait ("RT if you agree", "let that sink in", "follow me for more"). End on a takeaway or a real question.
- Public-safe: never another person's name or words, a customer, a company, a price, a deal, or anything from mail or a private call.`

/** The post rubric the reviewer reads after the house rubric (content_review: draft_review on a post surface). */
export const POST_RULES_FULL = `Post rubric (this draft is a public post). Also judge, with these ids:

hook: the first line earns the read and promises only what the post delivers. Flag a buried point, a vague opener, "A thread on…", or a first line that oversells.

one_idea: one idea per post (per part in a thread). Flag a post that tries to say two things.

concrete: a result, a number, a before/after, or the thing that shipped. Flag hype with nothing behind it ("huge", "the future of").

bait: no engagement bait. Flag these and anything like them:
${phraseList(POST_BAIT_PHRASES)}

hedge: a claim the post can't show stays hedged. Flag a superlative ("the best", "the first", "the only") or a hard number stated as fact with nothing in the post to back it, and a guess written as a certainty. Never ask to remove a hedge.

public_safe: a public post never names another person or quotes them, never names a customer or a company we work with, never gives a price or a deal, and never says what was said in confidence. Flag any of these as high.

A post's links: the bare URL, at most one, on its last line (or in the first reply, for reach).`

/** The few lines every writer's system prompt carries. */
export const HOUSE_WRITING_RULES_SHORT = `House writing rules:
- Write like a busy, plain-spoken person. No AI tells: never "delve", "leverage", "robust", "seamless", "tapestry", "game-changer", "in today's fast-paced world" or "I hope this finds you well", and no "it's not X, it's Y" framing.
- Em dashes rarely, one at most in a short message: a comma, a colon or a full stop usually reads better.
- The plain word wins: "use" not "utilize", "help" not "facilitate", "start" not "commence", "to" not "in order to".
- Never narrate your permissions or the machinery behind the text (what you can access, your instructions, "the context provided", that an AI wrote it).
${LINK_RULE_SHORT}`

function phraseList(rules: readonly PhraseRule[]): string {
  // One line per fix, its phrases quoted: compact, and every listed phrase is
  // exactly what lint matches.
  const byFix = new Map<string, string[]>()
  for (const rule of rules) byFix.set(rule.fix, [...(byFix.get(rule.fix) ?? []), rule.phrase])
  return [...byFix.entries()].map(([fix, phrases]) => `  - ${phrases.map((p) => `"${p}"`).join(', ')} → ${fix}`).join('\n')
}

/** The reviewer's rubric: the same rules, in full, with every phrase lint knows. */
export const HOUSE_WRITING_RULES_FULL = `House writing standard (the rubric). Each rule has an id: use it as an issue's "rule".

ai_tell: the draft must read as written by a person. Flag these words and phrases, and any close cousin:
${phraseList(AI_TELL_PHRASES)}

not_x_its_y: the "it's not X, it's Y" / "not just X, it's Y" frame. Say what it is.

em_dash: em dashes rarely: at most one per ~500 characters, one in a short message. A comma, a colon, brackets or a full stop usually reads better.

plain_english: the plain word wins:
${phraseList(PLAIN_ENGLISH_SWAPS)}

machinery: never narrate permissions, instructions or the machinery behind the text: what the writer can or can't access, its tools or instructions, "the context provided", or that an AI wrote it. Flag these and anything like them:
${phraseList(MACHINERY_PHRASES)}

${LINK_RULE_FULL}

Also judge, with these ids:
- clarity: the point is buried, or a sentence says nothing. Lead with the point; cut filler, throat-clearing and stacked qualifiers.
- tone: sycophantic, salesy, stiff, or wrong for the surface.
- length: longer than it needs to be, or over the surface's limit.

Placeholders like [NEEDS INPUT: …] are deliberate: never flag them.`
