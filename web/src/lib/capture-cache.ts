// ── Shared capture detail cache ────────────────────────────────
// Module-level cache so capture data survives unmount/remount on tab switch.
// Also allows recording-context to seed data from the POST response so the
// CaptureDetailPanel can render immediately without waiting for a re-fetch.

import type { NoteAttribution } from '@/components/note-attribution/note-attribution-extension'

interface MeetingParticipant {
  email?: string
  name?: string
  company?: string
  jobTitle?: string
  isOrganizer?: boolean
}

export interface CaptureLabel {
  id: string
  name: string
  color: string
}

export interface CaptureDetail {
  id: string
  title: string
  /** Creator (captures.user_id). Absent on payloads predating the visibility
   *  column — the scope control stays hidden rather than guessing ownership. */
  user_id?: string | null
  /** 'workspace' = every member sees it; 'private' = only the creator. */
  visibility: 'workspace' | 'private'
  content: string | null
  summary: string | null
  transcript: string | null
  user_notes: string | null
  audio_url: string | null
  duration_seconds: number | null
  source_url: string | null
  calendar_event_id: string | null
  meeting_url: string | null
  location: string | null
  organizer_email: string | null
  participants: MeetingParticipant[] | null
  project_id: string | null
  project_name: string | null
  tags: string[] | null
  labels: CaptureLabel[]
  metadata: Record<string, unknown> | null
  ai_processed: boolean
  ai_summary: string | null
  note_attributions: NoteAttribution[] | null
  decision_count: number
  suggested_decision_count: number
  status: string
  is_pinned: boolean
  started_at: string | null
  ended_at: string | null
  recorded_at: string | null
  /** Context packages attached via the "+ Packages" chip (mig 240). Empty =
   *  no package context injected into this capture's live agent. */
  package_ids: string[]
  created_at: string
  updated_at: string
}

export const captureDetailCache = new Map<string, CaptureDetail>()
export const CAPTURE_CACHE_MAX = 20

// ── Pending-create registry (optimistic capture start) ────────────
// Capture ids are client-minted and the detail panel opens BEFORE the create
// POST lands, so any direct writer to /api/account/captures/{id} (title rename,
// summary autosave, live_mode toggle, package ids) must wait for the
// row to exist — otherwise its PATCH 404s and the write is silently lost, then
// superseded by the INSERT's stale click-time values. recording-context
// registers the in-flight create here; writers await captureRowReady(id).
// Resolves true immediately for ids with no pending create (every
// non-optimistic path), false when the create failed (session torn down —
// skip the write).
const pendingCreates = new Map<string, Promise<boolean>>()

export function registerPendingCaptureCreate(id: string, settled: Promise<boolean>) {
  pendingCreates.set(id, settled)
  void settled.finally(() => {
    pendingCreates.delete(id)
  })
}

export async function captureRowReady(id: string): Promise<boolean> {
  return pendingCreates.get(id) ?? true
}

export function writeCaptureCache(id: string, data: CaptureDetail) {
  captureDetailCache.set(id, data)
  if (captureDetailCache.size > CAPTURE_CACHE_MAX) {
    const oldest = captureDetailCache.keys().next().value
    if (oldest) captureDetailCache.delete(oldest)
  }
}

/**
 * Seed the cache from a POST /api/account/captures response.
 * Fills in null/default values for fields not returned by the POST.
 */
export function seedCaptureCache(postResponse: {
  id: string
  title: string
  summary?: string | null
  recorded_at?: string | null
  created_at: string
  status: string
  is_pinned: boolean
  started_at?: string | null
  user_id?: string | null
  visibility?: 'workspace' | 'private'
}) {
  const now = new Date().toISOString()
  const seeded: CaptureDetail = {
    id: postResponse.id,
    title: postResponse.title,
    user_id: postResponse.user_id ?? null,
    visibility: postResponse.visibility ?? 'workspace',
    content: null,
    summary: postResponse.summary ?? null,
    transcript: null,
    user_notes: null,
    audio_url: null,
    duration_seconds: null,
    source_url: null,
    calendar_event_id: null,
    meeting_url: null,
    location: null,
    organizer_email: null,
    participants: null,
    project_id: null,
    project_name: null,
    tags: null,
    labels: [],
    metadata: null,
    ai_processed: false,
    ai_summary: null,
    note_attributions: null,
    decision_count: 0,
    suggested_decision_count: 0,
    status: postResponse.status,
    is_pinned: postResponse.is_pinned,
    started_at: postResponse.started_at ?? null,
    ended_at: null,
    recorded_at: postResponse.recorded_at ?? now,
    package_ids: [],
    created_at: postResponse.created_at,
    updated_at: postResponse.created_at,
  }
  writeCaptureCache(postResponse.id, seeded)
}
