/**
 * Best-effort extraction of a single string value from PARTIAL JSON as it
 * streams in token-by-token.
 *
 * The live-agent model writes the meeting summary as the `ai_summary` argument
 * to the write_summary tool (and `new_text` to update_summary). The AI SDK emits
 * those arguments as `tool-input-delta` parts — raw JSON fragments like
 * `{"ai_summary":"## Summ`. To show the summary typing in, we need the current
 * value of that one key, decoded (so `\n` → newline, `\"` → quote), even though
 * the JSON isn't closed yet.
 *
 * A full JSON.parse can't run on an unterminated string, so we scan manually:
 * find `"<key>"` followed by `:` and an opening quote, then walk the value
 * decoding escapes until we hit the (unescaped) closing quote or the end of
 * what's arrived so far. Returns the decoded value (which grows as more deltas
 * arrive), or '' if the key/opening quote hasn't appeared yet.
 *
 * Deliberately tolerant: a half-written escape at the very end (a lone trailing
 * backslash, or `\u00` mid-sequence) is dropped from this pass and completed on
 * the next delta. The goal is a smooth-growing preview, not strict correctness —
 * the canonical value lands via the DB write regardless.
 */
// Hard cap on the extracted value length. A real meeting summary is a few KB;
// this is a safety net against a buggy/adversarial tool sending an enormous
// unclosed string, which — re-scanned per delta — would otherwise allocate
// unbounded memory (and the value is only a live PREVIEW; the canonical summary
// lands via the tool's own DB write regardless of what we render here).
const MAX_VALUE_LENGTH = 1_000_000 // 1MB of decoded text

export function extractStreamingStringValue(json: string, key: string): string {
  const needle = `"${key}"`
  const keyIdx = json.indexOf(needle)
  if (keyIdx === -1) return ''

  // Advance past the key, optional whitespace, the colon, optional whitespace,
  // and the opening quote of the value.
  let i = keyIdx + needle.length
  while (i < json.length && /\s/.test(json[i])) i++
  if (json[i] !== ':') return ''
  i++
  while (i < json.length && /\s/.test(json[i])) i++
  if (json[i] !== '"') return ''
  i++ // now at the first char of the value

  let out = ''
  while (i < json.length) {
    const ch = json[i]
    if (ch === '\\') {
      // Escape sequence — need at least one more char.
      if (i + 1 >= json.length) break // half-written escape; finish next delta
      const next = json[i + 1]
      switch (next) {
        case 'n': out += '\n'; i += 2; break
        case 't': out += '\t'; i += 2; break
        case 'r': out += '\r'; i += 2; break
        case '"': out += '"'; i += 2; break
        case '\\': out += '\\'; i += 2; break
        case '/': out += '/'; i += 2; break
        case 'b': out += '\b'; i += 2; break
        case 'f': out += '\f'; i += 2; break
        case 'u': {
          // \uXXXX — need 4 hex digits.
          if (i + 6 > json.length) { i = json.length; break } // incomplete; stop
          const hex = json.slice(i + 2, i + 6)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16))
            i += 6
          } else {
            i = json.length // malformed; stop cleanly
          }
          break
        }
        default:
          // Unknown escape — emit the char literally and move on.
          out += next; i += 2; break
      }
    } else if (ch === '"') {
      // Unescaped closing quote — value is complete.
      break
    } else {
      out += ch
      i++
    }
    // Safety cap: stop accumulating past the max (a pathological unclosed value).
    if (out.length >= MAX_VALUE_LENGTH) break
  }

  return out
}
