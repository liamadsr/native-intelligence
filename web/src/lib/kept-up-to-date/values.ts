/**
 * What a source's own words offer as a new value (tables phase 8,
 * ./engine.ts): the sentences a change may quote, and the dates and amounts
 * written in them. The decision only ever picks among these, so a date or a
 * number it sets is one the source says, never one it made up.
 *
 *   - Sentences: an email body's own lines (the quoted reply under "On … wrote:"
 *     and lines starting with ">" left out), split at sentence ends.
 *   - Dates: chrono-node over each sentence, read from the source's own date
 *     ("Friday" is the Friday after the message). A month alone ("push it to
 *     March") is that month's last day: a close date in March is one by its end.
 *   - Amounts: a currency sign or code beside a number ("$48,000", "45k USD",
 *     "€1.2m"), and plain numbers for number columns ("25 seats").
 *
 * Pure.
 */
import * as chrono from 'chrono-node'
import { KEPT_MAX_SENTENCES, KEPT_SENTENCE_MAX } from '@/lib/ai/decisions/tasks/record-kept-up-to-date'

/** At most this many sentences go to the decision as evidence. */
export const MAX_SENTENCES = KEPT_MAX_SENTENCES
/** A sentence's length in the state. */
export const SENTENCE_MAX = KEPT_SENTENCE_MAX
/** At most this many dates, amounts and plain numbers are offered per source. */
export const MAX_DATES = 4
export const MAX_AMOUNTS = 4
export const MAX_NUMBERS = 3

/** The body above a quoted reply: "On Tue, … wrote:", "-----Original Message-----", or ">" lines. */
export function ownText(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^On .{4,200}wrote:$/i.test(t) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break
    // Outlook's quoted header: a "From:" line after a blank one.
    if (out.length > 0 && /^From: .+/.test(t) && !(lines[i - 1] ?? '').trim()) break
    if (t.startsWith('>')) continue
    out.push(lines[i])
  }
  return out.join('\n')
}

/** A text's sentences, in order: each line split at sentence ends, clipped, empty ones gone. */
export function sentencesOf(text: string, max = MAX_SENTENCES): string[] {
  const out: string[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim()
    if (!t) continue
    for (const part of t.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)) {
      const s = part.trim()
      if (s.length < 2) continue
      out.push(s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX - 1)}…` : s)
      if (out.length >= max) return out
    }
  }
  return out
}

/** A date a source names: the stored form (YYYY-MM-DD) and the words that said it. */
export interface FoundDate {
  value: string
  phrase: string
  sentence: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** The dates the sentences name, from `refIso` (the source's own date), at most `max`, each once. */
export function datesIn(sentences: readonly string[], refIso: string | null, max = MAX_DATES): FoundDate[] {
  const ref = refIso && Number.isFinite(Date.parse(refIso)) ? new Date(refIso) : new Date()
  const out: FoundDate[] = []
  sentences.forEach((sentence, i) => {
    let results: chrono.ParsedResult[] = []
    try {
      results = chrono.parse(sentence, ref, { forwardDate: true })
    } catch {
      results = []
    }
    for (const r of results) {
      const c = r.start
      // A time alone ("at 3pm") is no date.
      if (!c.isCertain('day') && !c.isCertain('month') && !c.isCertain('weekday')) continue
      const y = c.get('year')
      const m = c.get('month')
      let d = c.get('day')
      if (!y || !m || !d) continue
      if (!c.isCertain('day') && !c.isCertain('weekday')) d = lastDay(y, m)
      const value = `${y}-${pad(m)}-${pad(d)}`
      if (out.some((x) => x.value === value)) continue
      out.push({ value, phrase: r.text.trim().slice(0, 80), sentence: i })
      if (out.length >= max) return
    }
  })
  return out.slice(0, max)
}

/** An amount a source names: the number, its currency when it says one, and the words. */
export interface FoundAmount {
  amount: number
  currency: string | null
  phrase: string
  sentence: number
}

const SIGNS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' }
const CODES: Record<string, string> = { usd: 'USD', eur: 'EUR', gbp: 'GBP', cad: 'CAD', aud: 'AUD', dollars: 'USD', dollar: 'USD', euros: 'EUR', euro: 'EUR', pounds: 'GBP' }
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`
const SCALE = String.raw`k|m|mm|bn|thousand|million|billion`
const SIGNED = new RegExp(String.raw`([$€£])\s?(${NUM})\s?(${SCALE})?\b`, 'gi')
const CODED = new RegExp(String.raw`\b(${NUM})\s?(${SCALE})?\s?(usd|eur|gbp|cad|aud|dollars?|euros?|pounds)\b`, 'gi')
const PLAIN = new RegExp(String.raw`(?<![\w$€£.,:/-])(${NUM})\s?(k|thousand|million)?(?![\w.,:/%-])`, 'gi')

function scaled(num: string, scale: string | undefined): number {
  const n = Number(num.replace(/,/g, ''))
  switch ((scale ?? '').toLowerCase()) {
    case 'k':
    case 'thousand':
      return n * 1_000
    case 'm':
    case 'mm':
    case 'million':
      return n * 1_000_000
    case 'bn':
    case 'billion':
      return n * 1_000_000_000
    default:
      return n
  }
}

/** The amounts with a currency the sentences name, at most `max`, each once. */
export function amountsIn(sentences: readonly string[], max = MAX_AMOUNTS): FoundAmount[] {
  const out: FoundAmount[] = []
  const add = (amount: number, currency: string | null, phrase: string, sentence: number) => {
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e15) return
    if (out.some((x) => x.amount === amount && x.currency === currency)) return
    out.push({ amount: Math.round(amount * 100) / 100, currency, phrase: phrase.trim().slice(0, 80), sentence })
  }
  sentences.forEach((s, i) => {
    for (const m of s.matchAll(SIGNED)) add(scaled(m[2], m[3]), SIGNS[m[1]] ?? null, m[0], i)
    for (const m of s.matchAll(CODED)) add(scaled(m[1], m[2]), CODES[m[3].toLowerCase()] ?? null, m[0], i)
  })
  return out.slice(0, max)
}

/**
 * Plain numbers the sentences name (for a number column: "25 seats"), past
 * the ones inside a date or an amount, and never a year, a time or a phone.
 */
export function numbersIn(sentences: readonly string[], dates: readonly FoundDate[], amounts: readonly FoundAmount[], max = MAX_NUMBERS): FoundAmount[] {
  const out: FoundAmount[] = []
  sentences.forEach((s, i) => {
    const taken = [...dates.filter((d) => d.sentence === i).map((d) => d.phrase), ...amounts.filter((a) => a.sentence === i).map((a) => a.phrase)]
    for (const m of s.matchAll(PLAIN)) {
      if (taken.some((t) => t.includes(m[1]))) continue
      const n = scaled(m[1], m[2])
      if (!Number.isFinite(n) || n <= 0 || n >= 1e15) continue
      // A bare year reads as a date, not a number.
      if (!m[2] && /^(19|20)\d{2}$/.test(m[1])) continue
      if (out.some((x) => x.amount === n) || amounts.some((a) => a.amount === n)) continue
      out.push({ amount: n, currency: null, phrase: m[0].trim(), sentence: i })
      if (out.length >= max) return
    }
  })
  return out.slice(0, max)
}
