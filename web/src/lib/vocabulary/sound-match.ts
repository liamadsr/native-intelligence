/**
 * Sound-match correction for transcripts (docs/plans/custom-vocabulary.md §9).
 *
 * A finished utterance is compared, one to three words at a time, with the
 * vocabulary by how it SOUNDS: each term and each span becomes a consonant
 * skeleton of how it is said ("Dial8" → "dial eight" → `dlAt`, "Superbase" →
 * `sprbs` vs Supabase `spbs`). A strong match is rewritten to the term's
 * spelling; a span whose letters equal a term's is respelled ("post hog" →
 * PostHog). The speech engine is never touched, so this works the same on
 * Deepgram and local-stt and costs a few milliseconds per utterance.
 *
 * The rules that keep ordinary speech safe (§9 "Rules v2"):
 *   1. keys keep a marker for each word-initial vowel ("iCloud" `Akld` ≠ "cloud" `kld`);
 *   2. a single ordinary English word is never replaced by sound (homophones
 *      like cellar → Sellar need an explicit "sounds like" form);
 *   3. ordinary-word checks understand plurals and verb endings (`isOrdinary`);
 *   4. a multi-word span holding a filler word is never joined into a term
 *      ("a very" → Avery).
 *
 * A port of the measured Python harness (dial8-desktop/.claude/boost-test/v2/
 * sm.py + phonetic.py + phonetic2.py, rules v2, forms policy), including
 * difflib's SequenceMatcher.ratio; checked edit for edit against it. Three
 * guards were added after review (2026-10-24), also mirrored in the harness
 * (SM_V3) and re-measured:
 *   5. a multi-word span never crosses punctuation ("go home. Page me" is not "Home Page");
 *   6. an exact match that only recases ordinary words is left alone ("mobile app"
 *      stays, though "Mobile App" is a project), and a term made only of ordinary
 *      words is never reached by sound ("mobile apps" is not "Mobile App");
 *   7. a possessive or contraction ending is matched without and kept ("Superbase's" → "Supabase's").
 * `__tests__/sound-match.test.ts` pins the cases that matter.
 *
 * Pure: no I/O. The ordinary-word lexicon is injected (./lexicon.ts loads it).
 */

const LETTER_NAMES: Record<string, string> = {
  a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef', g: 'jee', h: 'aych', i: 'eye', j: 'jay',
  k: 'kay', l: 'el', m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar', s: 'es', t: 'tee',
  u: 'you', v: 'vee', w: 'doubleyou', x: 'ex', y: 'why', z: 'zee',
}
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Words that are never joined into a term as part of a multi-word span. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'be', 'of', 'to', 'in', 'on', 'at', 'is', 'it', 'uh', 'um', 'and', 'or',
  'i', 'we', 'he', 'me', 'my', 'so', 'as', 'by', 'if', 'do', 'no', 'oh', 'ah', 'er',
])

const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** A run of digits as people say it: up to 99 as a number ("16" → sixteen), longer digit by digit. */
function numberWords(run: string): string {
  if (run.length === 2 && run[0] !== '0') {
    const n = Number(run)
    if (n < 20) return TEENS[n - 10]
    return n % 10 ? `${TENS[Math.floor(n / 10)]} ${DIGITS[n % 10]}` : TENS[n / 10]
  }
  return [...run].map((d) => DIGITS[Number(d)]).join(' ')
}

/**
 * A span as a sequence of said words, for word-for-word matches: spoken(), with
 * every single letter as its name ("A sixteen Z" → "ay sixteen zee").
 */
export function saidWords(text: string): string {
  return spoken(text)
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length === 1 && LETTER_NAMES[w] ? LETTER_NAMES[w] : w))
    .join(' ')
}

/**
 * The ways a term with letters spelled out or numbers in it is said, word for
 * word: as written ("a sixteen z"), digit by digit ("a one six z") and, for an
 * acronym, letter by letter ("A P I M"). Only forms of two words or more.
 */
export function saidForms(term: string): string[] {
  // Only a term said differently from how it reads (numbers, spelled letters): "Mobile App" has none.
  const plain = term.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).join(' ')
  const forms = new Set<string>()
  if (saidWords(term) !== plain) forms.add(saidWords(term))
  if (/\d\d/.test(term)) forms.add(saidWords(term.replace(/\d/g, (d) => ` ${d} `)))
  const compact = term.replace(/[^A-Za-z0-9]/g, '')
  if (compact.length >= 2 && compact.length <= 6 && isUpperWord(compact)) {
    forms.add([...compact.toLowerCase()].map((c) => LETTER_NAMES[c] ?? DIGITS[Number(c)]).join(' '))
  }
  return [...forms].filter((f) => f.split(' ').length >= 2)
}

/** Lowercase letters and digits only. */
export function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isUpperWord(w: string): boolean {
  // Python's str.isupper(): at least one cased character and no lowercase ones.
  return /[A-Z]/.test(w) && !/[a-z]/.test(w)
}

/** How a written term is said: camelCase split, digits and short all-caps runs spelled out. */
export function spoken(text: string): string {
  let t = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  t = t.replace(/([A-Za-z])(\d)/g, '$1 $2')
  t = t.replace(/(\d)([A-Za-z])/g, '$1 $2')
  const out: string[] = []
  for (const w of t.match(/[A-Za-z']+|\d+/g) ?? []) {
    if (/^\d+$/.test(w)) {
      out.push(numberWords(w))
    } else if (isUpperWord(w) && w.length >= 2 && w.length <= 5 && !/[AEIOU][^AEIOU]+[AEIOU]/.test(w)) {
      for (const c of w.toLowerCase()) {
        const name = LETTER_NAMES[c]
        if (name) out.push(name)
      }
    } else {
      out.push(w.toLowerCase())
    }
  }
  return out.join(' ')
}

const KEY_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['tch', 'x'], ['sch', 'sk'], ['ph', 'f'], ['ck', 'k'], ['sh', 'x'], ['ch', 'x'],
  ['th', '0'], ['wh', 'w'], ['gh', ''], ['dg', 'j'], ['kn', 'n'], ['wr', 'r'],
  ['qu', 'kw'], ['q', 'k'], ['x', 'ks'], ['z', 's'], ['v', 'f'],
]

/** Consonant skeleton (simplified Metaphone) of one spoken word or string. */
export function consonantKey(input: string): string {
  let s = input.toLowerCase().replace(/[^a-z]/g, '')
  for (const [a, b] of KEY_REPLACEMENTS) s = s.split(a).join(b)
  s = s.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
  s = s.replace(/g(?=[eiy])/g, 'j')
  s = s.replace(/w(?![aeiou])/g, '')
  s = s.replace(/[aeiouy]/g, '')
  s = s.replace(/h/g, '')
  return s.replace(/(.)\1+/g, '$1')
}

/** Per-word consonant keys, each word-initial vowel kept as an `A` marker. */
export function soundKey(spokenText: string): string {
  let out = ''
  for (const w of spokenText.split(/\s+/)) {
    if (!w) continue
    const k = consonantKey(w)
    out += 'aeiou'.includes(w[0]) ? `A${k}` : k
  }
  return out
}

// ── difflib.SequenceMatcher(None, a, b).ratio(), exactly ────────────────────
// The keys and spellings are short (well under difflib's 200-char autojunk
// threshold), so there is no junk and no popularity pruning to reproduce.

function longestMatch(a: string, b: string, b2j: Map<string, number[]>, alo: number, ahi: number, blo: number, bhi: number) {
  let besti = alo, bestj = blo, bestsize = 0
  let j2len = new Map<number, number>()
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>()
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue
      if (j >= bhi) break
      const k = (j2len.get(j - 1) ?? 0) + 1
      newj2len.set(j, k)
      if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k }
    }
    j2len = newj2len
  }
  return [besti, bestj, bestsize] as const
}

/** difflib's ratio: 2·M / (|a| + |b|), M = total size of the matching blocks. */
export function similarity(a: string, b: string): number {
  const total = a.length + b.length
  if (total === 0) return 1
  const b2j = new Map<string, number[]>()
  for (let j = 0; j < b.length; j++) {
    const list = b2j.get(b[j])
    if (list) list.push(j)
    else b2j.set(b[j], [j])
  }
  let matches = 0
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!
    const [i, j, k] = longestMatch(a, b, b2j, alo, ahi, blo, bhi)
    if (k) {
      matches += k
      if (alo < i && blo < j) queue.push([alo, i, blo, j])
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
    }
  }
  return (2 * matches) / total
}

// ── the term index ──────────────────────────────────────────────────────────

interface IndexEntry {
  term: string
  /** Where its term stands in the list: the compiled list puts the person's own words first. */
  order: number
  key: string
  letters: string
  spokenLetters: string
  bucket: string
}

function bigrams(k: string): string[] {
  if (k.length < 2) return [k]
  const out: string[] = []
  for (let i = 0; i < k.length - 1; i++) out.push(k.slice(i, i + 2))
  return out
}

const bucketOf = (key: string) => key.replace(/^A+/, '').slice(0, 1) || 'A'

export interface Candidate {
  score: number
  keyScore: number
  letterScore: number
  term: string
  /** Its term's place in the list (the earlier wins a tie). */
  order: number
}

/** Terms (and their extra sound forms) indexed by sound-key bigrams. */
export class SoundIndex {
  private readonly entries: IndexEntry[] = []
  private readonly grams = new Map<string, number[]>()

  constructor(terms: readonly string[], forms?: ReadonlyMap<string, readonly string[]>) {
    const order = new Map<string, number>()
    terms.forEach((t, i) => {
      if (!order.has(t)) order.set(t, i)
    })
    const add = (term: string, said: string) => {
      const sp = spoken(said)
      const key = soundKey(sp)
      const at = order.get(term) ?? terms.length
      this.entries.push({ term, order: at, key, letters: letters(said), spokenLetters: letters(sp), bucket: bucketOf(key) })
    }
    for (const t of terms) add(t, t)
    for (const [t, fs] of forms ?? []) for (const f of fs) add(t, f)
    this.entries.forEach((e, i) => {
      if (!e.key) return
      for (const g of new Set(bigrams(e.key))) {
        const list = this.grams.get(g)
        if (list) list.push(i)
        else this.grams.set(g, [i])
      }
    })
  }

  get size(): number {
    return this.entries.length
  }

  /** The best-sounding terms for a transcript span, best first. */
  candidates(span: string, top = 3): Candidate[] {
    const sp = spoken(span)
    const sk = soundKey(sp)
    if (sk.replace(/A/g, '').length < 2) return []
    const sl = letters(span)
    const ssl = letters(sp)
    const sg = new Set(bigrams(sk))
    const hits = new Map<number, number>()
    for (const g of sg) for (const i of this.grams.get(g) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1)
    const need = Math.max(1, Math.floor(sg.size / 3))
    const first = bucketOf(sk)
    const res: Candidate[] = []
    for (const [i, c] of hits) {
      const e = this.entries[i]
      if (c < need || e.bucket !== first) continue
      if (Math.abs(e.key.length - sk.length) > 2) continue
      const keyScore = similarity(sk, e.key)
      const letterScore = Math.max(similarity(sl, e.letters), similarity(ssl, e.spokenLetters))
      res.push({ score: 0.6 * keyScore + 0.4 * letterScore, keyScore, letterScore, term: e.term, order: e.order })
    }
    // Best first (Python sorted the (score, ks, ls, term) tuples descending).
    // A dead heat goes to the word earlier in the list, not the later letter
    // of the alphabet: the compiled list puts the person's own words first,
    // so a word they fixed a name to ("Jay Ng" → Giang: the name is its
    // "sounds like", so the two always tie) beats the name (Liam, 10-25).
    res.sort(
      (x, y) =>
        y.score - x.score ||
        y.keyScore - x.keyScore ||
        y.letterScore - x.letterScore ||
        x.order - y.order ||
        (y.term > x.term ? 1 : y.term < x.term ? -1 : 0),
    )
    return res.slice(0, top)
  }
}

// ── the corrector ───────────────────────────────────────────────────────────

/** Whether a transcript word is ordinary English (or a first name), plurals and verb endings included. */
export function isOrdinary(word: string, lexicon: ReadonlySet<string>): boolean {
  let w = word.toLowerCase().replace(/^'+|'+$/g, '')
  if (w.endsWith("'s")) w = w.slice(0, -2)
  if (lexicon.has(w)) return true
  const SUFFIXES: ReadonlyArray<readonly [string, string]> = [
    ['ies', 'y'], ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e'], ['ly', ''],
  ]
  for (const [suf, rep] of SUFFIXES) {
    if (w.endsWith(suf) && w.length > suf.length + 2 && lexicon.has(w.slice(0, -suf.length) + rep)) return true
  }
  return false
}

export interface CorrectorOptions {
  /**
   * The lexicon's first names that are nothing else (./lexicon-names.ts): a
   * one-word "sounds like" that is one of them ("Toma" for Thomas, learned
   * from the person's own fix) is matched when heard exactly, though it's an
   * ordinary word; an everyday word never is ("when" for Nguyen).
   */
  nameOnly?: ReadonlySet<string>
  /** Minimum score for a sound replacement. */
  strict?: number
  /** Added to `strict` when every word of the span is ordinary. */
  guard?: number
}

export interface Correction {
  kind: 'respell' | 'sound'
  from: string
  to: string
  /** The replacement token as written, punctuation and endings kept ("Supabase's,"). */
  output: string
  /** Index of the first token replaced and how many were. */
  index: number
  length: number
  score?: number
}

/** A near miss, for the log: the closest term to a span that was left alone, and why. */
export interface NearMiss {
  from: string
  to: string
  score: number
  /** "ordinary word", "ordinary words", "filler word", "term is ordinary words" or "below threshold". */
  reason: string
  index: number
}

export interface VocabularyEntry {
  term: string
  /** Extra ways it is said or (mis)written: "sounds like" and learned forms. */
  soundsLike?: readonly string[]
}

/** The punctuation around a token, so a replacement keeps "Superbase," → "Supabase,". */
function splitPunctuation(token: string): { lead: string; core: string; trail: string } {
  const m = token.match(/^([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)$/u)
  return m ? { lead: m[1], core: m[2], trail: m[3] } : { lead: '', core: token, trail: '' }
}

const stripToken = (token: string) => token.replace(/[^\p{L}\p{N}_'-]/gu, '')

/** Whether a span of tokens has punctuation between its words (a sentence or clause break). */
function crossesPunctuation(tokens: readonly string[], i: number, n: number): boolean {
  for (let k = i; k < i + n; k++) {
    const p = splitPunctuation(tokens[k])
    if (k < i + n - 1 && p.trail) return true
    if (k > i && p.lead) return true
  }
  return false
}

const ENDING = /['’](s|re|ll|ve|d|m)$/i

export class SoundMatchCorrector {
  private readonly index: SoundIndex
  private readonly exact = new Map<string, string>()
  /** "Sounds like" phrases of ordinary words ("super base"): matched letter for letter, never by sound. */
  private readonly exactForms = new Map<string, string>()
  /** One-word "sounds like" forms that are only first names ("Toma" for Thomas): matched exactly. */
  private readonly nameForms = new Map<string, string>()
  /** saidForms() of each term with spelled letters or numbers ("ay sixteen zee" → A16Z): matched word for word. */
  private readonly said = new Map<string, string>()
  private maxSaidTokens = 0
  /** Terms made only of ordinary words ("Mobile App"): exact recasing and sound matching never apply. */
  private readonly ordinaryTerms = new Set<string>()
  private readonly strict: number
  private readonly guard: number

  constructor(
    entries: readonly VocabularyEntry[],
    private readonly lexicon: ReadonlySet<string>,
    options: CorrectorOptions = {},
  ) {
    this.strict = options.strict ?? 0.86
    this.guard = options.guard ?? 0.08
    const terms: string[] = []
    const forms = new Map<string, string[]>()
    for (const e of entries) {
      const term = e.term.trim()
      if (!term) continue
      terms.push(term)
      this.exact.set(letters(term), term) // the last spelling wins, as in the harness
      if (term.split(/\s+/).every((w) => isOrdinary(w, lexicon))) this.ordinaryTerms.add(term)
      // A "sounds like" form that is itself ordinary words would turn everyday
      // speech into the term ("when" for Nguyen): it never reaches sound matching (§9).
      // A phrase of two or more such words that someone typed on purpose ("super base")
      // still counts, but only when heard exactly as written.
      const usable: string[] = []
      for (const f of e.soundsLike ?? []) {
        const words = f.trim().split(/\s+/).filter(Boolean)
        if (!words.length) continue
        if (!words.every((w) => isOrdinary(w, lexicon))) usable.push(f)
        else if (words.length > 1 && words.length <= 3) this.exactForms.set(letters(f), term)
        else if (words.length === 1 && options.nameOnly?.has(words[0].toLowerCase().replace(/['’]s$/, ''))) {
          this.nameForms.set(letters(f), term)
        }
      }
      if (usable.length) forms.set(term, [...(forms.get(term) ?? []), ...usable])
      for (const f of saidForms(term)) {
        this.said.set(f, term)
        this.maxSaidTokens = Math.min(6, Math.max(this.maxSaidTokens, f.split(' ').length))
      }
    }
    this.index = new SoundIndex(terms, forms)
  }

  get size(): number {
    return this.index.size
  }

  /**
   * Correct one utterance given as tokens (whitespace-split words, punctuation
   * attached). Returns the new tokens and what changed.
   */
  correctTokens(tokens: readonly string[], trace?: NearMiss[]): { tokens: string[]; corrections: Correction[] } {
    // Matched without a possessive or contraction ending ("Superbase's" is Superbase); the output keeps it.
    const texts = tokens.map((t) => stripToken(t).replace(ENDING, ''))
    const out: string[] = []
    const corrections: Correction[] = []
    const emit = (i: number, n: number, kind: Correction['kind'], term: string, score?: number) => {
      const first = splitPunctuation(tokens[i])
      const last = splitPunctuation(tokens[i + n - 1])
      const ending = last.core.match(ENDING)?.[0] ?? ''
      const keep = ending && !term.toLowerCase().endsWith(ending.toLowerCase()) ? ending : ''
      const output = `${first.lead}${term}${keep}${last.trail}`
      out.push(output)
      corrections.push({ kind, from: texts.slice(i, i + n).join(' '), to: term, output, index: i, length: n, score })
    }
    let i = 0
    while (i < tokens.length) {
      // Word for word, a term said the way it is written or spelled out ("A sixteen Z",
      // "A P I M"): exact, so the ordinary-word and filler guards don't apply.
      let saidHit: { n: number; term: string } | null = null
      for (let n = Math.min(this.maxSaidTokens, tokens.length - i); n >= 2; n--) {
        if (crossesPunctuation(tokens, i, n)) continue
        const words = texts.slice(i, i + n)
        // Letters alone must be at least three and not just "a"/"I" ("it was a I mean" is not AI).
        if (words.every((w) => w.length === 1) && (n < 3 || words.every((w) => /^[ai]$/i.test(w)))) continue
        const term = this.said.get(saidWords(words.join(' ')))
        if (term !== undefined) {
          saidHit = { n, term }
          break
        }
      }
      if (saidHit) {
        emit(i, saidHit.n, 'respell', saidHit.term, 1)
        i += saidHit.n
        continue
      }

      let best: { kind: 'noop' | 'respell' | 'sound'; n: number; term?: string; score?: number } | null = null
      let miss: Omit<NearMiss, 'index'> | null = null
      const near = (span: string, reason: string, c = this.index.candidates(span, 1)[0]) => {
        if (trace && c && c.score >= 0.75 && (!miss || c.score > miss.score)) miss = { from: span, to: c.term, score: c.score, reason }
      }
      for (const n of [3, 2, 1]) {
        if (i + n > tokens.length) continue
        const words = texts.slice(i, i + n)
        const span = words.join(' ')
        const sl = letters(span)
        if (!sl) continue
        const allOrdinary = words.every((w) => isOrdinary(w, this.lexicon))
        if (n > 1 && words.some((w) => FILLER_WORDS.has(w.toLowerCase()))) {
          if (trace) near(span, 'filler word')
          continue
        }
        if (n > 1 && crossesPunctuation(tokens, i, n)) continue
        const exact = this.exact.get(sl) ?? (n > 1 ? this.exactForms.get(sl) : undefined)
        // A name heard that the person spells their own way ("Toma" → Thomas).
        const named = exact === undefined && n === 1 ? this.nameForms.get(sl) : undefined
        if (named !== undefined) {
          best = { kind: 'respell', n, term: named }
          break
        }
        if (exact !== undefined) {
          const recaseOnly = allOrdinary && span.toLowerCase() === exact.toLowerCase()
          if (span === exact || (n === 1 && allOrdinary) || recaseOnly) { best = { kind: 'noop', n }; break }
          best = { kind: 'respell', n, term: exact }
          break
        }
        if (n === 1 && allOrdinary) {
          if (trace) near(span, 'ordinary word')
          continue
        }
        const c = this.index.candidates(span, 1)[0]
        if (!c) continue
        if (allOrdinary && this.ordinaryTerms.has(c.term)) {
          if (trace) near(span, 'term is ordinary words', c)
          continue
        }
        const need = this.strict + (allOrdinary ? this.guard : 0)
        if (c.score >= need && (best === null || c.score > (best.score ?? -1))) best = { kind: 'sound', n, term: c.term, score: c.score }
        else if (trace && c.score < need) near(span, allOrdinary ? 'ordinary words' : 'below threshold', c)
      }
      if (best && (best.kind === 'respell' || best.kind === 'sound') && best.term) {
        emit(i, best.n, best.kind, best.term, best.score)
        i += best.n
        continue
      }
      if (best && best.kind === 'noop') {
        out.push(...tokens.slice(i, i + best.n))
        i += best.n
        continue
      }
      if (trace && miss) trace.push({ ...(miss as Omit<NearMiss, 'index'>), index: i })
      out.push(tokens[i])
      i += 1
    }
    return { tokens: out, corrections }
  }

  /**
   * Correct a plain-text utterance (dictation, a transcript line). Every space
   * and line break outside a replaced span is kept as it was.
   */
  correctText(text: string, trace?: NearMiss[]): { text: string; corrections: Correction[] } {
    const found = [...text.matchAll(/\S+/g)]
    if (!found.length) return { text, corrections: [] }
    const r = this.correctTokens(found.map((m) => m[0]), trace)
    if (!r.corrections.length) return { text, corrections: [] }
    const at = new Map(r.corrections.map((c) => [c.index, c]))
    let out = ''
    let pos = 0
    for (let i = 0; i < found.length; ) {
      const c = at.get(i)
      const start = found[i].index ?? 0
      if (c) {
        const last = found[i + c.length - 1]
        out += text.slice(pos, start) + c.output
        pos = (last.index ?? 0) + last[0].length
        i += c.length
      } else {
        out += text.slice(pos, start + found[i][0].length)
        pos = start + found[i][0].length
        i++
      }
    }
    return { text: out + text.slice(pos), corrections: r.corrections }
  }
}
