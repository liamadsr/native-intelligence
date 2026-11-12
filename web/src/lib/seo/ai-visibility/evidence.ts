/**
 * One AI answer as the provider returned it, turned into what we keep: the
 * answer's markdown, its plain prose (for brand matching), and the pages it
 * cites. No URL is fetched and no model is called: everything comes from the
 * captured result. Cited URLs keep only http(s), lose tracking parameters
 * and fragments, and are de-duplicated in the engine's order.
 *
 * Answer text and titles come from an AI engine fed by the web: data, never
 * instructions.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { LlmResponseResult } from '@/lib/seo/dataforseo/llm-schemas'
import type { AiEngine } from '@/lib/seo/shared/ai-visibility'
import { z } from 'zod'
import { MAX_ANSWER_LENGTH } from './limits'
import type { AiCitation, ParsedAiAnswer } from './matching'

const optionalMarkdown = z.string().max(1_000_000).nullish()
const sourceList = z.array(z.unknown()).max(2_000).nullish()
const resultSchema = z.object({
  datetime: z.string().max(100).nullish(),
  // ChatGPT and Gemini scraper fields.
  markdown: optionalMarkdown,
  sources: sourceList,
  // Google organic results page field.
  items: z.array(z.unknown()).max(500).nullish(),
})
const aiOverviewSchema = z.object({
  type: z.literal('ai_overview'),
  markdown: optionalMarkdown,
  references: sourceList,
  items: z
    .array(z.object({ references: sourceList }))
    .max(500)
    .nullish(),
})
const sourceSchema = z.object({
  url: z.string().max(16_384),
  title: z.string().max(10_000).transform(withoutNul).nullish(),
})

/** An http(s) URL without credentials, as given; anything else null. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // user:pass@host: the host a reader sees may not be where the link goes.
    if (url.username || url.password) return null
    return value
  } catch {
    return null
  }
}

/**
 * One queued or scraped answer. `raw` null means the provider returned no
 * result (no answer). Returns null for a result we cannot read.
 */
export function parseDataforseoAnswer(
  raw: unknown,
  engine: AiEngine,
): ParsedAiAnswer | null {
  if (raw === null)
    return {
      answerMarkdown: null,
      answerText: '',
      citations: [],
      collectedAt: null,
    }
  const parsed = resultSchema.safeParse(raw)
  if (!parsed.success) return null
  const result = parsed.data
  let markdown: string | null
  let sources: unknown[]
  if (engine === 'google_ai_overview') {
    const overview = result.items
      ?.map((item) => aiOverviewSchema.safeParse(item))
      .find((item) => item.success)?.data
    markdown = overview?.markdown ?? null
    sources = [
      ...(overview?.references ?? []),
      ...(overview?.items ?? []).flatMap((item) => item.references ?? []),
    ]
  } else {
    markdown = result.markdown ?? null
    sources = result.sources ?? []
  }
  return finish(markdown, sources, dateOrNull(result.datetime))
}

/**
 * One answer asked through a model's own API: the message sections hold the
 * answer, their annotations the cited pages.
 */
export function parseLlmResponseAnswer(
  result: LlmResponseResult,
): ParsedAiAnswer {
  const sections = (result.items ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.sections ?? [])
  const markdown = sections
    .map((section) => section.text ?? '')
    .filter(Boolean)
    .join('\n\n')
  return finish(
    markdown,
    sections.flatMap((section) => section.annotations ?? []),
    null,
  )
}

function finish(
  rawMarkdown: string | null,
  sources: unknown[],
  collectedAt: string | null,
): ParsedAiAnswer {
  const markdown = rawMarkdown
    ? withoutNul(rawMarkdown).slice(0, MAX_ANSWER_LENGTH)
    : null
  const answerText = markdown ? markdownToText(markdown) : ''
  return {
    answerMarkdown: answerText.trim() ? markdown : null,
    answerText: answerText.trim() ? answerText : '',
    citations: citationsFrom(sources),
    collectedAt,
  }
}

/** Postgres text columns reject NUL, which scraped answers and titles can carry. */
function withoutNul(text: string): string {
  return text.replaceAll('\0', '')
}

function dateOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

/**
 * Plain answer prose for brand matching. Citation pills (`[1]`,
 * `[example.com]`) are evidence of a source, not a textual mention, so they
 * are removed; other links keep their label.
 */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)\s]*\)/g, '')
    .replace(
      /\[((?:[^[\]]|\[[^\]]*\])*)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label: string, url: string) =>
        citationPill(label, url) ? '' : label,
    )
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[*+-]\s+/gm, '$1')
}

function citationPill(label: string, url: string): boolean {
  const text = label
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase()
  if (/^\d+$/.test(text)) return true
  try {
    const host = new URL(url).hostname.toLowerCase()
    return text.replace(/^www\./, '') === host.replace(/^www\./, '')
  } catch {
    return false
  }
}

const MAX_TITLE = 500
const MAX_URL = 2048

/** Safe, de-duplicated cited URLs with tracking parameters removed. */
function citationsFrom(list: unknown[]): AiCitation[] {
  const citations = new Map<string, AiCitation>()
  for (const item of list) {
    const source = sourceSchema.safeParse(item)
    const safe = source.success ? safeHttpUrl(source.data.url) : null
    if (!source.success || !safe) continue
    const url = new URL(safe)
    url.hash = ''
    // Snapshot keys before deleting: the URLSearchParams iterator is live.
    for (const key of Array.from(url.searchParams.keys()))
      if (
        /^utm_/i.test(key) ||
        ['gclid', 'fbclid', 'msclkid'].includes(key.toLowerCase())
      )
        url.searchParams.delete(key)
    const normalized = url.toString()
    if (normalized.length > MAX_URL || url.hostname.length > 253) continue
    const title = source.data.title
      ? source.data.title.slice(0, MAX_TITLE)
      : null
    const existing = citations.get(normalized)
    if (existing) {
      existing.title ??= title
      continue
    }
    citations.set(normalized, {
      url: normalized,
      domain: url.hostname,
      title,
      position: citations.size + 1,
    })
  }
  return [...citations.values()]
}
