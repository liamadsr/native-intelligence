'use client'

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { Check, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, Link2, Timer } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { SpeakerContactSearch } from '@/components/desktop/speaker-contact-search'
import { getSpeakerDisplayName } from '@/hooks/use-recording'
import type { AgentActivityEvent } from '@/hooks/use-recording'
import {
  useAutoAcceptCountdown,
  useDetectedSpeakers,
  useFinalSegmentCount,
  useHasLiveTranscriptSegments,
  useLiveActiveSpeaker,
  useTranscriptSegments,
} from '@/hooks/recording-context'
import { parseTranscriptText, type TranscriptSegment } from '@/lib/deepgram-stream'
import type { SpeakerIdentification } from '@/lib/voice-id-service'

/**
 * A capture page's live pieces, at the foot of its card (see
 * CaptureControlsBar in app/account/(dashboard)/views/capture-controls-bar.tsx):
 *   - Voice ID — LiveVoiceIdRow, the speakers carousel in a slim row above the
 *     controls (during a live capture, VoiceIdCarousel shows in the live
 *     agent's HUD instead: components/live-hud);
 *   - the transcript — TranscriptView, in the Transcripts pill's card;
 *   - the live agent's tool calls — ToolCallsView, in the Tools pill's card,
 *     which exists only while the capture records.
 * The leaves read the per-utterance signals (live segments, detected speakers,
 * agent activity) from the ref-backed recording stores themselves, so a
 * speech-cadence update re-renders only what paints it — never the capture
 * page that owns everything else.
 */

// ── Types ───────────────────────────────────────────────────────

interface PostSessionReview {
  sessionId: string
  autoAssigned: { speakerId: string; contactId: string; contactName: string; confidence: number; speakingDurationSec: number }[]
}

/** Voice ID's wiring, as the capture page hands it down. */
export interface VoiceIdProps {
  speakerNames: Record<string, string>
  /** Speaker labels demoted from the default "You" special-case by live self-
   *  verification. Passed to getSpeakerDisplayName so a demoted local_1 stops
   *  rendering as "You". Omitted (undefined) = today's behavior. */
  demotedSelfLabels?: ReadonlySet<string>
  speakerContacts: Record<string, SpeakerIdentification>
  assignContact: (speaker: string, contactId: string, contactName: string) => void
  acceptSuggestion: (speaker: string) => void
  dismissSuggestion: (speaker: string) => void
  unlinkSpeaker: (speaker: string) => void
  // Post-session review
  postSessionReview?: PostSessionReview | null
  confirmPostSessionSpeaker?: (speakerId: string) => void
  reassignPostSessionSpeaker?: (speakerId: string, rightContactId: string, rightContactName: string) => void
  /** "Is this you?" — a voice close to the user's own, not yet verified (issue 11). */
  selfSuggestion?: { speakerId: string; similarity: number } | null
  /** The user says a voice is theirs ("This is me", or ✓ on "Is this you?"). */
  confirmSelf?: (speaker: string) => void
  /** The user says a suggested voice is not theirs. */
  dismissSelf?: (speaker: string) => void
}

/** Which transcript a capture page shows: its live buffer while it's (re)recording
 *  — after a resume's prior transcript — else the saved one. */
export interface CaptureTranscriptSource {
  /** True while THIS capture is the one actively recording. */
  isActiveRecording: boolean
  /** Prior-session transcript text, when this recording is a resume (else null). */
  resumedPriorTranscript: string | null
  /** The capture's persisted transcript, shown when NOT actively recording. */
  persistedTranscript: string | null
  /**
   * Whether this page may show the live buffer: it is recording, or it is the
   * page that just recorded it. The buffer outlives Stop (so that page doesn't
   * blank before the final save lands), and any other capture's page must
   * never show it (GEN-41). Defaults to true.
   */
  holdsLiveSegments?: boolean
}

/** The live buffer as a page that does not hold it sees it. */
const NO_LIVE_SEGMENTS: TranscriptSegment[] = []
const NO_DETECTED_SPEAKERS: string[] = []

const LIVE_AGENT_TOOL_LABELS: Record<string, string> = {
  search_projects: 'Search projects',
  search_contacts: 'Search contacts',
  list_workspace_members: 'List members',
  get_project_details: 'Get project',
  propose_change: 'Propose change',
  update_capture: 'Write summary',
  edit_capture_content: 'Edit summary',
}

// ── Compact tool call row ───────────────────────────────────────

function ToolCallRow({ event }: { event: AgentActivityEvent }) {
  const [open, setOpen] = useState(false)
  const label = LIVE_AGENT_TOOL_LABELS[event.toolName] || event.toolName.replace(/_/g, ' ')
  const hasArgs = event.args && Object.keys(event.args).length > 0

  return (
    <div className="border-b border-border/40 last:border-0 min-w-0 overflow-hidden">
      <button
        onClick={() => hasArgs && setOpen(!open)}
        disabled={!hasArgs}
        className={cn(
          'flex w-full items-center gap-1.5 py-1 text-[11px] text-muted-foreground',
          hasArgs && 'hover:text-foreground cursor-pointer',
        )}
      >
        <CheckCircle className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        <span className="truncate font-medium">{label}</span>
        {hasArgs && (
          <ChevronDown className={cn(
            'ml-auto h-2.5 w-2.5 shrink-0 transition-transform',
            open && 'rotate-180',
          )} />
        )}
      </button>
      {open && hasArgs && (
        <div className="pb-1.5 pl-[18px] pr-1 min-w-0">
          <div className="rounded bg-muted/50 px-2 py-1 font-mono text-[10px] text-muted-foreground leading-relaxed overflow-hidden break-all">
            {Object.entries(event.args).map(([key, value]) => (
              <div key={key} className="break-all">
                <span className="text-muted-foreground/60">{key}:</span>{' '}
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Speaker helpers ─────────────────────────────────────────────

function isLocalSpeaker(speaker: string): boolean {
  const s = speaker.toLowerCase()
  return s.startsWith('local') || s === 'me' || s === 'you'
}

/** Who's talking right now: the speaker of the latest interim (still-forming)
 *  segment, else of the latest final one. Exported for tests. The live store's
 *  useLiveActiveSpeaker() (recording-context) applies the same rule — keep the
 *  two in step. */
export function activeSpeakerOf(segments: TranscriptSegment[]): string | null {
  if (segments.length === 0) return null
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].isFinal) return segments[i].speaker
  }
  return segments[segments.length - 1].speaker
}

// ── Scroll helpers ──────────────────────────────────────────────

/**
 * Clamp a CSS-transform track offset so the content stays visible.
 *
 * When the track is wider than the container (i.e. the pill list overflows):
 *   minOffset = containerWidth − trackScrollWidth  (negative → track shifted fully left)
 *   maxOffset = 0                                   (track starts at left edge)
 *
 * Only called when trackScrollWidth > containerWidth.
 */
export function clampTrackOffset(
  currentOffset: number,
  deltaX: number,
  containerWidth: number,
  trackScrollWidth: number,
): number {
  const minOffset = containerWidth - trackScrollWidth
  const maxOffset = 0
  return Math.max(minOffset, Math.min(maxOffset, currentOffset - deltaX))
}

// ── Voice ID carousel ───────────────────────────────────────────

/** One arrow press pans the speakers this share of the visible width — the
 *  next few come into view with some of the current ones still showing. */
const ARROW_PAN_FRACTION = 0.6

/** After the user pans (wheel or arrows), the carousel holds still this long
 *  before it goes back to following whoever is talking. */
const MANUAL_PAN_HOLD_MS = 2000

/**
 * Voice ID: the speakers detected in the call, as a centred row of pills —
 * click an unknown one to assign them a contact, accept or dismiss a suggested
 * match, or open an identified one to unlink it (or, after the call, confirm
 * or correct an automatic match). The one talking stands out.
 *
 * When they fit, they sit still, centred. When they don't, the row becomes a
 * carousel: arrows either side (and a horizontal wheel) pan it, and otherwise
 * it keeps whoever is talking as near the middle as its ends allow. Hovering it
 * freezes it, so a pill never slides out from under the pointer.
 *
 * Renders nothing until someone is heard.
 */
export function VoiceIdCarousel(
  props: VoiceIdProps & {
    detectedSpeakers: string[]
    activeSpeaker: string | null
    className?: string
  },
) {
  if (props.detectedSpeakers.length === 0) return null
  return <VoiceIdTrack {...props} />
}

function VoiceIdTrack({
  detectedSpeakers,
  activeSpeaker,
  className,
  ...voiceId
}: VoiceIdProps & {
  detectedSpeakers: string[]
  activeSpeaker: string | null
  className?: string
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  // Whether the pills overflow the row, and — when they do — how far left the
  // track can go before blank space shows at its end.
  const [fit, setFit] = useState({ overflows: false, minOffset: 0 })
  const [isHovered, setIsHovered] = useState(false)
  // What's panning it by hand, if anything: a wheel pan moves instantly, an
  // arrow press glides.
  const [manualPan, setManualPan] = useState<'wheel' | 'arrow' | null>(null)
  const isManualScrolling = manualPan != null
  const pendingOffsetRef = useRef<number | null>(null)
  const manualPanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Freeze which speaker looks "active" while hovering so pills don't dim/scale
  const frozenSpeakerRef = useRef<string | null>(null)
  const visualActiveSpeaker = isHovered ? frozenSpeakerRef.current : activeSpeaker

  // Fitting all of them, it sits still and centred; else it pans, kept within
  // its ends (a resize can leave the stored offset past one).
  const shownOffset = fit.overflows ? Math.max(fit.minOffset, Math.min(0, offset)) : 0
  const atStart = shownOffset >= 0
  const atEnd = shownOffset <= fit.minOffset

  // Measure against the ROW (the room there is), not the window the pills show
  // through — that shrinks to the pills themselves while they fit, and makes
  // room for the arrows once they don't.
  useLayoutEffect(() => {
    const row = rowRef.current
    const container = containerRef.current
    const track = trackRef.current
    if (!row || !container || !track) return
    const measure = () => {
      const overflows = track.offsetWidth > row.clientWidth
      const minOffset = overflows ? Math.min(0, container.offsetWidth - track.offsetWidth) : 0
      setFit((prev) =>
        prev.overflows === overflows && prev.minOffset === minOffset ? prev : { overflows, minOffset },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(container)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  // Overflowing, keep the active speaker's pill centred. While hovered or
  // panned by hand, queue the offset and apply it afterward.
  useEffect(() => {
    if (!activeSpeaker || !fit.overflows) return
    const track = trackRef.current
    const container = containerRef.current
    if (!track || !container) return
    const activeEl = Array.from(track.children).find(
      (el) => (el as HTMLElement).dataset.speaker === activeSpeaker,
    ) as HTMLElement | undefined
    if (!activeEl) return

    const containerCenter = container.offsetWidth / 2
    const pillCenter = activeEl.offsetLeft + activeEl.offsetWidth / 2
    const newOffset = containerCenter - pillCenter

    if (isHovered || isManualScrolling) {
      pendingOffsetRef.current = newOffset
    } else {
      setOffset(newOffset)
      pendingOffsetRef.current = null
    }
  }, [activeSpeaker, detectedSpeakers.length, isHovered, isManualScrolling, fit.overflows])

  /** A hand pan: hold off following the talker for a while after the last one. */
  const holdManualPan = useCallback((source: 'wheel' | 'arrow') => {
    setManualPan(source)
    if (manualPanTimeoutRef.current) clearTimeout(manualPanTimeoutRef.current)
    manualPanTimeoutRef.current = setTimeout(() => setManualPan(null), MANUAL_PAN_HOLD_MS)
  }, [])

  // Non-passive wheel listener so we can prevent the parent from scrolling
  // while the user manually pans the speaker pill track.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onWheel = (e: WheelEvent) => {
      const track = trackRef.current
      if (!track) return

      // Accept horizontal scroll or shift+vertical (common on some trackpads/mice)
      const deltaX =
        Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (deltaX === 0) return

      // Only intercept when the pill list actually overflows the container
      const trackWidth = track.scrollWidth
      const containerWidth = container.offsetWidth
      if (trackWidth <= containerWidth) return

      e.preventDefault()
      setOffset((prev) => clampTrackOffset(prev, deltaX, containerWidth, trackWidth))
      holdManualPan('wheel')
    }

    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [holdManualPan])

  // Cleanup lingering timeout on unmount
  useEffect(() => {
    return () => {
      if (manualPanTimeoutRef.current) clearTimeout(manualPanTimeoutRef.current)
    }
  }, [])

  /** An arrow press: most of a window's width towards `direction`. */
  const pan = (direction: -1 | 1) => {
    const container = containerRef.current
    const track = trackRef.current
    if (!container || !track) return
    const width = container.offsetWidth
    setOffset(clampTrackOffset(shownOffset, direction * width * ARROW_PAN_FRACTION, width, track.offsetWidth))
    holdManualPan('arrow')
  }

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true)
    frozenSpeakerRef.current = activeSpeaker
  }, [activeSpeaker])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
    frozenSpeakerRef.current = null
    // Only snap back to active speaker if the user isn't also manually scrolling.
    // When manual scroll finishes, the isManualScrolling→false effect handles it.
    if (!isManualScrolling && pendingOffsetRef.current != null) {
      setOffset(pendingOffsetRef.current)
      pendingOffsetRef.current = null
    }
  }, [isManualScrolling])

  return (
    <div
      ref={rowRef}
      data-voice-id-carousel
      // 20px: about half the 36px controls row it sits above.
      className={cn('flex h-5 w-full items-center justify-center gap-0.5', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {fit.overflows && (
        <CarouselArrow direction="left" disabled={atStart} onClick={() => pan(-1)} />
      )}
      {/* Clipped sideways only: the talker's pill is scaled up a touch, and
          may stand a hair taller than the slim row. */}
      <div ref={containerRef} className="relative flex h-full min-w-0 items-center overflow-x-clip">
        <div
          ref={trackRef}
          className={cn(
            'flex w-max shrink-0 items-center gap-1.5 px-1',
            // Skip the CSS transition during a wheel pan so movement feels
            // instant and responsive; keep it for arrows and auto-centering.
            manualPan !== 'wheel' && 'transition-transform duration-500 ease-out',
          )}
          style={{ transform: `translateX(${shownOffset}px)` }}
        >
          {detectedSpeakers.map((speaker) => (
            <div
              key={speaker}
              data-speaker={speaker}
              data-self-suggestion={voiceIdKind(speaker, voiceId) === 'self' ? '' : undefined}
              className={cn(
                'shrink-0 transition-all duration-500 ease-out',
                speaker === visualActiveSpeaker ? 'scale-110 z-10' : 'opacity-40 scale-90',
              )}
            >
              <VoiceIdSpeaker speaker={speaker} {...voiceId} />
            </div>
          ))}
        </div>
      </div>
      {fit.overflows && (
        <CarouselArrow direction="right" disabled={atEnd} onClick={() => pan(1)} />
      )}
    </div>
  )
}

/** Which of Voice ID's states a speaker is in. */
function voiceIdKind(
  speaker: string,
  { speakerContacts, selfSuggestion, confirmSelf }: Pick<VoiceIdProps, 'speakerContacts' | 'selfSuggestion' | 'confirmSelf'>,
): 'self' | 'suggestion' | 'identified' | 'unknown' {
  const contact = speakerContacts[speaker]
  if (contact?.isSuggestion) return 'suggestion'
  if (contact) return 'identified'
  if (selfSuggestion?.speakerId === speaker && confirmSelf) return 'self'
  return 'unknown'
}

/**
 * One speaker's Voice ID: click an unknown one to assign them a contact,
 * accept or dismiss a suggested match or an "Is this you?", or open an
 * identified one to unlink it (or, after the call, confirm or correct an
 * automatic match).
 *   - 'pill': a pill in the carousel's slim row (VoiceIdCarousel);
 *   - 'title': the speaker as a card's title — the live agent HUD's header,
 *     where each voice has its own page (app/hud/agent). The same controls;
 *     the name at title size, any suggestion beside it.
 * `identifiedDetails` adds lines under an identified speaker's card header
 * (the live agent HUD's person card: components/live-hud/hud-person-card.tsx).
 */
export function VoiceIdSpeaker({
  speaker,
  variant = 'pill',
  speakerNames,
  demotedSelfLabels,
  speakerContacts,
  assignContact,
  acceptSuggestion,
  dismissSuggestion,
  unlinkSpeaker,
  postSessionReview,
  confirmPostSessionSpeaker,
  reassignPostSessionSpeaker,
  selfSuggestion,
  confirmSelf,
  dismissSelf,
  identifiedDetails,
}: VoiceIdProps & { speaker: string; variant?: 'pill' | 'title'; identifiedDetails?: ReactNode }) {
  const title = variant === 'title'
  const kind = voiceIdKind(speaker, { speakerContacts, selfSuggestion, confirmSelf })
  const contact = speakerContacts[speaker]
  const speakerDisplayName = (s: string) => getSpeakerDisplayName(s, speakerNames, demotedSelfLabels)
  const name = speakerDisplayName(speaker)
  // As a title, a speaker with a question pending keeps their name beside it.
  const titleText = <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground">{name}</span>

  if (kind === 'self' && confirmSelf) {
    const chip = (
      <div className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-400/50 bg-sky-50 px-2 py-0.5 dark:border-sky-600/40 dark:bg-sky-950/40">
        <span className="text-[10px] font-medium text-sky-700 dark:text-sky-300">Is this you?</span>
        <button
          aria-label="Yes, this is me"
          className="inline-flex items-center justify-center rounded-full w-3.5 h-3.5 bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900 dark:text-emerald-300 transition-colors"
          onClick={() => confirmSelf(speaker)}
        >
          <Check className="h-2 w-2" />
        </button>
        <button
          aria-label="No, not me"
          className="inline-flex items-center justify-center rounded-full w-3.5 h-3.5 bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 transition-colors"
          onClick={() => dismissSelf?.(speaker)}
        >
          <span className="text-[8px] font-bold leading-none">&#10005;</span>
        </button>
      </div>
    )
    return title ? (
      <div data-self-suggestion className="flex min-w-0 items-center gap-2">
        {titleText}
        {chip}
      </div>
    ) : (
      chip
    )
  }

  if (kind === 'suggestion' && contact) {
    const chip = (
      <div className={cn(
        'inline-flex min-w-0 shrink items-center gap-1 rounded-full px-2 py-0.5',
        contact.isLearningMatch
          ? 'border border-zinc-300/50 bg-zinc-50 dark:bg-zinc-900/40 dark:border-zinc-600/40'
          : 'border border-amber-400/50 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-600/40',
      )}>
        <span className={cn(
          'text-[10px] font-medium truncate max-w-[140px]',
          contact.isLearningMatch
            ? 'text-zinc-600 dark:text-zinc-300'
            : 'text-amber-700 dark:text-amber-300',
        )}>
          {contact.isLearningMatch
            ? `Possible: ${contact.contactName}?`
            : `${contact.contactName} (${(contact.confidence * 100).toFixed(0)}%)`}
        </span>
        <AutoAcceptCountdown suggestion={contact} />
        <button
          aria-label={`Yes, this is ${contact.contactName}`}
          className="inline-flex shrink-0 items-center justify-center rounded-full w-3.5 h-3.5 bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900 dark:text-emerald-300 transition-colors"
          onClick={() => acceptSuggestion(speaker)}
        >
          <Check className="h-2 w-2" />
        </button>
        <button
          aria-label={`No, not ${contact.contactName}`}
          className="inline-flex shrink-0 items-center justify-center rounded-full w-3.5 h-3.5 bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 transition-colors"
          onClick={() => dismissSuggestion(speaker)}
        >
          <span className="text-[8px] font-bold leading-none">&#10005;</span>
        </button>
      </div>
    )
    return title ? (
      <div className="flex min-w-0 items-center gap-2">
        {titleText}
        {chip}
      </div>
    ) : (
      chip
    )
  }

  if (kind === 'identified' && contact) {
    const pendingReview = postSessionReview?.autoAssigned.find((a) => a.speakerId === speaker)
    const isPendingReview = !!pendingReview
    const icon = contact.isAutoMatched ? <Check className={title ? 'h-3 w-3 shrink-0' : 'h-2.5 w-2.5'} /> : <Link2 className={title ? 'h-3 w-3 shrink-0' : 'h-2.5 w-2.5'} />
    return (
      <Popover>
        <PopoverTrigger asChild>
          {title ? (
            <button
              className={cn(
                '-mx-1.5 inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] font-semibold leading-5 text-foreground transition-colors hover:bg-foreground/[0.06]',
                isPendingReview && 'text-amber-700 dark:text-amber-300',
              )}
            >
              <span className="min-w-0 truncate">{name}</span>
              <span className="text-foreground/50">{icon}</span>
            </button>
          ) : (
            <button className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors hover:opacity-80',
              isPendingReview
                ? 'border border-amber-400/50 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:border-amber-600/40 dark:text-amber-300'
                : cn(isLocalSpeaker(speaker) ? 'bg-foreground/10' : 'bg-muted', 'text-foreground'),
            )}>
              {icon}
              <span className="truncate max-w-[100px]">{name}</span>
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent className={cn(identifiedDetails ? 'w-64' : 'w-56', 'p-0')} align="start">
          <div>
            {/* Header */}
            <div className="px-3 pt-3 pb-2">
              <div className="flex items-center gap-2">
                <div className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium',
                  contact.isAutoMatched ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-muted text-muted-foreground',
                )}>
                  {contact.isAutoMatched ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
                </div>
                <div>
                  <p className="text-xs font-medium">{contact.contactName}</p>
                  <p className="text-[10px] text-muted-foreground/60">
                    {contact.isAutoMatched
                      ? `${(contact.confidence * 100).toFixed(0)}% match`
                      : 'Manually linked'}
                  </p>
                </div>
              </div>
            </div>

            {identifiedDetails}

            {/* Speaker actions */}
            <div className="border-t border-border/40 px-3 py-2">
              <Button
                variant="outline" size="sm"
                className="h-6 w-full text-[10px] border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => unlinkSpeaker(speaker)}
              >
                Unlink
              </Button>
            </div>

            {/* Learning / review section — confirming saves the held
                embeddings + a trust confirmation for THIS speaker;
                reassigning penalizes the wrong contact and teaches
                the right one. Nothing is saved until one is chosen. */}
            {isPendingReview && (
              <div className="border-t border-border/40 px-3 py-2">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50 mb-1.5">Improve matching</p>
                <div className="flex gap-1">
                  <Button
                    variant="outline" size="sm"
                    className="h-6 flex-1 text-[10px] border-emerald-500/30 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-950/30"
                    onClick={() => confirmPostSessionSpeaker?.(speaker)}
                  >
                    <Check className="mr-1 h-2.5 w-2.5" />
                    Correct
                  </Button>
                  <SpeakerContactSearch
                    speakerId={speaker}
                    speakerDisplayName={name}
                    onAssign={(cId, cName) => {
                      reassignPostSessionSpeaker?.(speaker, cId, cName)
                    }}
                  >
                    <Button
                      variant="outline" size="sm"
                      className="h-6 flex-1 text-[10px] border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      Wrong
                    </Button>
                  </SpeakerContactSearch>
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <SpeakerContactSearch
      speakerId={speaker}
      speakerDisplayName={name}
      onAssign={(cId, cName) => assignContact(speaker, cId, cName)}
      onAssignSelf={confirmSelf ? () => confirmSelf(speaker) : undefined}
    >
      {title ? (
        <button
          aria-label={`Who is ${name}?`}
          className="-mx-1.5 inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] font-semibold leading-5 text-foreground transition-colors hover:bg-foreground/[0.06]"
        >
          <span className="min-w-0 truncate">{name}</span>
          <CircleHelp className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      ) : (
        <button className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
          <span className="truncate max-w-[100px]">{name}</span>
          <CircleHelp className="h-2.5 w-2.5 opacity-50" />
        </button>
      )}
    </SpeakerContactSearch>
  )
}

function CarouselArrow({
  direction,
  disabled,
  onClick,
}: {
  direction: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}) {
  const Icon = direction === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'left' ? 'Scroll speakers left' : 'Scroll speakers right'}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

/** A suggestion chip's auto-accept countdown ("7s"), while it has seconds
 *  left. A leaf over the countdown's tick store, so its 1 Hz ticks re-render
 *  this number alone — not the capture page, nor the speakers row. */
function AutoAcceptCountdown({ suggestion }: { suggestion: SpeakerIdentification }) {
  const seconds = useAutoAcceptCountdown(suggestion)
  if (seconds == null || seconds <= 0) return null
  return (
    <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-600 dark:text-amber-400 tabular-nums">
      <Timer className="h-2.5 w-2.5" />
      {seconds}s
    </span>
  )
}

// ── Transcript ──────────────────────────────────────────────────

/**
 * One line of the transcript, as a chat bubble. Memoized on primitives (plus
 * the page's speaker names, identity-stable between changes), so a ~150ms
 * flush that only grows the still-forming interim line re-renders that one row
 * — every settled line above it bails out.
 */
const TranscriptRow = memo(function TranscriptRow({
  speaker,
  text,
  isFinal,
  speakerNames,
  demotedSelfLabels,
}: {
  speaker: string
  text: string
  isFinal: boolean
  speakerNames: Record<string, string>
  demotedSelfLabels?: ReadonlySet<string>
}) {
  const isLocal = isLocalSpeaker(speaker)
  return (
    <div
      className={cn(
        'flex flex-col max-w-[90%]',
        !isFinal && 'opacity-50',
        isLocal ? 'ml-auto items-end' : 'mr-auto items-start',
      )}
    >
      <span className="text-[9px] text-muted-foreground/60 mb-0.5 px-1">
        {getSpeakerDisplayName(speaker, speakerNames, demotedSelfLabels)}
      </span>
      <p className={cn(
        // select-text: transcripts are content — keep them copyable under
        // the desktop app's select-none chrome baseline.
        'select-text text-[11px] leading-relaxed rounded-2xl px-2.5 py-1',
        isLocal
          ? 'bg-foreground/10 text-foreground rounded-br-md'
          : 'bg-muted text-foreground rounded-bl-md',
      )}>
        {text}
      </p>
    </div>
  )
})

/**
 * The transcript as chat bubbles — yours on the right — following the latest
 * line unless you've scrolled up, with a Copy of every final line. Opens at
 * the latest line. Fills its parent's height.
 */
export function TranscriptView({
  segments,
  speakerNames,
  demotedSelfLabels,
  title,
}: {
  segments: TranscriptSegment[]
  speakerNames: Record<string, string>
  demotedSelfLabels?: ReadonlySet<string>
  /** Heads the view, across from Copy. */
  title?: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const prevCountRef = useRef(segments.length)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hasSegments = segments.length > 0

  const handleCopy = useCallback(() => {
    const text = transcriptCopyText(segments, speakerNames, demotedSelfLabels)
    copyTextToClipboard(text).then((ok) => {
      // It resolves false when neither clipboard path worked.
      if (!ok) return
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [segments, speakerNames, demotedSelfLabels])
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
  }, [])

  // Track whether user has manually scrolled up
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    userScrolledRef.current = !atBottom
  }, [])

  // Open at the latest line — on mount (the card opening), and once the first
  // line arrives.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hasSegments])

  // Auto-scroll only if user hasn't scrolled up
  useEffect(() => {
    if (segments.length > prevCountRef.current && !userScrolledRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    prevCountRef.current = segments.length
  }, [segments.length])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
        <span className="truncate text-[11px] font-medium text-muted-foreground">{title}</span>
        {hasSegments && (
          <button
            onClick={handleCopy}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted hover:border-foreground/30 transition-colors"
          >
            {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {hasSegments ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
        >
          {segments.map((segment) => (
            <TranscriptRow
              key={segment.id}
              speaker={segment.speaker}
              text={segment.text}
              isFinal={segment.isFinal}
              speakerNames={speakerNames}
              demotedSelfLabels={demotedSelfLabels}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-muted-foreground/50">
          No transcript yet
        </div>
      )}
    </div>
  )
}

// ── Tool calls ──────────────────────────────────────────────────

/**
 * The live agent's tool calls, oldest first — each one opens to its arguments
 * — following the newest. Fills its parent's height.
 */
export function ToolCallsView({ events, title }: { events: AgentActivityEvent[]; title?: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Follow the newest call (and open at it).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {title != null && (
        <div className="flex h-8 shrink-0 items-center px-3">
          <span className="truncate text-[11px] font-medium text-muted-foreground">{title}</span>
        </div>
      )}
      {events.length > 0 ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-2">
          {events.map((event) => (
            <ToolCallRow key={event.id} event={event} />
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-muted-foreground/50">
          No tool calls yet
        </div>
      )}
    </div>
  )
}

// ── Leaves ──────────────────────────────────────────────────────

/**
 * Derive the segment list a capture page displays. Exported for tests.
 *
 * The prior/persisted transcript parses are memoized on THEIR strings alone —
 * `liveSegments` gets a fresh array identity on every ~150ms flush, so keying
 * the parse on it (as the old single memo did) re-ran parseTranscriptText over
 * the entire never-changing prior transcript ~7×/s for the whole session on
 * resumed captures.
 */
/** A transcript as copied text: each final line as "Name: words". */
export function transcriptCopyText(
  segments: readonly TranscriptSegment[],
  speakerNames: Record<string, string>,
  demotedSelfLabels?: ReadonlySet<string>,
): string {
  return segments
    .filter((s) => s.isFinal)
    .map((s) => `${getSpeakerDisplayName(s.speaker, speakerNames, demotedSelfLabels)}: ${s.text}`)
    .join('\n')
}

/** The segments a capture page shows (useDisplayTranscriptSegments' rule, for
 *  a one-off read outside render). */
export function displayTranscriptSegments(
  isActiveRecording: boolean,
  liveSegments: readonly TranscriptSegment[],
  resumedPriorTranscript: string | null,
  persistedTranscript: string | null,
): TranscriptSegment[] {
  if (isActiveRecording || liveSegments.length > 0) {
    const prior = resumedPriorTranscript ? parseTranscriptText(resumedPriorTranscript) : []
    return [...prior, ...liveSegments]
  }
  return parseTranscriptText(persistedTranscript)
}

export function useDisplayTranscriptSegments(
  isActiveRecording: boolean,
  liveSegments: TranscriptSegment[],
  resumedPriorTranscript: string | null,
  persistedTranscript: string | null,
): TranscriptSegment[] {
  const priorSegments = useMemo(
    () => (resumedPriorTranscript ? parseTranscriptText(resumedPriorTranscript) : []),
    [resumedPriorTranscript],
  )
  const persistedSegments = useMemo(
    () => parseTranscriptText(persistedTranscript),
    [persistedTranscript],
  )

  // While this capture is (re)recording OR there are live segments, show the
  // prior-session transcript (resume only) followed by the live buffer; else the
  // persisted transcript so it stays visible after stop / on re-open. Mirrors the
  // memo that used to live in the panel.
  return useMemo(() => {
    if (isActiveRecording || liveSegments.length > 0) {
      return priorSegments.length > 0 ? [...priorSegments, ...liveSegments] : liveSegments
    }
    return persistedSegments
  }, [isActiveRecording, liveSegments, priorSegments, persistedSegments])
}

/**
 * The transcript a capture page shows, and how many final lines it has — read
 * from the live segment store (useSyncExternalStore) at the LEAF that paints
 * it, so the ~6-7×/s flushes never reach the capture page.
 */
export function useCaptureTranscript({
  isActiveRecording,
  resumedPriorTranscript,
  persistedTranscript,
  holdsLiveSegments = true,
}: CaptureTranscriptSource): { segments: TranscriptSegment[]; finalSegmentCount: number } {
  const storeSegments = useTranscriptSegments()
  const liveSegments = holdsLiveSegments ? storeSegments : NO_LIVE_SEGMENTS
  const liveFinalSegmentCount = useFinalSegmentCount()
  const segments = useDisplayTranscriptSegments(
    isActiveRecording,
    liveSegments,
    resumedPriorTranscript,
    persistedTranscript,
  )
  const finalSegmentCount =
    isActiveRecording || liveSegments.length > 0 ? liveFinalSegmentCount : segments.length
  return { segments, finalSegmentCount }
}

/**
 * useCaptureTranscript's `finalSegmentCount` alone — for a leaf that shows the
 * count but not the lines (the Transcripts pill while its card is shut). The
 * same rule, read from stores that change only when the count can: the live
 * final count (new finals only) and whether there are live segments at all
 * (flips on start/stop) — so an interim flush never re-renders the caller.
 */
export function useCaptureFinalSegmentCount({
  isActiveRecording,
  persistedTranscript,
  holdsLiveSegments = true,
}: Pick<CaptureTranscriptSource, 'isActiveRecording' | 'persistedTranscript' | 'holdsLiveSegments'>): number {
  const hasLiveSegments = useHasLiveTranscriptSegments() && holdsLiveSegments
  const liveFinalSegmentCount = useFinalSegmentCount()
  const showsLive = isActiveRecording || hasLiveSegments
  // Not live: the persisted transcript's lines — useDisplayTranscriptSegments'
  // `persistedSegments`, counted. Parsed only while that's what's shown.
  const persistedCount = useMemo(
    () => (showsLive ? 0 : parseTranscriptText(persistedTranscript).length),
    [showsLive, persistedTranscript],
  )
  return showsLive ? liveFinalSegmentCount : persistedCount
}

/**
 * Who's talking in the transcript a capture page shows — activeSpeakerOf over
 * useCaptureTranscript's `segments` — read from stores that change only when
 * the answer can: the live transcript's own latest speaker, and whether it has
 * any segments. The prior (resume) and persisted transcripts parse to FINAL
 * lines only, so over `[...prior, ...live]` the rule lands on the live lines'
 * speaker whenever there are any, and on the prior transcript's last line
 * otherwise; not recording and nothing live, on the persisted one's.
 */
export function useCaptureActiveSpeaker({
  isActiveRecording,
  resumedPriorTranscript,
  persistedTranscript,
  holdsLiveSegments = true,
}: CaptureTranscriptSource): string | null {
  const hasLiveSegments = useHasLiveTranscriptSegments() && holdsLiveSegments
  const liveActiveSpeaker = useLiveActiveSpeaker()
  // The transcript the answer comes from when there are no live lines (null —
  // nothing parsed — while there are).
  const settledTranscript = hasLiveSegments
    ? null
    : isActiveRecording
      ? resumedPriorTranscript
      : persistedTranscript
  const settledActiveSpeaker = useMemo(
    () => activeSpeakerOf(parseTranscriptText(settledTranscript)),
    [settledTranscript],
  )
  return hasLiveSegments ? liveActiveSpeaker : settledActiveSpeaker
}

/**
 * Voice ID for a capture page, as a leaf: the detected speakers and who's
 * talking come from the recording stores here, never through the page. It
 * reads who's talking, not the transcript, so a flush that doesn't change the
 * talker leaves the speaker pills (each a popover) alone.
 * Renders nothing until someone is heard.
 */
export function LiveVoiceIdRow({
  isActiveRecording,
  resumedPriorTranscript,
  persistedTranscript,
  holdsLiveSegments = true,
  className,
  ...voiceId
}: VoiceIdProps & CaptureTranscriptSource & { className?: string }) {
  // The speakers are kept after Stop with the live buffer, so they are the
  // last call's: only the page that holds that buffer shows them.
  const storeSpeakers = useDetectedSpeakers()
  const detectedSpeakers = holdsLiveSegments ? storeSpeakers : NO_DETECTED_SPEAKERS
  const activeSpeaker = useCaptureActiveSpeaker({ isActiveRecording, resumedPriorTranscript, persistedTranscript, holdsLiveSegments })
  return (
    <VoiceIdCarousel
      {...voiceId}
      detectedSpeakers={detectedSpeakers}
      activeSpeaker={activeSpeaker}
      className={className}
    />
  )
}
