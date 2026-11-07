export interface MeetingParticipant {
  email?: string
  name?: string
  company?: string
  jobTitle?: string
  isOrganizer?: boolean
}

export interface CaptureListItem {
  id: string
  title: string
  type: string
  summary: string | null
  recorded_at: string | null
  started_at?: string | null
  ended_at?: string | null
  created_at: string
  status: string
  is_pinned: boolean
  participants: MeetingParticipant[] | null
  duration_seconds: number | null
  ai_processed?: boolean
  source_action_count?: number
  suggested_action_count?: number
}

/** @deprecated Use CaptureListItem */
export type NoteListItem = CaptureListItem

export interface AttachmentItem {
  id: string
  file_name: string
  file_size_bytes: number | null
  mime_type: string | null
  file_extension: string | null
  file_category: string | null
  storage_path: string | null
  thumbnail_path: string | null
  /** @deprecated The DB column is `note_id`; use `note_id` for captures */
  capture_id?: string | null
  note_id: string | null
  action_id: string | null
  project_id: string | null
  created_at: string
}

export function formatCaptureDate(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const dateOnly = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  )

  if (dateOnly.getTime() === today.getTime()) return 'Today'
  if (dateOnly.getTime() === yesterday.getTime()) return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Returns a compact participant summary suitable for display in a capture row.
 *
 * Shows up to two names, then "+N more" for any additional participants.
 * Falls back to the email local-part when no display name is available.
 *
 * Examples:
 *   ["Alice Brown"]                          → "Alice Brown"
 *   ["Alice Brown", "Bob Chen"]              → "Alice Brown, Bob Chen"
 *   ["Alice Brown", "Bob Chen", "Carol Day"] → "Alice Brown, Bob Chen +1 more"
 */
export function formatParticipantSummary(
  participants: MeetingParticipant[],
): string {
  if (participants.length === 0) return ''

  function displayName(p: MeetingParticipant): string {
    if (p.name?.trim()) return p.name.trim()
    if (p.email?.trim()) return p.email.trim().split('@')[0]
    return ''
  }

  const names = participants.map(displayName).filter(Boolean)
  if (names.length === 0) return ''

  const MAX_SHOWN = 2
  if (names.length <= MAX_SHOWN) return names.join(', ')

  const shown = names.slice(0, MAX_SHOWN).join(', ')
  const remaining = names.length - MAX_SHOWN
  return `${shown} +${remaining} more`
}

function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.floor(
    (today.getTime() - dateOnly.getTime()) / 86400000,
  )

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'

  // Last 7 days: "Wed, Apr 2"
  if (diffDays < 7) {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  // Same year: "March 25"
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
    })
  }

  // Different year: "March 25, 2024"
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Returns a sortable key for a date (YYYY-MM-DD) to maintain reverse chronological order */
function getDaySortKey(dateStr: string): string {
  const date = new Date(dateStr)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function groupCapturesByDate(
  captures: CaptureListItem[],
): { label: string; captures: CaptureListItem[] }[] {
  const groups = new Map<string, { label: string; sortKey: string; captures: CaptureListItem[] }>()

  for (const capture of captures) {
    const dateStr = capture.started_at || capture.recorded_at || capture.created_at
    const label = getDayLabel(dateStr)
    const sortKey = getDaySortKey(dateStr)
    const existing = groups.get(sortKey)
    if (existing) {
      existing.captures.push(capture)
    } else {
      groups.set(sortKey, { label, sortKey, captures: [capture] })
    }
  }

  // Sort groups by sortKey descending (newest first)
  return Array.from(groups.values())
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(({ label, captures: groupCaptures }) => ({ label, captures: groupCaptures }))
}
