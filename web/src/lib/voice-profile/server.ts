/**
 * Server-side voice-profile aggregation — turns raw user_voice_profile rows
 * into per-passage PROTOTYPES for live self-verification.
 *
 * Shared by GET /api/account/voice-profile?include=prototypes and the
 * self-binding re-verification route. Both build prototypes with the SAME
 * grouping logic as CRM contacts (src/lib/voice-prototypes.ts:buildContactProfile),
 * including the ≥3-session outlier filter — the enrollment flow writes exactly
 * one session_id per story passage (3), so the filter is active as mutual
 * corroboration. Pure functions, no I/O.
 */
import { buildContactProfile, MAX_PROTOTYPES, type EnrollmentRow } from '@/lib/voice-prototypes'

/**
 * One user_voice_profile row as read from Supabase.
 *
 * `embedding` comes back as the pgvector text form (a JSON-stringified array,
 * proven format from the voice-enrollments route) or an already-parsed array.
 */
export interface UserVoiceProfileRow {
  embedding: string | number[]
  quality: number | null
  session_id: string
  created_at: string | null
  /** 'settings_training' (the Settings passages) or 'session_confirm' (learned from a confirmed meeting voice). */
  source?: string | null
}

/** Parse the pgvector text form (or pass through a parsed array). */
function parseEmbedding(embedding: string | number[]): number[] {
  return typeof embedding === 'string' ? (JSON.parse(embedding) as number[]) : embedding
}

/**
 * The rows prototypes are built from: every Settings passage, then the newest
 * meeting-learned sessions (followups issue 11) up to MAX_PROTOTYPES sessions in
 * all. buildContactProfile keeps the most recent sessions, so without this a
 * week of confirmed meetings would push the clean read-aloud passages out.
 */
function pinnedSessions(rows: UserVoiceProfileRow[]): UserVoiceProfileRow[] {
  const bySession = new Map<string, { learned: boolean; latest: string }>()
  for (const r of rows) {
    const learned = r.source === 'session_confirm'
    const prev = bySession.get(r.session_id)
    const at = r.created_at ?? ''
    if (!prev) bySession.set(r.session_id, { learned, latest: at })
    else if (at > prev.latest) prev.latest = at
  }
  const settings = [...bySession].filter(([, s]) => !s.learned).map(([id]) => id)
  const learned = [...bySession]
    .filter(([, s]) => s.learned)
    .sort((a, b) => (a[1].latest < b[1].latest ? 1 : a[1].latest > b[1].latest ? -1 : 0))
    .map(([id]) => id)
  const keep = new Set([...settings, ...learned.slice(0, Math.max(0, MAX_PROTOTYPES - settings.length))])
  return rows.filter((r) => keep.has(r.session_id))
}

/**
 * Build per-session unit-norm prototypes from a user's stored voice-profile
 * rows. Empty input (never enrolled) → empty array. Reuses buildContactProfile
 * so the grouping, most-recent-first ordering, MAX_PROTOTYPES cap and the
 * outlier filter match contact matching exactly — over the Settings passages
 * plus the newest meeting-learned sessions (pinnedSessions).
 */
export function buildSelfPrototypes(rows: UserVoiceProfileRow[]): number[][] {
  const enrollmentRows: EnrollmentRow[] = pinnedSessions(rows).map((r) => ({
    embedding: parseEmbedding(r.embedding),
    session_id: r.session_id,
    created_at: r.created_at,
  }))
  const profile = buildContactProfile(enrollmentRows)
  return profile?.prototypes ?? []
}

/** Mean per-chunk quality across stored rows (0..1), or null when none/unknown. */
export function meanChunkQuality(rows: { quality: number | null }[]): number | null {
  const scores = rows.map((r) => r.quality).filter((q): q is number => typeof q === 'number')
  if (scores.length === 0) return null
  return scores.reduce((a, b) => a + b, 0) / scores.length
}
