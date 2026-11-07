/**
 * Parse / serialize `.env`-format text for cloud environments.
 *
 * A cloud environment stores its variables as raw `.env` text (what the user
 * pastes into the settings textarea). At run time we parse that into a
 * `Record<string,string>` to hand to `Sandbox.create({ env })`; for editing we
 * serialize a map back to text.
 *
 * This is a deliberately small, dependency-free parser covering the dotenv
 * conventions people actually paste:
 *   - `KEY=VALUE` and `KEY = VALUE` (whitespace around `=` trimmed)
 *   - blank lines and `#` comment lines (ignored)
 *   - inline `#` comments after an UNQUOTED value (stripped)
 *   - a leading `export ` (stripped, so pasted shell exports work)
 *   - single- or double-quoted values (quotes removed; inner `#` kept)
 *   - `\n`, `\t`, `\r`, `\"` escapes inside DOUBLE quotes only
 *
 * It is intentionally lenient: a malformed line (no `=`, empty key) is skipped
 * rather than throwing, so one bad paste never breaks a run. Keys must match a
 * conservative env-name shape; anything else is dropped.
 */

/** Conservative POSIX-ish env var name: letter/underscore then word chars. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Decode backslash escapes inside a double-quoted value in a SINGLE left-to-right
 * pass, so an escaped backslash (`\\`) consumes the next char and can't be
 * re-interpreted. A naive chain of sequential `.replace()` calls is wrong: it
 * would turn the input `C:\\new` (literal backslash + "new", as stringifyEnv
 * emits for `C:\new`) into `C:\` + newline + `ew` because `\n` matches before
 * `\\` collapses. Recognized escapes: \n \r \t \" \\; an unknown escape keeps the
 * following char literally (so `\x` → `x`), and a trailing lone backslash is kept.
 */
function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.|$)/g, (_m, c: string) => {
    switch (c) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case '"': return '"'
      case '\\': return '\\'
      case '': return '\\' // trailing lone backslash
      default: return c    // unknown escape: drop the backslash, keep the char
    }
  })
}

/**
 * Parse `.env`-format text into a key→value map. Later definitions of the same
 * key win (last-wins), matching dotenv. Returns `{}` for empty/blank input.
 */
export function parseEnvText(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!text) return out

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // Allow a pasted `export KEY=VALUE`.
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()

    const eq = line.indexOf('=')
    if (eq === -1) continue // not a KEY=VALUE line — skip

    const key = line.slice(0, eq).trim()
    if (!ENV_KEY_RE.test(key)) continue // junk key — skip

    let value = line.slice(eq + 1).trim()

    // A quoted value followed by an inline comment (`KEY="v" # note`): keep the
    // quoted part only, so the quote handling below sees `"v"`.
    if (value[0] === '"' || value[0] === "'") {
      const tail = /^(["'])((?:\\.|(?!\1).)*)\1\s+#.*$/.exec(value)
      if (tail) value = `${tail[1]}${tail[2]}${tail[1]}`
    }

    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      const quote = value[0]
      value = value.slice(1, -1)
      // Only double quotes process escapes; single quotes are literal.
      if (quote === '"') {
        value = unescapeDoubleQuoted(value)
      }
    } else {
      // Unquoted: strip a trailing inline comment (` # ...`). Require whitespace
      // before the `#` so values like `pass#1` survive.
      const hash = value.search(/\s#/)
      if (hash !== -1) value = value.slice(0, hash).trimEnd()
    }

    out[key] = value
  }

  return out
}

/**
 * Serialize a key→value map back to `.env` text. Values containing characters
 * that would change meaning (whitespace, `#`, quotes, newlines) are
 * double-quoted with the relevant characters escaped, so the result round-trips
 * back through `parseEnvText`. Keys are emitted in insertion order.
 */
export function stringifyEnv(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([key, value]) => `${key}=${quoteIfNeeded(value)}`)
    .join('\n')
}

function quoteIfNeeded(value: string): string {
  if (value === '') return ''
  // Safe bare value: no whitespace, no comment marker, no quotes/backslashes.
  if (/^[^\s#"'\\]+$/.test(value)) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}
