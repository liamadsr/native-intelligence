/**
 * Pure, framework-free labeling for the onboarding researcher's tool calls.
 *
 * These functions turn one streamed `{ toolName, input }` tool-call into a warm,
 * present-tense one-liner ("Searching the web for Acme…", "Reading acme.com…",
 * "Creating your first project — Q3 launch…"). They have NO React/DOM/server
 * dependency, so they are shared by two very different callers:
 *
 *   - the CLIENT research companion hook (src/app/account/onboarding/
 *     use-research-companion.ts), which reconstructs a LIVE activity strip from
 *     the eve stream, and re-exports these names for backwards compatibility; and
 *   - the researcher AGENT tree, which captures the SAME trail DURABLY during the
 *     run and lands it in the home conversation as message history (so the main
 *     agent can answer "what did you look at?"). Because the eve compile can't import
 *     src/, the agent side carries a byte-for-byte MIRROR of this file at
 *     agents/onboarding-researcher/lib/research-activity-labels.ts — keep the two
 *     in sync (same mirror discipline as home-brief-writer.ts / research-progress.ts).
 *
 * Every reader is best-effort: provider-managed web tools vary their input field
 * names, so a missing field must never throw — it degrades to a generic line.
 */

/** Pull a plausible short label out of a tool-call input bag, best-effort. */
export function readString(input: unknown, ...keys: string[]): string | null {
  if (!input || typeof input !== 'object') return null
  const bag = input as Record<string, unknown>
  for (const k of keys) {
    const v = bag[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/** Reduce a URL to a bare hostname for a friendlier "Reading acme.com…". */
export function hostOf(raw: string | null): string | null {
  if (!raw) return null
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0] || null
  }
}

/** Elide long free text so a one-liner stays a one-liner. */
export function clip(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * Turn one tool-call into a friendly line. Returns a neutral fallback for tools
 * we don't specifically narrate — never a raw snake_case name, never silence.
 */
export function labelForToolCall(toolName: string, input: unknown): string {
  switch (toolName) {
    case 'enrich_company': {
      const company = readString(input, 'domain', 'name', 'company')
      return company ? `Researching ${clip(company)}…` : 'Researching your company…'
    }
    case 'enrich_me':
      return 'Looking you up…'
    case 'web_search': {
      const q = readString(input, 'query', 'q', 'search')
      return q ? `Searching the web for ${clip(q)}…` : 'Searching the web…'
    }
    case 'web_fetch': {
      const domain = hostOf(readString(input, 'url', 'uri', 'link'))
      return domain ? `Reading ${clip(domain)}…` : 'Reading a page…'
    }
    case 'save_research_claims':
      return 'Saving what I learned…'
    case 'save_starter_content': {
      const rename = readString(input, 'workspaceRename')
      if (rename) return `Naming your workspace ${clip(rename)}…`
      const project = readString(input, 'projectName')
      return project
        ? `Creating your first project — ${clip(project)}…`
        : 'Creating your first project…'
    }
    case 'finish_research':
      return 'Adding starter actions…'
    default:
      return 'Getting to know your workspace…'
  }
}

// ─── Phase mapping (working-step ghost plan) ─────────────────

export const WORKING_PHASES = [
  'Reading about your company',
  'Setting up a starter project',
  'Drafting your first actions',
] as const

export type WorkingPhaseIndex = 0 | 1 | 2

/** Which plan phase a tool-call belongs to (monotonic; unknown → null). */
export function phaseForToolCall(toolName: string): WorkingPhaseIndex | null {
  switch (toolName) {
    case 'web_search':
    case 'web_fetch':
    case 'save_research_claims':
    case 'enrich_company':
    case 'enrich_me':
    case 'read_file':
    case 'glob':
    case 'grep':
    case 'bash':
    case 'write_file':
      return 0
    case 'save_starter_content':
      return 2
    case 'finish_research':
      return 2
    default:
      return null
  }
}

/** Pull a company name from a seeding tool-call input, best-effort. */
export function companyNameFromToolCall(toolName: string, input: unknown): string | null {
  if (toolName === 'enrich_company') return readString(input, 'name', 'domain')
  if (toolName === 'save_starter_content') return readString(input, 'workspaceRename')
  return null
}
