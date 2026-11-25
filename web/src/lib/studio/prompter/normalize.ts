// Words as the prompter compares them: what a script says and what the person was heard saying go through the same
// steps, so "Don't", "do not" and "dont", or "25%" and "twenty five percent", come out as the same tokens.
// Pure: no DOM, no clock. Used by follow.ts (where the speaker is in the script) and checklist.ts (what was covered).

/** One compared word: `stem` is what matching uses; `content` is false for a stop word. `from`/`to` are the
 *  character range in the source text the word came from (a contraction's or a number's words share their source's). */
export type Token = { word: string; stem: string; content: boolean; from: number; to: number }

const STOP_WORDS = new Set(
  (
    'a an the and or but if then so than that this these those there here is are was were be been being am do does did ' +
    'have has had having i me my mine we us our you your he him his she her it its they them their what which who whom ' +
    'whose when where why how all any both each few more most other some such no nor not only own same too very can will ' +
    'just should would could shall may might must of at by for with about against between into through during before after ' +
    'above below to from up down in out on off over under again further once also as well let lets okay ok oh um uh like ' +
    'yeah yes really actually basically right now go going get got gonna wanna kind sort thing things'
  ).split(' '),
)

const CONTRACTIONS: Record<string, string> = {
  "can't": 'can not', cant: 'can not', "won't": 'will not', wont: 'will not', "shan't": 'shall not',
  "ain't": 'is not', "let's": 'let us', "y'all": 'you all', "i'm": 'i am', im: 'i am', "it's": 'it is',
  "that's": 'that is', thats: 'that is', "what's": 'what is', whats: 'what is', "there's": 'there is',
  "here's": 'here is', "he's": 'he is', "she's": 'she is', "who's": 'who is', "where's": 'where is',
  "how's": 'how is', "gonna": 'going to', wanna: 'want to', gotta: 'got to',
}
// n't, 're, 've, 'll, 'd — the general forms, after the specials above.
const SUFFIXES: [RegExp, string][] = [[/n't$/, ' not'], [/'re$/, ' are'], [/'ve$/, ' have'], [/'ll$/, ' will'], [/'d$/, ' would']]
// Apostrophe-less spellings a recognizer writes ("dont", "youre"): only ones that are not also other words.
const BARE: Record<string, string> = {
  dont: 'do not', doesnt: 'does not', didnt: 'did not', isnt: 'is not', arent: 'are not', wasnt: 'was not',
  werent: 'were not', havent: 'have not', hasnt: 'has not', hadnt: 'had not', wouldnt: 'would not',
  couldnt: 'could not', shouldnt: 'should not', youre: 'you are', theyre: 'they are', weve: 'we have',
  youve: 'you have', theyve: 'they have', youll: 'you will', theyll: 'they will', ive: 'i have',
}
/** Words a recognizer swaps for each other: matched as one. */
const SAME: Record<string, string> = { their: 'there', theyre: 'there', thru: 'through', alright: 'all right', ok: 'okay' }

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const ORDINALS: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' }

/** A whole number as words ("1200" → "one thousand two hundred"); up to the billions, else digit by digit. */
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return ''
  if (n >= 1e12) return String(n).split('').map((d) => ONES[Number(d)]).join(' ')
  const parts: string[] = []
  const chunk = (v: number) => {
    const out: string[] = []
    if (v >= 100) { out.push(ONES[Math.floor(v / 100)]!, 'hundred'); v %= 100 }
    if (v >= 20) { out.push(TENS[Math.floor(v / 10)]!); v %= 10; if (v) out.push(ONES[v]!) }
    else if (v > 0 || out.length === 0) out.push(ONES[v]!)
    return out.join(' ')
  }
  if (n === 0) return 'zero'
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size) { parts.push(chunk(Math.floor(n / size)), name); n %= size }
  }
  if (n > 0) parts.push(chunk(n))
  return parts.join(' ')
}

function ordinal(words: string): string {
  const all = words.split(' '), last = all.pop()!
  const fixed = ORDINALS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`)
  return [...all, fixed].join(' ')
}

/** A number written with digits, as words: "3.5" → "three point five", "1st" → "first", "1,200" → "one thousand two hundred". */
function digitsAsWords(raw: string): string {
  const ord = /^(\d+)(st|nd|rd|th)$/.exec(raw)
  if (ord) return ordinal(numberWords(Number(ord[1])))
  const plain = raw.replace(/,/g, '')
  const dec = /^(\d+)\.(\d+)$/.exec(plain)
  if (dec) return `${numberWords(Number(dec[1]))} point ${dec[2]!.split('').map((d) => ONES[Number(d)]).join(' ')}`
  if (/^\d+$/.test(plain)) return numberWords(Number(plain))
  return raw
}

/** A word's stem for matching: possessives and common endings folded ("makes", "making", "made"? no: irregulars stay). */
export function stem(word: string): string {
  let w = word.replace(/'s$/, '').replace(/'/g, '')
  if (w.length <= 3) return w
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3)
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2)
  else if (/(ss|x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1)
  // "running" → "runn" → "run"; "make"/"making" → "mak".
  if (/([bdfgklmnprtz])\1$/.test(w) && w.length > 3) w = w.slice(0, -1)
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1)
  return w
}

/** The words of `text`, normalized, with where each came from. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  // Same length as `text` (each character folded on its own), so match offsets index the original.
  const folded = Array.from(text, (ch) => {
    const f = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[‘’ʼ`]/g, "'")
    return f.length === 1 ? f : ch.length === 1 ? (f[0] ?? ' ') : f.padEnd(ch.length, ' ').slice(0, ch.length)
  }).join('')
  const pattern = /\$?\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?%?|[a-z]+(?:'[a-z]+)*|[&%+]/g
  for (const match of folded.matchAll(pattern)) {
    const from = match.index!, to = from + match[0].length
    let raw = match[0]
    const out: string[] = []
    if (raw === '&' || raw === '+') out.push(raw === '&' ? 'and' : 'plus')
    else if (raw === '%') out.push('percent')
    else if (/^\$?\d/.test(raw)) {
      const dollars = raw.startsWith('$'), percent = raw.endsWith('%')
      raw = raw.replace(/^\$/, '').replace(/%$/, '')
      out.push(...digitsAsWords(raw).split(' '))
      if (percent) out.push('percent')
      if (dollars) out.push('dollars')
    } else {
      const expanded = CONTRACTIONS[raw] ?? BARE[raw] ?? SUFFIXES.reduce((w, [re, rep]) => (re.test(w) ? w.replace(re, rep) : w), raw)
      out.push(...expanded.split(' '))
    }
    for (const word of out) {
      if (!word) continue
      const same = SAME[word] ?? word
      const s = stem(same)
      tokens.push({ word: same, stem: s, content: !STOP_WORDS.has(same) && !STOP_WORDS.has(s), from, to })
    }
  }
  return tokens
}

/** The content words' stems of `text`, each once, in order (a checklist item's words). */
export function contentStems(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => t.content).map((t) => t.stem))]
}
