'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { format, parseISO } from 'date-fns'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Video,
  Clock,
  ChevronDown,
  ChevronRight,
  Users,
  Loader2,
  X,
  Mail,
  Trash2,
  Plus,
  Calendar,
  Paperclip,
  Search,
  Link2,
  Link2Off,
  Play,
  UserPlus,
  ArrowRightLeft,
  Tag,
  RotateCw,
  Package,
  History,
  Info,
} from 'lucide-react'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { ProjectPanelField, type ProjectOption as PickerProjectOption } from '@/components/views/properties'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import dynamic from 'next/dynamic'
import { usePanelSection } from './use-panel-section'
import { ShareDialog } from '../components/share-dialog'
import {
  CaptureVisibilityControl,
  canOfferVisibilityControl,
  useCaptureVisibilityViewer,
  type CaptureVisibility,
} from '../components/capture-visibility-control'
import { DraftFollowUpDialog } from '../components/draft-followup-dialog'
import { CopyIdButton } from '../components/copy-id-button'
import { CopyTranscriptButton } from '../components/copy-transcript-button'
import { InlineCommentProvider } from '@/components/inline-comments/inline-comment-context'
import { AnnotatedContent } from '@/components/inline-comments/annotated-content'
import { SelectionPopover } from '@/components/inline-comments/selection-popover'
import { InlineCommentPopover } from '@/components/inline-comments/inline-comment-popover'
import { CommentableEditor } from '@/components/inline-comments/commentable-editor'
import { createAuthenticatedAPI, mapAuthComments, GUEST_NOOP_API } from '@/components/inline-comments/adapters'
import type { CommentIdentity } from '@/components/inline-comments/types'
import type { NoteAttribution } from '@/components/note-attribution/note-attribution-extension'
import { captureDetailCache, captureRowReady, writeCaptureCache, type CaptureDetail, type CaptureLabel } from '@/lib/capture-cache'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { namesLine, plainLine } from '@/lib/read-aloud/listen-briefs'
import { cachedJson } from '@/lib/cached-fetch'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { LabelPickerContent } from '@/components/labels/label-picker-content'
import { createClient } from '@/lib/supabase/client'
import { AttributionTooltip } from '@/components/note-attribution/attribution-tooltip'
import { LiveVoiceIdRow } from '@/components/capture/live-capture-header'
import { useLiveHudUp } from '@/components/capture/voice-id-hud-publisher'
import { SystemAudioWarning, systemAudioNeedsAttention } from '@/components/capture/system-audio-warning'
import { useStreamingExtraction, toolLabel } from '@/hooks/use-streaming-extraction'
import {
  registerStreamingPanel,
  unregisterStreamingPanel,
  STREAM_EXTRACTION_EVENT,
  type StreamExtractionDetail,
} from '@/lib/live-agent/streaming-extraction-bus'
import { isDesktopApp } from '@/lib/platform'
import { AttachmentsCarousel } from '@/components/capture/attachments-carousel'
import { ActivityRow } from '@/components/views/activity-row'
import { uploadAttachments } from '@/lib/attachments/upload-client'
import {
  CAPTURE_ATTACHMENTS_EVENT,
  announceCaptureAttachments,
  readAttachmentsCaptureId,
} from '@/lib/attachments/dropped-files'
import { useElementFileDrop } from '@/lib/attachments/use-element-file-drop'
import { ATTACHMENT_ACCEPT_ATTR } from '@/lib/attachments/constants'
import type { ProposedChange, ProposedChangeCounts } from '@/lib/proposed-changes/types'
import { DEFAULT_TRUST_POLICY } from '@/lib/proposed-changes/trust-policy'
import { ProposalNodeExtension } from '@/components/capture/proposal-node-extension'
import { ProposalNodeProvider, type ProposalNodeContextValue } from '@/components/capture/proposal-node-context'
import type { ProposalChangeRef } from './note-editor'
import { CaptureControlsBar } from './capture-controls-bar'
import { CaptureLiveChatSection, useCaptureLiveChat } from './capture-live-chat-section'
import { LiveCapturePills } from './live-capture-pills'
import { useLiveAgentStatus, useRecordingContext } from '@/hooks/recording-context'
import { useCurrentMemberId, useCurrentMemberProfile, useWorkspaceEdition, useWorkspaces } from '@/app/account/workspace-switcher'
import { editionDefaultAgentSlug } from '@/lib/editions'
import { resolveBatchHandoffAgentId } from '@/lib/live-agent/default-agent'
import { isAssistOnlyAgent, type AgentToolSelection } from '@/lib/live-agent/read-tool-names'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import { toast } from 'sonner'
import { useEntityDetailSync, useEntityListSync } from '@/hooks/use-entity-sync'
import { useRecordingPollFallback } from '@/hooks/use-recording-poll-fallback'
import { emitEntityUpdated } from '@/lib/entity-events'

// Sentinel value for the agent <Select>. A null agentId means the built-in
// "Assistant" persona (the general-purpose default, resolved server-side in
// /api/ai/live-agent). Radix Select needs a non-empty string value, so we map
// null ↔ this sentinel rather than using "".
const ASSISTANT_SENTINEL = '__assistant__'

interface MeetingParticipant {
  email?: string
  name?: string
  company?: string
  jobTitle?: string
  isOrganizer?: boolean
}

interface LinkedParticipant {
  id: string
  contact_id: string | null
  contact_name: string | null
  name: string
  email: string | null
  company: string | null
  job_title: string | null
  role: string | null
  avatar_url: string | null
  source?: 'calendar_event' | 'manual' | 'voice_id'
}

interface ContactSearchResult {
  id: string
  full_name: string
  email: string | null
  job_title: string | null
  company: { id: string; name: string } | null
}

// CaptureDetail type is imported from @/lib/capture-cache


interface Agent {
  id: string
  name: string
  icon: string | null
  color: string | null
  description: string | null
  is_default: boolean
  slug: string | null
  /** The agent's behavior config. Only `capture_mode` is read here (to tell an
   *  ASSIST-ONLY live copilot from a note-taker); the tool-selection fields are
   *  the runtimes' business. Already returned by GET /api/account/agents —
   *  `agent_config` is in LIBRARY_ITEM_FIELDS — so this only widens the local
   *  type to the payload that was always on the wire. */
  agent_config: AgentToolSelection | null
}

// The seeded "Interactive Assistant" system agent (migration 151) — its persona
// is written FOR live mode (leans forward, say_to_user as a primary channel). We
// lock the agent selector to it while live mode is on, UNLESS the workspace's
// edition names its own live default (see `defaultAgents` in the edition
// manifest). Matched by slug, which is stable across workspaces — and across
// environments, which is why the manifest names slugs rather than ids.
const INTERACTIVE_ASSISTANT_SLUG = 'interactive'

interface CalendarEventOption {
  id: string
  title: string
  start: string
  end: string
  attendees: string[]
  organizer: string | null
  conference_url: string | null
  location: string | null
  calendar_provider?: string
  // Recurring-series identity, passed through to link-event
  series_master_id?: string
  ical_uid?: string
  has_recurrence?: boolean
  source?: string
}

interface SeriesHistoryCapture {
  id: string
  title: string
  user_id: string
  is_own: boolean
  owner_name: string | null
  owner_avatar_url: string | null
  started_at: string | null
  ended_at: string | null
  duration_seconds: number | null
  visibility: string | null
}

interface SeriesOccurrence {
  occurrence_start: string
  captures: SeriesHistoryCapture[]
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${diffYears}y ago`
}

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`
}

// Capture detail cache is shared via @/lib/capture-cache

// Both realtime channels refetch on reaching SUBSCRIBED to close the
// mount→SUBSCRIBED replay gap — but on a plain panel open that fires ~1s after
// the mount fetch already resolved, downloading everything twice. Skip the
// resync when the corresponding fetch resolved this recently; a genuine
// reconnect (channel rejoin after a disconnect) arrives much later.
const SUBSCRIBED_RESYNC_SKIP_MS = 5_000

/**
 * Decide how the capture-stream channel handles an incoming ai_summary. TWO
 * INDEPENDENT decisions — the split is the point: `merge` compares against
 * capture STATE (skipping the redundant setCapture for the per-transcript-
 * append full-row rebroadcasts), while `push` compares against what the
 * EDITOR last received. State is freshened by refetch paths that deliberately
 * do NOT push to the editor (the 25s poll tick, useEntityDetailSync's
 * socket-recovery refetch, the capture-ended handler mid-recording) — so a
 * state-based push gate would classify a genuinely NEW summary as "already
 * seen" whenever such a refetch resolved first, and the editor would never
 * receive it. '' (a deliberate clear) flows through both decisions like any
 * other value; the '{{streaming}}' sentinel and non-string payloads flow
 * through neither.
 */
export function decideRealtimeSummary(
  newSummary: unknown,
  stateSummary: string | null | undefined,
  editorSummary: string | null,
): { merge: boolean; push: boolean } {
  if (typeof newSummary !== 'string' || newSummary === '{{streaming}}') {
    return { merge: false, push: false }
  }
  return {
    merge: newSummary !== stateSummary,
    push: newSummary !== editorSummary,
  }
}

/**
 * The capture channel's SUBSCRIBED-resync recency skip. A plain panel open
 * reaches SUBSCRIBED ~1s after the mount fetch resolved, so a fresh fetch
 * stamp skips the resync (avoids re-downloading the full row, transcript
 * included) — but ONLY when the editor is also in sync with state. A refetch
 * that freshened state WITHOUT pushing (socket recovery: detail-sync's
 * refetch lands, stamps the fetch time, then the channel finishes rejoining)
 * leaves the editor lagging behind a fresh stamp; this resync is then the
 * only path left that pushes, and must run.
 */
export function shouldSkipSubscribedResync(
  now: number,
  fetchedAt: number,
  editorSummary: string | null,
  stateSummary: string | null,
): boolean {
  return now - fetchedAt < SUBSCRIBED_RESYNC_SKIP_MS && editorSummary === stateSummary
}

/**
 * Reconcile a fetched proposed-changes list into previous state, preserving
 * OBJECT identity for rows the fetch didn't change — and ARRAY identity when
 * nothing changed at all. Row identity is what lets the memoized ProposalCards
 * skip re-rendering on the frequent realtime-triggered full-list refetches;
 * array identity keeps proposalNodeCtx (and everything derived from the list)
 * stable too.
 *
 * Matching updated_at ⇒ keep the PREV object. Every server-side mutation bumps
 * updated_at (trigger, mig 071), so a same-updated_at row is byte-identical on
 * the server — and when the LOCAL copy differs anyway, the difference is an
 * optimistic flip (accept/dismiss set status ahead of the echo) that a fetch
 * dispatched before the write committed must not revert. The write's own echo
 * refetches with the bumped updated_at and converges.
 */
export function reconcileProposedChanges(
  prev: ProposedChange[],
  fetched: ProposedChange[],
): ProposedChange[] {
  if (prev.length === 0) return fetched
  const prevById = new Map(prev.map((c) => [c.id, c]))
  const next = fetched.map((row) => {
    const existing = prevById.get(row.id)
    return existing && existing.updated_at === row.updated_at ? existing : row
  })
  return next.length === prev.length && next.every((c, i) => c === prev[i])
    ? prev
    : next
}

// The later of two row timestamps. Stale-guarded merges keep the NEWER
// updated_at even while refusing the row's ai_summary — a save's own response
// is always classified "stale" (its pending flag is still set), and without
// advancing the baseline here the recency guard would depend entirely on the
// Realtime echo arriving.
function laterTimestamp(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return new Date(b).getTime() > new Date(a).getTime() ? b : a
}

// A refetched column reads the same as state's: the same primitive, or the
// same JSON (labels, participants, metadata arrive as fresh objects every time).
function sameCaptureValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

// What the recorder's own transcript auto-save changes on the row: every
// append rewrites `transcript` and bumps `updated_at` (trigger), 2–30s apart.
// The poll's meta payload leaves `transcript` out, so there it shows up as
// `updated_at` alone.
const TRANSCRIPT_SAVE_FIELDS = new Set(['transcript', 'updated_at'])

type RefetchMergeOptions = { stale: boolean; ignoreTranscriptSaves?: boolean }

/**
 * Merge a refetched capture row into state, handing back `prev` ITSELF when
 * the row changed nothing, so React bails out instead of re-rendering the
 * ~4k-line panel. Every catch-up path lands here, the recording poll most of
 * all: it ticks every 25s for the whole meeting, and in the desktop app's
 * WKWebView each needless panel render is a main-thread stall (React, then a
 * style and layout pass).
 *
 * A row without the heavy text columns (the poll's `?fields=meta`) keeps
 * state's transcript, content and note_attributions: the keys are absent, so
 * the spread leaves them alone.
 *
 * `stale` (isFetchedCaptureStale) keeps state's ai_summary and the later
 * updated_at, as before. `ignoreTranscriptSaves` is the recording poll's: while
 * this client records, a row whose only news is `transcript` + `updated_at` is
 * its own auto-save coming back, and the panel paints the live buffer, not
 * capture.transcript, so nothing on screen would change. The capture-stream
 * channel skips the same echo. The saved text comes into state when the
 * recording stops (mergeSavedTranscript).
 */
export function mergeRefetchedCapture(
  prev: CaptureDetail | null,
  fetched: CaptureDetail,
  opts: RefetchMergeOptions,
): CaptureDetail {
  if (!prev) return fetched
  const next: CaptureDetail = opts.stale
    ? { ...prev, ...fetched, labels: fetched.labels ?? prev.labels, ai_summary: prev.ai_summary, updated_at: laterTimestamp(prev.updated_at, fetched.updated_at) }
    : { ...prev, ...fetched, labels: fetched.labels ?? prev.labels }
  const before = prev as unknown as Record<string, unknown>
  const after = next as unknown as Record<string, unknown>
  for (const key of Object.keys(after)) {
    if (opts.ignoreTranscriptSaves && TRANSCRIPT_SAVE_FIELDS.has(key)) continue
    if (!sameCaptureValue(before[key], after[key])) return next
  }
  return prev
}

/**
 * Put a refetched row into capture state. `current` is the render-synced
 * mirror (captureStateRef): a row that changes nothing against it never
 * reaches setCapture, so the tick queues no update at all. Otherwise the
 * updater merges against the latest state. Returns whether it called
 * setCapture.
 */
export function commitRefetchedCapture(
  current: CaptureDetail | null,
  fetched: CaptureDetail,
  opts: RefetchMergeOptions,
  setCapture: Dispatch<SetStateAction<CaptureDetail | null>>,
): boolean {
  if (current && mergeRefetchedCapture(current, fetched, opts) === current) return false
  setCapture((prev) => mergeRefetchedCapture(prev, fetched, opts))
  return true
}

/**
 * Put the stop's saved transcript into state (ni:capture-transcript-saved):
 * the transcript column alone, `prev` itself when it already holds that text.
 */
export function mergeSavedTranscript(
  prev: CaptureDetail | null,
  transcript: string | null,
): CaptureDetail | null {
  return !prev || prev.transcript === transcript ? prev : { ...prev, transcript }
}

/**
 * The live-agent status dot, as its own leaf.
 *
 * liveAgentStatus cycles listening→processing→listening on every turn, so
 * reading it in the panel body would re-render this whole component on each
 * transition. It lives in a ref-backed store (recording-context) and only this
 * 8-pixel dot subscribes to it.
 */
function LiveAgentStatusDot({ isPaused }: { isPaused: boolean }) {
  const liveAgentStatus = useLiveAgentStatus()
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        isPaused
          ? 'bg-muted-foreground/25'
          : liveAgentStatus === 'finalizing' || liveAgentStatus === 'processing'
            ? 'bg-amber-400/70'
            : liveAgentStatus === 'deferred'
              ? 'bg-muted-foreground/40'
              : 'bg-green-500/80',
      )}
    />
  )
}

const CAPTURE_SECTIONS = ['overview', 'agents', 'live-chat'] as const
type CaptureSection = (typeof CAPTURE_SECTIONS)[number]
const CAPTURE_SECTION_LABELS: Record<CaptureSection, string> = { overview: 'Overview', agents: 'Agents', 'live-chat': 'Live chat' }

// The Agents tab (plan row 10), loaded when opened.
const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

export function CaptureDetailPanel({
  captureId,
  onClose,
  onDeleted,
  onSelectionChange,
  onOpenContact,
  onOpenEntity,
  section,
  onSectionChange,
}: {
  captureId: string
  onClose: () => void
  onDeleted?: () => void
  onSelectionChange?: (selection: { entityType: 'capture'; entityId: string; field: string; selectedText: string } | null) => void
  onOpenContact?: (contactId: string, name: string, event?: React.MouseEvent) => void
  onOpenEntity?: (entityType: string, id: string, title: string, event?: React.MouseEvent) => void
  /** Active inner tab (Overview / Agents), restored from navigation history. */
  section?: string
  onSectionChange?: (section: string) => void
}) {
  // Unique instance ID — prevents Supabase Realtime channel name collisions when
  // multiple CaptureDetailPanels for the same capture are mounted (e.g. across tabs).
  const instanceIdRef = useRef(crypto.randomUUID())
  const instanceId = instanceIdRef.current
  // Ref to the bespoke capture-stream channel (set when it subscribes below), so
  // the poll fallback's liveness getter can check THIS channel's join state — not
  // just the shared socket's connectivity. `state` is realtime-js CHANNEL_STATES
  // ('joined' when live delivery is healthy); typed minimally to avoid importing
  // the RealtimeChannel type.
  const captureStreamChannelRef = useRef<{ state?: string } | null>(null)
  const cachedRaw = captureDetailCache.get(captureId)
  // Normalise cache entries that pre-date the labels / visibility features
  const cached = cachedRaw
    ? { ...cachedRaw, labels: cachedRaw.labels ?? [], visibility: cachedRaw.visibility ?? 'workspace' }
    : undefined
  const [capture, setCapture] = useState<CaptureDetail | null>(cached ?? null)
  // Render-synced mirror for async handlers (Realtime callbacks, fetch
  // resolutions) that need the freshest capture without re-subscribing.
  const captureStateRef = useRef<CaptureDetail | null>(capture)
  captureStateRef.current = capture
  const [loading, setLoading] = useState(!cached)
  const [, setSaving] = useState(false)
  const [participantsExpanded, setParticipantsExpanded] = useState(false)
  // Recurring-meeting history thread (other captures of the same series).
  // Server-filtered by visibility: own + workspace-shared, never others' private.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [seriesHistory, setSeriesHistory] = useState<SeriesOccurrence[] | null>(null)
  const seriesSessions = useMemo(
    () =>
      (seriesHistory || []).flatMap((o) =>
        o.captures.map((c) => ({ ...c, occurrence_start: o.occurrence_start })),
      ),
    [seriesHistory],
  )

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deletingCapture, setDeletingCapture] = useState(false)

  // Move-to-workspace dialog
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveTargetWorkspaceId, setMoveTargetWorkspaceId] = useState<string | null>(null)
  const [movingCapture, setMovingCapture] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  interface MovePreflightAction {
    id: string
    identifier: string
    title: string
    edited: boolean
    edit_reasons: string[]
  }
  interface MovePreflight {
    accepted_actions_unlinked: number
    pending_suggestions: number
    suggested_actions: number
    confirmed_decisions: number
    suggested_decisions: number
    attachments: number
    /** Live share links on the capture — deactivated in place by the move. */
    shares_active?: number
    confirmed_actions?: MovePreflightAction[]
    claims?: { sole_sourced: number; shared: number }
    contacts?: { auto_created: { id: string; full_name: string; email: string | null }[]; other: number }
  }
  const [movePreflight, setMovePreflight] = useState<MovePreflight | null>(null)
  // Which confirmed actions follow the capture. Untouched ones are pre-checked;
  // hand-edited ones start unchecked so moving them is an explicit choice.
  const [moveActionIds, setMoveActionIds] = useState<Set<string>>(new Set())
  const [moveClaims, setMoveClaims] = useState(true)
  const [moveContacts, setMoveContacts] = useState(true)

  // File upload
  const [isDragging, setIsDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [attachmentRefreshKey, setAttachmentRefreshKey] = useState(0)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const titleInputRef = useRef<HTMLTextAreaElement>(null)

  const summaryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  // Serializes summary PATCHes — see handleSummaryChange.
  const summarySaveChainRef = useRef<Promise<void>>(Promise.resolve())
  // The ai_summary value most recently PATCHed by this panel — lets the
  // Realtime handler tell our own save echo apart from an agent write (an echo
  // must not be run through the reveal animation: its prefix frames would
  // truncate the just-typed text).
  const lastSavedSummaryRef = useRef<string | null>(null)
  // EDITOR-SIDE WATERMARK: the full summary string the editor last received.
  // Stamped at every editor-push site — the initial-content seed below (the
  // ai_summary the editor's first document reflects; null when it mounted on
  // the non-ai fallback of a never-written summary), revealSummary (the reveal
  // TARGET at animation start), setSummaryDirect (which the guarded-refetch
  // push and the content-edited handler route through), and handleSummaryChange
  // (the user's own typed text is by definition editor content). The realtime
  // push gate and the SUBSCRIBED resync skip compare against THIS, never
  // against capture state: state is freshened by refetch paths that
  // deliberately don't touch the editor (poll tick, detail-sync, capture-ended),
  // and a state compare would permanently suppress the push of a genuinely new
  // summary — see decideRealtimeSummary / shouldSkipSubscribedResync.
  const lastEditorSummaryRef = useRef<string | null>(null)
  // Which captureId's first render already seeded the watermark — the editor
  // is keyed per captureId and reads initialContent once per mount.
  const editorSeededForRef = useRef<string | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)

  // A fetched capture row is stale for ai_summary purposes when a summary save
  // is pending, or when the row is older than current state — a GET served
  // before a recent write committed but resolving after it. Merging/pushing a
  // stale summary ripples into the editor and reverts just-typed text.
  const isFetchedCaptureStale = (cap: CaptureDetail) => {
    const prev = captureStateRef.current
    return (
      summaryTimeoutRef.current !== null ||
      (!!prev?.updated_at && !!cap.updated_at &&
        new Date(cap.updated_at).getTime() < new Date(prev.updated_at).getTime())
    )
  }

  const attributionEditorRef = useRef<any>(null)

  const currentMemberId = useCurrentMemberId()
  const { workspaces: allWorkspaces, currentId: currentWorkspaceId } = useWorkspaces()
  // The viewer's AUTH uid (captures.user_id is a uid, not a member id) plus the
  // workspace's member count — both off the already-cached workspace payload.
  const { userId: currentUserId, memberCount: workspaceMemberCount } =
    useCaptureVisibilityViewer(currentWorkspaceId)
  // Optional: this panel also renders inside surfaces without the dashboard
  // overlay, and the "Push to…" menu falls back to a hard navigation there.
  const settingsOverlay = useOptionalSettingsOverlay()

  // Live agent recipes
  const [agents, setAgents] = useState<Agent[]>([])

  // The auto-accept policy — used to explain WHY a high-confidence proposal is
  // still pending (below threshold / not yours / external / inferred). Every
  // workspace runs Native Intelligence's tuned defaults (Liam, 2026-10-17: opinionated
  // platform, no configuration fatigue; the Trust page and its overrides are
  // gone, migration 354), so the card reads the default policy directly instead
  // of fetching it.
  const autoAcceptPolicy = DEFAULT_TRUST_POLICY

  // End-of-meeting batch run in flight for THIS capture. Set by the
  // 'capture-processing-start' event dispatched when the user stops a live-mode-
  // OFF recording; cleared on 'capture-ended' (success) or
  // 'capture-processing-error' (failure). Drives the background-processing
  // indicator so the user knows extraction is running after they hit Stop.
  const [isProcessingBatch, setIsProcessingBatch] = useState(false)

  // Streaming summary state (post-capture AI processing)

  // Projects list for project picker
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])

  // Inject the capture's current project so it renders immediately, even before
  // the projects lookup list finishes loading.
  const captureProjectId = capture?.project_id ?? null
  const captureProjectName = capture?.project_name ?? null
  const projectOptions = useMemo<PickerProjectOption[]>(() => {
    const list: PickerProjectOption[] = projects.map((p) => ({ id: p.id, name: p.name, icon: null }))
    if (captureProjectId && captureProjectName && !list.some((p) => p.id === captureProjectId)) {
      list.unshift({ id: captureProjectId, name: captureProjectName, icon: null })
    }
    return list
  }, [projects, captureProjectId, captureProjectName])

  // Linked participants (from capture_participant table, with contact_id)
  const [linkedParticipants, setLinkedParticipants] = useState<LinkedParticipant[]>([])

  // Participant add/search state
  const [addParticipantOpen, setAddParticipantOpen] = useState(false)
  const [contactSearchQuery, setContactSearchQuery] = useState('')
  const [contactSearchResults, setContactSearchResults] = useState<ContactSearchResult[]>([])
  const [contactSearchLoading, setContactSearchLoading] = useState(false)
  const [addingParticipant, setAddingParticipant] = useState<string | null>(null)
  const [removingParticipant, setRemovingParticipant] = useState<string | null>(null)
  const contactSearchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Event linking state
  const [eventSearchOpen, setEventSearchOpen] = useState(false)
  const [eventSearchQuery, setEventSearchQuery] = useState('')
  const [eventSearchResults, setEventSearchResults] = useState<CalendarEventOption[]>([])
  const [eventSearchLoading, setEventSearchLoading] = useState(false)
  const [eventDateRange, setEventDateRange] = useState<{ from: string; to: string }>(() => {
    const now = new Date()
    // Start from beginning of today so in-progress events are included
    const from = new Date(now); from.setHours(0, 0, 0, 0)
    // Through end of tomorrow — covers the 95% case
    const to = new Date(now); to.setDate(to.getDate() + 2); to.setHours(0, 0, 0, 0)
    return { from: from.toISOString(), to: to.toISOString() }
  })
  // Bumped per event search so a slower, older response can't overwrite the
  // results (or clear the spinner) of the search the user typed last.
  const eventSearchSeqRef = useRef(0)
  const [linkedEventTitle, setLinkedEventTitle] = useState<string | null>(null)


  // Proposed changes (new system)
  const [proposedChanges, setProposedChanges] = useState<ProposedChange[]>([])
  const [proposedCounts, setProposedCounts] = useState<ProposedChangeCounts>({ pending: 0, applied: 0, dismissed: 0, total: 0 })
  // Render-synced mirror for async handlers that need the freshest list
  // WITHOUT depending on it — dependency-free callbacks keep proposalNodeCtx
  // (and every proposal card under it) stable across refetches.
  const proposedChangesRef = useRef<ProposedChange[]>(proposedChanges)
  proposedChangesRef.current = proposedChanges
  // Monotonic fetch sequence: a stale proposals response (an older GET
  // resolving after a newer one) must never clobber the newer list.
  const proposedFetchSeqRef = useRef(0)
  // When each resource's last fetch RESOLVED — read by the SUBSCRIBED resync
  // guards (see SUBSCRIBED_RESYNC_SKIP_MS).
  const proposedFetchAtRef = useRef(0)
  const captureFetchAtRef = useRef(0)
  const [workspaceMembers, setWorkspaceMembers] = useState<{ id: string; display_name: string; avatar_url: string | null }[]>([])
  const [workspaceAiMembers, setWorkspaceAiMembers] = useState<{ id: string; name: string; avatar_url: string | null }[]>([])
  const [workspaceContacts, setWorkspaceContacts] = useState<{ id: string; full_name: string; email: string | null }[]>([])

  // Labels — workspace-scoped labels available for 'capture' scope
  const { grouped: scopedLabelsGrouped, labels: scopedLabels } = useScopedLabels('capture')
  const allLabels = useMemo(() => scopedLabels as unknown as CaptureLabel[], [scopedLabels])
  const labelToggleInFlight = useRef(new Set<string>())

  // Page inspector visibility, with a width-based fallback for standalone panels.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  // Overview (the capture) or Agents (plan row 10: every agent interaction
  // with it). The overview stays mounted while Agents shows: its editor, refs
  // and channels are not torn down by a tab switch.
  const [pickedSection, setActiveSection] = usePanelSection<CaptureSection>(section, onSectionChange, 'overview', CAPTURE_SECTIONS)
  const sidebarOpen = usePropertiesVisible(panelBodyRef)

  // Inline commenting state. Raw rows from the comments endpoint land here
  // when the (non-blocking) mount fetch resolves; they're mapped to the
  // unified shape against the CURRENT identity below — the identity can
  // resolve after the fetch does, so mapping is derived, not frozen at fetch
  // time. The panel body no longer waits on either: InlineCommentProvider
  // mounts immediately and hydrates these by id when they arrive.
  const [rawInlineComments, setRawInlineComments] = useState<Record<string, unknown>[]>([])

  // Comment identity — built synchronously from the workspace cache (fetched
  // once at app startup) instead of the per-mount /api/account/workspace round
  // trip that used to gate the entire panel body behind max(capture, comments,
  // workspace) and blanked it forever if that fetch failed. Until the cache
  // resolves, the guest identity renders the editor with commenting disabled —
  // never a blank body.
  const { displayName: memberDisplayName, avatarUrl: memberAvatarUrl } = useCurrentMemberProfile()
  const commentIdentity = useMemo<CommentIdentity>(
    () =>
      currentMemberId
        ? {
            mode: 'authenticated',
            memberId: currentMemberId,
            displayName: memberDisplayName || 'You',
            avatarUrl: memberAvatarUrl || null,
          }
        : { mode: 'guest' },
    [currentMemberId, memberDisplayName, memberAvatarUrl],
  )
  // The narrowing here is load-bearing: CommentIdentity also has a share-link
  // (guest) mode used by other surfaces, and createAuthenticatedAPI only
  // accepts the authenticated arm. The guest arm (identity still loading)
  // posts nowhere.
  const commentApi = useMemo(
    () =>
      commentIdentity.mode === 'authenticated'
        ? createAuthenticatedAPI('capture', captureId, commentIdentity)
        : GUEST_NOOP_API,
    [commentIdentity, captureId],
  )
  const inlineComments = useMemo(
    () =>
      commentIdentity.mode === 'authenticated'
        ? mapAuthComments(rawInlineComments, commentIdentity)
        : [],
    [rawInlineComments, commentIdentity],
  )

  // Note attribution state
  const [activeAttributionId, setActiveAttributionId] = useState<string | null>(null)

  // Live recording detection — is this capture the one currently being recorded?
  // `isStarting` counts too: capture start is optimistic (the panel opens before
  // the mic confirms), and treating the spin-up window as active shows the
  // recording UI immediately instead of flashing an idle/resume state for the
  // few hundred ms of mic startup.
  const recording = useRecordingContext()
  const isActiveRecording =
    (recording.isRecording || recording.isStarting) && recording.captureId === captureId
  // The live transcript buffer and its detected speakers outlive Stop, so the
  // just-stopped page doesn't blank before the final save lands. Only the page
  // that recorded them may show them (GEN-41), and not once another capture
  // has started (kept pages stay mounted).
  const [recordedHereId, setRecordedHereId] = useState<string | null>(null)
  if (isActiveRecording && recordedHereId !== captureId) setRecordedHereId(captureId)
  if (recordedHereId !== null && recording.captureId && recording.captureId !== recordedHereId) setRecordedHereId(null)
  const holdsLiveSegments = isActiveRecording || recordedHereId === captureId
  const isLiveAgentActive = isActiveRecording
  // The call's thread with its live agent, read-only, once the call is over
  // (capture-live-chat-section.tsx): a section only when there's a thread.
  const liveChatConversationId = useCaptureLiveChat(captureId, isActiveRecording)
  // A Live chat section restored with no thread to show is the overview.
  const activeSection: CaptureSection = pickedSection === 'live-chat' && !liveChatConversationId ? 'overview' : pickedSection
  // During a live capture Voice ID is in the live agent's HUD (the desktop's
  // window, or the web's floating panel), not on this card
  // (voice-id-hud-publisher.tsx useLiveHudUp). It's back here once the
  // capture stops — post-session review and later linking happen on this page.
  const voiceIdInHud = useLiveHudUp()
  // Ref for use in callbacks — avoids recreating fetchCapture when recording state changes
  const isActiveRecordingRef = useRef(isActiveRecording)
  isActiveRecordingRef.current = isActiveRecording

  // When RESUMING a stopped/crashed capture, the live in-memory buffer
  // (recording.transcriptSegments) starts empty and only fills with NEW speech —
  // so the panel would otherwise look like it lost everything captured before.
  // The prior transcript is safe in the DB (capture.transcript) and is preserved
  // on save (saveTranscript prepends it server-side). We snapshot it at the
  // moment this capture becomes the active recording, then render it BEFORE the
  // live segments. The snapshot predates this session, so it never double-counts
  // the live text the auto-save later folds into capture.transcript.
  const [resumedPriorTranscript, setResumedPriorTranscript] = useState<string | null>(null)
  // True once we've taken (or deliberately skipped) the snapshot for the current
  // active-recording session, so later auto-save growth of capture.transcript
  // can't re-snapshot and double-count the live text mid-session.
  const priorSnapshotTakenRef = useRef(false)
  useEffect(() => {
    if (!isActiveRecording) {
      // Recording ended (or this isn't the active capture) — reset for next time
      // and let the persisted-transcript fallback (now complete) take over.
      priorSnapshotTakenRef.current = false
      if (resumedPriorTranscript !== null) setResumedPriorTranscript(null)
      return
    }
    // Active recording. Snapshot the pre-existing transcript ONCE, as soon as the
    // capture row is available. Non-empty only for a resume; a fresh recording
    // snapshots null/empty, which prepends nothing. Guarded so it fires once even
    // though capture.transcript grows via auto-save during the session.
    if (!priorSnapshotTakenRef.current && capture) {
      priorSnapshotTakenRef.current = true
      setResumedPriorTranscript(capture.transcript ?? null)
    }
  }, [isActiveRecording, capture, resumedPriorTranscript])

  // External content for live editor updates (from AI edit tool results)
  const [externalEditorContent, setExternalEditorContent] = useState<string | undefined>(undefined)

  // ── Editor content: React state, plus a sink for animation frames ─────────
  // Every value that SETS the editor content goes through React state
  // (setEditorContent → externalEditorContent → NoteEditor's externalContent).
  // The two animations — the streaming typewriter and the live reveal — push
  // each FRAME straight into the editor through the receiver NoteEditor hands
  // us (showInEditor → externalContentSink), so a frame costs the editor a
  // parse + setContent instead of costing a render of this whole panel. When an
  // animation stops, settleEditorContent puts its last frame into state too,
  // where NoteEditor finds a value it already holds and does nothing.
  //
  // Frames that skip React must stay indistinguishable from the per-frame
  // setState they replace, which is what the bookkeeping below is for:
  //   • A frame takes the sink only when nothing is in flight through React (no
  //     set waiting to render, and NoteEditor's effect has seen what rendered).
  //     Otherwise that pending value would reach the editor AFTER the frame and
  //     rewind it, so the frame queues behind it through state, as before.
  //   • While frames are ahead of state, React's same-value bail-out would drop
  //     a set equal to the (stale) rendered state and leave the frame showing.
  //     With a setState per frame the state would have held the last frame and
  //     the set would have gone through, so setEditorContent delivers it itself.
  const editorSinkRef = useRef<((markdown: string) => void) | null>(null)
  // What the editor was last handed, by either path. revealSummary's prefix
  // check reads it, so it must be current between renders — it is written at
  // every hand-off, never re-derived from (possibly stale) state.
  const externalEditorContentRef = useRef('')
  // Frames went through the sink since the state was last set.
  const editorFramesAheadRef = useRef(false)
  // The value the state is heading to (last set), the value it had at the last
  // render, and the value NoteEditor's externalContent effect last ran with.
  const editorStateSetRef = useRef<string | undefined>(undefined)
  const editorStateRenderedRef = useRef<string | undefined>(undefined)
  editorStateRenderedRef.current = externalEditorContent
  const editorStateSeenRef = useRef<string | undefined>(undefined)
  // The last value that reached NoteEditor, through its effect or the sink —
  // what the state would hold now if every frame were a setState.
  const editorReceivedRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    // Passive effects run children first, so NoteEditor's own externalContent
    // effect has already handled this value.
    editorStateSeenRef.current = externalEditorContent
    editorReceivedRef.current = externalEditorContent
  }, [externalEditorContent])

  // Set the editor content through React state (every non-animated write).
  const setEditorContent = useCallback((markdown: string) => {
    externalEditorContentRef.current = markdown
    editorFramesAheadRef.current = false
    editorStateSetRef.current = markdown
    setExternalEditorContent(markdown)
    const rendered = editorStateRenderedRef.current
    if (
      markdown === rendered &&
      rendered === editorStateSeenRef.current &&
      editorReceivedRef.current !== markdown
    ) {
      // React bails out (the state already holds `markdown`), but frames moved
      // the editor past it: deliver it the way the state change would have.
      const sink = editorSinkRef.current
      if (sink) {
        editorReceivedRef.current = markdown
        sink(markdown)
      }
    }
  }, [])

  // Show one animation frame without re-rendering the panel.
  const showInEditor = useCallback((markdown: string) => {
    const sink = editorSinkRef.current
    const rendered = editorStateRenderedRef.current
    if (!sink || editorStateSetRef.current !== rendered || rendered !== editorStateSeenRef.current) {
      // Editor not mounted yet, or a value is in flight through React.
      setEditorContent(markdown)
      return
    }
    externalEditorContentRef.current = markdown
    editorFramesAheadRef.current = true
    editorReceivedRef.current = markdown
    sink(markdown)
  }, [setEditorContent])

  // An animation stopped: bring React state level with its last frame.
  const settleEditorContent = useCallback(() => {
    if (editorFramesAheadRef.current) setEditorContent(externalEditorContentRef.current)
  }, [setEditorContent])

  // Quiet refetch of capture + proposals, used to reconcile to canonical state
  // after the capture-ended event OR a streaming extraction finishes. Declared
  // here (before the streaming hook references it in onDone); its implementation
  // is assigned further below once fetchProposedChanges exists.
  const captureEndedRefetchRef = useRef<() => void>(() => {})

  // ── Streaming extraction (Granola-style live generation) ──────────────────
  // Consumes the SSE stream from the live-agent route and types the model's
  // prose into the editor in real time, with a shimmer affordance + a tool
  // activity hint. The streamed text is a PREVIEW; the canonical summary and
  // proposals arrive via Supabase Realtime (the subscriptions below). On `done`
  // we reconcile to that canonical state.
  //
  // Three entry points funnel through this one hook (the panel owns streaming):
  //   • Reprocess button (handleReprocess) — mode 'batch'
  //   • End-of-meeting batch — the recording layer dispatches the bus event when
  //     this panel is mounted; otherwise the recording layer runs it headless.
  //   • Live pause — mode 'live', dispatched per silence window.
  //
  // 'batch' streams lock the editor read-only + show the full shimmer banner
  // (the user is watching a finished meeting fill in). 'live' streams are
  // SUBTLE: text types in but the editor stays editable and there's no banner,
  // so a meeting in progress doesn't flicker read-only every few seconds.
  const [streamingMode, setStreamingMode] = useState<'batch' | 'live' | null>(null)
  const streaming = useStreamingExtraction({
    onDone: () => {
      // Canonical summary/proposals already landed via the tools' DB writes →
      // Realtime. captureEndedRefetchRef refetches the capture + proposals; the
      // Realtime resync also pushes ai_summary into the editor (replacing the
      // streamed preview with the authoritative copy). For a batch run that the
      // recording layer handed off, also fire capture-ended so the recording
      // layer runs its post-extraction work (title generation, indexing) now
      // that the summary exists.
      const wasBatch = streamingMode === 'batch'
      setStreamingMode(null)
      captureEndedRefetchRef.current()
      setIsProcessingBatch(false)
      if (wasBatch) {
        window.dispatchEvent(
          new CustomEvent('ni:capture-ended', { detail: { captureId } }),
        )
      }
    },
    onError: (message) => {
      // Live pauses fail quietly (they retry every window; a toast per failure
      // would spam during a meeting). Batch failures are surfaced.
      if (streamingMode !== 'live') toast.error(message)
      setStreamingMode(null)
      setIsProcessingBatch(false)
    },
  })

  // Register this panel as a streaming surface for its capture while mounted, so
  // the recording layer hands its end-of-meeting batch run to us (the visible
  // stream) instead of running it headless. Unregister on unmount/ id change so
  // the recording layer falls back to the guaranteed headless run.
  useEffect(() => {
    registerStreamingPanel(captureId)
    return () => unregisterStreamingPanel(captureId)
  }, [captureId])

  // Run a streaming extraction when the recording layer requests one for THIS
  // capture (end-of-meeting batch handoff, or a live pause).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as StreamExtractionDetail
      if (detail.captureId !== captureId) return
      setStreamingMode(detail.mode)
      void streaming.start({
        captureId,
        mode: detail.mode,
        recipeId: detail.recipeId,
        recentChunks: detail.recentChunks,
      })
    }
    window.addEventListener(STREAM_EXTRACTION_EVENT, handler)
    return () => window.removeEventListener(STREAM_EXTRACTION_EVENT, handler)
  }, [captureId, streaming.start, streamingMode])
  // Live mirrors of the stream state for the rAF typewriter + the Realtime
  // handler (both run outside React render and read the latest value via ref).
  // The text comes straight from the hook's ref, which holds every token as it
  // arrives; the hook's `streamingText` state only catches up once per frame.
  const streamingTextRef = streaming.streamingTextRef
  const streamingRef = useRef(streaming.isStreaming)
  streamingRef.current = streaming.isStreaming
  // Continuous typewriter: while a stream is in flight, type the summary into
  // the editor character-by-character toward the latest streamed text, so it
  // reads as being WRITTEN rather than appearing in 250ms chunks. A persistent
  // rAF loop advances a "shown length" toward streamingTextRef.current.length at
  // a steady rate; each frame pushes the growing prefix to the editor. The
  // editor re-parses the (always-valid prefix) markdown — partial mid-line
  // markup briefly shows literal then resolves, imperceptible at typing speed.
  //
  // Adaptive speed: type ~enough chars/frame to feel like fast typing, but if
  // the model races ahead and the backlog grows large, speed up proportionally
  // so we never fall far behind reality. When the stream ends we keep typing
  // until the shown length catches the final text, then stop.
  const typeShownLenRef = useRef(0)
  const typeRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (!streaming.isStreaming) return
    // Reset the typewriter for a fresh stream.
    typeShownLenRef.current = 0

    // A BATCH run re-extracts the whole meeting from scratch (the server deletes
    // pending proposals but KEEPS accepted ones). Clear the editor immediately
    // so the user watches the new summary get WRITTEN onto a blank page rather
    // than typed on top of the stale summary. Accepted proposals persist as rows
    // and reappear as the new summary re-references their <!-- proposal:ID -->
    // markers (and via Realtime). Live streams append during a meeting, so they
    // must NOT clear — only batch does.
    if (streamingMode === 'batch') {
      setEditorContent('')
    }

    const BASE_CHARS_PER_FRAME = 6 // ~360 chars/sec at 60fps — brisk but legible

    const tick = () => {
      const target = streamingTextRef.current
      const shown = typeShownLenRef.current
      if (target.length > shown) {
        const backlog = target.length - shown
        // Catch up faster the further behind we are (keeps long summaries from
        // lagging), but always reveal at least the base rate for the typed feel.
        const step = Math.max(BASE_CHARS_PER_FRAME, Math.ceil(backlog / 12))
        const next = Math.min(target.length, shown + step)
        typeShownLenRef.current = next
        // Straight to the editor — a frame must not re-render this panel.
        showInEditor(target.slice(0, next))
      }
      // Keep looping while streaming, or until we've typed out the remainder
      // after the stream ended.
      if (streamingRef.current || typeShownLenRef.current < streamingTextRef.current.length) {
        typeRafRef.current = requestAnimationFrame(tick)
      } else {
        typeRafRef.current = null
        settleEditorContent()
      }
    }

    typeRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (typeRafRef.current != null) {
        cancelAnimationFrame(typeRafRef.current)
        typeRafRef.current = null
      }
      // Stopped mid-way (the stream ended, or a new run restarted the loop):
      // the state holds what the editor shows, as it did with a setState per
      // frame. No-op when the loop already settled on its own.
      settleEditorContent()
    }
    // Only (re)start the loop when streaming flips on/off (streamingMode is set
    // before the flip). The loop reads the latest text from the refs each frame,
    // so it doesn't need a streamingText dep. The rest are stable (the hook's
    // ref, and callbacks over refs), listed for exhaustive-deps.
  }, [streaming.isStreaming, streamingMode, streamingTextRef, setEditorContent, showInEditor, settleEditorContent])

  // Unified "extraction in flight" flag — true while either the SSE stream is
  // running (Reprocess / live preview) OR a background batch run is pending
  // (the event-driven path that pre-dates streaming). Drives the Reprocess
  // button's spinner and the editor's read-only/affordance state.
  const isExtracting = streaming.isStreaming || isProcessingBatch

  // ── Live-mode summary reveal (light typing animation) ─────────────────────
  // During an active LIVE recording the summary lands via Supabase Realtime as
  // the model writes it (one whole-summary update per silence window). Instead
  // of snapping the new text in, we briefly "type" from the previously-shown
  // length up to the new content so the page feels alive — without touching the
  // live-pause hot path (its fetch, activity feed, and stop-gate are untouched).
  //
  // Realtime gives the FULL summary each time, not deltas, and updates can jump.
  // So the reveal is capped + supersede-safe: a newer update mid-reveal cancels
  // the current animation and starts revealing toward the newest text, never
  // falling behind reality.
  const revealRafRef = useRef<number | null>(null)
  const revealShownLenRef = useRef(0)
  // The prefix check reads externalEditorContentRef (declared with the editor
  // content state above): what the editor was last handed, frames included.
  const revealSummary = useCallback((next: string) => {
    // Watermark the reveal TARGET up front (not per frame): the animation
    // always finishes at `next` unless superseded by another push, which
    // re-stamps.
    lastEditorSummaryRef.current = next
    if (revealRafRef.current != null) {
      cancelAnimationFrame(revealRafRef.current)
      revealRafRef.current = null
    }
    // If the new summary doesn't extend what's shown (a rewrite/shrink), just
    // set it — typing backwards or across a divergent rewrite looks broken.
    const from = revealShownLenRef.current
    if (next.length <= from || !next.startsWith(externalEditorContentRef.current.slice(0, from))) {
      revealShownLenRef.current = next.length
      setEditorContent(next)
      return
    }
    // Reveal from `from` → next.length over ~500ms, capped so a big jump still
    // finishes promptly. ~24 chars/frame minimum keeps long appends snappy.
    const total = next.length
    const startTs = performance.now()
    const DURATION = 500
    const step = (ts: number) => {
      const t = Math.min(1, (ts - startTs) / DURATION)
      const target = Math.max(
        from + Math.ceil((total - from) * t),
        revealShownLenRef.current + 24,
      )
      const shown = Math.min(total, target)
      revealShownLenRef.current = shown
      // Straight to the editor — a frame must not re-render this panel.
      showInEditor(next.slice(0, shown))
      if (shown < total) {
        revealRafRef.current = requestAnimationFrame(step)
      } else {
        revealRafRef.current = null
        settleEditorContent()
      }
    }
    revealRafRef.current = requestAnimationFrame(step)
  }, [setEditorContent, showInEditor, settleEditorContent])
  // Direct (non-animated) summary set that keeps the reveal bookkeeping in
  // sync — an own-save echo, resync push, or clear must cancel any in-flight
  // animation and reset the shown-length watermark, otherwise the NEXT reveal
  // animates from a stale offset and its early (shorter) frames truncate the doc.
  const setSummaryDirect = useCallback((next: string) => {
    lastEditorSummaryRef.current = next
    if (revealRafRef.current != null) {
      cancelAnimationFrame(revealRafRef.current)
      revealRafRef.current = null
    }
    revealShownLenRef.current = next.length
    setEditorContent(next)
  }, [setEditorContent])
  // Cancel any in-flight reveal on unmount / capture switch.
  useEffect(() => {
    return () => {
      if (revealRafRef.current != null) cancelAnimationFrame(revealRafRef.current)
      revealRafRef.current = null
      revealShownLenRef.current = 0
    }
  }, [captureId])

  // Listen for AI edit tool completions and re-fetch the capture content
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { entityId: string }
      if (detail.entityId !== captureId) return
      // Re-fetch from the API — after any summary save already in flight has
      // landed (the chain never rejects), so the read is not served from before
      // it. A save still in its debounce when the read returns is caught by
      // isFetchedCaptureStale below. This panel dispatches the event itself on
      // a link/unlink, often right after typing in the summary.
      summarySaveChainRef.current
        .then(() => fetch(`/api/account/captures/${captureId}`))
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data?.capture) return
          const cap = data.capture as CaptureDetail
          // A refetch racing an in-flight/just-committed summary save must not
          // regress state or the editor (same guard as the resync path).
          const fetchedStale = isFetchedCaptureStale(cap)
          setCapture((prev) => {
            if (!prev) return prev
            return fetchedStale
              ? { ...prev, ...cap, ai_summary: prev.ai_summary, updated_at: laterTimestamp(prev.updated_at, cap.updated_at) }
              : { ...prev, ...cap }
          })
          if (!fetchedStale) {
            // '' is a deliberate clear — don't resurrect the fallback text.
            const editorContent = cap.ai_summary ?? (cap.summary || cap.content || '')
            setSummaryDirect(editorContent)
          }
        })
        .catch(() => {})
    }
    window.addEventListener('ni:content-edited', handler)
    return () => window.removeEventListener('ni:content-edited', handler)
  }, [captureId, setSummaryDirect])

  // Listen for capture-ended event — refresh capture data (live agent already produced results)
  // (captureEndedRefetchRef is declared earlier — above the streaming hook that
  // references it in onDone — and assigned its implementation further below.)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { captureId: string }
      if (detail.captureId !== captureId) return
      // The background batch run (if any) finished — clear the indicator and
      // pull in the freshly-extracted summary / proposals.
      setIsProcessingBatch(false)
      captureEndedRefetchRef.current()
    }
    window.addEventListener('ni:capture-ended', handler)
    return () => window.removeEventListener('ni:capture-ended', handler)
  }, [captureId])

  // Background-processing indicator lifecycle: the end-of-meeting batch run
  // starts (after Stop, live mode off) → show the indicator; it errors → hide it
  // (a toast already explains the failure). The success case is handled by
  // 'capture-ended' above.
  useEffect(() => {
    const onStart = (e: Event) => {
      const detail = (e as CustomEvent).detail as { captureId: string }
      if (detail.captureId !== captureId) return
      setIsProcessingBatch(true)
    }
    const onError = (e: Event) => {
      const detail = (e as CustomEvent).detail as { captureId: string }
      if (detail.captureId !== captureId) return
      setIsProcessingBatch(false)
    }
    window.addEventListener('ni:capture-processing-start', onStart)
    window.addEventListener('ni:capture-processing-error', onError)
    return () => {
      window.removeEventListener('ni:capture-processing-start', onStart)
      window.removeEventListener('ni:capture-processing-error', onError)
    }
  }, [captureId])

  // Reset the indicator whenever the viewed capture changes. The start/end events
  // are per-capture, but switching captures should never carry a stale "processing"
  // state into a different one — so it can't get visually stuck on the wrong panel.
  useEffect(() => {
    setIsProcessingBatch(false)
  }, [captureId])

  // Listen for capture-resumed event — refresh capture data so UI reflects active recording
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { captureId: string }
      if (detail.captureId !== captureId) return
      captureEndedRefetchRef.current()
    }
    window.addEventListener('ni:capture-resumed', handler)
    return () => window.removeEventListener('ni:capture-resumed', handler)
  }, [captureId])

  // Selection change handler — reports to parent for AI context
  const handleEditorSelectionChange = useCallback(
    (selectedText: string | null) => {
      if (!onSelectionChange || !capture) return
      if (selectedText) {
        const field = 'ai_summary'
        onSelectionChange({
          entityType: 'capture',
          entityId: captureId,
          field,
          selectedText,
        })
      } else {
        onSelectionChange(null)
      }
    },
    [onSelectionChange, capture, captureId],
  )

  const fetchCapture = useCallback(async () => {
    // Don't flash loading spinner if we have cached data or active recording
    const hasCached = captureDetailCache.has(captureId)
    if (!isActiveRecordingRef.current && !hasCached) setLoading(true)
    const res = await fetch(`/api/account/captures/${captureId}`)
    if (res.ok) {
      const data = await res.json()
      captureFetchAtRef.current = Date.now()
      // Normalise: older API versions may not include `labels` / `visibility` yet
      const fetchedCapture: CaptureDetail = {
        ...(data.capture as CaptureDetail),
        labels: data.capture.labels ?? [],
        visibility: data.capture.visibility ?? 'workspace',
      }
      setCapture(fetchedCapture)
      writeCaptureCache(captureId, fetchedCapture)
      // Linked-event display name: prefer the event's own title (stamped into
      // metadata at link/create time) — the capture title drifts once renamed.
      if (fetchedCapture.calendar_event_id) {
        const storedTitle = fetchedCapture.metadata?.linked_event_title
        setLinkedEventTitle(
          typeof storedTitle === 'string' && storedTitle ? storedTitle : fetchedCapture.title,
        )
      }
    }
    setLoading(false)
  }, [captureId])


  // Use a ref so the callback identity stays stable and doesn't re-trigger the fetch effect
  const agentIdRef = useRef(recording.agentId)
  agentIdRef.current = recording.agentId
  // The LIVE LOCK holds while a capture is recording (or spinning up), not
  // after: live is the only mode, so a lock keyed on live mode alone would
  // never let go, and a stopped capture's picker chooses the agent Reprocess
  // runs. Global like the selection it locks (recording.agentId).
  const liveLocked = recording.liveModeEnabled && (recording.isRecording || recording.isStarting)
  // Read (never subscribed to) by fetchAgents, so the edition's BATCH default
  // never lands while the live lock owns the selection.
  const liveLockedRef = useRef(liveLocked)
  liveLockedRef.current = liveLocked

  // ── "+ Packages" — context packages attached to this capture (mig 239). ──
  // Local capture mirror + best-effort PATCH gated on the row existing. The
  // live agent is primed to pull the packages via get_package. The picker only
  // offers packages the user can see (the
  // list endpoint is RLS-fenced), and the PATCH re-validates per id.
  const capturePackageIds = useMemo(() => capture?.package_ids ?? [], [capture?.package_ids])

  const [attachablePackages, setAttachablePackages] = useState<
    { id: string; name: string; visibility: string }[]
  >([])
  const fetchAttachablePackages = useCallback(async () => {
    const data = await cachedJson<{ packages?: { id: string; name: string; visibility: string }[] }>(
      '/api/account/knowledge-packages',
      { scope: currentWorkspaceId },
    )
    if (data) {
      setAttachablePackages(
        (data.packages || []).map((p) => ({ id: p.id, name: p.name, visibility: p.visibility })),
      )
    }
  }, [currentWorkspaceId])

  const persistPackageIds = useCallback(
    (ids: string[], prevIds: string[]) => {
      setCapture((prev) => (prev ? { ...prev, package_ids: ids } : prev))
      void captureRowReady(captureId)
        .then(async (ready) => {
          if (!ready) return
          const res = await fetch(`/api/account/captures/${captureId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ package_ids: ids }),
          })
          // Refused (visibility changed, id re-validation, 5xx): throw so the
          // catch rolls the chips back and the live agent is never told.
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          // Mid-call attach: let the live agent acknowledge the change in the
          // conversation ("I'm using the … packages to guide this call").
          // Server no-ops when no
          // live conversation exists yet (the greeting covers attach-at-start)
          // or the set is empty; the message id dedupes repeat acks of the
          // same set. Fire-and-forget — an ack must never block the toggle.
          if (ids.length > 0) {
            void fetch('/api/account/chat-history/live/packages-ack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ capture_id: captureId }),
            }).catch(() => {})
          }
        })
        .catch((err) => {
          console.warn('[capture] failed to persist attached packages:', err)
          // Roll back only if no later toggle has replaced this set (the
          // optimistic write above stored `ids` itself, so identity tells us).
          setCapture((prev) =>
            prev && prev.package_ids === ids ? { ...prev, package_ids: prevIds } : prev,
          )
          toast.error('Could not attach packages')
        })
    },
    [captureId],
  )

  const toggleAttachedPackage = useCallback(
    (id: string) => {
      const next = capturePackageIds.includes(id)
        ? capturePackageIds.filter((p) => p !== id)
        : [...capturePackageIds, id].slice(0, 5)
      persistPackageIds(next, capturePackageIds)
    },
    [capturePackageIds, persistPackageIds],
  )

  // The workspace's edition — the source of the per-mode default agent slugs.
  // Read through the SAME hook the nav rail and command palette use, so the
  // panel can never disagree with them about which edition is active (and so a
  // workspace switch re-resolves here for free). Its `defaultAgents` field is
  // authored in the edition manifest and passed through by
  // `withEffectiveSurface`, so feature overrides never touch it.
  const workspaceEdition = useWorkspaceEdition()
  const editionLiveAgentSlug = editionDefaultAgentSlug(workspaceEdition, 'live')
  const editionBatchAgentSlug = editionDefaultAgentSlug(workspaceEdition, 'batch')

  const fetchAgents = useCallback(async () => {
    // Workspace-static + shared cache: repeat panel opens shouldn't refire it.
    const data = await cachedJson<{ agents?: Agent[] }>('/api/account/agents', {
      scope: currentWorkspaceId,
    })
    if (data) setAgents((data.agents || []) as Agent[])
  }, [currentWorkspaceId])

  // Pre-select the EDITION's batch default, if it has one and that agent is
  // actually in this workspace's list. Otherwise do NOT auto-select: a null
  // agentId means the built-in "Assistant" persona (resolved server-side in
  // /api/ai/live-agent) is active — a general-purpose note-taker that adapts to
  // any conversation. The user opts into a specialist (Project Manager, etc.)
  // from the dropdown; until then the Assistant is the default.
  //
  // An EFFECT keyed on both inputs, not a tail on fetchAgents: the two resolve
  // INDEPENDENTLY and in either order. `useWorkspaceEdition` returns the `full`
  // default (⇒ no batch slug) until the workspace GET lands and stamps the
  // active id, while the agents list arrives from its own cached fetch — and
  // the effect that calls fetchAgents is keyed on `captureId` alone, so it
  // never refires when the edition catches up. Doing the pre-select inside
  // fetchAgents therefore dropped it entirely whenever the panel mounted first,
  // which is the common case on a cold load.
  //
  // Only when NOTHING is selected yet: clobbering a selection the user already
  // made (or that a reopened recording restored) would make the dropdown
  // un-stickable. The server resolves the very same default when the client
  // sends no recipe_id, so a workspace whose seed row is missing behaves
  // identically either way — this is about SHOWING the user which persona is
  // about to run, not about routing.
  //
  // `agentIdRef`/`liveLockedRef` (not the values) so this reads them at
  // RESOLVE time without subscribing: re-running on every agent change would
  // fight the user's own selection, and a recording has its own lock (below).
  useEffect(() => {
    if (!editionBatchAgentSlug) return
    if (agentIdRef.current || liveLockedRef.current) return
    const match = agents.find((a) => a.slug === editionBatchAgentSlug)
    if (match) recording.setAgentId(match.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, editionBatchAgentSlug])

  // The agent live mode locks to: the edition's declared live default when it
  // names one AND that agent exists here, else the seeded Interactive Assistant
  // (today's behavior), else nothing — in which case the toggle leaves the
  // selection alone and the server's own fallback decides.
  const liveLockAgent = useMemo(() => {
    const byEdition = editionLiveAgentSlug
      ? agents.find((a) => a.slug === editionLiveAgentSlug)
      : undefined
    return byEdition ?? agents.find((a) => a.slug === INTERACTIVE_ASSISTANT_SLUG) ?? null
  }, [agents, editionLiveAgentSlug])

  // Is the agent that will actually DRIVE the live call an assist-only copilot
  // (real-time help, no notes, no proposals)? While live mode is on — every
  // recording — that is the lock's agent. Keyed on live mode, NOT the lock: Stop
  // reads this hint after the recording flag drops, and must still see the
  // agent that drove the call. (With live mode off it would be whatever the
  // user selected: the same recipe reaches the route.)
  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === recording.agentId) ?? null,
    [agents, recording.agentId],
  )
  const liveAgentAssistOnly = isAssistOnlyAgent(
    (recording.liveModeEnabled ? liveLockAgent : selectedAgent)?.agent_config,
  )
  // The PAIRED NOTE-TAKER: an assist-only live agent runs beside the edition's
  // BATCH persona, which writes the record live and finalizes it when the call
  // ends (the live route pairs them; see `pair_notes`). Named here only for the
  // line under the card — the server resolves the same agent for the turn.
  const liveNotesAgentName = useMemo(
    () =>
      editionBatchAgentSlug
        ? (agents.find((a) => a.slug === editionBatchAgentSlug)?.name ?? null)
        : null,
    [agents, editionBatchAgentSlug],
  )

  // Publish the two facts the RECORDING PROVIDER needs to decide whether the
  // end-of-call batch pass runs (`shouldRunPostLiveBatch`) but cannot work out
  // itself: it holds no agents list and no edition. Both are refs on the
  // provider side, so this is a write, not a render trigger. Kept in an effect
  // (rather than computed at stop time) because the provider's stop path is a
  // `useCallback` with a deliberately minimal dep list — reading a ref there is
  // free, re-deriving these would not be.
  //
  // CLEARED ON UNMOUNT, and that half is load-bearing: the provider lives ABOVE
  // the dashboard (account-providers.tsx) and survives navigation AND workspace
  // switches, while this panel mounts and unmounts beneath it. Without the
  // cleanup the refs keep whatever the last mounted panel wrote — so a sales
  // capture's `hasBatchDefault: true` would still be set when the user switches
  // to a `full`/`notes` workspace and records with no panel open, and that
  // capture would take a second, unwanted extraction pass over a summary live
  // mode already wrote. Resetting to `false` is the safe direction: it is
  // exactly today's behavior, and a mounted panel re-publishes the real values
  // on its next render.
  const setPostLiveBatchHints = recording.setPostLiveBatchHints
  useEffect(() => {
    setPostLiveBatchHints({
      liveAgentAssistOnly,
      // An edition that names a BATCH persona is declaring that a specific agent
      // writes the finished record. The slug alone is enough: if the agent row
      // is missing from this workspace, the run still happens and the SERVER
      // resolver falls back (to its own default, then to ASSISTANT_PERSONA) —
      // notes get written either way, which is the invariant that matters.
      hasBatchDefault: !!editionBatchAgentSlug,
    })
    return () => setPostLiveBatchHints({ liveAgentAssistOnly: false, hasBatchDefault: false })
  }, [liveAgentAssistOnly, editionBatchAgentSlug, setPostLiveBatchHints])

  // Lock the agent to the live persona while a capture records (the edition's
  // declared live default, else the Interactive Assistant — whose persona is
  // written for live mode); also when the agent list loads after the recording
  // began. The lock collapses the dropdown to a single option (see the Select
  // below). When the recording ends the picker is simply unlocked: nothing is
  // restored, because the live agent's final turn and the end-of-call batch
  // read the selection AFTER the recording flag drops — a restore there would
  // hand them the wrong agent. The lingering live persona is harmless: the
  // handoff rule swaps it for the batch default in every batch run (Stop's and
  // Reprocess's).
  const setAgentId = recording.setAgentId
  useEffect(() => {
    if (liveLocked && liveLockAgent && recording.agentId !== liveLockAgent.id) {
      // fromLiveLock: this selection is the edition's LIVE persona put there by
      // the lock, not a user choice — the end-of-call handoff rule drops it for
      // any batch run rather than grading the transcript with a mid-call persona.
      setAgentId(liveLockAgent.id, { fromLiveLock: true })
    }
    // recording.agentId is excluded from deps so this re-asserts on the lock's
    // edges, not on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveLocked, liveLockAgent, setAgentId])

  const fetchProjects = useCallback(async () => {
    // Minimal mode + shared cache: the picker only needs id/name, and repeat
    // panel opens shouldn't refire the request.
    const data = await cachedJson<{ projects?: { id: string; name: string }[] }>(
      '/api/account/projects?minimal=1',
      { scope: currentWorkspaceId },
    )
    if (data) {
      const list = (data.projects || [])
        .filter((p) => p.name !== '__default__')
        .map((p) => ({ id: p.id, name: p.name }))
      setProjects(list)
    }
  }, [currentWorkspaceId])

  const fetchLinkedParticipants = useCallback(async () => {
    const res = await fetch(`/api/account/captures/${captureId}/participants`)
    if (res.ok) {
      const data = await res.json()
      setLinkedParticipants(data.participants || [])
    }
  }, [captureId])

  const fetchSeriesHistory = useCallback(async () => {
    const res = await fetch(`/api/account/captures/${captureId}/series`)
    if (res.ok) {
      const data = await res.json()
      setSeriesHistory(data.occurrences || [])
    }
  }, [captureId])

  // The history row only matters for event-linked captures; refresh whenever
  // the link changes (handleLinkEvent/handleUnlinkEvent also refetch).
  const linkedCalendarEventId = capture?.calendar_event_id
  useEffect(() => {
    setSeriesHistory(null)
    setHistoryOpen(false)
    if (linkedCalendarEventId) void fetchSeriesHistory()
  }, [linkedCalendarEventId, fetchSeriesHistory])

  const searchContacts = useCallback(async (query: string) => {
    setContactSearchLoading(true)
    try {
      const url = query.trim()
        ? `/api/account/contacts?search=${encodeURIComponent(query)}&limit=10`
        : `/api/account/contacts?limit=5&sort=last_interaction_at&direction=desc`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        // Filter out contacts already in the participant list
        const existingContactIds = new Set(linkedParticipants.map((p) => p.contact_id).filter(Boolean))
        setContactSearchResults(
          (data.contacts || []).filter((c: ContactSearchResult) => !existingContactIds.has(c.id)),
        )
      }
    } finally {
      setContactSearchLoading(false)
    }
  }, [linkedParticipants])

  const handleAddParticipant = useCallback(async (contact: ContactSearchResult) => {
    setAddingParticipant(contact.id)
    try {
      const res = await fetch(`/api/account/captures/${captureId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.id,
          external_name: contact.full_name,
          external_email: contact.email || undefined,
          company: contact.company?.name || undefined,
          job_title: contact.job_title || undefined,
          role: 'attendee',
          source: 'manual',
        }),
      })
      if (res.ok) {
        await fetchLinkedParticipants()
        setContactSearchQuery('')
        setContactSearchResults([])
        setAddParticipantOpen(false)

        // Log CRM interaction in the background
        fetch(`/api/account/captures/${captureId}/participants/log-interaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_id: contact.id }),
        }).catch(() => {})
      }
    } finally {
      setAddingParticipant(null)
    }
  }, [captureId, fetchLinkedParticipants])

  const handleRemoveParticipant = useCallback(async (participantId: string) => {
    setRemovingParticipant(participantId)
    try {
      const res = await fetch(`/api/account/captures/${captureId}/participants/${participantId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setLinkedParticipants((prev) => prev.filter((p) => p.id !== participantId))
      }
    } finally {
      setRemovingParticipant(null)
    }
  }, [captureId])

  // ─── Proposed changes (new system) ─────────────────────────

  const fetchProposedChanges = useCallback(async () => {
    const seq = ++proposedFetchSeqRef.current
    const res = await fetch(`/api/account/captures/${captureId}/proposed-changes`)
    if (res.ok) {
      const data = await res.json()
      // A newer fetch was dispatched while this one was in flight — its
      // response supersedes ours whatever order they resolve in.
      if (seq !== proposedFetchSeqRef.current) return
      proposedFetchAtRef.current = Date.now()
      const fetched = (data.changes || []) as ProposedChange[]
      // Reconcile by id so unchanged rows keep their object identity — that's
      // what lets the memoized ProposalCards (and proposalNodeCtx) sit out
      // refetches that changed nothing about them.
      setProposedChanges((prev) => reconcileProposedChanges(prev, fetched))
      // Keep the previous object when nothing changed (every 25s poll and
      // proposal event lands here) so React bails out instead of re-rendering.
      const counts: ProposedChangeCounts = data.counts || { pending: 0, applied: 0, dismissed: 0, total: 0 }
      setProposedCounts((prev) =>
        prev.pending === counts.pending &&
        prev.applied === counts.applied &&
        prev.dismissed === counts.dismissed &&
        prev.total === counts.total
          ? prev
          : counts,
      )
    }
  }, [captureId])

  // Trailing-debounced proposals refetch for realtime bursts: an extraction
  // pass emits ~2 events per item, and one refetch at the end beats N
  // overlapping GETs (same coalescing pattern as unified-view-layout's
  // scheduleRefetch). The channel effect's cleanup clears the timer.
  const proposedRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleProposedRefetch = useCallback(() => {
    if (proposedRefetchTimerRef.current) clearTimeout(proposedRefetchTimerRef.current)
    proposedRefetchTimerRef.current = setTimeout(() => {
      proposedRefetchTimerRef.current = null
      void fetchProposedChanges()
    }, 300)
  }, [fetchProposedChanges])

  // Single stale-guarded capture refetch + merge, shared by every catch-up path
  // (Realtime SUBSCRIBED resync, useEntityDetailSync refetch, capture-ended
  // refetch, and the recording poll fallback). Consolidating these guarantees NO
  // path — least of all the poll — can skip isFetchedCaptureStale and clobber a
  // mid-edit summary, or route a caught-up summary through the reveal animation.
  //
  // `pushSummaryToEditor` mirrors the summary into the editor via setSummaryDirect
  // (never revealSummary — a poll/resync catch-up must snap, not type) so a dead
  // socket still shows the latest agent notes. Callers that only need state/cache
  // freshened (detail-sync, capture-ended) pass false.
  //
  // A row that changes nothing leaves state alone (mergeRefetchedCapture), so
  // these catch-ups cost no panel render unless something moved.
  // `recordingPoll` is the 25s poll's: it reads `?fields=meta` (no transcript,
  // content or note_attributions; on a long call the transcript alone is
  // ~100KB, downloaded and parsed every tick) and ignores the recorder's own
  // transcript saves (see mergeRefetchedCapture). The transcript catches up when
  // the recording stops (ni:capture-transcript-saved, below).
  const refetchCaptureGuarded = useCallback(
    async (opts?: { pushSummaryToEditor?: boolean; recordingPoll?: boolean }) => {
      // Swallow all failures: every caller invokes this as `void
      // refetchCaptureGuarded(...)`, so a rejected fetch (flaky wifi mid-
      // recording — the exact target scenario, hit every 25s poll tick) would
      // otherwise surface as an unhandled promise rejection. Matches the
      // `.catch(() => {})` the pre-consolidation blocks each had.
      try {
        const meta = !!opts?.recordingPoll
        const res = await fetch(`/api/account/captures/${captureId}${meta ? '?fields=meta' : ''}`)
        if (!res.ok) return
        const data = await res.json()
        const cap = data?.capture as CaptureDetail | undefined
        if (!cap) return
        // A meta row isn't a whole capture: until the mount fetch has filled
        // state, leave it to that fetch.
        if (meta && !captureStateRef.current) return
        captureFetchAtRef.current = Date.now()
        const normalized: CaptureDetail = { ...cap, labels: cap.labels ?? [], visibility: cap.visibility ?? 'workspace' }
        // A GET that raced an in-flight/just-committed summary save must not
        // regress ai_summary or updated_at (→ editor initialContent → the doc).
        const fetchedStale = isFetchedCaptureStale(normalized)
        // Read when the row lands: a tick still in flight as the recording
        // stops merges in full.
        const ignoreTranscriptSaves = meta && isActiveRecordingRef.current
        commitRefetchedCapture(
          captureStateRef.current,
          normalized,
          { stale: fetchedStale, ignoreTranscriptSaves },
          setCapture,
        )
        if (!fetchedStale) {
          // A meta row goes onto the cached capture, so the cache keeps its
          // transcript for the next open.
          const cached = meta ? captureDetailCache.get(captureId) ?? captureStateRef.current : null
          writeCaptureCache(captureId, cached ? { ...cached, ...normalized } : normalized)
          if (opts?.pushSummaryToEditor) {
            const summary = normalized.ai_summary
            if (summary && summary !== '{{streaming}}') setSummaryDirect(summary)
          }
        }
      } catch {
        // best-effort catch-up; a failed refetch just retries on the next tick
      }
    },
    // isFetchedCaptureStale is a locally-defined helper that closes over refs
    // (stable); setSummaryDirect is a stable useCallback. Keyed on captureId so
    // the helper's identity is stable per capture.
    [captureId, setSummaryDirect],
  )

  // The stop's final transcript, re-read the moment it's saved. The recording
  // poll reads the meta payload, so capture.transcript is whatever the panel
  // last fetched in full. The live buffer covers that while it shows; this
  // brings state level with the saved text once the session ends, on every stop
  // path (recording-context fires the event before the ended_at PATCH, and even
  // when no capture-ended follows). Only the transcript column is read and
  // merged: a full row fetched here could land after ended_at's realtime echo
  // and put ended_at back to null.
  useEffect(() => {
    const onSaved = (e: Event) => {
      const savedId = (e as CustomEvent<{ captureId?: string }>).detail?.captureId
      if (savedId !== captureId) return
      fetch(`/api/account/captures/${captureId}?fields=transcript`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const transcript = data?.capture?.transcript as string | null | undefined
          if (transcript === undefined) return
          setCapture((prev) => mergeSavedTranscript(prev, transcript))
          const cached = captureDetailCache.get(captureId)
          if (cached && cached.transcript !== transcript) writeCaptureCache(captureId, { ...cached, transcript })
        })
        .catch(() => {})
    }
    window.addEventListener('ni:capture-transcript-saved', onSaved)
    return () => window.removeEventListener('ni:capture-transcript-saved', onSaved)
  }, [captureId])

  // ─── Realtime detail sync ──────────────────────────────────
  // The bespoke capture-stream channel (below) only patches a handful of fields
  // (title / ended_at / ai_summary / ai_processed) live during recording. This
  // covers EVERY other field (project_id, status, labels, is_pinned, transcript,
  // …) when the row is updated remotely (teammate, MCP tool,
  // cron): a full stale-guarded refetch that never regresses the summary the user
  // may be mid-edit. On remote delete, follow the panel's close convention.
  useEntityDetailSync('capture', captureId, {
    // State/cache freshen only — don't push into the editor (an in-tab edit or
    // the reveal animation owns it); the shared helper's stale guard protects it.
    refetch: () => {
      void refetchCaptureGuarded()
    },
    onDeleted: () => {
      captureDetailCache.delete(captureId)
      onDeleted?.()
      onClose()
    },
  })

  // Optimistic-start undo (mic rejected / create POST failed): recording-context
  // broadcasts this so a panel left mounted in ANY tab closes. The goBack undo
  // only rewinds the ACTIVE tab, and on the no-row leg (create failed) there is
  // no realtime DELETE to heal a background tab's panel — it would sit there
  // live-looking while every edit 404s silently. Ref-mirrored handler so the
  // listener registers once per captureId.
  const closeOnStartUndoneRef = useRef(() => {})
  closeOnStartUndoneRef.current = () => {
    captureDetailCache.delete(captureId)
    onDeleted?.()
    onClose()
  }
  useEffect(() => {
    const onUndone = (e: Event) => {
      const undoneId = (e as CustomEvent<{ captureId?: string }>).detail?.captureId
      if (undoneId === captureId) closeOnStartUndoneRef.current()
    }
    window.addEventListener('ni:capture-start-undone', onUndone)
    return () => window.removeEventListener('ni:capture-start-undone', onUndone)
  }, [captureId])

  // Participants list: refetch when a capture_participant row for THIS capture is
  // added/updated/removed elsewhere. Realtime rows carry capture_id in fields;
  // locally-emitted events may not, so fall through and let the refetch confirm.
  useEntityListSync(['capture_participant'], fetchLinkedParticipants, {
    match: (d) => !d.fields || d.fields.capture_id === captureId,
  })

  // Keep ref in sync for capture-ended handler (defined before fetchCapture/fetchProposedChanges).
  // Uses the shared stale-guarded refetch (no loading spinner) + proposals pull.
  // The freshly-extracted end-of-meeting summary is pushed into the editor so a
  // capture that ended while the socket was dead still surfaces its final notes —
  // but ONLY when NOT actively recording. This handler fires from streaming
  // onDone for EVERY live-pause stream completion, not just end-of-meeting; on a
  // healthy socket during recording the push could resolve mid reveal-animation
  // and setSummaryDirect would snap over it. Gating on !isActiveRecording keeps
  // the end-of-meeting push while leaving the mid-recording healthy path to the
  // realtime reveal.
  captureEndedRefetchRef.current = () => {
    void refetchCaptureGuarded({ pushSummaryToEditor: !isActiveRecordingRef.current })
    fetchProposedChanges()
  }

  // Reprocess: run a fresh batch extraction over the full transcript through
  // the same live-agent pipeline. Used to (a) recover a capture whose live-OFF
  // batch run never fired (e.g. a crash), or (b) re-extract with a different
  // agent after picking one. Replaces still-pending proposals and keeps anything
  // already accepted (server-side semantics).
  //
  // Persona: the SELECTED agent (recording.agentId), or — when none is selected
  // — the built-in Assistant (omit recipe_id → server falls back to
  // ASSISTANT_PERSONA). This matches the live + end-of-meeting batch paths
  // exactly, so the same capture behaves consistently however it's processed.
  //
  // ...with ONE correction, the end-of-call handoff rule (see
  // `resolveBatchHandoffAgentId`): this is a `mode: 'batch'` run, and while live
  // mode is on the selection above is LOCKED to the edition's live default by
  // the effect further up — the product's choice, not the user's. Carrying it
  // into a batch run would grade the finished transcript with the mid-call
  // persona (`sales-live`) and never reach the post-call one the edition
  // declares. So a selection that is merely the edition's live default is
  // swapped for its batch default; a specialist the user actually picked, the
  // batch default itself, and "no selection" all pass through untouched. A null
  // result omits recipe_id, and the SERVER resolver lands on the same persona.
  const handleReprocess = useCallback(async () => {
    // Stream the re-extraction so the summary types in live and proposals pop
    // in as the model produces them (Granola-style). The hook handles auth,
    // the SSE consumption, and the typing preview; onDone/onError (wired where
    // the hook is created) reconcile to canonical state and surface failures.
    setStreamingMode('batch')
    await streaming.start({
      captureId,
      mode: 'batch',
      recipeId:
        resolveBatchHandoffAgentId({
          selectedAgentId: recording.agentId,
          editionLiveAgentSlug,
          editionBatchAgentSlug,
          agents,
        }) || undefined,
    })
  }, [
    captureId,
    recording.agentId,
    streaming.start,
    editionLiveAgentSlug,
    editionBatchAgentSlug,
    agents,
  ])

  const fetchWorkspaceMembers = useCallback(async () => {
    // Both lookups are workspace-static: cached (shared with every other
    // consumer of these endpoints) and fired in PARALLEL — they used to be two
    // sequential uncached fetches per panel open. AI team members (agents)
    // live on the full workspace endpoint so capture proposals can be
    // assigned to an agent.
    const [membersData, ws] = await Promise.all([
      cachedJson<{ members?: { id: string; display_name: string; avatar_url: string | null }[] }>(
        '/api/account/workspace/members',
        { scope: currentWorkspaceId },
      ),
      cachedJson<{ aiMembers?: { id: string; name: string; avatar_url: string | null }[] }>(
        '/api/account/workspace',
        { scope: currentWorkspaceId },
      ),
    ])
    if (membersData) {
      setWorkspaceMembers(
        (membersData.members || []).map((m) => ({
          id: m.id,
          display_name: m.display_name,
          avatar_url: m.avatar_url,
        })),
      )
    }
    if (ws) {
      setWorkspaceAiMembers(
        (ws.aiMembers || []).map((m) => ({
          id: m.id,
          name: m.name,
          avatar_url: m.avatar_url,
        })),
      )
    }
  }, [currentWorkspaceId])

  const fetchWorkspaceContacts = useCallback(async () => {
    // Workspace-static → shared cache, same as fetchProjects.
    const data = await cachedJson<{ contacts?: { id: string; full_name: string; email: string | null }[] }>(
      '/api/account/contacts?limit=100',
      { scope: currentWorkspaceId },
    )
    if (data) {
      setWorkspaceContacts(
        (data.contacts || []).map((c) => ({
          id: c.id,
          full_name: c.full_name,
          email: c.email,
        })),
      )
    }
  }, [currentWorkspaceId])

  const handleProposalApply = useCallback(async (changeId: string): Promise<string | null> => {
    const res = await fetch(`/api/account/captures/${captureId}/proposed-changes/${changeId}/apply`, {
      method: 'POST',
    })
    if (res.ok) {
      // The route returns the entity it created. Keeping it does two things the
      // old fire-and-forget optimistic flip couldn't: the row immediately gets
      // its "open"/"start agent" affordances (which key off result_entity_id),
      // and "confirm then push to Asana" can push the very action it just made
      // instead of hunting for it.
      const body = await res.json().catch(() => null) as { entity_id?: string | null } | null
      const entityId = body?.entity_id ?? null
      setProposedChanges((prev) =>
        prev.map((c) =>
          c.id === changeId
            ? { ...c, status: 'applied' as const, result_entity_id: entityId ?? c.result_entity_id }
            : c,
        ),
      )
      setProposedCounts((prev) => ({ ...prev, pending: prev.pending - 1, applied: prev.applied + 1 }))
      return entityId
    } else {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null
      if (res.status === 409 && body?.code === 'already_applied') {
        // We lost the accept race (another tab, or this row's own Accept while
        // the push menu was open). Nothing failed — the proposal IS accepted, by
        // the request that won. The refetch brings back the applied row with the
        // winner's result_entity_id, so a push can be retried from the row.
        toast.info('Already accepted — push again from the row')
        fetchProposedChanges()
        return null
      }
      const message = body?.error || 'Failed to apply change'
      toast.error(message)
      // Refetch so the card shows the error_message persisted by the apply route
      fetchProposedChanges()
      // Null tells a confirm-then-push caller the confirm failed, so it stops
      // rather than pushing an action that was never created.
      return null
    }
  }, [captureId, fetchProposedChanges])

  const handleProposalDismiss = useCallback(async (changeId: string) => {
    // Capture the prior status so we decrement the right counter — an applied
    // (auto-accepted) item dismissed here moves applied→dismissed, not
    // pending→dismissed. Read from the render-synced ref, NOT a proposedChanges
    // dep: a dep would give this callback (and proposalNodeCtx, and every card
    // under it) a new identity on every refetch.
    const prevStatus = proposedChangesRef.current.find((c) => c.id === changeId)?.status
    const res = await fetch(`/api/account/captures/${captureId}/proposed-changes/${changeId}/dismiss`, {
      method: 'POST',
    })
    if (res.ok) {
      setProposedChanges((prev) =>
        prev.map((c) => (c.id === changeId ? { ...c, status: 'dismissed' as const } : c)),
      )
      setProposedCounts((prev) => ({
        ...prev,
        pending: prevStatus === 'applied' ? prev.pending : prev.pending - 1,
        applied: prevStatus === 'applied' ? prev.applied - 1 : prev.applied,
        dismissed: prev.dismissed + 1,
      }))
    } else {
      const body = await res.json().catch(() => null) as { error?: string } | null
      toast.error(body?.error || 'Failed to dismiss change')
    }
  }, [captureId])

  const handleProposalUndo = useCallback(async (changeId: string) => {
    const res = await fetch(`/api/account/captures/${captureId}/proposed-changes/${changeId}/undo`, {
      method: 'POST',
    })
    if (res.ok) {
      const data = await res.json().catch(() => null) as { change?: { id: string } } | null
      setProposedChanges((prev) =>
        prev.map((c) =>
          c.id === changeId
            ? { ...c, ...(data?.change || {}), status: 'pending' as const, auto_accepted: false }
            : c,
        ),
      )
      setProposedCounts((prev) => ({ ...prev, applied: prev.applied - 1, pending: prev.pending + 1 }))
    } else {
      const body = await res.json().catch(() => null) as { error?: string } | null
      toast.error(body?.error || 'Failed to undo change')
    }
  }, [captureId])

  const handleProposalEdit = useCallback(async (changeId: string, updates: Record<string, unknown>) => {
    const res = await fetch(`/api/account/captures/${captureId}/proposed-changes/${changeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      setProposedChanges((prev) =>
        prev.map((c) => (c.id === changeId ? data.change : c)),
      )
    }
  }, [captureId])

  // Note: bulk "apply all" of proposed changes is still exposed via the
  // /api/account/captures/[id]/proposed-changes/apply-all route (used by the AI
  // tools / MCP). The top-of-page "Apply all" button was removed because action
  // items now auto-apply — see the Reprocess button next to the title instead.

  // Build proposal refs for the editor's markdown → JSON parser.
  // Stable: only recalculates when the set of proposal IDs changes (not on status updates).
  const proposalIdKey = useMemo(
    () => [...proposedChanges].sort((a, b) => a.sort_order - b.sort_order).map((c) => c.id).join(','),
    [proposedChanges],
  )
  const proposalRefs = useMemo<ProposalChangeRef | undefined>(() => {
    if (proposedChanges.length === 0) return undefined
    const sorted = [...proposedChanges].sort((a, b) => a.sort_order - b.sort_order)
    const byIndex = new Map<number, string>()
    const byId = new Map<string, string>()
    const allIds: string[] = []
    sorted.forEach((change, i) => {
      byIndex.set(i, change.id)
      byId.set(change.id, change.id)
      byId.set(change.id.slice(0, 8), change.id)
      allIds.push(change.id)
    })
    return { byIndex, byId, allIds }
  }, [proposalIdKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // O(1) id → change lookup for the editor's per-node portals — each
  // ProposalNode resolves its change by id on every render, and a scan of the
  // full list per node made that O(N²) across a refetch.
  const proposedChangesById = useMemo(
    () => new Map(proposedChanges.map((c) => [c.id, c])),
    [proposedChanges],
  )

  // Context value for ProposalNode React components inside the editor
  const proposalNodeCtx = useMemo<ProposalNodeContextValue>(() => ({
    changes: proposedChanges,
    changesById: proposedChangesById,
    onApply: handleProposalApply,
    onDismiss: handleProposalDismiss,
    onEdit: handleProposalEdit,
    onUndo: handleProposalUndo,
    onOpenEntity,
    members: workspaceMembers,
    aiMembers: workspaceAiMembers,
    contacts: workspaceContacts,
    projects,
    currentMemberId,
    autoAcceptPolicy,
    onOpenSettings: settingsOverlay?.openSettings,
  }), [proposedChanges, proposedChangesById, handleProposalApply, handleProposalDismiss, handleProposalEdit, handleProposalUndo, onOpenEntity, workspaceMembers, workspaceAiMembers, workspaceContacts, projects, currentMemberId, autoAcceptPolicy, settingsOverlay?.openSettings])

  // Always include ProposalNodeExtension so the schema supports proposalNode atoms
  // from initial mount — avoids full editor remount when proposals first arrive.
  const proposalExtensions = useMemo(() => [ProposalNodeExtension], [])

  // Subscribe to Realtime for live proposed changes (during active captures)
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`proposed-changes:${captureId}:${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'proposed_change',
          filter: `capture_id=eq.${captureId}`,
        },
        () => {
          // Refetch all proposed changes on any insert/update/delete —
          // debounced, so an extraction burst coalesces into one GET instead
          // of a refetch-per-event storm.
          scheduleProposedRefetch()
        },
      )
      .subscribe((status) => {
        // Resync on (re)subscribe. Realtime only delivers events that occur
        // AFTER the channel reaches SUBSCRIBED — any rows written during the
        // mount→SUBSCRIBED handshake (e.g. a batch run finishing right as the
        // panel opens) are never replayed. Refetching here closes that window,
        // which is the usual cause of "I had to refresh to see the new items".
        // CHANNEL_ERROR/TIMED_OUT auto-retry and fire SUBSCRIBED again on reconnect.
        // Skipped when the mount fetch just resolved (see the recency guard) —
        // a plain panel open reaches SUBSCRIBED ~1s in and was downloading the
        // identical list twice; a reconnect rejoin comes later and still resyncs.
        if (status === 'SUBSCRIBED') {
          if (Date.now() - proposedFetchAtRef.current < SUBSCRIBED_RESYNC_SKIP_MS) return
          fetchProposedChanges()
        }
      })

    return () => {
      if (proposedRefetchTimerRef.current) {
        clearTimeout(proposedRefetchTimerRef.current)
        proposedRefetchTimerRef.current = null
      }
      supabase.removeChannel(channel)
    }
  }, [captureId, instanceId, fetchProposedChanges, scheduleProposedRefetch])

  useEffect(() => {
    fetchCapture()
    fetchProposedChanges()
    fetchWorkspaceMembers()
    fetchWorkspaceContacts()
    fetchAgents()
    fetchProjects()
    fetchLinkedParticipants()

    // Fetch inline comments — non-blocking. The identity comes synchronously
    // from the workspace cache (see commentIdentity above), and the provider
    // hydrates these by id when they arrive, so nothing here gates first paint.
    fetch(`/api/account/captures/${captureId}/comments`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.comments) setRawInlineComments(data.comments)
      })
      .catch(() => {})
  // Only re-run when the captureId changes — the fetch callbacks are stable
  // per capture (memoized on captureId or the workspace id, which can't change
  // under a mounted panel)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId])

  // Supabase Realtime: watch for ai_summary updates on this capture (from live agent)
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`capture-stream:${captureId}:${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'captures',
          filter: `id=eq.${captureId}`,
        },
        (payload) => {
          const updated = payload.new as Record<string, unknown>
          const newSummary = updated.ai_summary as string | null

          // Every merge below is conditional on the field actually CHANGING.
          // The full row is rebroadcast on every transcript append (a 2–30s
          // cadence for the whole recording) and captures default to
          // 'Untitled Capture', so a bare truthiness check re-rendered the
          // entire panel per append for fields that hadn't moved. Returning
          // `prev` unchanged lets React bail out of the update entirely.
          if (updated.title) {
            setCapture((prev) =>
              prev && prev.title !== updated.title
                ? { ...prev, title: updated.title as string }
                : prev,
            )
          }

          if (updated.ended_at) {
            setCapture((prev) =>
              prev && prev.ended_at !== updated.ended_at
                ? { ...prev, ended_at: updated.ended_at as string }
                : prev,
            )
          }

          // Carry the row's updated_at into every merge — the staleness guards
          // on the resync/refetch paths compare against it.
          const rowUpdatedAt = updated.updated_at as string | undefined

          // '' is a deliberate clear (ours or a teammate's) and must propagate
          // like any other value — skipping it left the cleared text on other
          // screens and the recency baseline unarmed for the clearing write.
          // TWO independent skips (see decideRealtimeSummary): the state merge
          // vs the render-synced mirror (re-merging identical text per
          // transcript-append echo was a guaranteed full-panel re-render), the
          // editor push vs the EDITOR-side watermark — a refetch that freshened
          // state without pushing must never swallow the editor's only push.
          if (typeof newSummary === 'string') {
            const { merge, push } = decideRealtimeSummary(
              newSummary,
              captureStateRef.current?.ai_summary,
              lastEditorSummaryRef.current,
            )
            if (merge) {
              setCapture((prev) => prev ? { ...prev, ai_summary: newSummary, updated_at: rowUpdatedAt ?? prev.updated_at } : prev)
            }
            // Push live updates to the editor so it reflects real-time changes.
            // During an active LIVE recording, reveal the new text with a light
            // typing animation (Granola-style) instead of snapping it in. When
            // an SSE stream is already driving the editor (batch/Reprocess), or
            // outside an active recording, set it directly — the stream's own
            // buffered typing / the canonical reconcile owns the animation there.
            // NEVER animate the echo of our own save: the animation feeds prefix
            // slices into the editor, and a prefix of just-typed text truncates it.
            if (push) {
              if (
                newSummary !== '' &&
                isActiveRecordingRef.current &&
                !streamingRef.current &&
                newSummary !== lastSavedSummaryRef.current
              ) {
                revealSummary(newSummary)
              } else {
                setSummaryDirect(newSummary)
              }
            }
          }

          if (updated.ai_processed === true) {
            // Only on the false→true edge — once processed, later echoes of the
            // (still-true) flag carry nothing this leg needs: summary changes
            // are merged by the leg above.
            setCapture((prev) =>
              prev && !prev.ai_processed
                ? { ...prev, ai_processed: true, ai_summary: (newSummary || prev.ai_summary), updated_at: rowUpdatedAt ?? prev.updated_at }
                : prev,
            )
          }
        },
      )
      .subscribe((status) => {
        // Resync on (re)subscribe — same rationale as the proposed_change channel.
        // A batch run that writes ai_summary during the mount→SUBSCRIBED handshake
        // would otherwise be missed, leaving a stale summary until manual refresh.
        // We refetch the capture (refreshes state + cache without touching the
        // editor), then push the fetched summary into the editor ONLY when the
        // user isn't mid-edit (no pending debounced save). The editor itself
        // no-ops if the content already matches, so this is safe and idempotent.
        if (status === 'SUBSCRIBED') {
          // Skipped when the mount fetch just resolved AND the editor is in
          // sync with state (recency guard): a plain panel open reaches
          // SUBSCRIBED ~1s in and re-downloaded the full row (transcript
          // included) twice. When the editor LAGS a fresh state — a socket-
          // recovery refetch landed without pushing, stamping the fetch time —
          // this resync is the only path left that pushes, so it must run.
          // A reconnect rejoin arrives later, so its catch-up resync still runs.
          if (
            shouldSkipSubscribedResync(
              Date.now(),
              captureFetchAtRef.current,
              lastEditorSummaryRef.current,
              captureStateRef.current?.ai_summary ?? null,
            )
          ) return
          // Shared stale-guarded refetch: never touches ai_summary/updated_at
          // on a raced fetch (keeps the recency guard armed), seeds cache and
          // pushes the caught-up summary (via setSummaryDirect, not reveal) only
          // when it's safe — closing the mount→SUBSCRIBED replay gap.
          void refetchCaptureGuarded({ pushSummaryToEditor: true })
        }
      })

    // Track the live channel so the poll fallback can read its join state.
    captureStreamChannelRef.current = channel as unknown as { state?: string }

    return () => {
      captureStreamChannelRef.current = null
      supabase.removeChannel(channel)
    }
    // revealSummary / setSummaryDirect / refetchCaptureGuarded are stable
    // (keyed on captureId); listed to satisfy exhaustive-deps without forcing
    // the channel to re-subscribe on unrelated renders.
  }, [captureId, instanceId, revealSummary, setSummaryDirect, refetchCaptureGuarded])

  // POLL FALLBACK (flagship live-notes surface). While THIS capture is actively
  // recording, poll as defense-in-depth so a dead socket can't strand the live
  // notes. Proposals are always safe to poll directly (no editor/summary
  // hazard); the capture row's summary is mirrored into the editor ONLY when live
  // delivery is down (see the hook doc — avoids cancelling an in-flight reveal).
  // It keeps ticking while realtime looks healthy: the socket it backs up dies
  // without saying so. A tick reads the capture without its transcript
  // (`recordingPoll`), and one that brings nothing new renders nothing (both
  // fetches keep state's objects), the recorder's own transcript saves
  // included.
  const onPollTick = useCallback(
    ({ deliveryDown }: { deliveryDown: boolean }) => {
      void fetchProposedChanges()
      void refetchCaptureGuarded({ pushSummaryToEditor: deliveryDown, recordingPoll: true })
    },
    [fetchProposedChanges, refetchCaptureGuarded],
  )
  // Live delivery is "down" if the shared socket is disconnected OR this capture's
  // own stream channel isn't joined — the socket can be repaired (watchdog knock)
  // while a specific channel is momentarily still rejoining, and pushing a snapped
  // summary during that narrow window is the safe choice. Only when BOTH are
  // healthy do we defer to the realtime reveal path.
  const isDeliveryDown = useCallback(() => {
    const supabase = createClient()
    if (!supabase.realtime.isConnected()) return true
    return captureStreamChannelRef.current?.state !== 'joined'
  }, [])
  useRecordingPollFallback(isActiveRecording, onPollTick, isDeliveryDown)


  function startEditingTitle() {
    if (!capture) return
    setTitleDraft(capture.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  async function saveTitle() {
    const trimmed = titleDraft.trim()
    if (!trimmed || !capture || trimmed === capture.title) {
      setEditingTitle(false)
      return
    }
    // Optimistic start: wait for the row's INSERT before renaming — a PATCH
    // against the not-yet-inserted row 404s and the rename is silently lost,
    // then superseded by the INSERT's default title.
    if (!(await captureRowReady(captureId))) {
      setEditingTitle(false)
      return
    }
    const res = await fetch(`/api/account/captures/${captureId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    })
    if (res.ok) {
      const data = await res.json()
      mergeCaptureResponse(data.capture as CaptureDetail)
      // Fan the rename out + arm self-echo suppression so the detail-sync refetch
      // can't regress the title with this tab's own realtime echo.
      emitEntityUpdated({ entityType: 'capture', id: captureId, fields: { title: trimmed } })
    }
    setEditingTitle(false)
  }

  // Merge a PATCH/GET response into capture state without letting a row that
  // predates a raced summary write regress ai_summary (→ summaryText → the
  // editor's initialContent → the doc).
  function mergeCaptureResponse(cap: CaptureDetail) {
    const fetchedStale = isFetchedCaptureStale(cap)
    setCapture((prev) => {
      if (!prev) return cap
      return fetchedStale
        ? { ...prev, ...cap, ai_summary: prev.ai_summary, updated_at: laterTimestamp(prev.updated_at, cap.updated_at) }
        : { ...prev, ...cap }
    })
  }

  function handleSummaryChange(value: string) {
    // The serialized editor doc IS the editor's content — stamp the watermark
    // immediately (not in the debounced save) so a realtime echo of the typed
    // text racing the debounce can't re-push a prefix over the user's typing.
    lastEditorSummaryRef.current = value
    if (summaryTimeoutRef.current) clearTimeout(summaryTimeoutRef.current)
    const timer = setTimeout(() => {
      // Chain saves so overlapping bursts can't commit out of order — an older
      // PATCH resolving after a newer one would win in the DB.
      summarySaveChainRef.current = summarySaveChainRef.current.then(async () => {
        setSaving(true)
        try {
          // Optimistic start: hold the autosave until the row exists — a 404'd
          // PATCH would be silently dropped (and lastSavedSummaryRef would lie
          // to the resync guard about it having landed).
          if (!(await captureRowReady(captureId))) return
          // Recorded before dispatch — the Realtime echo can arrive before the
          // HTTP response does.
          lastSavedSummaryRef.current = value
          const res = await fetch(`/api/account/captures/${captureId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ai_summary: value }),
          })
          if (res.ok) {
            const data = await res.json()
            mergeCaptureResponse(data.capture as CaptureDetail)
          }
        } finally {
          setSaving(false)
          // Clear the ref so it accurately reflects "a save is pending" — but
          // only when it still holds THIS cycle's timer. If a newer burst armed
          // a new timer while this save was in flight, nulling the ref here
          // would orphan that timer and reopen the resync guard while its save
          // is still pending.
          if (summaryTimeoutRef.current === timer) summaryTimeoutRef.current = null
        }
      }).catch(() => {}) // a failed save must not poison the chain for later saves
    }, 500)
    summaryTimeoutRef.current = timer
  }

  async function searchCalendarEvents(query: string, from: string, to: string) {
    const seq = ++eventSearchSeqRef.current
    setEventSearchLoading(true)
    try {
      const params = new URLSearchParams({ timeMin: from, timeMax: to, maxResults: '50' })
      const res = await fetch(`/api/calendar/events?${params}`)
      if (!res.ok) return
      const data = await res.json()
      const serverEvents = data.events || []

      // Merge with local Exchange events from desktop app (EventKit)
      const { mergeWithLocalExchangeEvents } = await import('@/lib/integrations/calendar-local')
      const mergedEvents = await mergeWithLocalExchangeEvents(serverEvents, from, to)

      // Filter out all-day events (reminders, OOO, holidays) – they aren't meetings to capture
      const timedEvents = mergedEvents.filter((e: { isAllDay?: boolean }) => !e.isAllDay)

      const events: CalendarEventOption[] = timedEvents.map((e: {
        id: string; title: string; start: string; end: string;
        attendees?: string[]; organizer?: string; conferenceUrl?: string; location?: string;
        provider?: string; seriesMasterId?: string; icalUid?: string;
        hasRecurrence?: boolean; source?: string;
      }) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        attendees: e.attendees || [],
        organizer: e.organizer || null,
        conference_url: e.conferenceUrl || null,
        location: e.location || null,
        calendar_provider: e.provider,
        series_master_id: e.seriesMasterId,
        ical_uid: e.icalUid,
        has_recurrence: e.hasRecurrence,
        source: e.source,
      }))
      const filtered = query.trim()
        ? events.filter((e) => e.title.toLowerCase().includes(query.toLowerCase()))
        : events

      // Sort: in-progress events first, then upcoming (soonest first), then past (most recent first)
      const now = Date.now()
      filtered.sort((a, b) => {
        const aStart = new Date(a.start).getTime()
        const bStart = new Date(b.start).getTime()
        const aEnd = new Date(a.end).getTime()
        const bEnd = new Date(b.end).getTime()
        const aInProgress = aStart <= now && aEnd > now
        const bInProgress = bStart <= now && bEnd > now
        const aUpcoming = aStart > now
        const bUpcoming = bStart > now

        // In-progress first
        if (aInProgress && !bInProgress) return -1
        if (!aInProgress && bInProgress) return 1
        if (aInProgress && bInProgress) return aStart - bStart

        // Upcoming second (soonest first)
        if (aUpcoming && !bUpcoming) return -1
        if (!aUpcoming && bUpcoming) return 1
        if (aUpcoming && bUpcoming) return aStart - bStart

        // Past events last (most recent first)
        return bStart - aStart
      })

      // Dedup by id+start (recurring events share the same id across instances)
      const seen = new Set<string>()
      const deduped = filtered.filter((e) => {
        const key = `${e.id}|${e.start}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      if (seq !== eventSearchSeqRef.current) return
      setEventSearchResults(deduped)
    } finally {
      if (seq === eventSearchSeqRef.current) setEventSearchLoading(false)
    }
  }

  async function handleLinkEvent(event: CalendarEventOption) {
    setEventSearchOpen(false)
    const prevTitle = linkedEventTitle
    const prevEventId = capture?.calendar_event_id ?? null
    setLinkedEventTitle(event.title)
    setCapture((prev) => prev ? { ...prev, calendar_event_id: event.id } : prev)
    const res = await fetch(`/api/account/captures/${captureId}/link-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendar_event_id: event.id,
        calendar_provider: event.calendar_provider,
        title: event.title,
        start: event.start,
        end: event.end,
        attendees: event.attendees,
        organizer: event.organizer,
        conference_url: event.conference_url,
        location: event.location,
        series_master_id: event.series_master_id,
        ical_uid: event.ical_uid,
        has_recurrence: event.has_recurrence,
        source: event.source,
      }),
    })
    if (!res.ok) {
      // Roll back the optimistic link — the server refused (e.g. another live
      // capture of the caller's already holds this event).
      setLinkedEventTitle(prevTitle)
      setCapture((prev) => (prev ? { ...prev, calendar_event_id: prevEventId } : prev))
      const data = await res.json().catch(() => null)
      toast.error('Could not link event', {
        description: data?.error || 'The event could not be linked to this capture.',
      })
      return
    }
    // Refresh participants + the series history after linking
    fetchLinkedParticipants()
    void fetchSeriesHistory()
    // The live HUD's meeting time (useCaptureSchedule) and brief re-read the
    // capture on this, as after the tray's re-link (tray-start-capture-handler).
    window.dispatchEvent(new CustomEvent('ni:content-edited', { detail: { entityId: captureId } }))
  }

  async function handleUnlinkEvent() {
    const prevTitle = linkedEventTitle
    const prevEventId = capture?.calendar_event_id ?? null
    setCapture((prev) => prev ? { ...prev, calendar_event_id: null } : prev)
    setLinkedEventTitle(null)
    const res = await fetch(`/api/account/captures/${captureId}/link-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendar_event_id: null }),
    }).catch(() => null)
    if (!res?.ok) {
      // Roll back the optimistic unlink — the server still links the event.
      setLinkedEventTitle(prevTitle)
      setCapture((prev) => (prev ? { ...prev, calendar_event_id: prevEventId } : prev))
      toast.error('Could not unlink event')
      return
    }
    window.dispatchEvent(new CustomEvent('ni:content-edited', { detail: { entityId: captureId } }))
  }

  async function toggleLabel(labelId: string, isAttached: boolean) {
    if (!capture) return
    if (labelToggleInFlight.current.has(labelId)) return
    labelToggleInFlight.current.add(labelId)

    // Optimistic update
    const currentLabels = capture.labels ?? []
    const updatedLabels = isAttached
      ? currentLabels.filter((l) => l.id !== labelId)
      : (() => {
          const label = allLabels.find((l) => l.id === labelId)
          return label ? [...currentLabels, label] : currentLabels
        })()
    setCapture((prev) => prev ? { ...prev, labels: updatedLabels } : prev)

    try {
      const res = isAttached
        ? await fetch(`/api/account/captures/${captureId}/labels/${labelId}`, {
            method: 'DELETE',
          })
        : await fetch(`/api/account/captures/${captureId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label_id: labelId }),
          })
      if (!res.ok) throw new Error(`label ${isAttached ? 'remove' : 'add'} failed: ${res.status}`)
      // Fan the new label set out to other surfaces + arm self-echo suppression
      // so the detail-sync refetch (fired by this tab's own realtime echo of the
      // capture row) can't revert the optimistic add/remove.
      emitEntityUpdated({ entityType: 'capture', id: captureId, fields: { labels: updatedLabels } })
    } catch {
      // Revert on a network failure or a rejected request
      setCapture((prev) => prev ? { ...prev, labels: capture.labels } : prev)
      toast.error('Could not update labels')
    } finally {
      labelToggleInFlight.current.delete(labelId)
    }
  }

  async function handleProjectChange(projectId: string | null) {
    const prevProjectId = capture?.project_id ?? null
    const prevProjectName = capture?.project_name ?? null
    setCapture((prev) => prev ? { ...prev, project_id: projectId, project_name: projects.find(p => p.id === projectId)?.name || null } : prev)
    const res = await fetch(`/api/account/captures/${captureId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    }).catch(() => null)
    if (!res?.ok) {
      setCapture((prev) => prev ? { ...prev, project_id: prevProjectId, project_name: prevProjectName } : prev)
      toast.error('Could not change project')
      return
    }
    const data = await res.json()
    mergeCaptureResponse(data.capture as CaptureDetail)
    // Fan the change out + arm self-echo suppression so the detail-sync refetch
    // can't clobber the optimistic project reassignment with this tab's echo.
    emitEntityUpdated({ entityType: 'capture', id: captureId, fields: { project_id: projectId } })
  }

  // Scope control. The PATCH itself (and the rollback on failure) lives in
  // CaptureVisibilityControl; this only mirrors the value into panel state,
  // the shared cache, and the list/board rows.
  function handleVisibilityChange(visibility: CaptureVisibility) {
    setCapture((prev) => {
      if (!prev) return prev
      const next = { ...prev, visibility }
      writeCaptureCache(captureId, next)
      return next
    })
    emitEntityUpdated({
      entityType: 'capture',
      id: captureId,
      fields: { visibility, user_id: currentUserId },
    })
  }

  async function handleDeleteCapture() {
    if (deletingCapture) return
    setDeletingCapture(true)
    const res = await fetch(
      `/api/account/captures/${captureId}?permanent=true`,
      { method: 'DELETE' },
    )
    if (res.ok) {
      setDeleteConfirm(false)
      onDeleted?.()
      onClose()
    }
    setDeletingCapture(false)
  }

  async function handleMoveCapture() {
    if (movingCapture || !moveTargetWorkspaceId) return
    setMovingCapture(true)
    setMoveError(null)
    // Note: the preflight fetch above is intentionally non-gating. If the
    // user clicks Move before the preflight resolves (or while it's failed),
    // the move proceeds anyway — no confirmed actions are selected yet, so
    // they stay behind (the safe default) and the disclosure comes from the
    // move response's counts in the success toast. The dialog's checklist is
    // a hint, not a contract.
    try {
      const res = await fetch(`/api/account/captures/${captureId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination_workspace_id: moveTargetWorkspaceId,
          confirmed_action_ids: [...moveActionIds],
          move_claims: moveClaims,
          move_contacts: moveContacts,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setMoveError(body?.error ?? `Move failed (${res.status})`)
        setMovingCapture(false)
        return
      }
      const body = (await res.json().catch(() => null)) as
        | {
            counts?: {
              unlinked_actions?: number
              moved_confirmed_actions?: number
              moved_claims?: number
              copied_contacts?: number
            }
          }
        | null
      const targetName =
        allWorkspaces.find((w) => w.id === moveTargetWorkspaceId)?.name ??
        'destination workspace'
      const counts = body?.counts
      const parts: string[] = []
      const movedActions = counts?.moved_confirmed_actions ?? 0
      const unlinked = counts?.unlinked_actions ?? 0
      const movedClaims = counts?.moved_claims ?? 0
      const copiedContacts = counts?.copied_contacts ?? 0
      if (movedActions > 0) {
        parts.push(`${movedActions} accepted ${movedActions === 1 ? 'action' : 'actions'} moved along`)
      }
      if (unlinked > 0) {
        parts.push(`${unlinked} accepted ${unlinked === 1 ? 'action stays' : 'actions stay'} behind`)
      }
      if (movedClaims > 0) {
        parts.push(`${movedClaims} knowledge ${movedClaims === 1 ? 'claim' : 'claims'} moved`)
      }
      if (copiedContacts > 0) {
        parts.push(`${copiedContacts} ${copiedContacts === 1 ? 'contact' : 'contacts'} copied over`)
      }
      if (parts.length > 0) {
        toast.success(`Capture moved to ${targetName}`, {
          description: `${parts.join('; ')}.`,
        })
      } else {
        toast.success(`Capture moved to ${targetName}`)
      }
      // Reset all dialog state before unmount. onClose() typically unmounts
      // this panel so the React updates after are no-ops, but if a parent
      // refactor keeps the component mounted these prevent stale-state bugs.
      setMovingCapture(false)
      setMoveOpen(false)
      setMoveTargetWorkspaceId(null)
      setMovePreflight(null)
      setMoveActionIds(new Set())
      setMoveClaims(true)
      setMoveContacts(true)
      // The capture no longer belongs to the active workspace. Notify the
      // parent so its list refreshes, then close (usually unmounts).
      onDeleted?.()
      onClose()
      return
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : 'Move failed')
      setMovingCapture(false)
    }
  }

  // Fetch move preflight silently when the dialog opens. The dialog renders
  // without waiting on this; if the response arrives and there's unlinked
  // work, an inline warning appears. No visible loading state — avoids the
  // layout-shift glitch when the warning suddenly appears.
  useEffect(() => {
    if (!moveOpen) return
    let cancelled = false
    setMovePreflight(null)
    setMoveActionIds(new Set())
    setMoveClaims(true)
    setMoveContacts(true)
    fetch(`/api/account/captures/${captureId}/move/preflight`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`preflight ${res.status}`)
        return res.json()
      })
      .then((data: MovePreflight) => {
        if (cancelled) return
        setMovePreflight(data)
        setMoveActionIds(
          new Set(
            (data.confirmed_actions ?? [])
              .filter((a) => !a.edited)
              .map((a) => a.id),
          ),
        )
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[move preflight] failed:', err)
        // Non-fatal — dialog still works, just without counts.
      })
    return () => {
      cancelled = true
    }
  }, [moveOpen, captureId])

  // ── File upload ──

  // The panel's element, as state: it isn't there while the capture loads (the
  // early returns below), and the drop listeners attach once it is.
  const [captureEl, setCaptureEl] = useState<HTMLDivElement | null>(null)

  const [uploadError, setUploadError] = useState<string | null>(null)

  const handleFileUpload = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    let result: Awaited<ReturnType<typeof uploadAttachments>>
    try {
      result = await uploadAttachments(files, { noteId: captureId })
    } finally {
      setUploading(false)
    }
    if (result.uploaded > 0) announceCaptureAttachments(captureId)
    if (result.firstError) {
      setUploadError(result.firstError)
      setTimeout(() => setUploadError(null), 5000)
    }
  }, [captureId])

  // Files attached to this capture from elsewhere (the app's live-capture drop,
  // the agent HUD, this panel itself): show them.
  useEffect(() => {
    const onChanged = (e: Event) => {
      if (readAttachmentsCaptureId((e as CustomEvent).detail) === captureId) setAttachmentRefreshKey((k) => k + 1)
    }
    window.addEventListener(CAPTURE_ATTACHMENTS_EVENT, onChanged)
    return () => window.removeEventListener(CAPTURE_ATTACHMENTS_EVENT, onChanged)
  }, [captureId])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      handleFileUpload(Array.from(e.target.files))
      e.target.value = ''
    }
  }, [handleFileUpload])

  // The page's own file picker, in the desktop too (as the chat box's): it
  // hands over the files themselves. The desktop's native dialog handed back
  // paths, each read back through the asset protocol: one more step to fail.
  const handleAddAttachment = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Drag-and-drop and paste-to-attach, scoped to the panel element so that
  // when multiple CaptureDetailPanel instances are mounted (e.g. persistent
  // recording panel + another capture open) drops only attach to the visible
  // one, and pasting elsewhere on the page never attaches here.
  useElementFileDrop(captureEl, handleFileUpload, setIsDragging)
  // Its properties (Attachments among them) show outside the panel: a zone too.
  const [propsEl, setPropsEl] = useState<HTMLDivElement | null>(null)
  const [propsDragging, setPropsDragging] = useState(false)
  useElementFileDrop(propsEl, handleFileUpload, setPropsDragging, { paste: false })

  // NOTE: the live transcript array is NOT read here anymore. It updates ~6-7×/s
  // during a recording, and reading it in this ~3.3k-line panel re-rendered the
  // whole thing on every flush (the dominant remaining typing-lag source). It's
  // now consumed at the LEAVES — <LiveVoiceIdRow> and <LiveTranscriptsPill>
  // below subscribe to it via useTranscriptSegments() (useSyncExternalStore), so
  // only those small subtrees repaint per flush. The panel's merge logic moved
  // into them too (useCaptureTranscript).

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!capture) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Capture not found</div>
      </div>
    )
  }

  const dateStr = capture.started_at || capture.recorded_at || capture.created_at
  const summaryFallback = capture.summary || capture.content || ''
  // ai_summary === '' is a deliberate clear (the user deleted the body) — do NOT
  // resurrect the fallback text, or the editor reloads it right after the empty
  // save round-trips. Only a never-written summary (null) falls back.
  const summaryText = capture.ai_summary === '{{streaming}}'
    ? summaryFallback
    : (capture.ai_summary ?? summaryFallback)
  // Seed the editor watermark at the render where the editor first mounts for
  // this capture (keyed per captureId — initialContent applies exactly once):
  // record the ai_summary its initial document reflects. Null both for a
  // never-written summary (the editor shows the non-ai fallback) and for the
  // '{{streaming}}' sentinel (same fallback; the real text must still push
  // when it lands). Render-synced ref write, idempotent — matches the
  // captureStateRef pattern above. Later renders must NOT re-stamp: state can
  // move ahead of the editor via non-pushing refetches, and tracking state
  // here would recreate the suppression bug the watermark exists to fix.
  if (editorSeededForRef.current !== captureId) {
    editorSeededForRef.current = captureId
    lastEditorSummaryRef.current =
      capture.ai_summary === '{{streaming}}' ? null : (capture.ai_summary ?? null)
  }
  const participants = (capture.participants || []) as MeetingParticipant[]
  const hasTranscript = !!capture.transcript

  // Counts for follow-up dialog
  const confirmedActionCount = 0
  const confirmedDecisionCount = (capture.decision_count || 0) - (capture.suggested_decision_count || 0)
  const participantEmails = participants
    .map((p) => p.email)
    .filter((e): e is string => !!e)

  return (
    <div
      ref={setCaptureEl}
      data-testid="capture-detail"
      data-capture-id={captureId}
      data-file-drop-zone=""
      className="relative flex h-full flex-col"
    >
      {/* Listen mode: who and when, then its notes' own summary, as it opens. */}
      <ListenBrief
        kind="capture"
        id={captureId}
        fallback={() => {
          const c = captureStateRef.current
          const people = namesLine(((c?.participants || []) as MeetingParticipant[]).map((p) => p.name))
          return plainLine(c?.title, people && `with ${people}`)
        }}
      />

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 backdrop-blur-sm">
          <div className="text-center">
            <Paperclip className="mx-auto h-8 w-8 text-primary/60" />
            <p className="mt-2 text-sm font-medium text-primary/80">Drop files to attach</p>
          </div>
        </div>
      )}

      {/* Upload error toast */}
      {uploadError && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive shadow-sm">
            <X className="h-3.5 w-3.5 shrink-0" />
            <span>{uploadError}</span>
          </div>
        </div>
      )}

      {/* Upload progress indicator */}
      {uploading && (
        <div className="absolute inset-x-0 top-0 z-50">
          <div className="h-0.5 w-full overflow-hidden bg-primary/10">
            <div className="h-full w-1/3 animate-pulse bg-primary/50" style={{ animation: 'indeterminate 1.5s infinite linear' }} />
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 px-5">
        <div className="flex shrink-0 items-center gap-1">
          {CAPTURE_SECTIONS.filter((tab) => tab !== 'live-chat' || liveChatConversationId).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveSection(tab)}
              className={cn(
                'inline-flex shrink-0 items-center px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
                activeSection === tab
                  ? 'bg-foreground text-background border-foreground font-medium'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
              )}
            >
              {CAPTURE_SECTION_LABELS[tab]}
            </button>
          ))}
        </div>
        <WindowActions className="ml-auto flex items-center gap-1">
          {/* Visibility is creator-only and only offered in shared workspaces. */}
          {canOfferVisibilityControl(
            capture.user_id,
            capture.visibility ?? 'workspace',
            currentUserId,
            workspaceMemberCount,
          ) && (
            <CaptureVisibilityControl
              captureId={captureId}
              visibility={capture.visibility ?? 'workspace'}
              onVisibilityChange={handleVisibilityChange}
            />
          )}
          {/* Capture history — the recurring meeting's other sessions. Same pill
                  family as the visibility control beside it. Hidden when the series
                  has no other sessions; the list is visibility-filtered server-side
                  (own + workspace-shared, never a teammate's private capture). */}
          {seriesSessions.length > 1 && (
            <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
              <PopoverTrigger asChild>
                <PreferenceActionButton
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-transparent px-3 text-xs shadow-sm transition-colors hover:bg-muted/50 dark:shadow-none"
                  title="Previous sessions of this recurring meeting"
                  aria-label="Capture history"
                >
                  <History className="h-3 w-3 shrink-0" />
                  <span>Capture history</span>
                  <span className="text-muted-foreground">
                    {seriesSessions.filter((c) => c.id !== captureId).length}
                  </span>
                </PreferenceActionButton>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-1" align="start">
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Capture history
                </p>
                <div className="max-h-72 overflow-y-auto">
                  {seriesSessions.map((c) => {
                    const isCurrent = c.id === captureId
                    const when = new Date(c.occurrence_start)
                    return (
                      <button
                        key={c.id}
                        disabled={isCurrent}
                        onClick={(e) => {
                          if (isCurrent) return
                          setHistoryOpen(false)
                          onOpenEntity?.('capture', c.id, c.title, e)
                        }}
                        className={cn(
                          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                          isCurrent
                            ? 'cursor-default text-foreground/50'
                            : 'text-foreground/80 hover:bg-muted/50',
                        )}
                      >
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-left">{c.title}</span>
                        {isCurrent ? (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                            current
                          </span>
                        ) : !c.is_own && c.owner_name ? (
                          <span
                            className="max-w-[90px] shrink-0 truncate text-[10px] text-muted-foreground"
                            title={`Captured by ${c.owner_name}`}
                          >
                            {c.owner_name}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {/* Resume — restart capture for this row (mic-only on web). Lives at
                      the top next to Reprocess now (moved out of the live-agent panel).
                      Styled like the Share button. Hidden during an active recording. */}
          {!isActiveRecording && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PreferenceActionButton
                    label="Resume recording"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => recording.resumeCapture(captureId)}
                    disabled={recording.isRecording || isExtracting}
                    aria-label="Resume recording"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </PreferenceActionButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {recording.isRecording ? 'Already recording another capture' : 'Resume recording'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {/* Reprocess — re-extract everything from the full transcript (same
                      pipeline). Keeps action items you've already accepted; the summary,
                      decisions, and pending items are rewritten. Styled like the Share
                      button (ghost, text+icon), but turns RED on hover to warn it's
                      destructive. Hidden during an active recording. */}
          {!isActiveRecording && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PreferenceActionButton
                    label="Reprocess capture"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    onClick={handleReprocess}
                    disabled={isExtracting || recording.isRecording}
                    aria-label="Reprocess"
                  >
                    {isExtracting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5" />
                    )}
                  </PreferenceActionButton>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[260px]">
                  Reprocess — re-extract from the full transcript. Keeps action items you&apos;ve already
                  accepted; everything else (summary, decisions, pending items) is rewritten.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {/* Draft Follow-Up — only after AI processing, when there's something
                      confirmed to summarise. Styled like the Share button. */}
          {capture.ai_processed && (confirmedActionCount > 0 || confirmedDecisionCount > 0) && (
            // Tooltip wraps the dialog so both Radix Slots (DialogTrigger +
            // TooltipTrigger) converge on the single Button child. The dialog's
            // DialogTrigger renders `asChild`, so its direct child must itself be
            // a Slot (TooltipTrigger), NOT a Context provider.
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <DraftFollowUpDialog
                  captureId={captureId}
                  captureTitle={capture.title}
                  participantEmails={participantEmails}
                  confirmedActionCount={confirmedActionCount}
                  confirmedDecisionCount={confirmedDecisionCount}
                >
                  <TooltipTrigger asChild>
                    <PreferenceActionButton
                      label="Draft follow-up email"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      aria-label="Draft follow-up email"
                    >
                      <Mail className="h-3.5 w-3.5" />
                    </PreferenceActionButton>
                  </TooltipTrigger>
                </DraftFollowUpDialog>
                <TooltipContent side="bottom">Draft follow-up email</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <CopyIdButton entityType="capture" id={captureId} />
          <CopyTranscriptButton
            isActiveRecording={isActiveRecording}
            liveIsThisCapture={holdsLiveSegments}
            resumedPriorTranscript={resumedPriorTranscript}
            persistedTranscript={capture?.transcript ?? null}
            speakerNames={recording.speakerNames}
            demotedSelfLabels={recording.selfDemotedLabels}
          />
          <ShareDialog shareableType="capture" shareableId={captureId} />
          {currentWorkspaceId && allWorkspaces.length > 1 && (
            <PreferenceActionButton
              label="Move capture to another workspace"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setMoveError(null)
                setMoveTargetWorkspaceId(null)
                setMoveOpen(true)
              }}
              title="Move to workspace…"
              aria-label="Move capture to another workspace"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          )}
          <PreferenceActionButton
            label="Delete capture"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => setDeleteConfirm(true)}
            title="Delete capture"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </WindowActions>
      </div>

      {/* The body is gated ONLY on `capture` (the early returns above). The
          identity comes synchronously from the workspace cache and comments
          hydrate into the provider when their fetch lands — neither ever
          blanks the body (the old commentIdentity gate held first paint
          hostage to a workspace fetch, forever if it failed). */}
      <InlineCommentProvider
        initialComments={inlineComments}
        identity={commentIdentity}
        api={commentApi}
      >
          <div ref={panelBodyRef} className={cn('flex flex-1 min-h-0 justify-center', activeSection !== 'overview' && 'hidden')}>
            {/* Main content area */}
            <div ref={editorContainerRef} className="w-full max-w-[736px] min-w-0 mx-auto">
              <ScrollArea className="h-full">
                <div className="px-8 pb-28">
                <AnnotatedContent section="capture">
                  <div className="space-y-8">
                    {/* Title + metadata */}
                    <div className="pt-6 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        {editingTitle ? (
                          <EntityTitleInput
                            inputRef={titleInputRef}
                            value={titleDraft}
                            onChange={setTitleDraft}
                            onCommit={() => saveTitle()}
                            onCancel={() => setEditingTitle(false)}
                            className="min-w-0 flex-1 text-2xl"
                          />
                        ) : (
                          <h1
                            className="min-w-0 flex-1 text-2xl font-semibold leading-snug cursor-pointer hover:text-muted-foreground transition-colors"
                            title="Click to rename"
                            onClick={startEditingTitle}
                          >
                            {capture.title}
                          </h1>
                        )}
                        {/* Capture actions are available from the window preferences. */}
                      </div>
                    </div>

                    {/* Content area — proposals render inline as atom nodes.
                        readOnly during ANY stream (batch or live) so a manual save
                        can't persist the in-progress PREVIEW text as the canonical
                        summary — the canonical copy is always the server's tool
                        write, reconciled via Realtime. The visible "AI is writing"
                        activity indicator (driven by aiWritingLabel) is batch-only,
                        so an active meeting doesn't flicker a banner each pause. */}
                    <ProposalNodeProvider value={proposalNodeCtx}>
                      <CommentableEditor
                        section="capture"
                        key={`capture-${captureId}`}
                        initialContent={summaryText}
                        onUpdate={handleSummaryChange}
                        externalContent={externalEditorContent}
                        externalContentSink={editorSinkRef}
                        onSelectionChange={handleEditorSelectionChange}
                        noteAttributions={capture.note_attributions || undefined}
                        activeAttributionId={activeAttributionId}
                        onAttributionClick={setActiveAttributionId}
                        onEditorReady={(editor: any) => { attributionEditorRef.current = editor }}
                        autoFocus={isActiveRecording}
                        readOnly={streaming.isStreaming}
                        isAIWriting={streaming.isStreaming && streamingMode === 'batch'}
                        aiWritingLabel={toolLabel(streaming.activeTool)}
                        extraExtensions={proposalExtensions}
                        proposalRefs={proposalRefs}
                      />
                    </ProposalNodeProvider>


                    {/* Tags */}
                    {capture.tags && capture.tags.length > 0 && (
                      <>
                        <Separator />
                        <div className="flex flex-wrap gap-1.5">
                          {capture.tags.map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </>
                    )}

                  </div>
                </AnnotatedContent>
                </div>
              </ScrollArea>
            </div>

              {/* Sidebar — properties + comments */}
              <WindowProperties key={captureId} title={capture.title || 'Capture'} fallbackVisible={sidebarOpen}>
                      {(
                      <div
                        // Shown outside the panel (the card's properties
                        // popover or column): its own drop zone, so a file
                        // dropped on Attachments lands on this capture.
                        ref={setPropsEl}
                        data-file-drop-zone=""
                        className="relative p-4 space-y-4 overflow-hidden"
                      >
                        {propsDragging && (
                          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-primary/5">
                            <p className="flex items-center gap-2 text-sm font-medium text-primary/80">
                              <Paperclip className="h-4 w-4" />
                              Drop files to attach
                            </p>
                          </div>
                        )}
                        {/* Properties group */}
                        <div className="rounded-lg overflow-hidden">
                          <div data-properties-heading="" className="px-3 py-2 text-sm font-medium text-muted-foreground">Properties</div>
                          <div className="overflow-hidden pb-2">
                            {/* Date */}
                            <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
                              <Clock className="h-4 w-4 shrink-0" />
                              <span>{formatDate(dateStr)}</span>
                            </div>

                            {/* Duration */}
                            {capture.duration_seconds && capture.duration_seconds > 0 && (
                              <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
                                <Video className="h-4 w-4 shrink-0" />
                                <span>{formatDuration(capture.duration_seconds)}</span>
                              </div>
                            )}

                            {/* Project */}
                            <ProjectPanelField
                              value={capture.project_id}
                              projects={projectOptions}
                              onChange={(projectId) => handleProjectChange(projectId)}
                              placeholder="Set project"
                              padding="px-3"
                              onOpen={onOpenEntity && ((id, name, e) => onOpenEntity('project', id, name, e))}
                            />

                            {/* Event link */}
                            <Popover open={eventSearchOpen} onOpenChange={(open) => {
                              setEventSearchOpen(open)
                              if (open) {
                                setEventSearchQuery('')
                                searchCalendarEvents('', eventDateRange.from, eventDateRange.to)
                              }
                            }}>
                              <PopoverTrigger asChild>
                                <button className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors hover:bg-muted/50 overflow-hidden">
                                  <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                                  {capture.calendar_event_id ? (
                                    <span className="min-w-0 truncate text-left text-foreground/80">{linkedEventTitle || 'Linked event'}</span>
                                  ) : (
                                    <span className="text-muted-foreground">Link event</span>
                                  )}
                                  {capture.calendar_event_id && (
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-muted hover:text-foreground cursor-pointer"
                                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleUnlinkEvent() }}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); handleUnlinkEvent() } }}
                                      title="Unlink event"
                                    >
                                      <Link2Off className="h-3.5 w-3.5" />
                                    </span>
                                  )}
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-80 p-0" align="start" side="left">
                                <div className="border-b p-2">
                                  <div className="relative">
                                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                                    <Input
                                      className="h-8 pl-8 text-sm"
                                      placeholder="Search events…"
                                      value={eventSearchQuery}
                                      onChange={(e) => {
                                        setEventSearchQuery(e.target.value)
                                        searchCalendarEvents(e.target.value, eventDateRange.from, eventDateRange.to)
                                      }}
                                      autoFocus
                                    />
                                  </div>
                                  <div className="mt-1.5 flex items-center gap-1">
                                    <span className="text-[11px] text-muted-foreground">Range:</span>
                                    <input
                                      type="date"
                                      className="h-6 rounded border border-input bg-transparent px-1.5 text-[11px] text-muted-foreground"
                                      value={format(new Date(eventDateRange.from), 'yyyy-MM-dd')}
                                      onChange={(e) => {
                                        // Cleared input → '' (Invalid Date). The
                                        // range is LOCAL midnights: show and read
                                        // local dates, not the ISO string's UTC day.
                                        if (!e.target.value) return
                                        const from = parseISO(e.target.value).toISOString()
                                        setEventDateRange((prev) => ({ ...prev, from }))
                                        searchCalendarEvents(eventSearchQuery, from, eventDateRange.to)
                                      }}
                                    />
                                    <span className="text-[11px] text-muted-foreground">–</span>
                                    <input
                                      type="date"
                                      className="h-6 rounded border border-input bg-transparent px-1.5 text-[11px] text-muted-foreground"
                                      value={format(new Date(eventDateRange.to), 'yyyy-MM-dd')}
                                      onChange={(e) => {
                                        if (!e.target.value) return
                                        const to = parseISO(e.target.value).toISOString()
                                        setEventDateRange((prev) => ({ ...prev, to }))
                                        searchCalendarEvents(eventSearchQuery, eventDateRange.from, to)
                                      }}
                                    />
                                  </div>
                                </div>
                                <ScrollArea className="max-h-64">
                                  {eventSearchLoading ? (
                                    <div className="flex items-center justify-center py-6">
                                      <ThinkingOrb state="working" size={20} theme="auto" />
                                    </div>
                                  ) : eventSearchResults.length === 0 ? (
                                    <p className="py-6 text-center text-xs text-muted-foreground">No events found</p>
                                  ) : (
                                    <div className="py-1">
                                      {eventSearchResults.map((event) => {
                                        const start = new Date(event.start)
                                        const isLinked = capture.calendar_event_id === event.id
                                        return (
                                          <button
                                            key={`${event.id}|${event.start}`}
                                            className={cn(
                                              'flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50',
                                              isLinked && 'bg-muted/30',
                                            )}
                                            onClick={() => handleLinkEvent(event)}
                                          >
                                            <Calendar className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                            <div className="min-w-0 flex-1">
                                              <div className="flex items-center gap-1">
                                                <span className="min-w-0 flex-1 truncate font-medium">{event.title}</span>
                                                {isLinked && <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />}
                                              </div>
                                              <p className="text-[11px] text-muted-foreground">
                                                {start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                                                {' · '}
                                                {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                                              </p>
                                            </div>
                                          </button>
                                        )
                                      })}
                                    </div>
                                  )}
                                </ScrollArea>
                              </PopoverContent>
                            </Popover>

                            {/* Participants */}
                            <div>
                              <div className="flex items-center">
                                <button
                                  onClick={() => setParticipantsExpanded(!participantsExpanded)}
                                  className="flex h-8 flex-1 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                                >
                                  <Users className="h-4 w-4 shrink-0" />
                                  <span>{linkedParticipants.length || participants.length} {(linkedParticipants.length || participants.length) === 1 ? 'participant' : 'participants'}</span>
                                  {participantsExpanded ? <ChevronDown className="ml-auto h-3 w-3" /> : <ChevronRight className="ml-auto h-3 w-3" />}
                                </button>
                                <Popover open={addParticipantOpen} onOpenChange={(open) => {
                                  setAddParticipantOpen(open)
                                  if (open) {
                                    // Load a few recent contacts immediately
                                    searchContacts('')
                                  } else {
                                    setContactSearchQuery('')
                                    setContactSearchResults([])
                                  }
                                }}>
                                  <PopoverTrigger asChild>
                                    <button
                                      className="mr-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
                                      title="Add participant"
                                    >
                                      <UserPlus className="h-3.5 w-3.5" />
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-72 p-0" align="end" side="bottom">
                                    <div className="p-2">
                                      <div className="relative">
                                        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                          placeholder="Search contacts..."
                                          value={contactSearchQuery}
                                          onChange={(e) => {
                                            const q = e.target.value
                                            setContactSearchQuery(q)
                                            if (contactSearchTimeoutRef.current) clearTimeout(contactSearchTimeoutRef.current)
                                            contactSearchTimeoutRef.current = setTimeout(() => searchContacts(q), 250)
                                          }}
                                          className="h-8 pl-7 text-xs"
                                          autoFocus
                                        />
                                      </div>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto">
                                      {contactSearchLoading ? (
                                        <div className="flex items-center justify-center py-4">
                                          <ThinkingOrb state="working" size={20} theme="auto" />
                                        </div>
                                      ) : contactSearchResults.length > 0 ? (
                                        <div className="space-y-0.5 p-1">
                                          {contactSearchResults.map((c) => {
                                            const initials = c.full_name
                                              .split(' ')
                                              .map((w) => w[0])
                                              .join('')
                                              .toUpperCase()
                                              .slice(0, 2)
                                            return (
                                              <button
                                                key={c.id}
                                                disabled={addingParticipant === c.id}
                                                onClick={() => handleAddParticipant(c)}
                                                className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                                              >
                                                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                                                  {addingParticipant === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : initials}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                  <p className="truncate text-xs font-medium text-foreground/80">{c.full_name}</p>
                                                  {(c.email || c.company?.name) && (
                                                    <p className="truncate text-[11px] text-muted-foreground/60">
                                                      {[c.email, c.company?.name].filter(Boolean).join(' · ')}
                                                    </p>
                                                  )}
                                                </div>
                                                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                                              </button>
                                            )
                                          })}
                                        </div>
                                      ) : contactSearchQuery.trim() ? (
                                        <p className="px-3 py-4 text-center text-xs text-muted-foreground">No contacts found</p>
                                      ) : (
                                        <p className="px-3 py-4 text-center text-xs text-muted-foreground">No contacts found</p>
                                      )}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </div>
                              {participantsExpanded && (
                                <div className="max-h-48 overflow-y-auto space-y-0.5 px-2 pb-2">
                                  {linkedParticipants.length > 0
                                    ? linkedParticipants.map((p) => {
                                        const displayName = p.name || p.email || 'Unknown'
                                        const initials = displayName
                                          .split(' ')
                                          .map((w) => w[0])
                                          .join('')
                                          .toUpperCase()
                                          .slice(0, 2)
                                        const hasContact = !!p.contact_id && !!onOpenContact
                                        const isManual = p.source === 'manual'
                                        return (
                                          <div
                                            key={p.id}
                                            className={cn(
                                              'group flex items-center gap-2.5 rounded-md px-2 py-1.5',
                                              hasContact
                                                ? 'cursor-pointer transition-colors hover:bg-muted/50'
                                                : '',
                                            )}
                                            onClick={hasContact ? (e: React.MouseEvent) => onOpenContact!(p.contact_id!, p.contact_name || displayName, e) : undefined}
                                          >
                                            {p.avatar_url ? (
                                              <img
                                                src={p.avatar_url}
                                                alt={displayName}
                                                className="h-6 w-6 shrink-0 rounded-full object-cover"
                                              />
                                            ) : (
                                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                                                {initials}
                                              </div>
                                            )}
                                            <div className="min-w-0 flex-1">
                                              <div className="flex items-center gap-1">
                                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80">
                                                  {displayName}
                                                </span>
                                                {p.role === 'organizer' && (
                                                  <span className="shrink-0 text-[10px] text-muted-foreground/50">(organizer)</span>
                                                )}
                                                {isManual && (
                                                  <span className="shrink-0 text-[10px] text-muted-foreground/50">(added)</span>
                                                )}
                                              </div>
                                              {(p.job_title || p.company) && (
                                                <p className="truncate text-[11px] text-muted-foreground/60">
                                                  {[p.job_title, p.company].filter(Boolean).join(' · ')}
                                                </p>
                                              )}
                                            </div>
                                            {hasContact && !removingParticipant && (
                                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground/60" />
                                            )}
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                handleRemoveParticipant(p.id)
                                              }}
                                              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:flex"
                                              title="Remove participant"
                                            >
                                              {removingParticipant === p.id ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                              ) : (
                                                <X className="h-3 w-3" />
                                              )}
                                            </button>
                                          </div>
                                        )
                                      })
                                    : participants.map((p, i) => {
                                        const displayName = p.name || p.email || 'Unknown'
                                        const initials = displayName
                                          .split(' ')
                                          .map((w) => w[0])
                                          .join('')
                                          .toUpperCase()
                                          .slice(0, 2)
                                        return (
                                          <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                                              {initials}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <div className="flex items-center gap-1">
                                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80">
                                                  {displayName}
                                                </span>
                                                {p.isOrganizer && (
                                                  <span className="shrink-0 text-[10px] text-muted-foreground/50">(organizer)</span>
                                                )}
                                              </div>
                                              {(p.jobTitle || p.company) && (
                                                <p className="truncate text-[11px] text-muted-foreground/60">
                                                  {[p.jobTitle, p.company].filter(Boolean).join(' · ')}
                                                </p>
                                              )}
                                            </div>
                                          </div>
                                        )
                                      })}
                                </div>
                              )}
                            </div>

                            {/* Labels — part of Properties rather than its own group */}
                            {(capture.labels?.length ?? 0) > 0 && (
                              <div className="space-y-1 px-3 py-1">
                                {(capture.labels ?? []).map((l) => (
                                  <div key={l.id} className="flex items-center gap-2 text-sm">
                                    <span
                                      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                                      style={{ backgroundColor: l.color }}
                                    />
                                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                                    <button
                                      onClick={() => toggleLabel(l.id, true)}
                                      className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                                      aria-label={`Remove label ${l.name}`}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <Popover>
                              <PopoverTrigger asChild>
                                <button className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
                                  <Tag className="h-4 w-4 shrink-0" />
                                  <span>Add label</span>
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-56 p-2" align="start">
                                <LabelPickerContent
                                  grouped={scopedLabelsGrouped}
                                  selectedIds={(capture.labels ?? []).map((l) => l.id)}
                                  onToggle={(id, isAttached) => toggleLabel(id, isAttached)}
                                />
                              </PopoverContent>
                            </Popover>

                            {/* Attachments — a property row, like Participants */}
                            <AttachmentsCarousel
                              variant="row"
                              padding="px-3"
                              captureId={captureId}
                              refreshKey={attachmentRefreshKey}
                              onAddClick={handleAddAttachment}
                              uploading={uploading}
                            />

                            {/* Activity — a property row rather than its own card */}
                            <ActivityRow
                              createdAt={capture.created_at}
                              updatedAt={capture.updated_at}
                              formatRelativeTime={formatRelativeTime}
                              padding="px-3"
                            />
                          </div>
                        </div>

                        {/* Transcription connection warning — shown during active recording when Deepgram is unstable */}
                        {isActiveRecording && recording.transcriptionStatus !== 'connected' && (
                          <div className={cn(
                            'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                            recording.transcriptionStatus === 'disconnected'
                              ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
                              : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
                          )}>
                            <div className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              recording.transcriptionStatus === 'disconnected'
                                ? 'bg-red-500'
                                : 'bg-yellow-500 animate-pulse',
                            )} />
                            {recording.transcriptionStatus === 'disconnected'
                              ? 'Transcription disconnected — audio recording continues. Reconnecting when network recovers.'
                              : 'Transcription reconnecting — audio recording continues.'}
                          </div>
                        )}

                        {/* Attachment picker — opened by the Attachments row in Properties */}
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept={ATTACHMENT_ACCEPT_ATTR}
                          className="hidden"
                          onChange={handleFileInputChange}
                        />

                        {/* Tags group */}
                        {capture.tags && capture.tags.length > 0 && (
                          <div className="rounded-lg">
                            <div className="px-3 py-2 text-sm font-medium text-muted-foreground">Tags</div>
                            <div className="flex flex-wrap gap-1 px-3 pb-3">
                              {capture.tags.map((tag) => (
                                <Badge key={tag} variant="outline" className="text-xs">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Inline comment popover is rendered at root level */}
                      </div>
                      )}



                    </WindowProperties>
          </div>

          {/* The capture's controls, at the foot of its card (one-chat
              Slice 3; see CaptureControlsBar): the live agent picker, the
              Packages chip, Transcripts and Tools, and Voice ID
              above them. Built OUTSIDE the sidebar on purpose: they remain
              available when properties are closed. They used to portal into
              the chat composer; the composer is the main agent's now. While a
              live capture records, Voice ID is in the live agent's HUD
              instead. After the recording only Transcripts remains of the
              pills — Tools would open onto nothing (LiveCapturePills).
              Background-processing state lives on the Reprocess button in the
              top toolbar; Pause/Stop and the elapsed timer live in the live
              agent's HUD header while it's up, else the top bar's Capture
              button (lib/live-agent/hud-recording.ts). Overview only: the other sections have their own foot. */}
          <CaptureControlsBar
            className={cn(activeSection !== 'overview' && 'hidden')}
            voiceId={
              // Voice ID — the speakers heard so far, centred above the top
              // row; a carousel with arrows once they overflow. The detected
              // speakers and who's talking are read INSIDE this leaf from the
              // ref-backed stores — never passed down — so a speech-cadence
              // update never re-renders the panel. Not while it's in the HUD.
              voiceIdInHud && isActiveRecording ? null : <LiveVoiceIdRow
                className="mx-auto max-w-[85%]"
                speakerNames={recording.speakerNames}
                demotedSelfLabels={recording.selfDemotedLabels}
                speakerContacts={recording.speakerContacts}
                assignContact={recording.assignContact}
                acceptSuggestion={recording.acceptSuggestion}
                dismissSuggestion={recording.dismissSuggestion}
                unlinkSpeaker={recording.unlinkSpeaker}
                postSessionReview={recording.postSessionReview}
                confirmPostSessionSpeaker={recording.confirmPostSessionSpeaker}
                reassignPostSessionSpeaker={recording.reassignPostSessionSpeaker}
                selfSuggestion={recording.selfSuggestion}
                confirmSelf={recording.confirmSelf}
                dismissSelf={recording.dismissSelf}
                isActiveRecording={isActiveRecording}
                resumedPriorTranscript={resumedPriorTranscript}
                persistedTranscript={capture?.transcript ?? null}
                holdsLiveSegments={holdsLiveSegments}
              />
            }
            controls={
              <>
                {/* Left: the agent and how it runs. Shrinks (the agent's name
                    truncates) before it crowds Transcripts, Tools and
                    Capture; clipped sideways only, so focus rings still show
                    above and below. */}
                <div className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-clip pl-1">
                    {/* Agent selector. A null agentId = the built-in
                       "Assistant" (general-purpose default, resolved
                       server-side). Shown both while recording (drives
                       the live agent) and after it stops (drives which
                       agent Reprocess runs). Outline pill with the
                       status dot tucked inside. */}
                    <Select
                      value={recording.agentId || ASSISTANT_SENTINEL}
                      onValueChange={(v) =>
                        recording.setAgentId(v === ASSISTANT_SENTINEL ? null : v)
                      }
                      // Locked to the live persona (the Interactive
                      // Assistant or the edition's) while a capture
                      // records. The trigger is disabled so the only
                      // option is the one already selected.
                      disabled={liveLocked && !!liveLockAgent}
                    >
                      {/* Dot + label live inside ONE wrapper span. The
                          SelectTrigger base applies [&>span]:line-clamp-1
                          to DIRECT child spans, which collapses a bare dot
                          span to nothing — nesting it one level down keeps
                          the dot visible (this is why the status dot kept
                          disappearing). */}
                      <SelectTrigger
                        // Locked = no chevron (it's not interactive)
                        // and the trigger can shrink so the long
                        // "Interactive Assistant" label ellipses instead
                        // of starving the Packages chip.
                        hideChevron={liveLocked && !!liveLockAgent}
                        // A pill like the rest of the composer's row — "All
                        // skills", Transcripts, Tools, Capture: 36px, the
                        // app's own background, the hairline ring and small
                        // shadow; `-my-0.5` overhangs the row's py-0.5 so the
                        // row stays 36px. Open, it reads pressed, as "All
                        // skills" does.
                        className="-my-0.5 h-9 min-w-0 w-auto justify-start gap-1.5 rounded-full border border-border bg-background px-3 text-[12px] text-sidebar-foreground/70 shadow-sm hover:bg-muted hover:text-sidebar-foreground data-[state=open]:border-foreground/15 data-[state=open]:bg-muted data-[state=open]:text-foreground disabled:opacity-100 disabled:cursor-default dark:shadow-none"
                      >
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          {isActiveRecording && (
                            <LiveAgentStatusDot isPaused={recording.isPaused} />
                          )}
                          <span className="truncate">
                            {agents.find(r => r.id === recording.agentId)?.name || 'Assistant'}
                          </span>
                          {/* Suffix so it reads "<Name> agent". Dropped
                              when locked to live — "Interactive Assistant"
                              alone is clear and saves width — and on a
                              narrow window. */}
                          {!(liveLocked && liveLockAgent) && (
                            <span className="shrink-0 text-muted-foreground max-sm:hidden">&nbsp;agent</span>
                          )}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {liveLocked && liveLockAgent ? (
                          // Live mode: the Interactive Assistant is the
                          // only choice (the trigger is also disabled).
                          <SelectItem value={liveLockAgent.id}>
                            {liveLockAgent.name}
                          </SelectItem>
                        ) : (
                          <>
                            <SelectItem value={ASSISTANT_SENTINEL}>Assistant</SelectItem>
                            {agents.map((recipe) => (
                              <SelectItem key={recipe.id} value={recipe.id}>
                                {recipe.name}
                              </SelectItem>
                            ))}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    {/* ASSIST-ONLY agents write nothing during the call —
                        they help the user in the moment, and a PAIRED
                        note-taker (the edition's post-call agent) writes
                        the notes live beside them, then finalizes them
                        when the call ends. Without a word here, the picker
                        reads as one agent doing two jobs. Only when it's
                        true: an ⓘ beside the agent it explains. */}
                    {liveAgentAssistOnly && (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="flex h-7 w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                              aria-label="Real-time help only — how this agent works during the call"
                            >
                              <Info className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs">
                            Real-time help only — {liveNotesAgentName ?? 'a paired note-taker'} takes the notes live and finalizes them when the call ends.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {/* "+ Packages" — attach context packages to this
                        call. The live agent is primed to pull them via
                        get_package. Works on every platform but LIVE
                        MODE ONLY: the
                        batch path just extracts action items after the
                        fact — packages exist to guide the call in real
                        time, so without the live agent there is
                        nothing for them to do. Every capture is live,
                        so: shown before and during the call, not on a
                        capture that has ended (resuming one shows it
                        again). */}
                    {recording.liveModeEnabled && (isActiveRecording || !capture?.ended_at) && (
                    <Popover
                      onOpenChange={(open) => {
                        if (open) void fetchAttachablePackages()
                      }}
                    >
                      <PopoverTrigger asChild>
                        <button
                          className={cn(
                            'flex h-7 min-w-7 max-w-[110px] shrink items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-[12px]',
                            capturePackageIds.length > 0
                              ? 'border-border text-foreground hover:bg-muted'
                              : 'border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                          aria-label="Attach context packages for the live agent"
                        >
                          <Package className="h-3 w-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate max-sm:hidden">
                            {capturePackageIds.length === 0
                              ? 'Packages'
                              : capturePackageIds.length === 1
                                ? (attachablePackages.find((p) => p.id === capturePackageIds[0])?.name ??
                                  '1 package')
                                : `${capturePackageIds.length} packages`}
                          </span>
                        </button>
                      </PopoverTrigger>
                      {/* Above the chip, over the card. */}
                      <PopoverContent side="top" align="start" className="w-64 p-2">
                        <div className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                          Context packages for this call
                        </div>
                        {attachablePackages.length === 0 ? (
                          <div className="px-1 py-2 text-xs text-muted-foreground">
                            No packages yet — create one from Knowledge → Library
                            (Promote), then attach it here.
                          </div>
                        ) : (
                          <div className="max-h-56 overflow-y-auto">
                            {attachablePackages.map((p) => (
                              <label
                                key={p.id}
                                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-xs hover:bg-muted"
                              >
                                <Checkbox
                                  checked={capturePackageIds.includes(p.id)}
                                  onCheckedChange={() => toggleAttachedPackage(p.id)}
                                />
                                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {capturePackageIds.length >= 5 && (
                          <div className="px-1 pt-1.5 text-[11px] text-muted-foreground">
                            Up to 5 packages per call.
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                    )}
                  {/* No Live switch: every capture runs with the live agent
                      (recording-context's availability note). */}
                </div>
              </>
            }
            pills={
              // At the row's end: the transcript and the live agent's tool
              // calls, each a pill whose card rises out of it (hover to peek,
              // click to keep it open). The system-audio notice heads the
              // transcript's card — it's about who's in that transcript — and
              // a desktop capture that has lost the other side flags it on the
              // pill. Both pills are leaves: the transcript's flushes and the
              // agent's calls re-render only them. Tools only while recording.
              <LiveCapturePills
                isActiveRecording={isActiveRecording}
                resumedPriorTranscript={resumedPriorTranscript}
                persistedTranscript={capture?.transcript ?? null}
                holdsLiveSegments={holdsLiveSegments}
                speakerNames={recording.speakerNames}
                demotedSelfLabels={recording.selfDemotedLabels}
                notice={
                  isActiveRecording ? (
                    <SystemAudioWarning
                      status={recording.systemAudioStatus}
                      platform={isDesktopApp() ? 'desktop' : 'web'}
                    />
                  ) : null
                }
                alert={
                  isActiveRecording &&
                  isDesktopApp() &&
                  systemAudioNeedsAttention(recording.systemAudioStatus)
                }
              />
            }
          />

          {/* Comment entry only once the workspace-cache identity resolves.
              The guest arm here means "identity still loading" (or the cache
              fetch failed) — NOT a share-page visitor — and SelectionPopover's
              guest branch is a "Sign in to comment" funnel that must never be
              shown to an already-authenticated dashboard user. While loading,
              commenting is simply absent. (InlineCommentPopover needs no gate:
              its composer returns null for guests, and inlineComments is []
              until the identity resolves anyway.) */}
          {commentIdentity.mode === 'authenticated' && <SelectionPopover />}
          <InlineCommentPopover />
          <AttributionTooltip containerRef={editorContainerRef} />
      </InlineCommentProvider>

      {activeSection === 'live-chat' && liveChatConversationId && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CaptureLiveChatSection conversationId={liveChatConversationId} />
        </div>
      )}

      {activeSection === 'agents' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[736px] px-8">
            <EntityActivitySection entityType="capture" entityId={captureId} />
          </div>
        </div>
      )}

      <AlertDialog open={deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{capture.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This permanently deletes the capture along with its
                  transcript, decisions, participants, comments, labels, and
                  attachments.
                </p>
                <p>
                  Knowledge claims learned <em>only</em> from this capture are
                  deleted too; claims that also have evidence from other sources
                  are kept, with just this capture&rsquo;s evidence removed.
                </p>
                <p>
                  Actions created from this capture are kept — they lose their
                  link back to it. This can&rsquo;t be undone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCapture}
              disabled={deletingCapture}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingCapture ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={moveOpen}
        onOpenChange={(open) => {
          if (!open) {
            setMoveOpen(false)
            setMoveError(null)
            setMoveTargetWorkspaceId(null)
            setMovePreflight(null)
            setMoveActionIds(new Set())
            setMoveClaims(true)
            setMoveContacts(true)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move capture to another workspace</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  Pick the destination workspace. The transcript, decisions,
                  attachments, participants, and any pending AI suggestions
                  will move with the capture.
                </p>

                {movePreflight && (movePreflight.confirmed_actions?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-foreground">
                      Accepted actions from this capture — checked ones move
                      along, unchecked ones stay here:
                    </p>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
                      {movePreflight.confirmed_actions!.map((action) => (
                        <label
                          key={action.id}
                          className="flex cursor-pointer items-start gap-2 text-xs"
                        >
                          <Checkbox
                            checked={moveActionIds.has(action.id)}
                            onCheckedChange={(checked) => {
                              setMoveActionIds((prev) => {
                                const next = new Set(prev)
                                if (checked === true) next.add(action.id)
                                else next.delete(action.id)
                                return next
                              })
                            }}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-foreground">{action.identifier}</span>{' '}
                            <span className="text-muted-foreground">{action.title}</span>
                            {action.edited && (
                              <span
                                className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400"
                                title={action.edit_reasons.join(', ')}
                              >
                                edited
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px]">
                      Moved actions keep their identifier unless it collides in
                      the destination (then they&rsquo;re renumbered) and keep
                      their status by name where possible, but land in the
                      destination&rsquo;s first team. Assignees carry over when
                      that person is a member there; labels remap to a
                      same-named label and are dropped otherwise; PR and
                      Jira/Linear/Asana links are severed (the remote URL is
                      kept on the action). Actions marked <em>edited</em> have
                      hand-made changes or outside links, so they stay unless
                      you check them.
                    </p>
                  </div>
                )}

                {movePreflight && (movePreflight.claims?.sole_sourced ?? 0) > 0 && (
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={moveClaims}
                      onCheckedChange={(checked) => setMoveClaims(checked === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Move {movePreflight.claims!.sole_sourced} knowledge{' '}
                      {movePreflight.claims!.sole_sourced === 1 ? 'claim' : 'claims'} learned only
                      from this capture
                      {(movePreflight.claims!.shared ?? 0) > 0 && (
                        <>
                          {' '}
                          ({movePreflight.claims!.shared} with evidence from other
                          sources {movePreflight.claims!.shared === 1 ? 'stays' : 'stay'} here)
                        </>
                      )}
                      .
                    </span>
                  </label>
                )}

                {movePreflight && (movePreflight.contacts?.auto_created.length ?? 0) > 0 && (
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={moveContacts}
                      onCheckedChange={(checked) => setMoveContacts(checked === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Copy {movePreflight.contacts!.auto_created.length} auto-created participant{' '}
                      {movePreflight.contacts!.auto_created.length === 1 ? 'contact' : 'contacts'} (
                      {movePreflight.contacts!.auto_created
                        .slice(0, 3)
                        .map((c) => c.full_name)
                        .join(', ')}
                      {movePreflight.contacts!.auto_created.length > 3 && ', …'}) to the
                      destination workspace.
                    </span>
                  </label>
                )}

                <ul className="ml-4 list-disc space-y-1 text-xs">
                  <li>Project and team links on the capture will be cleared — you can re-link in the destination.</li>
                  <li>Pending suggestions keep their assignee when that person is a member of the destination, and lose their team and project.</li>
                  <li>Participants who aren&rsquo;t members of the destination will be unlinked.</li>
                  {(movePreflight?.shares_active ?? 0) > 0 && (
                    <li>
                      {movePreflight!.shares_active === 1
                        ? 'The public share link for this capture will stop working'
                        : `All ${movePreflight!.shares_active} share links for this capture will stop working`}{' '}
                      — they stay deactivated here, along with any comments left
                      by outside viewers.
                    </li>
                  )}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="py-2">
            <Select
              value={moveTargetWorkspaceId ?? undefined}
              onValueChange={(value) => {
                setMoveTargetWorkspaceId(value)
                setMoveError(null)
              }}
            >
              <SelectTrigger className="w-full" aria-label="Destination workspace">
                <span className="min-w-0 flex-1 truncate">
                  {moveTargetWorkspaceId
                    ? allWorkspaces.find((w) => w.id === moveTargetWorkspaceId)?.name ?? 'Select workspace…'
                    : 'Select workspace…'}
                </span>
              </SelectTrigger>
              <SelectContent>
                {allWorkspaces
                  .filter((w) => w.id !== currentWorkspaceId)
                  .map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {moveError && (
              <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {moveError}
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={movingCapture}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleMoveCapture()
              }}
              disabled={movingCapture || !moveTargetWorkspaceId}
            >
              {movingCapture ? 'Moving…' : 'Move capture'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
