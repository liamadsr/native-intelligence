/**
 * Merge-token rendering for sequence emails.
 *
 * Syntax: {{token}} or {{token|fallback text}}. Token matching is
 * case-INSENSITIVE on snake_case keys ({{First_Name}} == {{first_name}}) —
 * lemlist's case-sensitive variables are a documented footgun we don't copy.
 *
 * Values are HTML-escaped on substitution (bodies are HTML; a contact named
 * `<script>` must render inert). A token with neither a value nor a fallback
 * is UNRESOLVED — launch hard-blocks on it, and the engine refuses to send a
 * body containing one (mailing "{{first_name}}" to an investor is the exact
 * failure this exists to prevent).
 *
 * Malformed brace syntax ({{first-name}}, unclosed {{, nested braces) is
 * reported as a `malformed:<raw>` unresolved entry — it must block launch,
 * not get mailed verbatim. INVARIANT: unresolved.length === 0 implies the
 * rendered output contains no '{{' or '}}'.
 */

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:\|([^}]*))?\}\}/g
/** Any {{...}} span, valid or not — candidates for strict validation. */
const LOOSE_TOKEN_RE = /\{\{([^{}]*)\}\}/g
/** Strict name(|fallback) grammar for a loose match's inner text. */
const TOKEN_BODY_RE = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:\|([\s\S]*))?$/

export interface RenderResult {
  text: string
  /**
   * Token names (lowercased) that had no value and no fallback, plus
   * `malformed:<raw>` entries for brace syntax the grammar rejects.
   */
  unresolved: string[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>,
  opts: { escape?: boolean } = {},
): RenderResult {
  const escape = opts.escape ?? true
  const normalized = new Map<string, string>()
  for (const [key, value] of Object.entries(vars)) {
    if (value != null && value.trim() !== '') normalized.set(key.toLowerCase(), value)
  }

  const unresolved: string[] = []
  // `checked` pieces (raw template text, substituted values) must contain no
  // brace residue; re-emitted token spans are exempt — already reported above.
  const pieces: { text: string; checked: boolean }[] = []
  let last = 0
  for (const m of template.matchAll(LOOSE_TOKEN_RE)) {
    pieces.push({ text: template.slice(last, m.index), checked: true })
    last = m.index + m[0].length
    const body = TOKEN_BODY_RE.exec(m[1])
    if (!body) {
      unresolved.push(`malformed:${m[0]}`)
      pieces.push({ text: m[0], checked: false })
      continue
    }
    const key = body[1].toLowerCase()
    const value = normalized.get(key)
    if (value !== undefined) {
      pieces.push({ text: escape ? escapeHtml(value) : value, checked: true })
      continue
    }
    const fallback = body[2]?.trim()
    // A fallback trimming to '' ({{t|}}) is NOT a fallback — resolving it
    // silently mails a blank where the token was.
    if (fallback) {
      pieces.push({ text: escape ? escapeHtml(fallback) : fallback, checked: true })
      continue
    }
    unresolved.push(key)
    // Re-emit the ORIGINAL matched text so UI source-matching still works.
    pieces.push({ text: m[0], checked: false })
  }
  pieces.push({ text: template.slice(last), checked: true })

  // Unclosed '{{' / stray '}}' never matched LOOSE_TOKEN_RE — catch the residue.
  for (const piece of pieces) {
    if (piece.checked && /\{\{|\}\}/.test(piece.text)) {
      unresolved.push(`malformed:${piece.text.trim()}`)
    }
  }

  const text = pieces.map((p) => p.text).join('')
  // Belt-and-braces for the invariant: residue formed across piece boundaries.
  if (unresolved.length === 0) {
    const residue = /\{\{|\}\}/.exec(text)
    if (residue) unresolved.push(`malformed:${residue[0]}`)
  }

  return { text, unresolved: [...new Set(unresolved)] }
}

/** All token names (lowercased) referenced by a template. */
export function extractTokens(template: string): string[] {
  const names = new Set<string>()
  for (const match of template.matchAll(TOKEN_RE)) {
    names.add(match[1].toLowerCase())
  }
  return [...names]
}

export interface SequenceContactVars {
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  company?: string | null
  email?: string | null
}

/** Trimmed value, or null when empty/whitespace-only/absent. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * The v1 token vocabulary, built from a CRM contact + the sending user.
 * Deliberately small and fixed — arbitrary CRM fields are a later feature.
 */
export function buildTemplateVars(
  contact: SequenceContactVars,
  sender: { name?: string | null; email?: string | null },
): Record<string, string | null | undefined> {
  const fullName = clean(contact.full_name)
  const contactFirst = clean(contact.first_name) || fullName?.split(/\s+/)[0] || null
  const senderName = clean(sender.name) || clean(sender.email?.split('@')[0])
  return {
    first_name: contactFirst,
    last_name: contact.last_name,
    full_name: fullName || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null,
    company: contact.company,
    email: contact.email,
    sender_first_name: senderName?.split(/\s+/)[0] ?? null,
    sender_name: senderName,
  }
}
