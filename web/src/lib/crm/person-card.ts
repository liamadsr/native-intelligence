/**
 * A person's card in the live agent's HUD (live sidekick plan, Phase 2): who
 * a voice on the call is, once Voice ID has linked it to a contact. Small on
 * purpose (a 472×536 window): their name, role · company, how they relate to
 * the workspace, and one line of background.
 *
 * Read by GET /api/account/contacts/[id]/card; drawn by
 * components/live-hud/hud-person-card.tsx. Client-safe: no server imports.
 */
import { cleanText, readBlob } from './enrichment-details'

export interface PersonCard {
  id: string
  name: string
  role: string | null
  company: string | null
  /** "Customer · Warm", "Teammate": null when the record says nothing (a plain contact, a neutral tie). */
  relationship: string | null
  /** One line about them: the enricher's summary, else the start of the notes. */
  background: string | null
}

/** The slice of a contact row the card reads. */
export interface PersonCardRow {
  id: string
  full_name?: string | null
  email?: string | null
  job_title?: string | null
  relationship_type?: string | null
  relationship_strength?: string | null
  notes?: string | null
  metadata?: { enrichment?: unknown } | null
  company?: { name?: string | null } | { name?: string | null }[] | null
}

/** `contact.relationship_type` (mig 266's CHECK list) as the card says it; 'contact' says nothing. */
const RELATIONSHIP_TYPE_LABELS: Record<string, string> = {
  lead: 'Lead',
  customer: 'Customer',
  partner: 'Partner',
  vendor: 'Vendor',
  internal: 'Teammate',
  candidate: 'Candidate',
}

/** `contact.relationship_strength` as the card says it; 'neutral' (the default) says nothing. */
const RELATIONSHIP_STRENGTH_LABELS: Record<string, string> = {
  strong: 'Strong',
  warm: 'Warm',
  cold: 'Cold',
  stale: 'Gone quiet',
}

/** The card's background line is at most this long. */
export const PERSON_CARD_BACKGROUND_MAX = 160

/** The first sentence of `text`, cut at a word to PERSON_CARD_BACKGROUND_MAX. */
export function oneLine(text: string | null | undefined): string | null {
  const flat = cleanText(typeof text === 'string' ? text.replace(/\s+/g, ' ') : null)
  if (!flat) return null
  const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat
  if (sentence.length <= PERSON_CARD_BACKGROUND_MAX) return sentence
  const cut = sentence.slice(0, PERSON_CARD_BACKGROUND_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
}

export function buildPersonCard(row: PersonCardRow): PersonCard {
  const company = Array.isArray(row.company) ? (row.company[0] ?? null) : (row.company ?? null)
  const relationship = [
    RELATIONSHIP_TYPE_LABELS[row.relationship_type ?? ''],
    RELATIONSHIP_STRENGTH_LABELS[row.relationship_strength ?? ''],
  ].filter(Boolean)
  return {
    id: row.id,
    name: cleanText(row.full_name) ?? cleanText(row.email) ?? 'Unknown',
    role: cleanText(row.job_title),
    company: cleanText(company?.name),
    relationship: relationship.length ? relationship.join(' · ') : null,
    background: oneLine(readBlob(row.metadata?.enrichment).summary) ?? oneLine(row.notes),
  }
}
