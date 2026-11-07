/**
 * The campaign row's shape, once — shared by the API routes, the AI tools and
 * the Campaigns UI.
 *
 * CLIENT-BUNDLE SAFE: plain data and pure functions only (the view imports the
 * status list to render its picker), so nothing here may touch Supabase.
 *
 * `parseCampaignWrite` is the whole write-validation surface for both routes.
 * It is PARTIAL by construction — a key absent from the body is absent from
 * `fields`, so the same function serves a create (where the caller adds
 * `name`/defaults) and a PATCH (where an unmentioned column must not be
 * blanked). That partiality is the one property worth testing directly.
 *
 * A campaign that SENDS (roadmap D2) also carries an audience (a CRM filter
 * or group: `parseAudience`), the sequence it sends, whether it keeps adding
 * new matches each week (`rolling`), and the recipe it came from. Its
 * sent / replied / opted-out counts are computed from the sequence's
 * enrollments (src/lib/campaigns/counts.ts), never stored as running totals.
 */

export const CAMPAIGN_STATUSES = [
  'planned',
  'active',
  'paused',
  'completed',
  'archived',
] as const

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

/** Everything but the generated `fts` vector. */
export const CAMPAIGN_COLUMNS =
  'id, name, description, objective, status, channels, starts_on, ends_on, owner_member_id, tags, metadata, sequence_id, audience, rolling, recipe, launched_at, launched_by, refreshed_at, stats, created_at, updated_at'

/** The CRM relationship types an audience can pick (contact.relationship_type, migration 033). */
export const AUDIENCE_RELATIONSHIP_TYPES = ['customer', 'lead', 'partner', 'contact', 'vendor'] as const
export type AudienceRelationshipType = (typeof AUDIENCE_RELATIONSHIP_TYPES)[number]

/** The most contacts an explicit group may name. */
export const AUDIENCE_MAX_CONTACT_IDS = 500

/**
 * Who a campaign sends to: a CRM filter, a group, or both (every given part
 * must hold). Validated by `parseAudience`; JSON on the row.
 */
export interface CampaignAudience {
  /** CRM relationship types to include; absent: customers only. */
  relationship_types?: AudienceRelationshipType[]
  /** Only people last in touch more than this many days ago (contact.last_interaction_at). */
  last_contacted_more_than_days?: number
  /** With last_contacted_more_than_days: also people never in touch at all. Default false. */
  include_never_contacted?: boolean
  /** A CRM group: contacts carrying at least one of these tags. */
  tags_any?: string[]
  /** A group the person named: these contacts only. */
  contact_ids?: string[]
}

/** What a campaign's sends add up to (src/lib/campaigns/counts.ts). */
export interface CampaignCounts {
  /** People enrolled through it. */
  recipients: number
  /** People sent at least one email. */
  sent: number
  replied: number
  /** Stopped by the opt-out list: at enrollment (skipped) or before a later step. */
  opted_out: number
  /** Still in the sequence, more emails to come. */
  active: number
}

/** Running notes the launches write (skips by reason), beside the computed counts. */
export interface CampaignStats {
  skipped_opted_out?: number
  skipped_no_email?: number
  skipped_already_active?: number
  launches?: number
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  objective: string | null
  status: CampaignStatus
  channels: string[]
  starts_on: string | null
  ends_on: string | null
  owner_member_id: string | null
  tags: string[]
  metadata: Record<string, unknown>
  /** The sequence it sends (null: a planning record that sends nothing). */
  sequence_id: string | null
  audience: CampaignAudience | null
  /** Each week, new matches get a card of their own. */
  rolling: boolean
  /** The recipe it was set up from ('win_back'). */
  recipe: string | null
  launched_at: string | null
  launched_by: string | null
  refreshed_at: string | null
  stats: CampaignStats
  created_at: string
  updated_at: string
  /** Read paths only (the list route, list_campaigns): its counts and its sequence's name. */
  counts?: CampaignCounts
  sequence_name?: string | null
}

export function isCampaignStatus(raw: unknown): raw is CampaignStatus {
  return typeof raw === 'string' && (CAMPAIGN_STATUSES as readonly string[]).includes(raw)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Writable columns, and how each one is read out of a JSON body. */
export type CampaignWriteFields = Partial<{
  name: string
  description: string | null
  objective: string | null
  status: CampaignStatus
  channels: string[]
  starts_on: string | null
  ends_on: string | null
  owner_member_id: string | null
  tags: string[]
  sequence_id: string | null
  audience: CampaignAudience | null
  rolling: boolean
}>

export type CampaignWriteResult =
  | { ok: true; fields: CampaignWriteFields }
  | { ok: false; error: string }

/**
 * Read the writable campaign columns out of a request body.
 *
 * Absent key → absent field (a PATCH never blanks what it did not mention);
 * explicit `null` on a nullable column → cleared; an empty/whitespace string on
 * a nullable text column is treated as a clear, since that is what an emptied
 * form field means.
 */
export function parseCampaignWrite(body: Record<string, unknown>): CampaignWriteResult {
  const fields: CampaignWriteFields = {}

  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return { ok: false, error: 'name cannot be empty' }
    fields.name = name
  }

  for (const key of ['description', 'objective'] as const) {
    if (!(key in body)) continue
    const raw = body[key]
    if (raw === null) {
      fields[key] = null
      continue
    }
    if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` }
    fields[key] = raw.trim() || null
  }

  if ('status' in body) {
    if (!isCampaignStatus(body.status)) {
      return { ok: false, error: `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}` }
    }
    fields.status = body.status
  }

  for (const key of ['channels', 'tags'] as const) {
    if (!(key in body)) continue
    const raw = body[key]
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      return { ok: false, error: `${key} must be an array of strings` }
    }
    fields[key] = (raw as string[]).map((v) => v.trim()).filter(Boolean)
  }

  for (const key of ['starts_on', 'ends_on'] as const) {
    if (!(key in body)) continue
    const raw = body[key]
    if (raw === null || raw === '') {
      fields[key] = null
      continue
    }
    if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
      return { ok: false, error: `${key} must be an ISO date (YYYY-MM-DD)` }
    }
    fields[key] = raw
  }

  if ('owner_member_id' in body) {
    const raw = body.owner_member_id
    if (raw === null || raw === '') fields.owner_member_id = null
    else if (typeof raw !== 'string') {
      return { ok: false, error: 'owner_member_id must be a member uuid or null' }
    } else fields.owner_member_id = raw
  }

  if ('sequence_id' in body) {
    const raw = body.sequence_id
    if (raw === null || raw === '') fields.sequence_id = null
    else if (typeof raw !== 'string' || !UUID.test(raw)) {
      return { ok: false, error: 'sequence_id must be a sequence uuid or null' }
    } else fields.sequence_id = raw
  }

  if ('audience' in body) {
    if (body.audience === null) fields.audience = null
    else {
      const audience = parseAudience(body.audience)
      if (!audience.ok) return { ok: false, error: audience.error }
      fields.audience = audience.audience
    }
  }

  if ('rolling' in body) {
    if (typeof body.rolling !== 'boolean') return { ok: false, error: 'rolling must be true or false' }
    fields.rolling = body.rolling
  }

  return { ok: true, fields }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate an audience: known relationship types, a whole number of days
 * (1 to 3650), tags as strings, contact ids as uuids (at most
 * AUDIENCE_MAX_CONTACT_IDS), and at least one part that narrows it. Unknown
 * keys are dropped. Pure.
 */
export function parseAudience(raw: unknown): { ok: true; audience: CampaignAudience } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'audience must be an object' }
  const a = raw as Record<string, unknown>
  const audience: CampaignAudience = {}
  if (a.relationship_types !== undefined) {
    if (!Array.isArray(a.relationship_types) || a.relationship_types.length === 0 || a.relationship_types.some((t) => !(AUDIENCE_RELATIONSHIP_TYPES as readonly unknown[]).includes(t))) {
      return { ok: false, error: `audience.relationship_types must be some of: ${AUDIENCE_RELATIONSHIP_TYPES.join(', ')}` }
    }
    audience.relationship_types = [...new Set(a.relationship_types as AudienceRelationshipType[])]
  }
  if (a.last_contacted_more_than_days !== undefined) {
    const d = a.last_contacted_more_than_days
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 3650) {
      return { ok: false, error: 'audience.last_contacted_more_than_days must be a whole number of days from 1 to 3650' }
    }
    audience.last_contacted_more_than_days = d
  }
  if (a.include_never_contacted !== undefined) {
    if (typeof a.include_never_contacted !== 'boolean') return { ok: false, error: 'audience.include_never_contacted must be true or false' }
    audience.include_never_contacted = a.include_never_contacted
  }
  if (a.tags_any !== undefined) {
    if (!Array.isArray(a.tags_any) || a.tags_any.some((t) => typeof t !== 'string')) return { ok: false, error: 'audience.tags_any must be an array of strings' }
    const tags = (a.tags_any as string[]).map((t) => t.trim()).filter(Boolean)
    if (tags.length > 0) audience.tags_any = [...new Set(tags)]
  }
  if (a.contact_ids !== undefined) {
    if (!Array.isArray(a.contact_ids) || a.contact_ids.some((id) => typeof id !== 'string' || !UUID.test(id))) {
      return { ok: false, error: 'audience.contact_ids must be contact uuids' }
    }
    if (a.contact_ids.length > AUDIENCE_MAX_CONTACT_IDS) return { ok: false, error: `audience.contact_ids holds at most ${AUDIENCE_MAX_CONTACT_IDS}` }
    if (a.contact_ids.length > 0) audience.contact_ids = [...new Set(a.contact_ids as string[])]
  }
  if (!audience.relationship_types && audience.last_contacted_more_than_days === undefined && !audience.tags_any && !audience.contact_ids) {
    return { ok: false, error: 'audience needs at least one of relationship_types, last_contacted_more_than_days, tags_any or contact_ids' }
  }
  return { ok: true, audience }
}

const TYPE_PLURAL: Record<AudienceRelationshipType, string> = {
  customer: 'customers',
  lead: 'leads',
  partner: 'partners',
  contact: 'contacts',
  vendor: 'vendors',
}

/** "6 months" / "45 days": a day count in the person's words. Pure. */
function sinceText(days: number): string {
  if (days >= 60 && days % 30 === 0) return `${days / 30} months`
  if (days >= 365 && days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`
  return days === 1 ? '1 day' : `${days} days`
}

/**
 * The relationship types an audience matches: the ones it names; none named,
 * customers, unless it is a group (tags or chosen contacts), which takes
 * every type. Null: no type filter. Pure.
 */
export function audienceTypes(audience: CampaignAudience): AudienceRelationshipType[] | null {
  if (audience.relationship_types?.length) return audience.relationship_types
  return audience.tags_any?.length || audience.contact_ids?.length ? null : ['customer']
}

/** An audience in a line: "Customers last in touch more than 6 months ago, tagged rugs". Pure. */
export function describeAudience(audience: CampaignAudience | null | undefined): string {
  if (!audience) return 'No audience yet'
  if (audience.contact_ids && !audience.relationship_types && audience.last_contacted_more_than_days === undefined && !audience.tags_any) {
    return audience.contact_ids.length === 1 ? '1 chosen contact' : `${audience.contact_ids.length} chosen contacts`
  }
  const types = audienceTypes(audience)
  const who = types ? types.map((t) => TYPE_PLURAL[t]).join(' and ') : 'contacts'
  const parts = [who.charAt(0).toUpperCase() + who.slice(1)]
  if (audience.last_contacted_more_than_days !== undefined) {
    parts.push(`last in touch more than ${sinceText(audience.last_contacted_more_than_days)} ago${audience.include_never_contacted ? ' (or never)' : ''}`)
  }
  let line = parts.join(' ')
  if (audience.tags_any?.length) line += `, tagged ${audience.tags_any.join(' or ')}`
  if (audience.contact_ids?.length) line += `, among ${audience.contact_ids.length} chosen contacts`
  return line
}

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
}
