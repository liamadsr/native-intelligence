/**
 * SKILL.md interop — parse/serialize the Anthropic Agent Skills SKILL.md format.
 *
 * SKILL.md is a plain markdown file with optional YAML frontmatter delimited by
 * `---` lines. The frontmatter carries flat keys (`name`, `description`, and
 * optionally `license`/`metadata`/`allowed-tools`); everything after it is the
 * markdown instructions body.
 *
 * We deliberately do NOT depend on a YAML library. The frontmatter we import is
 * flat `key: value` — a hand-rolled tolerant parser covers it and keeps the
 * import path dependency-free. Anything structured/nested/unknown in the
 * frontmatter is dropped with a warning rather than parsed, because Native Intelligence only
 * imports `name` + `description`; tool access is set inside Native Intelligence after import
 * (the SKILL.md → Native Intelligence contract per Phase 3).
 *
 * Export is the inverse and STRICT: `serializeSkillMd` writes only standard
 * frontmatter (`name`, `description`) plus the body and any appended prose
 * sections. The export route folds NI-specific config (context_rules,
 * response_style) in as those prose sections rather than as custom frontmatter
 * keys, so the file stays portable to any SKILL.md consumer.
 */

export interface ParsedSkillMd {
  name: string
  description: string
  body: string
  warnings: string[]
}

/** The frontmatter keys we understand. Everything else is dropped w/ a warning. */
const KNOWN_KEYS = new Set(['name', 'description'])

/**
 * Human-facing warning for a frontmatter key we recognize by name but do not
 * import. `allowed-tools` gets a bespoke message pointing at where tool access
 * actually lives in Native Intelligence; other recognized-but-unsupported keys get a generic
 * "not imported" note.
 */
function unsupportedKeyWarning(key: string): string {
  if (key === 'allowed-tools') {
    return 'allowed-tools is not imported — set tool access in Native Intelligence after import'
  }
  return `${key} is not imported`
}

/**
 * Parse a SKILL.md file.
 *
 * Rules:
 *   - No frontmatter (missing or malformed opening delimiter) → the whole text
 *     is the body, name/description empty, and a warning is added.
 *   - Recognized-but-unsupported keys (license, metadata, allowed-tools) and any
 *     other unknown key → dropped, each with its own warning.
 *   - name/description are trimmed (and unquoted) from their frontmatter values.
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const warnings: string[] = []
  const normalized = text.replace(/\r\n/g, '\n')

  const fm = extractFrontmatter(normalized)
  if (!fm) {
    warnings.push('No frontmatter found — imported the whole file as instructions')
    return { name: '', description: '', body: normalized.trim(), warnings }
  }

  let name = ''
  let description = ''
  // Track which keys we already warned about so a duplicated unknown key doesn't
  // spam the warning list.
  const warnedKeys = new Set<string>()

  for (const rawLine of fm.frontmatter.split('\n')) {
    const line = rawLine.trim()
    // Blank lines and YAML comments carry no key/value — skip silently.
    if (!line || line.startsWith('#')) continue

    // Nested/sequence YAML (indented children, `- item` entries) belongs to a
    // structured value we don't import. The parent key already produced a
    // warning when we saw it; the children are ignored gracefully.
    if (/^\s/.test(rawLine) || line.startsWith('- ')) continue

    const colon = line.indexOf(':')
    if (colon === -1) {
      // A frontmatter line with no `key:` shape — not something we can map.
      continue
    }

    const key = line.slice(0, colon).trim()
    const rawValue = line.slice(colon + 1).trim()

    if (!KNOWN_KEYS.has(key)) {
      if (!warnedKeys.has(key)) {
        warnings.push(unsupportedKeyWarning(key))
        warnedKeys.add(key)
      }
      continue
    }

    const value = unquoteYamlValue(rawValue)
    if (key === 'name') name = value
    else if (key === 'description') description = value
  }

  return {
    name: name.trim(),
    description: description.trim(),
    body: fm.body.trim(),
    warnings,
  }
}

export interface SerializeSkillMdInput {
  /** Becomes the frontmatter `name` — the /command slug. */
  slug: string
  description: string
  /** Markdown instructions, written verbatim after the frontmatter. */
  body: string
  /** Extra prose sections appended after the body as `## heading` blocks. */
  extraSections?: Array<{ heading: string; lines: string[] }>
}

/**
 * Serialize a skill to SKILL.md text.
 *
 * STRICTLY standard frontmatter: `name` (from the slug) and `description`, and
 * nothing else — no NI-specific keys leak into the frontmatter. The body is
 * written verbatim; each extraSection is appended as `## <heading>` followed by
 * its lines. Frontmatter values that contain YAML-significant characters are
 * quoted/escaped.
 */
export function serializeSkillMd(input: SerializeSkillMdInput): string {
  const { slug, description, body, extraSections } = input

  const out: string[] = [
    '---',
    `name: ${formatYamlValue(slug)}`,
    `description: ${formatYamlValue(description)}`,
    '---',
    '',
  ]

  const trimmedBody = body.trim()
  if (trimmedBody) out.push(trimmedBody)

  for (const section of extraSections ?? []) {
    // Skip empty sections rather than emitting a bare heading with no content.
    if (!section.lines.length) continue
    if (out[out.length - 1] !== '') out.push('')
    out.push(`## ${section.heading}`, '', ...section.lines)
  }

  // Single trailing newline — POSIX-friendly, matches the export route's peers.
  return out.join('\n').replace(/\n*$/, '\n')
}

// ─── Frontmatter helpers ─────────────────────────────────────────────

/**
 * Split leading `---` frontmatter from the body. Returns null when the text
 * doesn't OPEN with a `---` delimiter line, or the closing `---` is missing —
 * both cases mean "no usable frontmatter" and the caller treats the whole text
 * as body.
 */
function extractFrontmatter(
  text: string,
): { frontmatter: string; body: string } | null {
  // Frontmatter must be the very first thing (optionally after blank lines).
  const leading = text.replace(/^\n+/, '')
  if (!/^---[ \t]*\n/.test(leading)) return null

  const afterOpen = leading.slice(leading.indexOf('\n') + 1)
  // Closing delimiter: a line that is exactly `---` (trailing whitespace ok).
  const closeMatch = afterOpen.match(/\n---[ \t]*(?:\n|$)/)
  if (!closeMatch || closeMatch.index === undefined) return null

  const frontmatter = afterOpen.slice(0, closeMatch.index)
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length)
  return { frontmatter, body }
}

/**
 * Strip a single layer of matching quotes and unescape the minimal set that
 * quoting introduces. Double-quoted values honor `\"`, `\\`, and the control-char
 * escapes `\n`/`\r`/`\t` that formatYamlValue emits; single-quoted values honor
 * YAML's `''` → `'`. Unquoted values are returned as-is.
 */
function unquoteYamlValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    // One left-to-right pass so `\\n` (escaped backslash + literal n) decodes to
    // the two-char string `\n`, NOT a newline — the backslash is consumed by its
    // own `\\` match before the `n` can be read as a control escape.
    return raw.slice(1, -1).replace(/\\(["\\nrt])/g, (_m, ch: string) => {
      if (ch === 'n') return '\n'
      if (ch === 'r') return '\r'
      if (ch === 't') return '\t'
      return ch // `"` or `\`
    })
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  return raw
}

/**
 * Render a frontmatter value, quoting when the raw string would be ambiguous or
 * invalid as a bare YAML scalar. We double-quote (escaping `\` and `"`) whenever
 * the value is empty, has edge whitespace, or contains a character that YAML
 * treats as significant in a bare scalar. Otherwise the bare value is emitted.
 */
function formatYamlValue(value: string): string {
  const v = value ?? ''
  const needsQuote =
    v === '' ||
    v !== v.trim() ||
    /[:#'"\n\r\t]/.test(v) ||
    /^[-?&*!|>%@`\[\]{},]/.test(v) ||
    /^(?:true|false|null|yes|no|on|off|~)$/i.test(v) ||
    // Bare numbers would be read as numeric scalars — quote to keep them strings.
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)
  if (!needsQuote) return v
  // Escape order matters: backslash FIRST (so the escapes we add below aren't
  // re-escaped), then the quote char, then the control chars into `\n`/`\r`/`\t`
  // sequences. Without the control-char step a value containing a real newline
  // would write a literally broken frontmatter line. unquoteYamlValue decodes
  // the same set so serialize → parse round-trips.
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}
