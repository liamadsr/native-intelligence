/**
 * Order keys: strings that sort the way the items stack, with room to put a
 * new key between any two. Digits are 0-9A-Za-z, compared as plain strings
 * (their ASCII order is their value order). A key never ends in the lowest
 * digit, so there is always a key below any key that is not empty.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
const val = (ch: string | undefined): number => (ch === undefined ? -1 : DIGITS.indexOf(ch))

export function isSortKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key.length || key.length > 200) return false
  for (const ch of key) if (DIGITS.indexOf(ch) < 0) return false
  return key[key.length - 1] !== DIGITS[0]
}

/**
 * A key strictly between `a` and `b`. `a` null or empty: before everything;
 * `b` null: after everything. Throws when a >= b.
 */
export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? ''
  const hi = b ?? null
  if (hi !== null && lo >= hi) throw new Error(`keyBetween: ${JSON.stringify(lo)} is not below ${JSON.stringify(hi)}`)
  let out = ''
  let i = 0
  // Walk the common prefix; once the two differ (or one ends), pick a digit between.
  for (;;) {
    const x = i < lo.length ? val(lo[i]) : 0
    const y = hi !== null && i < hi.length ? val(hi[i]) : BASE
    if (y - x > 1) {
      return out + DIGITS[x + Math.floor((y - x) / 2)]
    }
    if (y - x === 1) {
      // Take lo's digit and go on with no upper bound: anything longer than lo sorts below hi.
      out += DIGITS[x]
      i++
      for (;;) {
        const z = i < lo.length ? val(lo[i]) : 0
        if (BASE - z > 1) return out + DIGITS[z + Math.ceil((BASE - z) / 2)]
        out += DIGITS[z]
        i++
      }
    }
    // Same digit: keep it.
    out += DIGITS[x]
    i++
  }
}

/**
 * Keys for things added in front, one after another, stay short: a letter
 * that says how many digits follow (a: one, b: two…), then that many digits
 * from 1 to z, counted up. 'a1'…'az', then 'b11'…'bzz', and so on: twenty
 * thousand items in front of each other are four characters each. No digit
 * here is ever 0, so the rule above (no key ends in the lowest digit) holds.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const FIRST = DIGITS[1]
const LAST = DIGITS[BASE - 1]

function countUp(head: string): string | null {
  const chars = [...head]
  for (let i = chars.length - 1; i >= 1; i--) {
    if (chars[i] !== LAST) {
      chars[i] = DIGITS[val(chars[i]) + 1]
      return chars.join('')
    }
    chars[i] = FIRST
  }
  // Every digit was the last one: one more digit, under the next letter.
  const next = LETTERS[LETTERS.indexOf(chars[0]) + 1]
  return next ? next + FIRST.repeat(chars.length) : null
}

/** A key after `a` (null: the first key), short however many times it is asked. */
export function keyAfter(a: string | null | undefined): string {
  if (!a || a < 'a1') return 'a1'
  const n = LETTERS.indexOf(a[0]) + 1
  if (n < 1) return keyBetween(a, null)
  // The counted part of `a`, made whole if `a` was cut short or holds a 0.
  let head = a[0]
  for (let i = 1; i <= n; i++) head += i < a.length && a[i] !== DIGITS[0] ? a[i] : FIRST
  if (head > a) return head
  return countUp(head) ?? keyBetween(a, null)
}

/** `n` keys in order, each after the last, all after `a`. */
export function keysAfter(a: string | null | undefined, n: number): string[] {
  const out: string[] = []
  let last = a ?? null
  for (let i = 0; i < n; i++) {
    last = keyAfter(last)
    out.push(last)
  }
  return out
}

/** `n` keys in order, all strictly between `a` and `b`. */
export function keysBetween(a: string | null | undefined, b: string | null | undefined, n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [keyBetween(a, b)]
  // Halve: a middle key, then each side. Keeps keys short for big batches.
  const mid = Math.floor(n / 2)
  const m = keyBetween(a, b)
  return [...keysBetween(a, m, mid), m, ...keysBetween(m, b, n - mid - 1)]
}
