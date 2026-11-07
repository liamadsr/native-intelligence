import type { BrowserObservation } from './task-contract'

export const MAX_BROWSER_LINK_EVIDENCE_BYTES = 6000
export const MAX_BROWSER_EVIDENCE_LINKS = 12

export interface BrowserLinkEvidence {
  /** The containing task result's URL identifies the page these controls belong to. */
  source: 'final_native_observation'
  scope: 'visible_link_controls'
  observedAt: number
  /** Observing a link is not evidence about its destination page. */
  destinationsVisited: false
  links: { name: string; url: string }[]
  /** Output budgets or native control/string ceilings may have omitted evidence. */
  truncated: boolean
}

/** Exact destinations only: never infer a URL from text, truncate it, or fetch it. */
function safeDestination(value: string): boolean {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !!parsed.hostname
  } catch { return false }
}

/** Called only for the fresh observation that passed final task verification.
 * The inventory is viewport evidence, never a complete list of page links. */
export function browserLinkEvidence(observation: BrowserObservation): BrowserLinkEvidence {
  const evidence: BrowserLinkEvidence = {
    source: 'final_native_observation', scope: 'visible_link_controls', observedAt: observation.observedAt,
    destinationsVisited: false, links: [], truncated: observation.elements.length >= 100,
  }
  const encoder = new TextEncoder()
  const seen = new Set<string>()
  for (const control of observation.elements) {
    if (control.role !== 'link' || control.disabled || control.forbidden || !control.name.trim()) continue
    // Native targetData caps these strings without a per-field truncation bit.
    // A capped URL cannot be represented as an exact observed destination.
    if (control.destination.length >= 4000) { evidence.truncated = true; continue }
    if (!safeDestination(control.destination) || seen.has(control.destination)) continue
    if (control.name.length >= 300) evidence.truncated = true
    seen.add(control.destination)
    const link = { name: control.name, url: control.destination }
    // Reserve the longer `false` representation, even when already truncated.
    const candidate = { ...evidence, truncated: false, links: [...evidence.links, link] }
    if (evidence.links.length >= MAX_BROWSER_EVIDENCE_LINKS ||
      encoder.encode(JSON.stringify(candidate)).length > MAX_BROWSER_LINK_EVIDENCE_BYTES) {
      evidence.truncated = true
      continue
    }
    evidence.links.push(link)
  }
  return evidence
}
