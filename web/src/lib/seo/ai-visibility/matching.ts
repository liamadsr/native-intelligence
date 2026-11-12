/**
 * Does an AI answer name a brand, and does it cite the brand's website?
 *
 *   - A brand is MENTIONED when its name, one of its other names, or its
 *     domain appears in the answer's prose as a whole word (case, accents
 *     written either way, and runs of spaces ignored). Links and email
 *     addresses in the prose are not mentions; citation pills are removed
 *     before matching (./evidence.ts).
 *   - A brand is CITED when the answer cites a page on its domain or a
 *     subdomain of it (never a look-alike: example.com.evil.test is not
 *     example.com).
 *   - A prompt is BRANDED when it names the brand itself (by name, other
 *     name, or domain): its answers always mention the brand, so the rates
 *     leave branded prompts out by default.
 *
 * A generic brand name can count as a mention of something else; that is
 * accepted for simplicity.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { parse } from 'tldts'
import type { AiBrandResult, AiRunBrand } from './view'

export interface AiCitation {
  url: string
  domain: string
  title: string | null
  position: number
}

export interface ParsedAiAnswer {
  /** Null when the engine gave no answer (or Google showed no AI Overview). */
  answerMarkdown: string | null
  /** Plain prose for brand matching; empty without an answer. */
  answerText: string
  citations: AiCitation[]
  collectedAt: string | null
}

/** Whether a host is the brand's domain or one of its subdomains. */
export function ownedAiDomain(hostname: string, owned: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  const domain = owned.toLowerCase().replace(/^www\./, '')
  return !!domain && (host === domain || host.endsWith(`.${domain}`))
}

/**
 * Where any of `names` appears in `text` as a whole word, as UTF-16 offsets
 * into the original text, overlapping matches folded into the longest.
 */
export function aiMentionSpans(
  text: string,
  names: string[],
): { start: number; end: number }[] {
  // URLs/emails in captured prose are not textual brand mentions. Keep their
  // length so returned offsets still address the original answer.
  const prose = text.replace(
    /(?:https?:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
    (value) => ' '.repeat(value.length),
  )
  // Match canonically equivalent Unicode without losing original UTF-16 spans.
  let normalized = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of prose) {
    const decomposed = character.normalize('NFD')
    normalized += decomposed
    for (let i = 0; i < decomposed.length; i++) {
      starts.push(offset)
      ends.push(offset + character.length)
    }
    offset += character.length
  }
  const found = new Map<string, { start: number; end: number }>()
  for (const name of new Set(
    names.map((n) => n.trim()).filter((n) => n.length >= 2),
  )) {
    const escaped = name
      .normalize('NFD')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`,
      'giu',
    )
    for (const match of normalized.matchAll(pattern)) {
      const index = match.index ?? 0
      const start = starts[index]
      const end = ends[index + match[0].length - 1]
      found.set(`${start}:${end}`, { start, end })
    }
  }
  return [...found.values()]
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter(
      (span, i, all) =>
        !all
          .slice(0, i)
          .some((other) => other.start <= span.start && other.end >= span.end),
    )
}

/** "www.acme.com" -> "acme"; subdomains and non-domains -> null. */
function rootDomainName(value: string) {
  const { hostname, domain, domainWithoutSuffix } = parse(value)
  return hostname?.replace(/^www\./, '') === domain ? domainWithoutSuffix : null
}

/** The words answers name a brand by. A brand named "acme.com" is also written "Acme". */
export function aiBrandNames(
  brand: Pick<AiRunBrand, 'name' | 'domain'> & { aliases?: string[] },
): string[] {
  const stem = rootDomainName(brand.name)
  const base =
    stem && stem === rootDomainName(brand.domain)
      ? [brand.name, brand.domain, stem]
      : [brand.name, brand.domain]
  return [...base, ...(brand.aliases ?? [])]
}

/** One brand in one answer: named or not (and where first), cited or not. */
export function matchAiBrand(
  answer: Pick<ParsedAiAnswer, 'answerText' | 'citations'>,
  brand: Pick<AiRunBrand, 'name' | 'domain'> & { aliases?: string[] },
) {
  const spans = aiMentionSpans(answer.answerText, aiBrandNames(brand))
  return {
    mentioned: spans.length > 0,
    cited: answer.citations.some((citation) =>
      ownedAiDomain(citation.domain, brand.domain),
    ),
    firstMention: spans[0]?.start ?? null,
  }
}

/**
 * Every brand's result in one answer, with each named brand's position: its
 * place in the order of first mentions (1 is named first).
 */
export function matchAiBrands(
  answer: Pick<ParsedAiAnswer, 'answerText' | 'citations'>,
  brands: AiRunBrand[],
): AiBrandResult[] {
  const results = brands.map((brand) => {
    const match = matchAiBrand(answer, brand)
    return {
      name: brand.name,
      domain: brand.domain,
      own: brand.own,
      mentioned: match.mentioned,
      cited: match.cited,
      first_mention: match.firstMention,
      position: null as number | null,
    }
  })
  const order = results
    .filter((r) => r.first_mention !== null)
    .sort((a, b) => (a.first_mention ?? 0) - (b.first_mention ?? 0))
  order.forEach((r, i) => {
    r.position = i + 1
  })
  return results
}

/** Whether a prompt names the brand (by name, other name, or domain). */
export function aiPromptIsBranded(
  prompt: string,
  brand: Pick<AiRunBrand, 'name' | 'domain'> & { aliases?: string[] },
): boolean {
  if (aiMentionSpans(prompt, [brand.name, ...(brand.aliases ?? [])]).length)
    return true
  const domain = brand.domain
    .replace(/^www\./i, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Domain labels must end here: example.com.evil.test is another site.
  return (
    !!domain &&
    new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}_-])${domain}(?![\\p{L}\\p{M}\\p{N}_.-])`,
      'iu',
    ).test(prompt)
  )
}
