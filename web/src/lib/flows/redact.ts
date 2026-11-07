/**
 * A step's output as it is kept (F4 data passing, step-data.ts; a held
 * flow-step call's result, approvals.ts): every secret-shaped run of text
 * replaced, then capped. Pure, no imports.
 */
/** The most of one step's output that is kept and passed on. */
export const STEP_OUTPUT_MAX_CHARS = 8_000
/** What a cut output ends with. */
export const STEP_OUTPUT_TRUNCATED = ' [truncated]'

/** One step's stored output. */
export interface StepOutput {
  output: string
  /** True when the output was cut to the caps. */
  truncated?: true
}

/** Secret-shaped text, replaced wherever it appears in an output. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Authorization headers and bearer tokens.
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // Provider keys with well-known prefixes.
  /\b(sk|pk|rk)-(live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\blin_(api|oauth)_[A-Za-z0-9]{20,}\b/g,
  // A JWT (three base64url parts, the first a JSON header).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // A PEM private key block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/** `"password": "…"`, `api_key=…`, `token: …` and the like: the value goes, the name stays. */
const SECRET_FIELD_RE =
  /(["']?\b(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|private[_-]?key)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi

export const REDACTED = '[redacted]'

/** Text with every secret-shaped run replaced. Pure. */
export function redactSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out.replace(SECRET_FIELD_RE, (_m, name: string) => `${name}${REDACTED}`)
}

/** Cut text to `max` characters, never splitting a surrogate pair. */
function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  let end = Math.max(0, max)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--
  return { text: text.slice(0, end) + STEP_OUTPUT_TRUNCATED, truncated: true }
}

/** A step's raw output as it is kept: redacted, then capped. */
export function capStepOutput(raw: string | null | undefined, max: number = STEP_OUTPUT_MAX_CHARS): StepOutput {
  const { text, truncated } = cut(redactSecrets(typeof raw === 'string' ? raw : ''), max)
  return truncated ? { output: text, truncated: true } : { output: text }
}

