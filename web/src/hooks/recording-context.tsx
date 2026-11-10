'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useRecording, type AgentActivityEvent } from './use-recording'
import type { AudioLevelPayload } from '@/lib/tauri-bridge'
import { captureDetailCache, captureRowReady, registerPendingCaptureCreate, seedCaptureCache } from '@/lib/capture-cache'
import { hasStreamingPanel, requestStreamingExtraction } from '@/lib/live-agent/streaming-extraction-bus'
import { shouldRunPostLiveBatch } from '@/lib/live-agent/default-agent'
import { WebAudioCaptureError, type WebAudioCaptureErrorKind } from '@/lib/web-audio-capture'
import { emitEntityUpdated, markLocallyMutated } from '@/lib/entity-events'
import { MicPermissionDialog } from '@/components/capture/mic-permission-dialog'
import { isDesktopApp } from '@/lib/platform'
import { trackRecordingEvent } from '@/lib/recording-telemetry'
import { useAgentNudgeRelay } from './use-agent-nudge-relay'
import { useSoundQuietWhile } from '@/lib/sounds/quiet'
import { primeVocabulary } from '@/lib/vocabulary/client'

export type LiveAgentStatus = 'idle' | 'listening' | 'waiting' | 'processing' | 'finalizing' | 'deferred'

/** How a recording's capture should open (the dashboard shell decides what
 *  each means for its chats):
 *   - `discardedCaptureId` — the capture was just discarded, so whatever was
 *     opened for it can close. */
export interface RecordingNavigateOptions {
  discardedCaptureId?: string
}

/** The capture a recording opens. */
export interface RecordingCapture {
  captureId: string
  title: string
}

/** Opens a recording's capture as a card (null: nothing to open, only the
 *  options' undo). Registered by the dashboard shell. */
export type RecordingNavigateFn = (capture: RecordingCapture | null, options?: RecordingNavigateOptions) => void

/** Undo callback for the optimistic capture-start navigation: step back IF (and
 *  only if) the active tab is still showing that capture's detail panel — the
 *  guard lives in the shell (it can read tab state), not here. */
export type RecordingNavigateBackFn = (captureId: string) => void

/** A user correction of an agent suggestion — tracked so the agent avoids repeating mistakes */
export interface AgentCorrection {
  field: string
  agentProposed: string
  userCorrected: string
}

/**
 * Per-utterance signals that are DELIBERATELY NOT context fields (audit
 * finding 7). Each changes on a finalized utterance / live-agent turn — 6–20×
 * a minute for the whole meeting — and as context members they gave the
 * volatile context value a new identity every time, re-rendering the ~3.7k-line
 * capture detail panel (×2 mounted copies) for signals only a leaf paints.
 * They are not state anywhere — `useRecording` keeps them in ref-backed stores
 * and consumers read them through the leaf hooks at the bottom of this file:
 * useFinalSegmentCount / useDetectedSpeakers / useAgentActivity /
 * useLiveAgentStatus.
 */

type RecordingState = ReturnType<typeof useRecording> & {
  /** The capture ID associated with the current recording session */
  captureId: string | null
  /** True from the Capture click until the mic confirms (or fails). The start is
   *  OPTIMISTIC — captureId is bound and the panel opens before the mic is live —
   *  so surfaces use this to show a "starting" affordance instead of an idle/
   *  resume state during the spin-up window. */
  isStarting: boolean
  /** Start recording for an existing capture (e.g. from tray "Start Capture").
   *  `title` opens it in a tab of its own, as the Capture button does. */
  startRecordingForCapture: (captureId: string, opts?: { skipTranscriptSeed?: boolean; title?: string }) => Promise<void>
  /** Resume recording for a previously stopped capture — unlocks transcript, preserves live agent history.
   *  `title` opens the capture as a card first, as startRecordingForCapture does (a calendar Start). */
  resumeCapture: (captureId: string, opts?: { title?: string }) => Promise<void>
  /** An interrupted capture found on launch, awaiting the user's resume/discard
   *  decision. null when there's nothing to recover. */
  pendingRecovery: { captureId: string; title: string } | null
  /** Accept the recovery prompt — resume the interrupted capture. */
  confirmRecovery: () => Promise<void>
  /** Decline the recovery prompt — finalize the interrupted capture as ended. */
  dismissRecovery: () => Promise<void>
  /** Discard the current recording — stops recording and deletes the capture */
  discardRecording: () => Promise<void>
  /** Selected live agent recipe ID (null = workspace default) */
  agentId: string | null
  /** Set which live agent recipe to use.
   *
   *  `fromLiveLock` marks a selection made by the capture panel's LIVE LOCK (the
   *  edition's declared live persona) rather than by the user. It is the input to
   *  the end-of-call handoff rule: a batch run must never inherit a mid-call
   *  persona, so the stop path drops a live-lock selection and sends no
   *  recipe_id, letting the server resolve the edition's BATCH default. A
   *  selection the user actually made is never dropped. */
  setAgentId: (id: string | null, opts?: { fromLiveLock?: boolean }) => void
  /** THE POST-LIVE BATCH HINTS, published by the capture panel.
   *
   *  The end-of-call batch pass used to be gated on one thing: live mode OFF. It
   *  now also has to run after a LIVE call whose agent wrote nothing (an
   *  assist-only copilot) or whose edition names a batch persona that still has
   *  to write the record — see `shouldRunPostLiveBatch`. Deciding that needs the
   *  agents list and the workspace edition, and this provider has NEITHER (it
   *  deliberately holds no library or workspace state). The panel has both, so it
   *  publishes the two booleans here and the stop path reads them from refs.
   *
   *  Both default to `false`, which is exactly today's behavior — a panel that
   *  never calls this (or hasn't loaded its agents yet) changes nothing. */
  setPostLiveBatchHints: (hints: {
    liveAgentAssistOnly?: boolean
    hasBatchDefault?: boolean
  }) => void
  /** Whether live mode is on. ON = process every pause — every capture starts
   *  this way; the app offers no other mode. OFF (reachable only in code) = no
   *  live processing; one batch run over the full transcript at end. */
  liveModeEnabled: boolean
  /** Toggle live mode (flippable mid-meeting). Persists to the capture row. No
   *  UI calls it, and the next start re-arms live. */
  setLiveModeEnabled: (enabled: boolean) => void
  /** Force-persist the in-memory transcript for the ACTIVE capture before a
   *  chat turn to the live agent, so the server-side live-meeting context block
   *  (buildLiveCaptureContext reads captures.transcript) sees everything
   *  finalized up to this instant instead of the last debounced save. No-op
   *  when the id isn't the active recording (stale conversation) or nothing is
   *  recording (a stopped capture was already final-saved). */
  flushTranscriptForAgent: (captureId: string) => Promise<void>
  /** Corrections log — user overrides of agent suggestions, sent to agent on each call */
  correctionsLog: AgentCorrection[]
  /** Add a correction when the user overrides an agent suggestion */
  addCorrection: (correction: AgentCorrection) => void
  /** Register a navigate function (called by DashboardShell when mounted). The
   *  optional second fn undoes the optimistic capture-start navigation on mic /
   *  create failure (guarded in the shell: only if still viewing that capture). */
  registerNavigate: (fn: RecordingNavigateFn, goBack?: RecordingNavigateBackFn) => void
  /** Unregister the navigate function (called by DashboardShell on unmount) */
  unregisterNavigate: () => void
}

const RecordingContext = createContext<RecordingState | null>(null)

/** The stable subset of recording state: action functions + low-frequency flags
 *  that don't change at audio-frame rate. Consumers that only need these (the
 *  tab bar, capture button, tray handler, etc.) read this context instead of the
 *  full one, so they DON'T re-render ~10×/s on every audio-level update during a
 *  recording — only the live-recording UI (detail panel, chat capture panel),
 *  which genuinely needs `levels`/`elapsed`/`transcriptSegments`, consumes the
 *  full RecordingContext. */
export interface RecordingStableState {
  isRecording: boolean
  captureId: string | null
  /** Optimistic-start window: true from Capture click until the mic confirms.
   *  Low-frequency (flips twice per start), so it belongs in the stable subset —
   *  the Capture button + detail panel show "starting" affordances off it. */
  isStarting: boolean
  recordingError: string | null
  transcriptionStatus: RecordingState['transcriptionStatus']
  pendingRecovery: RecordingState['pendingRecovery']
  startRecording: RecordingState['startRecording']
  startRecordingForCapture: RecordingState['startRecordingForCapture']
  stopRecording: RecordingState['stopRecording']
  resumeCapture: RecordingState['resumeCapture']
  discardRecording: RecordingState['discardRecording']
  confirmRecovery: RecordingState['confirmRecovery']
  dismissRecovery: RecordingState['dismissRecovery']
  registerNavigate: RecordingState['registerNavigate']
  unregisterNavigate: RecordingState['unregisterNavigate']
  // Pause/resume controls + flags. Low-frequency (they change on pause/resume
  // and meeting-end finalize, NOT at audio-frame rate) and the two actions are
  // identity-stable useCallbacks — so they belong in the stable subset. This
  // lets the global Capture button drive pause/stop without subscribing to the
  // full, high-frequency RecordingContext (which would re-render it ~10×/s).
  isPaused: RecordingState['isPaused']
  isAgentFinalizing: RecordingState['isAgentFinalizing']
  pauseRecording: RecordingState['pauseRecording']
  resumeRecording: RecordingState['resumeRecording']
  // On-demand transcript flush for a chat talk-back turn. Identity-stable
  // useCallback (deps: [saveTranscript], itself []), so it belongs in the stable
  // subset — the chat panel can await it before a live turn WITHOUT subscribing
  // to the full, audio-frame-rate context.
  flushTranscriptForAgent: RecordingState['flushTranscriptForAgent']
  // A directive for the note-taker landed: run a record turn now, or once the
  // turn in flight settles (live-agent messaging L3). Identity-stable
  // useCallback over a ref; a no-op unless that capture is recording live.
  requestRecordTurn: RecordingState['requestRecordTurn']
  // Read the LATEST in-memory transcript segments on demand. A stable getter
  // (reads the external store's snapshot) rather than a raw array — so the chat
  // panel's per-turn context builder sees the freshest segments at TURN time
  // without re-rendering on every ~150ms transcript update.
  getTranscriptSegments: RecordingState['getTranscriptSegmentsSnapshot']
  // Audio levels + elapsed external-store accessors (identity-stable useCallbacks
  // from useRecording). Live here in the STABLE subset so the leaf hooks
  // useAudioLevels()/useRecordingElapsed() can read+subscribe via
  // useSyncExternalStore WITHOUT subscribing to the volatile full context — only
  // the subscribing leaf (waveform / timer readout) re-renders per audio frame.
  getLevels: RecordingState['getLevels']
  subscribeLevels: RecordingState['subscribeLevels']
  getElapsed: RecordingState['getElapsed']
  subscribeElapsed: RecordingState['subscribeElapsed']
  // Transcript segments external-store accessors — same rationale as levels: the
  // useTranscriptSegments() leaf hook reads+subscribes here so only the component
  // painting the live transcript re-renders per ~150ms flush, not the full context.
  getTranscriptSegmentsSnapshot: RecordingState['getTranscriptSegmentsSnapshot']
  subscribeTranscriptSegments: RecordingState['subscribeTranscriptSegments']
  // Derived-transcript-signal + activity-feed store accessors (audit finding 7)
  // — the useFinalSegmentCount()/useDetectedSpeakers()/useAgentActivity() leaf
  // hooks read+subscribe here so per-utterance signal changes re-render only
  // the leaf that paints them, not every context consumer.
  getFinalSegmentCount: RecordingState['getFinalSegmentCount']
  subscribeFinalSegmentCount: RecordingState['subscribeFinalSegmentCount']
  getDetectedSpeakers: RecordingState['getDetectedSpeakers']
  subscribeDetectedSpeakers: RecordingState['subscribeDetectedSpeakers']
  getAgentActivity: RecordingState['getAgentActivity']
  subscribeAgentActivity: RecordingState['subscribeAgentActivity']
  // Live-agent status store accessors — provider-owned (the status is provider
  // state, cycled twice per live-agent turn). Read via useLiveAgentStatus().
  getLiveAgentStatus: () => LiveAgentStatus
  subscribeLiveAgentStatus: (cb: () => void) => () => void
  // Voice ID auto-accept countdown tick store accessors (1 Hz while a suggestion
  // counts down) — read via useAutoAcceptCountdown() at the one chip that
  // paints the number, so a tick never touches speakerContacts / the context.
  getAutoAcceptTick: RecordingState['getAutoAcceptTick']
  subscribeAutoAcceptTicks: RecordingState['subscribeAutoAcceptTicks']
}

const RecordingStableContext = createContext<RecordingStableState | null>(null)

/** Auto-save transcript interval in ms. 30s keeps the server copy fresh for
 *  resume/recovery (the recovery marker is refreshed on the same tick) while
 *  halving the per-session PATCH volume vs. the old 15s cadence. */
const TRANSCRIPT_SAVE_INTERVAL = 30_000

/** Consecutive 5xx/network delta-append failures before we stop retrying the
 *  same delta and take the full-text PATCH fallback. Low enough to recover fast
 *  from a persistent server-side break (the 2026-07-10 append outage), high
 *  enough to ride out a one-off transient 500 without switching write paths. */
const APPEND_SERVER_FAIL_FALLBACK_THRESHOLD = 3

// ── Capture recovery ────────────────────────────────────────────
// Persists minimal state to localStorage so an interrupted capture
// can be resumed after a page reload or hard navigation.

const RECOVERY_KEY = 'ni-active-capture'
/** Max age (ms) of a recovery marker before we consider it stale. The marker
 *  is refreshed every 30s while recording, so this is how long a restart may
 *  take: a WebView that froze before it was quit, plus a slow relaunch, used to
 *  outlast the old 2 minutes and the capture was silently never offered. Ten
 *  minutes still means the same meeting (the server's abandoned-capture sweep
 *  waits an hour). */
const RECOVERY_MAX_AGE = 10 * 60_000
/** Checks of the marker's capture on launch before giving up for this launch.
 *  Right after a relaunch the network or the session can need a moment, and a
 *  failed check must not cost the resume. */
const RECOVERY_CHECK_ATTEMPTS = 3
/** Backoff step between those checks (1.5s, then 3s). */
const RECOVERY_CHECK_RETRY_MS = 1_500
/** Bound on each check, so a hung request can't stretch the window in which a
 *  recording started meanwhile could still meet a prompt. */
const RECOVERY_CHECK_TIMEOUT_MS = 5_000

interface RecoveryMarker {
  captureId: string
  elapsed: number
  savedAt: number
}

function writeRecoveryMarker(marker: RecoveryMarker) {
  try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(marker)) } catch { /* ignore */ }
}

function readRecoveryMarker(): RecoveryMarker | null {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY)
    if (!raw) return null
    return JSON.parse(raw) as RecoveryMarker
  } catch { return null }
}

function clearRecoveryMarker() {
  try { localStorage.removeItem(RECOVERY_KEY) } catch { /* ignore */ }
}

/**
 * The canonical end-of-meeting batch extraction: POST the capture to the
 * server's /api/ai/live-agent pipeline in batch mode. It runs for every
 * capture that takes a post-call pass (there is no local alternative).
 *
 * Returns true if extraction succeeded (caller then runs post-work + signals
 * capture-ended); false on failure (caller leaves the capture for Reprocess).
 * On failure it dispatches the processing-error event + toast itself, so the
 * caller only needs the boolean.
 */
async function runApiBatchExtraction(
  captureId: string,
  recipeId: string | null,
): Promise<boolean> {
  let authHeaders: Record<string, string> = {}
  try {
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) authHeaders['Authorization'] = `Bearer ${session.access_token}`
  } catch { /* cookies fallback */ }

  const res = await fetch('/api/ai/live-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      capture_id: captureId,
      mode: 'batch',
      recipe_id: recipeId || undefined,
      // This is the canonical END-OF-MEETING batch (not Reprocess), the only
      // path allowed to auto-archive a genuine mis-fire capture (GEN-135).
      // Reprocess is a recovery action and must never archive.
      allow_auto_archive: true,
    }),
  })
  // Surface a failure (incl. a 504 timeout on a very long meeting) so the user
  // knows to hit Reprocess — instead of the spinner silently vanishing.
  if (res.ok) return true
  const { toast } = await import('sonner')
  toast.error('Couldn’t process this meeting automatically. Open it and click Reprocess to try again.')
  window.dispatchEvent(
    new CustomEvent('ni:capture-processing-error', { detail: { captureId } }),
  )
  return false
}

// ── Live-agents availability ─────────────────────────────────────────────
// LIVE IS THE ONLY CAPTURE MODE (2026-10-10). Every capture — started from the
// Capture button, the meeting HUD, a calendar event or the tray, or resumed —
// runs with the live agent, on EVERY platform (web mic-only included), through
// the cloud live-agent path by default. The app no longer offers a live/batch
// switch. The post-capture (batch) pipeline stays in the tree and in use: it is
// the end-of-call pass `shouldRunPostLiveBatch` still runs after an assist-only
// live agent or for an edition's batch persona, and it is Reprocess.
// `liveModeEnabled` is therefore always on for a recording; its setter is kept
// (no UI calls it) so the batch-only path stays reachable in code.
//
// Every live turn and every post-call batch pass runs on the server (the eve
// live-agent and the server batch extraction).
//
// The whole machinery (transcript gate, /api/ai/live-agent pipeline, live status
// states) stays in the tree on the normal capture path so it never goes stale.

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [agentId, setAgentIdState] = useState<string | null>(null)
  // Whether the CURRENT `agentId` was put there by the capture panel's live lock
  // (the edition's declared LIVE persona) rather than chosen by the user. See
  // the end-of-call handoff rule at the batch call sites below.
  const agentIdFromLiveLockRef = useRef(false)
  const setAgentId = useCallback((id: string | null, opts?: { fromLiveLock?: boolean }) => {
    agentIdFromLiveLockRef.current = !!opts?.fromLiveLock && id !== null
    setAgentIdState(id)
  }, [])
  // The post-live batch hints (see `setPostLiveBatchHints` on the context type).
  // REFS, not state: nothing renders from them — the stop path reads them once —
  // and making them state would re-render every context consumer each time the
  // panel's agents list or edition resolves.
  const liveAgentAssistOnlyRef = useRef(false)
  const hasBatchDefaultRef = useRef(false)
  const setPostLiveBatchHints = useCallback(
    (hints: { liveAgentAssistOnly?: boolean; hasBatchDefault?: boolean }) => {
      if (hints.liveAgentAssistOnly !== undefined) {
        liveAgentAssistOnlyRef.current = hints.liveAgentAssistOnly
      }
      if (hints.hasBatchDefault !== undefined) {
        hasBatchDefaultRef.current = hints.hasBatchDefault
      }
    },
    [],
  )
  const [captureId, setCaptureId] = useState<string | null>(null)
  // Optimistic-start window (see startRecordingWithCapture): true from the
  // Capture click until the mic confirms or fails. Drives "starting" affordances.
  const [isStarting, setIsStarting] = useState(false)
  // ── liveAgentStatus as a REF-BACKED EXTERNAL STORE (audit finding 7) ──────
  // The status cycles twice per live-agent turn; as bare context state each
  // cycle re-rendered every volatile-context consumer (the whole capture detail
  // panel — for a 6px dot). It is now store-ONLY: there is no state mirror and
  // no context field. All writes route through publishLiveAgentStatus (the
  // useRecording callback below + the provider's own deferred/finalizing/idle
  // transitions), which writes the ref and notifies useLiveAgentStatus() leaf
  // subscribers only on an actual change — the provider itself never re-renders
  // for a status transition.
  const liveAgentStatusRef = useRef<LiveAgentStatus>('idle')
  const liveAgentStatusListenersRef = useRef<Set<() => void>>(new Set())
  const getLiveAgentStatus = useCallback(() => liveAgentStatusRef.current, [])
  const subscribeLiveAgentStatus = useCallback((cb: () => void) => {
    liveAgentStatusListenersRef.current.add(cb)
    return () => { liveAgentStatusListenersRef.current.delete(cb) }
  }, [])
  const publishLiveAgentStatus = useCallback(
    (next: LiveAgentStatus | ((prev: LiveAgentStatus) => LiveAgentStatus)) => {
      const value =
        typeof next === 'function'
          ? (next as (prev: LiveAgentStatus) => LiveAgentStatus)(liveAgentStatusRef.current)
          : next
      if (liveAgentStatusRef.current !== value) {
        liveAgentStatusRef.current = value
        liveAgentStatusListenersRef.current.forEach((cb) => cb())
      }
    },
    [],
  )
  const [correctionsLog, setCorrectionsLog] = useState<AgentCorrection[]>([])
  // Live mode: ON = process every pause (continuous); OFF = defer to a single
  // batch run at meeting end. ON, and every start re-arms it (see armLiveMode):
  // live is the only mode the app offers.
  const [liveModeEnabledState, setLiveModeEnabledState] = useState(true)
  // Effective live mode = the state, full stop. Available on every platform.
  const liveModeEnabled = liveModeEnabledState
  const liveModeEnabledRef = useRef(true)
  liveModeEnabledRef.current = liveModeEnabled
  // Every capture starts live (see the availability note above). Called first
  // thing by each start path, so a session can never inherit an earlier
  // setLiveModeEnabled(false). The ref is set too: the start reads it before
  // the re-render lands.
  const armLiveMode = useCallback(() => {
    liveModeEnabledRef.current = true
    setLiveModeEnabledState(true)
  }, [])
  // True while the end-of-meeting batch run is in flight — stops the
  // deferred-status effect from resetting the 'finalizing' state to idle.
  const batchRunningRef = useRef(false)
  // Guards stopRecordingWithCapture against concurrent / double invocation.
  const stoppingRef = useRef(false)
  // Guards startRecordingWithCapture against concurrent / double invocation. The
  // create POST now fires in parallel with mic startup, before the mic's own
  // "already active" re-entry check — so without this a fast double-click could
  // fire two create POSTs (two capture rows) before the second mic call rejects.
  const startingRef = useRef(false)
  // Mirror of agentId for use inside stopRecordingWithCapture (a useCallback)
  // without adding agentId to its deps / risking a stale closure.
  const agentIdRef = useRef<string | null>(null)
  agentIdRef.current = agentId

  /**
   * THE END-OF-CALL HANDOFF RULE, provider half.
   *
   * The persona a `mode: 'batch'` run should carry. An edition declares two
   * different personas (`defaultAgents` in src/lib/editions/manifest.ts) — one
   * that speaks to the user mid-call, one that writes the finished record — but
   * the client's selection is a single value, and while live mode is on the
   * capture panel LOCKS it to the live persona. That lock is the product's
   * choice, not the user's, so it must not follow the capture into a batch run:
   * a sales workspace would grade the transcript with `sales-live` and never
   * reach `sales-post-call`.
   *
   * This provider has no agents list and no edition, so it cannot name the batch
   * persona itself. It does the half it can: when the selection came from the
   * live lock, return `undefined` so NO `recipe_id` is sent and the SERVER
   * resolver (`resolveDefaultRecipeForCapture`, mode 'batch') picks the
   * edition's batch default. An explicit user pick is returned unchanged and is
   * NEVER overridden. The capture panel, which does have both, resolves the
   * batch agent id directly via `resolveBatchHandoffAgentId` so the user can see
   * which persona ran; both paths land on the same persona.
   */
  const batchRecipeId = useCallback((): string | undefined => {
    if (agentIdFromLiveLockRef.current) return undefined
    return agentIdRef.current || undefined
  }, [])

  const recording = useRecording({ liveAgentEnabled: liveModeEnabled, agentId, captureId, onLiveAgentStatusChange: publishLiveAgentStatus, correctionsLog })

  // Live-agent "talk back" HUD relay. Active only while actually recording a
  // live-agent meeting — opens the detached HUD, forwards say_to_user nudges to
  // it over Realtime broadcast, closes it on stop. Desktop-only (no-op on web).
  useAgentNudgeRelay(recording.isRecording && liveModeEnabled ? captureId : null, liveModeEnabled)
  // A capture records the mic and the system audio: no alert sounds in any
  // window meanwhile (they would be recorded into the meeting).
  useSoundQuietWhile(recording.isRecording || isStarting, 'capture')

  const navigateRef = useRef<RecordingNavigateFn | null>(null)
  const navigateBackRef = useRef<RecordingNavigateBackFn | null>(null)
  const captureIdRef = useRef<string | null>(null)
  const transcriptSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Server-row readiness for an optimistically-started capture: resolves true
  // once the create POST lands (row exists), false if it failed. Writers that
  // target the row (transcript saves) await this so they can't race the INSERT.
  // null outside an optimistic start (resume / tray paths bind existing rows).
  const createSettledRef = useRef<Promise<boolean> | null>(null)

  // Resume capture state — holds existing transcript and duration from prior sessions
  const existingTranscriptRef = useRef<string | null>(null)
  const previousDurationRef = useRef<number>(0)
  // True while a resume's prior-transcript prefetch is still loading. The mic
  // starts immediately on resume (don't make the user wait on the network), so
  // existingTranscriptRef may not be populated yet. While this is set, the
  // periodic auto-save skips a tick — saving now would persist ONLY the new
  // segments and clobber the prior transcript. It catches up on the next tick
  // once the prefetch resolves. (Resume always finishes well under the 15s save
  // interval, so at most one tick is skipped.)
  const resumePrefetchPendingRef = useRef(false)
  // Session generation for the transcript-seed prefetches. Every session entry
  // point (start / start-for-capture / resume / stop cleanup) increments it; a
  // prefetch captures the value at launch and bails from all ref writes when it
  // no longer matches — a late-resolving GET from a superseded session must
  // never overwrite the live session's bookkeeping (base_length poisoning).
  const seedGenerationRef = useRef(0)

  // Number of final segments persisted by the last successful auto-save. Lets the
  // periodic save skip the PATCH entirely when nothing new has been finalized
  // since (silence, pauses, idle stretches) — the dominant source of redundant
  // saves on a long call. Reset on start/resume/stop.
  const lastSavedFinalCountRef = useRef(0)

  // ── Delta-append bookkeeping ──────────────────────────────────────────────
  // The periodic auto-save no longer re-sends the WHOLE transcript each tick; it
  // POSTs only the NEW tail to /transcript-append. Two refs track exactly what
  // the server has CONFIRMED (advanced ONLY on a 2xx from the append route):
  //   - ackedFinalCountRef: how many final segments the server has (so the next
  //     append slices finalSegments[ackedFinalCount..]).
  //   - ackedTextLengthRef: the exact char length of the transcript the server
  //     holds. Doubles as the append route's `base_length` optimistic-concurrency
  //     token AND as the "prefix with '\n'?" signal (>0 ⇒ prepend the join
  //     separator, matching the full-save composition).
  // A failed/lost append leaves BOTH untouched, so the next tick re-sends the
  // identical delta (base still matches) — no hole is ever left. On resume,
  // ackedTextLength seeds from the restored server transcript length and
  // ackedFinalCount stays 0 (restored text is NOT in finalSegments; new segments
  // append AFTER it, exactly as the old full save did: restored + '\n' + new).
  const ackedFinalCountRef = useRef(0)
  const ackedTextLengthRef = useRef(0)
  // In-flight guard: appends must never overlap (a read-modify-write on the
  // server + optimistic base_length would race two concurrent deltas). The 30s
  // timer and the 2s debounce can both fire close together, so serialize.
  const appendInFlightRef = useRef(false)
  // Consecutive 5xx / network failures on the delta-append path. A transient 5xx
  // normally just leaves the acked refs untouched so the next tick retries the
  // same delta — but if the delta path is *persistently* broken (the 2026-07-10
  // outage: every append 500'd for 70 min), that retry-forever silently stops
  // persisting. After this many in a row we take the full-text PATCH fallback
  // (which uses a different route + write shape, so it self-heals) exactly like
  // the 4xx branch. Reset to 0 on any append success.
  const appendServerFailStreakRef = useRef(0)

  // Pending crash-recovery prompt. On launch we may find an interrupted capture
  // (the app died <10 min after its last save). Rather than silently turning the mic
  // back on, we surface this so the UI can ask the user whether to resume.
  const [pendingRecovery, setPendingRecovery] = useState<{ captureId: string; title: string } | null>(null)

  // Web mic-capture failure (permission denied / no device / mic in use / …).
  // Surfaced as a proper dialog instead of a raw red error string. null = no
  // dialog. Set when a web startRecording throws a WebAudioCaptureError.
  const [micCaptureError, setMicCaptureError] = useState<WebAudioCaptureErrorKind | null>(null)

  // Keep refs for latest values used in callbacks
  const recordingRef = useRef(recording)
  recordingRef.current = recording

  // (Historical: new captures used to default to batch, with live opt-in via a
  // panel toggle, and before that a mount effect applied a stored
  // `workspace.settings.live_mode_default`. Both are gone: every capture is live
  // — see the availability note above the provider.)

  // Show "deferred" while recording with live mode OFF (nothing processes until
  // the end). When live is ON, the recording hook drives the status, so we
  // leave it alone. liveAgentStatus is intentionally NOT a dependency: if it
  // were, the hook setting 'processing' (after a mid-meeting toggle ON) would
  // re-run this effect and clobber it back. We only react to the conditions
  // that actually warrant a 'deferred' state.
  // Custom vocabulary, loaded once the app is up so the first recording or
  // dictation is already corrected (src/lib/vocabulary/client.ts).
  useEffect(() => {
    void primeVocabulary()
  }, [])

  useEffect(() => {
    if (recording.isRecording && !liveModeEnabled) {
      publishLiveAgentStatus('deferred')
    }
    // publishLiveAgentStatus is an identity-stable useCallback (deps []).
  }, [recording.isRecording, liveModeEnabled, publishLiveAgentStatus])

  // On stop, clear a lingering 'deferred' to 'idle' — UNLESS the end-of-meeting
  // batch run is in flight (it owns the 'finalizing' → 'idle' transition).
  // Reading liveAgentStatus inside the body (not as a dep) avoids re-running
  // this when the batch run sets 'finalizing'.
  useEffect(() => {
    if (!recording.isRecording && !batchRunningRef.current) {
      publishLiveAgentStatus((s) => (s === 'deferred' ? 'idle' : s))
    }
    // publishLiveAgentStatus is an identity-stable useCallback (deps []).
  }, [recording.isRecording, publishLiveAgentStatus])

  /** Toggle live mode. No UI offers this any more (live is the only mode); kept
   *  so the batch-only path stays reachable in code. Flippable mid-meeting;
   *  persists intent to the capture row (best-effort) so the end-of-meeting
   *  batch decision and any later reconciler see the correct value. The next
   *  start re-arms live regardless (armLiveMode). */
  const setLiveModeEnabled = useCallback((enabled: boolean) => {
    // Flipping it on opens the live conversation below regardless of platform.
    setLiveModeEnabledState(enabled)
    const cid = captureIdRef.current
    if (cid) {
      // Row-readiness gate: during an optimistic start the row's INSERT may
      // still be in flight — a PATCH now would 404 and the toggle intent would
      // be lost (this session extracts live via the in-memory ref, but resume /
      // server-side readers would see the stale click-time value forever).
      void captureRowReady(cid).then((ready) => {
        if (!ready || captureIdRef.current !== cid) return
        fetch(`/api/account/captures/${cid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ live_mode: enabled }),
        }).catch(() => { /* best-effort; the in-memory ref still governs this session */ })
        // Flipping live mode ON mid-meeting must open the chat conversation —
        // the agent starts running immediately (useRecording sees
        // liveAgentEnabled), but without the conversation every writer no-ops
        // (no greeting, no proposals card, no questions in chat). The /live
        // endpoint is an atomic get-or-create, so this is a safe no-op if the
        // conversation already exists (e.g. the capture started with live mode
        // on). Inside the readiness gate for the same reason as the PATCH: the
        // get-or-create needs the capture row to exist.
        if (enabled) {
          void openLiveConversationRef.current(cid, agentIdRef.current)
        }
      })
    }
  }, [])

  /** Build the FULL `[speaker] text` transcript from the given final segments,
   *  prepending any prior-session transcript exactly as the historical full save
   *  did (restored + '\n' + new). Shared by all three full-text composition sites
   *  — the force PATCH on stop, the delta-append 409/4xx fallback, and the
   *  pagehide beacon flush — so they can never drift. */
  const buildFullTranscript = useCallback(
    (finalSegments: { speaker: string; text: string }[]) => {
      const newText = finalSegments.map((s) => `[${s.speaker}] ${s.text}`).join('\n')
      return existingTranscriptRef.current
        ? existingTranscriptRef.current + '\n' + newText
        : newText
    },
    [],
  )

  /** Save current transcript to the capture.
   *
   *  Two modes:
   *   - force === true (the authoritative final save on stop): FULL-TEXT PATCH to
   *     the no-shrink /captures/[id] route with force_transcript, exactly as
   *     before. It must always win even if shorter, so it never uses the delta
   *     path.
   *   - force === false (periodic + post-segment auto-save): DELTA-APPEND. POST
   *     only the new tail to /transcript-append with a base_length optimistic-
   *     concurrency token. On a base-length 409 we fall back to the full-text
   *     PATCH (no-shrink) and re-seed from what we sent; on a terminal lock we
   *     stop. Acked refs advance ONLY on a confirmed 2xx, so a lost append is
   *     re-sent on the next tick and never leaves a hole. */
  // Returns false ONLY when a FORCED save was rejected/failed (the transcript
  // may not be durable); every benign early-exit and the retrying delta path
  // return true.
  const saveTranscript = useCallback(async (
    captureId: string,
    force = false,
    opts?: { quiet?: boolean },
  ): Promise<boolean> => {
    // Hold off while a resume is still loading the prior transcript — saving now
    // would prepend nothing and overwrite the saved transcript with new segments
    // only. The next tick (or the final save on stop, which awaits the prefetch)
    // persists the full, concatenated transcript.
    if (resumePrefetchPendingRef.current) return true
    // Optimistic start: the capture row's INSERT may still be in flight. Wait for
    // it to settle before writing — a failed create means there is no row to save
    // to (the start path tears the session down). Resolved-true afterwards, so
    // this is a no-op await for the rest of the session.
    if (createSettledRef.current && !(await createSettledRef.current)) return true
    const segments = recordingRef.current.getTranscriptSegmentsSnapshot()
    if (!captureId || segments.length === 0) return true

    const finalSegments = segments.filter((s) => s.isFinal)
    if (finalSegments.length === 0) return true

    // Skip the redundant save when no new final segments have landed since the
    // last successful one (unless forced). This removes most ticks on a real
    // call where long silent stretches finalize nothing new.
    if (!force && finalSegments.length === lastSavedFinalCountRef.current) return true

    // ── Force: authoritative final save on stop — FULL-TEXT PATCH (unchanged) ──
    if (force) {
      // Bounded-wait for any in-flight delta append to clear before the
      // authoritative full-text PATCH, so Stop's write (and flushTranscriptForAgent,
      // which routes here too) can't interleave with a delta mid-flight. The
      // server CAS (transcript-append route) is the real data-loss guarantee; this
      // just restores deterministic ordering in the common case, so we cap the
      // wait and proceed anyway on timeout. Same bounded-poll pattern as the
      // resumePrefetchPendingRef wait in stopRecordingWithCapture.
      if (appendInFlightRef.current) {
        const deadline = Date.now() + 3_000
        while (appendInFlightRef.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      const transcriptText = buildFullTranscript(finalSegments)
      try {
        // Arm the realtime self-echo guard BEFORE the write: the capture-row
        // UPDATE fans back to this tab (workspace-entities channel) and would
        // otherwise pass wasRecentlyMutatedLocally → the detail panel's
        // refetch — a full-transcript GET per save. Accepted tradeoff: the
        // guard window also swallows teammate row updates while recording;
        // the panel's bespoke capture-stream channel (unguarded) still
        // delivers title/ended_at/ai_summary live, and the poll fallback
        // covers catch-up.
        markLocallyMutated('capture', captureId)
        const res = await fetch(`/api/account/captures/${captureId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // force_transcript opts out of the server's no-shrink guard — the final
          // save must always win even if shorter (e.g. a very short session).
          body: JSON.stringify({ transcript: transcriptText, force_transcript: true }),
        })
        if (!res.ok) {
          // A rejected final write (e.g. the DB transcript-lock trigger) used to
          // pass silently while the refs advanced as if durable — the transcript
          // was gone and nothing said so. Leave the refs untouched so a retry
          // still knows what's unsent, and make the failure loud (unless the
          // caller is a mid-meeting chat flush, whose segments the delta path
          // re-sends on the next tick anyway).
          if (!opts?.quiet) {
            trackRecordingEvent('final_transcript_save_failed', {
              capture_id: captureId,
              status: res.status,
            })
            toast.error('Final transcript save failed', {
              description: 'Part of this meeting\'s transcript may not have been saved.',
            })
          }
          return false
        }
        // Keep all bookkeeping coherent with the freshly-written full text, so a
        // (hypothetical) continued session would resume deltas from here cleanly.
        lastSavedFinalCountRef.current = finalSegments.length
        ackedFinalCountRef.current = finalSegments.length
        ackedTextLengthRef.current = transcriptText.length
      } catch (err) {
        console.warn('[RecordingProvider] Failed to save transcript (final):', err)
        if (!opts?.quiet) {
          trackRecordingEvent('final_transcript_save_failed', {
            capture_id: captureId,
            status: 0,
          })
          toast.error('Final transcript save failed', {
            description: 'Part of this meeting\'s transcript may not have been saved.',
          })
        }
        return false
      }
      return true
    }

    // ── Periodic / post-segment: DELTA-APPEND ──
    // In-flight guard: the 30s timer and the 2s debounce can fire close together;
    // overlapping appends would race the server read-modify-write + base_length.
    if (appendInFlightRef.current) return true
    appendInFlightRef.current = true
    try {
      const ackedCount = ackedFinalCountRef.current
      const baseLength = ackedTextLengthRef.current
      // Nothing new since the last acked append — nothing to send.
      if (finalSegments.length <= ackedCount) return true

      const newSegments = finalSegments.slice(ackedCount)
      const chunk = newSegments.map((s) => `[${s.speaker}] ${s.text}`).join('\n')
      // Prefix with the join separator when the server already holds text, so the
      // concatenation matches the full-save composition byte-for-byte.
      const appendText = baseLength > 0 ? '\n' + chunk : chunk

      // Server-fail handler shared by the network-catch and 5xx branches. Returns
      // true when the caller should STOP (leave acked refs untouched, retry the
      // identical delta next tick — no hole); false when the streak has crossed
      // the threshold and the caller should fall through to the full-text PATCH
      // fallback (a different route/write shape) to self-heal a persistent break.
      const shouldStopAfterServerFailure = (status: number): boolean => {
        appendServerFailStreakRef.current += 1
        if (appendServerFailStreakRef.current < APPEND_SERVER_FAIL_FALLBACK_THRESHOLD) {
          return true
        }
        // Threshold crossed — degrade to the full PATCH. Emit telemetry once at
        // the crossing so a persistent-append outage is queryable. status 0 =
        // network error (no HTTP status).
        trackRecordingEvent('transcript_save_degraded', {
          capture_id: captureId,
          reason: 'append_5xx_fallback',
          status,
        })
        return false
      }

      // null once we've decided to skip the delta path and go straight to the
      // full-text PATCH fallback (a network-streak fallback with no Response).
      let res: Response | null
      try {
        // Self-echo guard — same rationale as the force-PATCH arm above: the
        // append's realtime echo must not refetch the recorder's own write.
        markLocallyMutated('capture', captureId)
        res = await fetch(`/api/account/captures/${captureId}/transcript-append`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ append_text: appendText, base_length: baseLength }),
        })
      } catch (err) {
        console.warn('[RecordingProvider] Transcript append failed (network):', err)
        if (shouldStopAfterServerFailure(0)) return true
        console.warn('[RecordingProvider] Network-failure streak exceeded, falling back to full PATCH')
        res = null // fall through to the full-text PATCH below
      }

      if (res && res.ok) {
        const data = (await res.json().catch(() => null)) as { new_length?: number } | null
        const expected = baseLength + appendText.length
        // Verify the server landed exactly what we sent. If new_length diverges,
        // treat it as a mismatch and fall back to a full PATCH rather than trust
        // a bad advance. A reachable server (even a bad body) clears the streak.
        appendServerFailStreakRef.current = 0
        if (data && typeof data.new_length === 'number' && data.new_length === expected) {
          ackedFinalCountRef.current = finalSegments.length
          ackedTextLengthRef.current = data.new_length
          lastSavedFinalCountRef.current = finalSegments.length
          return true
        }
        // Length divergence → fall through to the full-PATCH fallback below.
      } else if (res && res.status === 409) {
        // Reachable server (just conflicting) → clear the streak.
        appendServerFailStreakRef.current = 0
        // Distinguish a terminal lock (stop forever) from a recoverable conflict
        // (base-length mismatch / concurrent-write CAS loss → full PATCH).
        const data = (await res.json().catch(() => null)) as { code?: string } | null
        if (data?.code === 'TRANSCRIPT_LOCKED') {
          // The capture ended / transcript is locked. No append can ever succeed;
          // stop trying. Freeze the skip-guard at the current count so the
          // periodic timer no-ops for the rest of this (now-terminal) session.
          lastSavedFinalCountRef.current = finalSegments.length
          trackRecordingEvent('transcript_save_degraded', {
            capture_id: captureId,
            reason: 'locked_terminal',
          })
          console.warn('[RecordingProvider] Transcript append rejected: capture locked')
          return true
        }
        // Base-length mismatch / concurrent write (or any other 409) → fall
        // through to full PATCH.
      } else if (res && res.status >= 400 && res.status < 500) {
        // Any OTHER 4xx (e.g. a 400 for an oversized append after a long offline
        // gap): the delta path is UNUSABLE for this request — retrying the same
        // delta would rebuild the identical rejected payload every tick and wedge
        // incremental persistence for the rest of the session. Fall back to the
        // full-text no-shrink PATCH (same as the 409 path) so it self-heals. A
        // reachable server clears the streak.
        appendServerFailStreakRef.current = 0
        trackRecordingEvent('transcript_save_degraded', {
          capture_id: captureId,
          reason: 'append_4xx_fallback',
          status: res.status,
        })
        console.warn('[RecordingProvider] Transcript append 4xx, falling back to full PATCH:', res.status)
        // Fall through to full PATCH.
      } else if (res) {
        // 5xx (e.g. a transient 500). Normally leave acked refs untouched and
        // retry the identical delta next tick (no hole). But a PERSISTENT 5xx
        // (the 2026-07-10 outage: every append 500'd for ~70 min) would retry
        // forever and silently stop persisting — so once the streak crosses the
        // threshold, fall through to the full-text PATCH (a different route) to
        // self-heal.
        console.warn('[RecordingProvider] Transcript append failed (5xx):', res.status)
        if (shouldStopAfterServerFailure(res.status)) return true
        console.warn('[RecordingProvider] 5xx streak exceeded, falling back to full PATCH')
        // Fall through to full PATCH.
      }
      // (res === null → the network-streak fallback already chose the full PATCH;
      //  fall straight through to it.)

      // ── Fallback: full-text PATCH via the no-shrink route ──
      // Reached on a base-length 409 or a new_length divergence. Re-establish
      // ground truth by sending the WHOLE transcript (no force — the no-shrink
      // guard still protects it), then re-seed the acked refs from what we sent
      // on success so deltas resume coherently.
      const transcriptText = buildFullTranscript(finalSegments)
      try {
        // Re-arm the self-echo guard: on the degraded path (append hung, then
        // failed) the arm before the delta POST may already be near/past its
        // 10s TTL by the time this second round trip's echo lands.
        markLocallyMutated('capture', captureId)
        const patchRes = await fetch(`/api/account/captures/${captureId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: transcriptText }),
        })
        if (patchRes.ok) {
          const patchData = (await patchRes.json().catch(() => null)) as
            | { transcript_guard_skipped?: boolean }
            | null
          // The no-shrink guard rejected our full text (server holds something
          // longer). Don't re-seed to a length the server didn't accept — leave
          // acked refs alone and let the next tick reconcile.
          if (patchData?.transcript_guard_skipped) {
            trackRecordingEvent('transcript_save_degraded', {
              capture_id: captureId,
              reason: 'guard_skipped',
            })
            console.warn('[RecordingProvider] Full-PATCH fallback no-shrink-skipped')
            return true
          }
          // Ground truth re-established via the fallback route — clear the
          // server-fail streak so a future transient append 5xx starts fresh.
          appendServerFailStreakRef.current = 0
          ackedFinalCountRef.current = finalSegments.length
          ackedTextLengthRef.current = transcriptText.length
          lastSavedFinalCountRef.current = finalSegments.length
        }
        // A non-ok PATCH leaves acked refs untouched — the next tick retries.
      } catch (err) {
        console.warn('[RecordingProvider] Full-PATCH fallback failed:', err)
      }
    } finally {
      appendInFlightRef.current = false
    }
    return true
  }, [buildFullTranscript])

  // Periodic transcript auto-save while recording + update recovery marker
  useEffect(() => {
    if (recording.isRecording && captureIdRef.current) {
      const cid = captureIdRef.current
      // Fresh recording session: in-memory transcript starts empty, so reset the
      // saved-count baseline (a resume already zeroed it; this covers new starts).
      // The delta-append acked refs are reset/seeded by the start path
      // (startRecordingWithCapture → 0/0) and the resume path (resumeCapture →
      // count 0, length from the restored server text) — NOT here, because this
      // effect runs for both and can't distinguish them, and clobbering the resume
      // seed would corrupt the first append's base_length.
      lastSavedFinalCountRef.current = 0
      transcriptSaveTimerRef.current = setInterval(() => {
        saveTranscript(cid)
        // Update recovery marker with latest elapsed time (elapsed is now an
        // external store — read the current value via the stable accessor).
        writeRecoveryMarker({ captureId: cid, elapsed: recordingRef.current.getElapsed(), savedAt: Date.now() })
      }, TRANSCRIPT_SAVE_INTERVAL)
    }

    return () => {
      if (transcriptSaveTimerRef.current) {
        clearInterval(transcriptSaveTimerRef.current)
        transcriptSaveTimerRef.current = null
      }
    }
  }, [recording.isRecording, saveTranscript])

  // Event-driven save: persist shortly after each NEW finalized segment lands,
  // not just on the 30s tick. This shrinks the worst-case unsaved window from
  // ~30s+ to a couple seconds. Debounced so a burst of finals (fast back-and-
  // forth) coalesces into one PATCH. The periodic timer above remains as a
  // belt-and-suspenders fallback (and still updates the recovery marker). The
  // save is guarded server-side (no-shrink) and skips internally when nothing
  // new finalized, so a redundant fire here is harmless.
  //
  // Driven by a STORE SUBSCRIPTION, not a re-render (audit finding 7): this
  // effect used to depend on the `finalSegmentCount` state mirror, which meant
  // the provider re-rendered on every finalized utterance for the whole meeting
  // just to re-arm a timer. Subscribing directly re-arms the debounce from the
  // store notification with zero renders.
  const segmentSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subscribeFinalSegmentCount = recording.subscribeFinalSegmentCount
  const getFinalSegmentCount = recording.getFinalSegmentCount
  useEffect(() => {
    if (!recording.isRecording) return
    const arm = () => {
      const cid = captureIdRef.current
      if (!cid || getFinalSegmentCount() === 0) return
      if (segmentSaveDebounceRef.current) clearTimeout(segmentSaveDebounceRef.current)
      segmentSaveDebounceRef.current = setTimeout(() => {
        segmentSaveDebounceRef.current = null
        saveTranscript(cid)
      }, 2_000)
    }
    // Arm once for whatever already finalized before this effect ran (a
    // resume, or a re-arm after the recording flag flipped).
    arm()
    const unsubscribe = subscribeFinalSegmentCount(arm)
    return () => {
      unsubscribe()
      if (segmentSaveDebounceRef.current) {
        clearTimeout(segmentSaveDebounceRef.current)
        segmentSaveDebounceRef.current = null
      }
    }
  }, [recording.isRecording, subscribeFinalSegmentCount, getFinalSegmentCount, saveTranscript])

  // On-demand flush for chat talk-back turns: the live-meeting context block is
  // built server-side from captures.transcript, so a question about something
  // said seconds ago must not race the debounced save above. Callers await this
  // (capped) before sending the turn. Guards: only the ACTIVE recording's
  // segments live in client memory — a stale capture id (an old conversation)
  // must never save the current session's transcript under the wrong capture.
  const flushTranscriptForAgent = useCallback(
    async (captureId: string) => {
      if (!captureId || captureId !== captureIdRef.current) return
      if (!recordingRef.current.isRecording) return
      // quiet: a transient mid-meeting flush failure is retried by the delta
      // path on the next tick — it must not fire the stop-time failure toast
      // and 'final_transcript_save_failed' telemetry on every chat turn.
      await saveTranscript(captureId, true, { quiet: true })
    },
    [saveTranscript],
  )

  // Identity-stable getter for the latest in-memory transcript segments. Reads
  // recordingRef.current (kept fresh every render, above) so a consumer of the
  // STABLE context can grab the freshest segments at call time — e.g. the chat
  // panel's per-turn live-context builder — without subscribing to the full,
  // high-frequency RecordingContext (which re-renders ~10×/s on audio frames).
  const getTranscriptSegments = useCallback(
    () => recordingRef.current.getTranscriptSegmentsSnapshot(),
    [],
  )

  // Write recovery marker on beforeunload so we can resume after a hard navigation.
  // Also warn the user if the live agent is still processing the final segment.
  // pagehide fires on tab close / app teardown (and is more reliable than
  // beforeunload on WebKit); we flush the latest transcript there via sendBeacon
  // because a normal async fetch can't complete during teardown. sendBeacon is a
  // POST, so it routes to a dedicated beacon endpoint (the PATCH route can't read
  // it). force=false equivalent — the server no-shrink guard still protects it.
  useEffect(() => {
    const flushViaBeacon = () => {
      const cid = captureIdRef.current
      if (!cid || !recordingRef.current.isRecording) return
      if (resumePrefetchPendingRef.current) return
      const segments = recordingRef.current.getTranscriptSegmentsSnapshot().filter((s) => s.isFinal)
      if (segments.length === 0) return
      const transcriptText = buildFullTranscript(segments)
      // Self-echo guard — same one-liner as the other three transcript write
      // sites (force PATCH, delta append, full-PATCH fallback). The beacon's
      // capture-row UPDATE echoes back over realtime whenever the tab survives
      // the unload (user clicks Stay on the leave-confirmation, bfcache
      // restore) and must not trigger a full-transcript refetch of our own
      // write.
      markLocallyMutated('capture', cid)
      try {
        const blob = new Blob(
          [JSON.stringify({ capture_id: cid, transcript: transcriptText })],
          { type: 'application/json' },
        )
        navigator.sendBeacon('/api/account/captures/transcript-beacon', blob)
      } catch { /* best-effort */ }
    }

    const beforeUnload = (e: BeforeUnloadEvent) => {
      const cid = captureIdRef.current
      if (cid && recordingRef.current.isRecording) {
        writeRecoveryMarker({ captureId: cid, elapsed: recordingRef.current.getElapsed(), savedAt: Date.now() })
      }
      flushViaBeacon()
      // Prevent tab close during agent finalization to avoid data loss
      if (recordingRef.current.isAgentFinalizing) {
        e.preventDefault()
      }
    }
    const onPageHide = () => {
      const cid = captureIdRef.current
      if (cid && recordingRef.current.isRecording) {
        writeRecoveryMarker({ captureId: cid, elapsed: recordingRef.current.getElapsed(), savedAt: Date.now() })
      }
      flushViaBeacon()
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
    // buildFullTranscript is an identity-stable useCallback (deps []) — listed so
    // the beacon composition stays in lockstep with the shared helper.
  }, [buildFullTranscript])

  /** Wrapped startRecording: starts the mic and creates the capture record
   *  CONCURRENTLY, then navigates to the detail panel as soon as both resolve.
   *
   *  Why concurrent: native audio startup (Core Audio device init + system-audio
   *  preflight) takes a few hundred ms, and the create POST is independent of it.
   *  Running them in parallel — instead of mic-then-POST — removes the native
   *  startup time from the path to opening the capture tab, which is the main
   *  source of "starting a new capture is slow" (resume is instant because it
   *  reuses an existing row + mounted panel and never hits this POST).
   *
   *  No-orphan guarantee preserved: if the mic fails (e.g. another window owns the
   *  recording), we delete the capture the POST may have created. We do NOT
   *  navigate until the mic has confirmed, so a mic failure never opens a panel. */
  // The agent the live conversation was last opened with, per capture — the
  // mid-call agent-change effect below compares against it.
  const liveConversationPersonaRef = useRef<{ captureId: string; recipeId: string | null } | null>(null)
  // Opens run one at a time, in call order: a re-fire (agent change, live
  // toggle) must never be overtaken by an earlier call still in flight, or a
  // stale persona could land on the conversation last.
  const liveConversationQueueRef = useRef<Promise<void>>(Promise.resolve())
  // Get-or-create the capture's chat conversation and announce it in this window
  // (LIVE_CAPTURE_CONVERSATION_EVENT: the HUD's chat talks to the live agent on
  // it). Best-effort: any failure just leaves the live agent on its
  // proposals/HUD-only path.
  const openLiveConversation = useCallback(
    (id: string, recipeId: string | null) => {
      liveConversationPersonaRef.current = { captureId: id, recipeId }
      const run = liveConversationQueueRef.current.then(async () => {
        try {
          const res = await fetch('/api/account/chat-history/live', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capture_id: id, recipe_id: recipeId }),
          })
          if (!res.ok) return
          const { conversationId, recipeId: pinnedRecipeId } = (await res.json()) as {
            conversationId?: string
            recipeId?: string | null
          }
          if (!conversationId) return
          window.dispatchEvent(
            new CustomEvent('ni:live-capture-conversation', {
              // `recipeId` is the agent the conversation is pinned to (the server's
              // answer, not the request): the HUD's chat talks as that agent, and
              // re-pins when a re-fire carries a different one.
              detail: { conversationId, captureId: id, recipeId: pinnedRecipeId ?? null },
            }),
          )
        } catch {
          // Live conversation is a best-effort surface — never break recording.
        }
      })
      liveConversationQueueRef.current = run
      return run
    },
    [],
  )
  // Stable ref so startRecordingWithCapture (deps: []) can call it without
  // taking it as a dependency (which would churn the context value).
  const openLiveConversationRef = useRef(openLiveConversation)
  openLiveConversationRef.current = openLiveConversation

  // Mid-call agent change → re-point the live conversation at the new agent.
  // The capture panel's live lock often selects the agent AFTER the recording
  // (and so the conversation) started, and both the chat tab and the local live
  // loop read the persona from the conversation. Re-firing the idempotent /live
  // open with the new id updates the row and re-dispatches the event, and the
  // chat tab re-pins. Compared against what was last SENT for this capture, so
  // it only fires once the conversation has been opened — never to create it
  // early (the capture row may not exist yet) — and never re-fires for a value
  // it already sent.
  useEffect(() => {
    const cid = captureIdRef.current
    if (!recording.isRecording || !liveModeEnabled || !cid) return
    const opened = liveConversationPersonaRef.current
    if (!opened || opened.captureId !== cid || opened.recipeId === agentId) return
    void openLiveConversationRef.current(cid, agentId)
  }, [agentId, recording.isRecording, liveModeEnabled])

  const startRecordingWithCapture = useCallback(async () => {
    // Re-entry guard: a double-click must not mint two captures now that the id
    // is client-generated and bound before any await.
    if (startingRef.current || recordingRef.current.isRecording) return
    startingRef.current = true
    setIsStarting(true)
    try {
    // Serialize behind an in-flight stop. Stop's tail has real suspension
    // windows (the resume-prefetch poll and the append-in-flight wait) during
    // which the button already reads idle — and the optimistic reset below
    // clobbers exactly the refs that tail still reads (existingTranscriptRef,
    // acked*, createSettledRef). Starting inside that window can gate the OLD
    // capture's authoritative final save on the NEW capture's create, or
    // compose a resumed capture's force save WITHOUT its prior transcript and
    // force-PATCH a shrunken copy over it. Bounded poll (same pattern as stop's
    // own prefetch wait); if the stop is wedged past the deadline, bail rather
    // than start on top of it.
    if (stoppingRef.current) {
      const deadline = Date.now() + 8_000
      while (stoppingRef.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (stoppingRef.current) return
    }
    armLiveMode()
    const now = new Date()
    const title = `Capture ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

    // ── Optimistic start: bind + seed + navigate SYNCHRONOUSLY ────────────────
    // The capture id is CLIENT-minted, so nothing on the click→panel path needs
    // the server: the detail panel opens on this render pass while the create
    // POST and mic startup race in the background. The panel renders from the
    // seeded cache (its mount GET tolerates a 404 while the INSERT is in
    // flight); `isStarting` drives its recording affordance until the mic
    // confirms. Failure of either background leg tears this back down below.
    const id = crypto.randomUUID()
    captureIdRef.current = id
    setCaptureId(id)
    // Brand-new capture: the server transcript is empty, so the delta-append
    // bookkeeping starts from zero. (A prior recording that stopped this session
    // left ackedTextLength non-zero via its force save; reset it here so the
    // first append of the NEW capture uses base_length 0 and no '\n' prefix.)
    ackedFinalCountRef.current = 0
    ackedTextLengthRef.current = 0
    existingTranscriptRef.current = null
    seedGenerationRef.current += 1
    seedCaptureCache({
      id,
      title,
      created_at: now.toISOString(),
      status: 'active',
      is_pinned: false,
      started_at: now.toISOString(),
      recorded_at: now.toISOString(),
    })
    navigateRef.current?.({ captureId: id, title })

    // Create POST (with the client-minted id), in parallel with mic startup.
    const createPromise = fetch('/api/account/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        title,
        started_at: now.toISOString(),
        live_mode: liveModeEnabledRef.current,
        // Audio topology — desktop records mic + system audio on separate
        // channels; web records one mic channel shared by everyone. The server
        // stores this in capture metadata; only desktop_dual can ever earn a
        // position self-binding (see lib/live-agent/self-binding.ts).
        capture_mode: isDesktopApp() ? 'desktop_dual' : 'web_mic_only',
      }),
    })
      .then(async (res) => (res.ok ? res.json() : null))
      .catch(() => null)
    // Row-readiness gate for writers (transcript saves) that must not race the
    // INSERT. Captured locally too so the failure paths below can read it after
    // the ref has been cleared/reused.
    const createSettled = createPromise.then(
      (data: { capture?: { id?: string } } | null) => Boolean(data?.capture),
    )
    createSettledRef.current = createSettled
    // Panel-side writers (title rename, summary autosave, live_mode, agent
    // folder) gate on this via captureRowReady — their PATCHes would otherwise
    // 404 against the not-yet-inserted row and be silently lost.
    registerPendingCaptureCreate(id, createSettled)

    // Undo for both failure legs: unbind, drop the optimistic cache entry, and
    // step back if the user is still looking at this capture (shell-guarded).
    const undoOptimisticStart = () => {
      if (captureIdRef.current === id) {
        captureIdRef.current = null
        setCaptureId(null)
      }
      if (createSettledRef.current === createSettled) createSettledRef.current = null
      captureDetailCache.delete(id)
      // Only clear a recovery marker THIS capture owns. The marker is one
      // shared localStorage key across every window on the origin — an
      // unconditional clear here would wipe another window's live marker (the
      // multi-window "already active" rejection lands in exactly this path) or
      // a pending crash-recovery offer.
      if (readRecoveryMarker()?.captureId === id) clearRecoveryMarker()
      // Close any mounted detail panel for this capture in EVERY tab — the
      // goBack below only rewinds the ACTIVE tab, and on the no-row leg
      // (create POST failed) there is no realtime DELETE to heal a panel left
      // mounted in a background tab (it would sit there live-looking, its
      // edits 404ing silently).
      window.dispatchEvent(
        new CustomEvent('ni:capture-start-undone', { detail: { captureId: id } }),
      )
      navigateBackRef.current?.(id)
    }

    // Start the mic. If it rejects (e.g. another window is recording,
    // permission denied), tear the optimistic UI back down — and delete the
    // capture row iff the POST actually created it, so no orphan is left.
    try {
      await recordingRef.current.startRecording()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      undoOptimisticStart()
      void createSettled.then((created) => {
        if (created) {
          fetch(`/api/account/captures/${id}`, { method: 'DELETE' }).catch(() => {})
        }
      })
      // Web mic-capture failures (permission denied / no device / mic in use)
      // get a proper explanatory dialog instead of a stray red error string.
      if (e instanceof WebAudioCaptureError) {
        setMicCaptureError(e.kind)
      } else if (msg.includes('already active')) {
        // Multi-window conflict (desktop) — a quick toast is enough.
        const { toast } = await import('sonner')
        toast.error('A capture is already running in another window. Stop it first.')
      }
      return
    }

    // Await the create result (likely already resolved — it raced the mic). If
    // it failed there is no row to persist into: stop the mic and undo rather
    // than record into the void.
    const data = await createPromise
    // A Stop may have raced the create round trip (stop nulls captureIdRef
    // synchronously at click, precisely so concurrent code can detect it). The
    // session is already over and stop's own writes were gated on
    // createSettled — do NOT re-seed a stale 'active' cache row or open a live
    // conversation for a dead capture.
    if (captureIdRef.current !== id) return
    if (!data?.capture) {
      console.error('[RecordingProvider] Capture create failed during start')
      undoOptimisticStart()
      try { await recordingRef.current.stopRecording() } catch { /* best-effort */ }
      const { toast } = await import('sonner')
      toast.error('Could not start the capture — please try again.')
      return
    }
    // Re-seed with the server's canonical row (authoritative timestamps).
    seedCaptureCache(data.capture)

    // Mic is live AND the capture row genuinely exists — recording is truly
    // underway: announce that a capture has begun, for EVERYONE (no live-mode /
    // desktop gate) — the counterpart of the -processing-start / -ended events
    // that only fire at Stop. Carries only the capture id.
    //
    // Dispatched AFTER the create POST is confirmed (not before the await above),
    // so no listener ever hears of a capture we're about to tear back down.
    window.dispatchEvent(
      new CustomEvent('ni:capture-started', { detail: { captureId: id } }),
    )

    // Live mode: get-or-create the capture's chat conversation so the meeting
    // agent can greet and post its findings there, in the HUD's chat.
    // Best-effort — a failure just means the agent falls back to proposals/HUD
    // only. Fire-and-forget; the announcement reaches the HUD.
    if (liveModeEnabledRef.current) {
      void openLiveConversationRef.current(id, agentIdRef.current)
    }
    } finally {
      startingRef.current = false
      setIsStarting(false)
    }
    // Calls into recording via recordingRef.current so this stays identity-stable
    // (depending on `recording` would re-create it every render — recording is a
    // fresh object each render — and churn the stable context value).
    // armLiveMode is identity-stable (deps []).
  }, [armLiveMode])

  /** Start recording for an existing capture: one made from a calendar event
   *  (the calendar's Start, the tray, the meeting HUD) or a resume.
   *
   *  `title` opens the capture the way the Capture button does — through the
   *  registered navigate, as a card in the main chat — before the mic starts,
   *  and undoes that if the mic fails. Resume passes none: its capture is already on screen. */
  const bindAndStartForCapture = useCallback(async (
    existingCaptureId: string,
    opts?: { skipTranscriptSeed?: boolean; title?: string },
  ) => {
    // Unguarded: callers (startRecordingForCapture, resumeCapture) own the
    // startingRef re-entry guard around this.
    armLiveMode()
    captureIdRef.current = existingCaptureId
    setCaptureId(existingCaptureId)
    writeRecoveryMarker({ captureId: existingCaptureId, elapsed: 0, savedAt: Date.now() })
    if (opts?.title) {
      navigateRef.current?.({ captureId: existingCaptureId, title: opts.title })
    }
    if (!opts?.skipTranscriptSeed) {
      // The bound capture may be a reused row that already holds text (a
      // pending sync row is empty, but a crash orphan isn't). Reset the
      // session refs and seed them from the server copy — without this the
      // first delta append sends base_length 0, mismatches, and the full-PATCH
      // fallback rebuilds from this session's segments only, leaving the
      // server's no-shrink guard as the sole thing between the prior text and
      // a wholesale overwrite. Mirrors resumeCapture's prefetch (which passes
      // skipTranscriptSeed — it has already done all of this plus the unlock).
      existingTranscriptRef.current = null
      previousDurationRef.current = 0
      lastSavedFinalCountRef.current = 0
      ackedFinalCountRef.current = 0
      ackedTextLengthRef.current = 0
      resumePrefetchPendingRef.current = true
      seedGenerationRef.current += 1
      const generation = seedGenerationRef.current
      void (async () => {
        const ac = new AbortController()
        const timeout = setTimeout(() => ac.abort(), 3_000)
        try {
          const res = await fetch(`/api/account/captures/${existingCaptureId}`, { signal: ac.signal })
          // A late-resolving GET from a superseded session (this start failed,
          // the user started something else) must not poison the live
          // session's refs — bail unless this prefetch still owns them.
          if (res.ok && seedGenerationRef.current === generation) {
            const data = await res.json()
            const cap = data.capture
            if (seedGenerationRef.current === generation) {
              if (typeof cap?.transcript === 'string' && cap.transcript) {
                existingTranscriptRef.current = cap.transcript
                ackedTextLengthRef.current = cap.transcript.length
              }
              previousDurationRef.current = cap?.duration_seconds || 0
            }
          }
        } catch (err) {
          console.warn('[RecordingProvider] Failed to prefetch capture before recording:', err)
        } finally {
          clearTimeout(timeout)
          // Success or failure, stop holding off saves — on failure the refs
          // stay zeroed, which under-estimates and falls back to the guarded
          // full PATCH exactly like a failed resume prefetch. Only the owning
          // generation may clear the hold-off (a superseded prefetch clearing
          // it would unblock saves against the NEW session's pending seed).
          if (seedGenerationRef.current === generation) {
            resumePrefetchPendingRef.current = false
          }
        }
      })()
    }
    try {
      await recordingRef.current.startRecording()
    } catch (err) {
      // Failed mic start: unbind so the in-flight prefetch can't seed a dead
      // session and a later start doesn't inherit this binding.
      seedGenerationRef.current += 1
      resumePrefetchPendingRef.current = false
      if (captureIdRef.current === existingCaptureId) {
        captureIdRef.current = null
        setCaptureId(null)
      }
      if (readRecoveryMarker()?.captureId === existingCaptureId) clearRecoveryMarker()
      if (opts?.title) navigateBackRef.current?.(existingCaptureId)
      throw err
    }
    // A Stop that raced the mic start already ended this session: open nothing.
    if (captureIdRef.current !== existingCaptureId) return
    if (liveModeEnabledRef.current) {
      // Every recording is live, but a row made outside the Capture button (a
      // calendar sync placeholder, from-event, an older capture being resumed)
      // can still say live_mode false: mark it, so server-side readers (the
      // abandoned-capture finalizer's needsBatchPass) treat it as this session
      // does. Best-effort, like setLiveModeEnabled's PATCH.
      fetch(`/api/account/captures/${existingCaptureId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live_mode: true }),
      }).catch(() => {})
      // The meeting agent's chat, as for a Capture-button start: get-or-create,
      // so a resume reattaches to the existing conversation without a second
      // greeting. The HUD's chat picks it up from the announcement.
      void openLiveConversationRef.current(existingCaptureId, agentIdRef.current)
    }
    // armLiveMode is identity-stable (deps []).
  }, [armLiveMode])

  const startRecordingForCapture = useCallback(async (
    existingCaptureId: string,
    opts?: { skipTranscriptSeed?: boolean; title?: string },
  ) => {
    // Same serialization as startRecordingWithCapture: during another start's
    // spin-up (isRecording still false) or a stop's async tail, an
    // unconditional rebind here would hijack captureIdRef — the in-flight
    // session's saves would then persist under THIS capture while the other
    // one is orphaned. Bail before mutating any binding. While genuinely
    // recording, refuse too: a second mic start resets the live session's
    // transcript, and its failure would unbind the capture still recording.
    if (startingRef.current || stoppingRef.current) return
    if (recordingRef.current.isRecording) throw new Error('Recording already active')
    startingRef.current = true
    try {
      await bindAndStartForCapture(existingCaptureId, opts)
    } finally {
      startingRef.current = false
    }
  }, [bindAndStartForCapture])

  /** Resume a previously stopped capture — unlocks transcript and starts recording.
   *
   *  The unlock is AWAITED before the mic starts (one extra round-trip):
   *  with the one-live-capture-per-user-per-event index (mig 226), clearing
   *  ended_at can conflict with a sync-created pending row for the same event
   *  — the resume route absorbs that placeholder server-side, and a genuine
   *  conflict (another session actively recording this meeting) must abort the
   *  resume BEFORE audio is captured into a still-locked row (the old
   *  fire-and-forget unlock silently lost the whole resumed session there).
   *  The prior-transcript prefetch still runs concurrently with the mic start;
   *  resumePrefetchPendingRef holds off the periodic auto-save meanwhile. */
  const resumeCapture = useCallback(async (existingCaptureId: string, opts?: { title?: string }) => {
    // Serialize against an in-flight start/stop (see startRecordingForCapture)
    // — resuming mid-spin-up would clobber existingTranscriptRef / acked refs
    // out from under the other session's save bookkeeping. It holds startingRef
    // itself from here on, so a double-clicked Resume (or a calendar Start
    // landing during the unlock POST) can't run a second start over this one.
    if (startingRef.current || stoppingRef.current) return
    if (recordingRef.current.isRecording) {
      trackRecordingEvent('resume_failed', {
        capture_id: existingCaptureId,
        reason: 'already_active',
        message: 'Recording already active',
      })
      throw new Error('Recording already active')
    }
    startingRef.current = true
    try {
    // Durable breadcrumb: a resume was attempted. Pairs with resume_failed below
    // and transcription_connected (use-recording) so the next "resume didn't
    // bring transcription back" report is reconstructable from the event stream.
    trackRecordingEvent('recording_resumed', { capture_id: existingCaptureId })

    try {
      const unlockRes = await fetch(`/api/account/captures/${existingCaptureId}/resume`, {
        method: 'POST',
      })
      if (!unlockRes.ok) {
        const data = (await unlockRes.json().catch(() => null)) as { error?: string } | null
        trackRecordingEvent('resume_failed', {
          capture_id: existingCaptureId,
          reason: 'unlock_rejected',
          message: data?.error || String(unlockRes.status),
        })
        toast.error('Could not resume capture', {
          description: data?.error || 'The capture could not be unlocked for recording.',
        })
        return
      }
    } catch (err) {
      trackRecordingEvent('resume_failed', {
        capture_id: existingCaptureId,
        reason: 'unlock_network',
        message: err instanceof Error ? err.message : String(err),
      })
      toast.error('Could not resume capture', {
        description: 'Network error while unlocking the capture.',
      })
      return
    }
    // Reset prior-session state and mark the prefetch in flight BEFORE the mic
    // starts (startRecording fires a periodic save on a timer — the guard must
    // already be set so the first tick can't race the prefetch).
    existingTranscriptRef.current = null
    previousDurationRef.current = 0
    lastSavedFinalCountRef.current = 0
    // Delta-append reset for the resumed session. The new session's segments
    // restart empty, so ackedFinalCount is 0 — new finals append AFTER the
    // restored server text (matching the old full save: restored + '\n' + new).
    // ackedTextLength is seeded to the RESTORED transcript's length once the
    // prefetch resolves (below); until then the auto-save is held off by
    // resumePrefetchPendingRef, so no append can fire against a wrong base. If the
    // prefetch fails, existingTranscriptRef stays null and the length stays 0 — a
    // safe under-estimate: the first append then sends base_length 0, mismatches
    // the server's real length, and falls back to the full-text PATCH (which
    // rebuilds new-segments-only; the server's no-shrink guard keeps the longer
    // stored copy). No data loss either way.
    ackedFinalCountRef.current = 0
    ackedTextLengthRef.current = 0
    resumePrefetchPendingRef.current = true
    seedGenerationRef.current += 1
    const generation = seedGenerationRef.current

    // Kick off the prior-transcript fetch concurrently — it does not need to
    // block the mic (the unlock above already did).
    const prefetch = (async () => {
      // Bound the GET so a hung connection can't hold resumePrefetchPendingRef
      // true and stall a subsequent stop (which polls a 5s deadline on it). On
      // abort/failure the finally clears the flag and existingTranscriptRef stays
      // null — safe, since the server still holds the prior transcript.
      const ac = new AbortController()
      const timeout = setTimeout(() => ac.abort(), 3_000)
      try {
        const res = await fetch(`/api/account/captures/${existingCaptureId}`, { signal: ac.signal })
        // Generation guard: a late-resolving prefetch from a superseded resume
        // must not overwrite the current session's bookkeeping.
        if (res.ok && seedGenerationRef.current === generation) {
          const data = await res.json()
          const cap = data.capture
          if (seedGenerationRef.current !== generation) return
          existingTranscriptRef.current = cap.transcript || null
          // Seed the delta-append base_length from the RESTORED server transcript
          // length. The first append after resume then uses this exact length as
          // its optimistic-concurrency token and prefixes the new chunk with '\n',
          // so the server concatenation (restored + '\n' + new) matches what the
          // old full-text save produced. Empty/absent restored transcript → 0.
          ackedTextLengthRef.current =
            typeof cap.transcript === 'string' ? cap.transcript.length : 0
          previousDurationRef.current = cap.duration_seconds || 0
          // (A resume no longer restores the row's stored live_mode: every
          // recording is live, and startRecordingForCapture below marks the row
          // and reopens the capture's chat conversation, whatever it said.)
        }
      } catch (err) {
        console.warn('[RecordingProvider] Failed to fetch capture for resume:', err)
      } finally {
        clearTimeout(timeout)
        // Whether the fetch succeeded or failed, stop holding off saves. On
        // failure existingTranscriptRef stays null — the saved transcript is
        // already on the server and the next save concatenates onto whatever the
        // stop-time final save reads; we never lose the persisted copy because
        // saveTranscript only ever PATCHes (existing + new), never deletes.
        // Only the owning generation may clear the hold-off.
        if (seedGenerationRef.current === generation) {
          resumePrefetchPendingRef.current = false
        }
      }
    })()

    // Start recording immediately — this is what makes Resume feel instant.
    // If the native start is rejected (e.g. a stale recording_window after a
    // WebView reload) the resume silently yields a dead transcript — emit a
    // durable failure breadcrumb before rethrowing so the incident is visible.
    try {
      await bindAndStartForCapture(existingCaptureId, { skipTranscriptSeed: true, title: opts?.title })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const reason = message.includes('already active') ? 'already_active' : 'other'
      trackRecordingEvent('resume_failed', { capture_id: existingCaptureId, reason, message })
      throw err
    }

    // Notify the UI
    window.dispatchEvent(
      new CustomEvent('ni:capture-resumed', {
        detail: { captureId: existingCaptureId },
      }),
    )

    // Ensure the prefetch settles so existingTranscriptRef is populated for the
    // first real save. This await happens AFTER the mic is already live, so it
    // doesn't delay the user — it just guarantees correctness downstream.
    await prefetch
    } finally {
      startingRef.current = false
    }
  }, [bindAndStartForCapture])

  // On mount: check for an interrupted capture and offer to resume it
  const recoveryAttemptedRef = useRef(false)
  useEffect(() => {
    if (recoveryAttemptedRef.current) return
    recoveryAttemptedRef.current = true

    const marker = readRecoveryMarker()
    if (!marker) return
    const captureId = marker.captureId

    // Stale check
    if (Date.now() - marker.savedAt > RECOVERY_MAX_AGE) {
      console.log('[RecordingProvider] Recovery marker too old, discarding')
      trackRecordingEvent('recovery_skipped', { capture_id: captureId, reason: 'stale' })
      clearRecoveryMarker()
      return
    }

    // Verify the capture still exists before resuming. Only an answer about
    // the capture (gone, or ended) drops the marker; a failed check is retried,
    // and if every try fails the marker stays for the next launch. It used to
    // be dropped on any non-OK response or network error, losing the resume.
    // A recording that started meanwhile (the HUD's Start, the tray) owns the
    // session and the marker now: never prompt over it.
    const superseded = () => {
      if (!captureIdRef.current && !startingRef.current) return false
      trackRecordingEvent('recovery_skipped', { capture_id: captureId, reason: 'recording' })
      return true
    }
    void (async () => {
      for (let attempt = 0; attempt < RECOVERY_CHECK_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, RECOVERY_CHECK_RETRY_MS * attempt))
        if (superseded()) return
        let res: Response
        const ac = new AbortController()
        const timeout = setTimeout(() => ac.abort(), RECOVERY_CHECK_TIMEOUT_MS)
        try {
          res = await fetch(`/api/account/captures/${captureId}`, { signal: ac.signal })
        } catch {
          continue
        } finally {
          clearTimeout(timeout)
        }
        if (res.status === 404) {
          trackRecordingEvent('recovery_skipped', { capture_id: captureId, reason: 'not_found' })
          clearRecoveryMarker()
          return
        }
        if (!res.ok) continue
        const data = await res.json().catch(() => null)
        if (!data?.capture) continue
        // Only offer recovery if the capture hasn't already been ended
        if (data.capture.ended_at) {
          console.log('[RecordingProvider] Capture already ended, skipping recovery')
          trackRecordingEvent('recovery_skipped', { capture_id: captureId, reason: 'ended' })
          clearRecoveryMarker()
          return
        }
        if (superseded()) return
        // Don't silently re-open the mic. Surface a prompt and let the user
        // decide — confirmRecovery() resumes, dismissRecovery() ends the capture.
        console.log(`[RecordingProvider] Found interrupted capture, prompting: ${captureId}`)
        trackRecordingEvent('recovery_prompted', { capture_id: captureId })
        setPendingRecovery({
          captureId,
          title: (data.capture.title as string) || 'your interrupted capture',
        })
        return
      }
      trackRecordingEvent('recovery_skipped', { capture_id: captureId, reason: 'check_failed' })
    })()
  }, [])

  // A recording that starts while the prompt is up (the HUD and tray live in
  // other windows) answers it: the prompt goes, and neither choice may run
  // against the session now live (Resume would re-bind it, End capture would
  // close the capture it may be recording into).
  useEffect(() => {
    if (captureId) setPendingRecovery(null)
  }, [captureId])

  /** User accepted the recovery prompt — resume the interrupted capture. */
  const confirmRecovery = useCallback(async () => {
    const pending = pendingRecovery
    if (!pending) return
    setPendingRecovery(null)
    if (captureIdRef.current) return
    await resumeCapture(pending.captureId)
  }, [pendingRecovery, resumeCapture])

  /** User declined recovery — end the capture as Stop would and drop the marker,
   *  so it's never offered again and doesn't linger as a phantom "live" capture. */
  const dismissRecovery = useCallback(async () => {
    const pending = pendingRecovery
    setPendingRecovery(null)
    // The marker belongs to a session that started meanwhile, if any.
    if (captureIdRef.current) return
    clearRecoveryMarker()
    if (!pending) return
    trackRecordingEvent('recovery_declined', { capture_id: pending.captureId })
    // Best-effort. The server closes the capture at its last write (the
    // transcript locks) and, when it has a meeting in it, runs the
    // end-of-meeting pass Stop would have run: extraction, then Triage. A bare
    // PATCH of ended_at used to close it and run nothing.
    try {
      await fetch(`/api/account/captures/${pending.captureId}/decline-recovery`, { method: 'POST' })
    } catch { /* best-effort — the marker is already cleared, so it won't reprompt; the sweep finishes it */ }
  }, [pendingRecovery])

  /** Wrapped stopRecording: saves final transcript + ended_at, then stops */
  const stopRecordingWithCapture = useCallback(async () => {
    // Guard against double / concurrent invocation (e.g. a double-clicked Stop
    // button). Without this, two runs would each save the transcript and fire a
    // batch POST — and two batch runs racing the pending-delete is unsafe.
    if (stoppingRef.current) return
    stoppingRef.current = true

    // Clear the recovery marker SYNCHRONOUSLY, before any await. The moment the
    // user clicks Stop their intent is final: this capture must never be auto-
    // resumed on a restart. Everything below (stop, transcript save, the ended_at
    // PATCH, the batch run) is async and can take many seconds or fail — if the
    // app is restarted in that window while the marker still exists and ended_at
    // hasn't landed yet, the on-mount recovery effect would silently resume the
    // capture ("it came back after restart"). Removing the marker first closes
    // that window entirely; the later clearRecoveryMarker() in the cid block is
    // now just belt-and-suspenders.
    clearRecoveryMarker()

    const cid = captureIdRef.current
    // Null the ref immediately so any concurrent caller that slipped past the
    // flag check sees no capture and exits via the `if (cid)` guard below.
    captureIdRef.current = null
    // Snapshot speaker data before stop clears it
    const speakerContacts = { ...recordingRef.current.speakerContacts }
    // elapsed is an external store now — read the current value via the accessor.
    const elapsed = recordingRef.current.getElapsed()

    // Show the "processing" indicator the INSTANT Stop is clicked, before any
    // awaits. When live mode is off, an end-of-meeting batch run will extract
    // the summary/actions — but that's gated behind stopRecording() + the
    // transcript save + the ended_at PATCH (1–2 s of awaited round-trips). If we
    // waited until the batch run actually started to signal the UI, the panel
    // would sit empty for that whole window and read as "nothing happened". So
    // we fire the start event synchronously here; the success ('capture-ended')
    // and failure ('capture-processing-error') events below still clear it.
    if (cid && !liveModeEnabledRef.current) {
      window.dispatchEvent(
        new CustomEvent('ni:capture-processing-start', { detail: { captureId: cid } }),
      )
    }

    try {
    // Stop the recording first (this sets recordingResult)
    await recordingRef.current.stopRecording()

    if (cid) {
      // If a resume's prior-transcript prefetch is somehow still in flight (user
      // resumed and immediately stopped), wait for it to settle before the final
      // save — otherwise the guard in saveTranscript would skip it and we'd lose
      // this session's new segments. Bounded so a hung fetch can't block stop.
      if (resumePrefetchPendingRef.current) {
        const deadline = Date.now() + 5_000
        while (resumePrefetchPendingRef.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50))
        }
        // If it never settled, force the guard off so the final save proceeds.
        // existingTranscriptRef may still be null, but the server already holds
        // the prior transcript and saveTranscript only ever appends — worst case
        // this PATCH writes the new segments alone, which the prior persisted
        // copy already supersedes on the server until the next read.
        resumePrefetchPendingRef.current = false
      }

      // Save final transcript — force, so the last segments persist even if the
      // count matches the previous auto-save (e.g. stopped during silence).
      // Authoritative final save, with ONE quiet retry: a transient rejection
      // that succeeds on retry must not alarm the user; a double failure is
      // loud (toast + final_transcript_save_failed) via saveTranscript itself.
      const finalSaved = await saveTranscript(cid, true, { quiet: true })
      if (!finalSaved) {
        await saveTranscript(cid, true)
      }

      // ── The transcript-durability signal (audit: transcript tail loss) ──────
      // Fires the INSTANT the authoritative full-text force-PATCH has been
      // awaited, and says exactly one thing: `captures.transcript` for this id
      // now holds the complete meeting text. Nothing else is claimed — in
      // particular ended_at has NOT landed yet (its PATCH is the next statement),
      // so a subscriber must treat this as a transcript signal only.
      //
      // WHY IT IS SEPARATE FROM 'ni:capture-ended'. capture-ended is an
      // EXTRACTION-lifecycle event: on the default configuration (live mode OFF
      // + panel mounted) the block below hands the batch run to the panel and
      // deliberately does not dispatch it, waiting for the panel's own dispatch
      // from streaming onDone. A batch that 504s on a very long transcript (or a
      // panel that unmounts mid-stream) therefore never produces capture-ended
      // at all — and the transcript reader keyed off it never runs, leaving a
      // pre-final-save row cached as if authoritative. Keying transcript
      // durability to extraction success was the defect; this decouples them.
      //
      // FIRING GUARANTEES (the whole point — do not add conditions here):
      //  • EVERY stop path that reached a bound capture id: live mode on/off,
      //    panel mounted or not, extraction succeeded / failed / never started.
      //  • Placed BEFORE the ended_at PATCH deliberately: that PATCH is wrapped
      //    in its own try/catch and can fail, and no branch below this line may
      //    ever be able to skip the dispatch.
      //  • Exactly once per stop — stoppingRef guards re-entry at the top and
      //    this line is straight-line code with no loop or retry above it.
      //    (Harmless if a subscriber sees it twice regardless: the intended
      //    consumption is an idempotent re-read of the transcript column.)
      //  • NOT dispatched on discard — that path deletes the row and never
      //    force-saves; there is no durable transcript to announce.
      window.dispatchEvent(
        new CustomEvent('ni:capture-transcript-saved', { detail: { captureId: cid } }),
      )

      // Update capture with ended_at and cumulative duration
      const totalDuration = previousDurationRef.current + elapsed
      const endedAt = new Date().toISOString()
      try {
        const res = await fetch(`/api/account/captures/${cid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ended_at: endedAt,
            duration_seconds: totalDuration,
            ai_processed: true,
          }),
        })
        // Fan the stop out locally (same pattern as the panel's title rename):
        // the PATCH's realtime echo is dropped client-wide — saveTranscript
        // armed the self-echo guard just above — and later realtime events
        // forward only THEIR changed columns, so without this emit no open
        // list on this client ever learns the capture ended (rows would read
        // as still-recording until a full refetch). Emitting re-arms the
        // guard, which is harmless (it is already armed).
        if (res.ok) {
          emitEntityUpdated({
            entityType: 'capture',
            id: cid,
            fields: { ended_at: endedAt, duration_seconds: totalDuration, ai_processed: true },
          })
        }
      } catch (err) {
        console.warn('[RecordingProvider] Failed to update capture end:', err)
      }

      // Post-extraction work that depends on the summary EXISTING: generate a
      // real title (reads ai_summary; skips if absent) and index for semantic
      // search. Must run AFTER the batch extraction completes — not before, or
      // the title generator finds no summary and bails. Both fire-and-forget.
      // `captureProcessed`: the record is final and NO batch pass will run, so
      // index-content also emits flow/capture.processed + stamps
      // batch_processed_at (what the batch finalize does on the other paths).
      const runPostExtraction = (capId: string, opts?: { captureProcessed?: boolean }) => {
        fetch(`/api/account/captures/${capId}/generate-title`, { method: 'POST' })
          .catch(() => {})

        fetch(`/api/account/captures/${capId}`)
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (!data?.capture) return
            const c = data.capture
            return fetch('/api/ai/index-content', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                captureId: capId,
                title: c.title,
                ai_summary: c.ai_summary,
                content: c.content,
                project_id: c.project_id,
                ...(opts?.captureProcessed ? { capture_processed: true } : {}),
              }),
            })
          })
          .catch((err) => console.warn('[RecordingProvider] Failed to index capture:', err))
      }

      // The live agent's LAST turn keeps running after stopRecording() returns
      // (the hook detaches it as background finalizing, up to 45s, and flags it
      // as isAgentFinalizing). A path that closes the record without a batch
      // pass must let that turn land first, or Triage would judge a capture
      // whose final proposals aren't staged yet. Bounded: never blocks past the
      // hook's own timeout by much.
      const waitForLiveAgentFinalizing = async (maxMs = 50_000) => {
        const started = Date.now()
        // The flag is set on the render after stop — give it a beat to propagate.
        await new Promise((r) => setTimeout(r, 500))
        while (recordingRef.current.isAgentFinalizing && Date.now() - started < maxMs) {
          await new Promise((r) => setTimeout(r, 250))
        }
      }

      // ── End-of-meeting batch run ──
      // The pass that WRITES THE RECORD. It runs whenever the notes still have
      // to be written — see `shouldRunPostLiveBatch` for the three cases:
      //   - live mode was OFF (nothing was processed during the meeting),
      //   - the live agent was ASSIST-ONLY (it helped the user in the room and
      //     deliberately wrote nothing, so without this the capture ends blank),
      //   - or the workspace's edition names a BATCH default persona, which is
      //     the edition declaring that a specific agent writes the finished
      //     record regardless of what happened live.
      // One batch run over the full transcript through the SAME live-agent
      // pipeline (same prompt, tools, tables, and confidence auto-accept).
      // Best-effort: a failure here just means the user can hit "Reprocess".
      //
      // Who runs it: if the capture's detail panel is mounted, hand the run to
      // IT so the user watches the extraction stream in (Granola-style). The
      // panel fires 'capture-ended' when its stream finishes, which triggers the
      // post-extraction work below at the right time. If no panel is mounted, we
      // run the guaranteed (non-stream) batch here ourselves so extraction is
      // never dropped — then do the post-work + capture-ended inline.
      const runBatch = shouldRunPostLiveBatch({
        liveMode: liveModeEnabledRef.current,
        liveAgentAssistOnly: liveAgentAssistOnlyRef.current,
        hasBatchDefault: hasBatchDefaultRef.current,
      })
      if (runBatch) {
        if (hasStreamingPanel(cid)) {
          // Panel-owned streaming run. Defer post-extraction + capture-ended
          // until the panel signals completion (its 'capture-ended' dispatch).
          const capId = cid
          // Safety timeout: if the panel unmounts mid-stream (user navigates
          // away), its streaming hook aborts and NEVER dispatches capture-ended,
          // so this listener would leak forever and wedge batchRunningRef /
          // liveAgentStatus on 'finalizing'. The timeout guarantees cleanup +
          // a reset to idle. Generous (well past a normal batch) so it never
          // fires on a slow-but-live run.
          let settled = false
          const cleanup = () => {
            if (settled) return
            settled = true
            window.removeEventListener('ni:capture-ended', onPanelDone)
            clearTimeout(timeoutId)
            batchRunningRef.current = false
            publishLiveAgentStatus('idle')
          }
          const onPanelDone = (e: Event) => {
            const d = (e as CustomEvent).detail as { captureId: string }
            if (d.captureId !== capId) return
            cleanup()
            runPostExtraction(capId)
          }
          const timeoutId = setTimeout(() => {
            // Panel never signaled (likely unmounted mid-stream). Reset state;
            // don't run post-extraction (the summary may not exist). The user
            // can Reprocess to re-run if needed.
            cleanup()
          }, 120_000)
          window.addEventListener('ni:capture-ended', onPanelDone)
          batchRunningRef.current = true
          publishLiveAgentStatus('finalizing')
          requestStreamingExtraction({
            captureId: cid,
            mode: 'batch',
            // End-of-call handoff rule (see batchRecipeId): a batch run never
            // inherits a live-lock persona.
            recipeId: batchRecipeId(),
          })
          // Don't await — the panel owns this run. Skip the inline post-work +
          // capture-ended below (the listener above handles them on completion).
        } else {
          // No panel mounted — run the guaranteed batch ourselves and await it
          // (the 'capture-processing-start' event was already dispatched at the
          // top of this function so the indicator shows immediately).
          batchRunningRef.current = true
          publishLiveAgentStatus('finalizing')
          // Track whether extraction actually produced results, so we only run
          // post-work + signal capture-ended on success (not after a failure,
          // which would waste a title/index pass and prematurely tear down UI).
          let extractionSucceeded = false
          try {
            // ── The server batch extraction ──
            // End-of-call handoff rule (see batchRecipeId): a batch run never
            // inherits a live-lock persona.
            extractionSucceeded = await runApiBatchExtraction(cid, batchRecipeId() ?? null)
          } catch (err) {
            console.warn('[RecordingProvider] End-of-meeting batch run failed:', err)
            window.dispatchEvent(
              new CustomEvent('ni:capture-processing-error', { detail: { captureId: cid } }),
            )
            try {
              const { toast } = await import('sonner')
              toast.error('Couldn’t process this meeting automatically. Open it and click Reprocess to try again.')
            } catch { /* ignore */ }
          } finally {
            batchRunningRef.current = false
            publishLiveAgentStatus('idle')
          }
          // Only run post-work + signal capture-ended when extraction actually
          // produced results. On failure we already dispatched a processing-error
          // and leave the capture for the user to Reprocess.
          if (extractionSucceeded) {
            runPostExtraction(cid)
            window.dispatchEvent(
              new CustomEvent('ni:capture-ended', { detail: { captureId: cid } }),
            )
          }
        }
      } else {
        // Live mode ON with a note-taking live agent and no edition batch
        // persona — the summary was written incrementally during the meeting,
        // so a batch run would only duplicate it. Signal capture-ended now; do
        // the post-work once the live agent's last turn has landed, and CLOSE
        // the record there (captureProcessed → flow/capture.processed +
        // batch_processed_at). Before this, no capture on this path ever fired
        // the loop trigger, so Triage never ran on it (precondition A4,
        // docs/plans/agent-orchestration-investigation.md §1.1).
        void waitForLiveAgentFinalizing().then(() => runPostExtraction(cid, { captureProcessed: true }))
        window.dispatchEvent(
          new CustomEvent('ni:capture-ended', { detail: { captureId: cid } }),
        )
      }

      // Re-post speaker assignments under the correct capture ID
      // (the hook posts to Tauri's sessionId which differs from our captureId)
      const confirmedSpeakers = Object.entries(speakerContacts)
        .filter(([, c]) => c.contactId && !c.isSuggestion)
        .map(([speakerId, c]) => ({
          speaker_label: speakerId,
          contact_id: c.contactId,
          contact_name: c.contactName,
          voice_match_confidence: c.confidence,
        }))

      if (confirmedSpeakers.length > 0) {
        fetch(`/api/account/captures/${cid}/speaker-assignments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: confirmedSpeakers }),
        }).catch((err) => console.warn('[RecordingProvider] Failed to save speaker assignments:', err))
      }

      // captureIdRef was already nulled at the top (double-call guard).
      setCaptureId(null)
      existingTranscriptRef.current = null
      previousDurationRef.current = 0
      // Invalidate any in-flight seed prefetch — a late GET from this (now
      // stopped) session must not write refs under a subsequent session.
      seedGenerationRef.current += 1
      setCorrectionsLog([])
      clearRecoveryMarker()
    }

    // ── Incident hotfix H3: release the session accumulators at STOP ────────
    // The per-word segment payloads, the merger's parallel copy, and the
    // activity feed used to survive until the NEXT start (~4–8MB after a long
    // call). Everything that reads them post-stop has run by here: the hook's
    // stop collected voice-ID assignments, the force save persisted the final
    // transcript, and the speaker-assignment POST used the snapshot taken at
    // the top.
    //
    // The text-bearing segments themselves are deliberately KEPT (as on main),
    // so the header's transcript pane never falls back to a capture row whose
    // transcript may not have caught up with the final save yet — see the
    // contract in clearSessionAccumulators' doc. The derived speaker signals
    // are preserved too (post-session review pills key off detectedSpeakers).
    recordingRef.current.clearSessionAccumulators()
    } finally {
      stoppingRef.current = false
    }
    // Uses recordingRef.current (not `recording`) so it stays identity-stable for
    // the stable context value. publishLiveAgentStatus is identity-stable (deps []).
    // batchRecipeId is identity-stable (deps []), like publishLiveAgentStatus.
  }, [saveTranscript, publishLiveAgentStatus, batchRecipeId])

  /** Discard: stop recording, delete the capture, and navigate away */
  const discardRecordingWithCapture = useCallback(async () => {
    const cid = captureIdRef.current

    // Stop the recording (skip saving transcript/assignments)
    await recordingRef.current.stopRecording()

    // Delete the capture from the database
    if (cid) {
      let deleted = false
      try {
        const res = await fetch(`/api/account/captures/${cid}`, { method: 'DELETE' })
        deleted = res.ok
        if (!res.ok) console.warn('[RecordingProvider] Failed to delete capture: HTTP', res.status)
      } catch (err) {
        console.warn('[RecordingProvider] Failed to delete capture:', err)
      }
      captureIdRef.current = null
      setCaptureId(null)
      clearRecoveryMarker()

      if (deleted) {
        // Close what was opened for the deleted capture
        navigateRef.current?.(null, { discardedCaptureId: cid })
      } else {
        // The recording is stopped but the capture row survived: keep its card
        // open (it can be deleted from there) and say so rather than claim a discard.
        toast.error('Couldn’t delete the capture. It’s still in your Captures.')
      }
    }
    // Discard keeps nothing — drop the in-memory session accumulators too,
    // segments INCLUDED (incident hotfix H3). Unlike stop, the capture row is
    // deleted and we navigate away, so no post-stop reader of the transcript
    // pane survives and there is nothing to keep the text for.
    recordingRef.current.clearSessionAccumulators({ dropSegments: true })
    // Uses recordingRef.current so it stays identity-stable.
  }, [])

  const addCorrection = useCallback((correction: AgentCorrection) => {
    setCorrectionsLog((prev) => [...prev, correction])
  }, [])

  const registerNavigate = useCallback((fn: RecordingNavigateFn, goBack?: RecordingNavigateBackFn) => {
    navigateRef.current = fn
    navigateBackRef.current = goBack ?? null
  }, [])

  const unregisterNavigate = useCallback(() => {
    navigateRef.current = null
    navigateBackRef.current = null
  }, [])

  // The volatile full context value. Memoized over EXPLICITLY ENUMERATED members
  // rather than [recording] — `useRecording` returns a fresh object literal every
  // render, so a naive [recording] dep would invalidate the memo on every render
  // (audio frames included) and defeat the whole point. Enumerating every field
  // means the reference changes only when a field actually changes. Now that the
  // audio-frame-rate signals (levels/elapsed) AND the ~150ms transcript array are
  // external stores read via useAudioLevels()/useRecordingElapsed()/
  // useTranscriptSegments() — NOT context fields — this value's identity is stable
  // across level frames AND transcript flushes. As of the finding-7 migration the
  // per-utterance signals (finalSegmentCount / detectedSpeakers / agentActivity /
  // liveAgentStatus) are gone from here too — they are ref-backed stores read at
  // the leaf via useFinalSegmentCount() / useDetectedSpeakers() /
  // useAgentActivity() / useLiveAgentStatus(). NOTHING that changes during a
  // recording remains in this value: its identity is now stable for a whole
  // meeting, so the capture detail panel does not re-render at all.
  //
  // ⚠️ When you add a field to useRecording's return, add it to BOTH the object
  // below AND the deps array, mirroring the discipline used for `stableValue` —
  // UNLESS it changes at speech/frame cadence, in which case it belongs in a
  // ref-backed store with a leaf hook instead (see LeafOnlySignal above), never
  // in this value.
  const value = useMemo<RecordingState>(() => ({
    ...recording,
    captureId,
    isStarting,
    startRecording: startRecordingWithCapture,
    startRecordingForCapture,
    resumeCapture,
    pendingRecovery,
    confirmRecovery,
    dismissRecovery,
    stopRecording: stopRecordingWithCapture,
    discardRecording: discardRecordingWithCapture,
    agentId,
    setAgentId,
    setPostLiveBatchHints,
    liveModeEnabled,
    setLiveModeEnabled,
    flushTranscriptForAgent,
    correctionsLog,
    addCorrection,
    registerNavigate,
    unregisterNavigate,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `recording` is spread but its fields are enumerated individually below; a single [recording] dep would churn every render (useRecording returns a fresh literal each render)
  }), [
    // ── useRecording fields (each must be listed; the `...recording` spread
    //    can't be tracked by a single dep since it's a fresh literal per render) ──
    recording.isRecording,
    recording.isPaused,
    recording.getLevels,
    recording.subscribeLevels,
    recording.getElapsed,
    recording.subscribeElapsed,
    recording.getTranscriptSegmentsSnapshot,
    recording.subscribeTranscriptSegments,
    recording.getFinalSegmentCount,
    recording.subscribeFinalSegmentCount,
    recording.getDetectedSpeakers,
    recording.subscribeDetectedSpeakers,
    recording.getAgentActivity,
    recording.subscribeAgentActivity,
    recording.getAutoAcceptTick,
    recording.subscribeAutoAcceptTicks,
    recording.recordingError,
    recording.recordingResult,
    recording.systemAudioStatus,
    recording.transcriptionStatus,
    recording.postSessionReview,
    recording.speakerNames,
    recording.speakerContacts,
    recording.selfDemotedLabels,
    recording.selfSuggestion,
    recording.voiceIdReady,
    recording.isAgentFinalizing,
    recording.startRecording,
    recording.stopRecording,
    recording.clearSessionAccumulators,
    recording.pauseRecording,
    recording.resumeRecording,
    recording.acceptSuggestion,
    recording.dismissSuggestion,
    recording.assignContact,
    recording.confirmSelf,
    recording.dismissSelf,
    recording.unlinkSpeaker,
    recording.renameSpeaker,
    recording.getEmbeddingCount,
    recording.confirmPostSessionSpeaker,
    recording.reassignPostSessionSpeaker,
    recording.correctPostSessionSpeaker,
    recording.dismissPostSessionReview,
    recording.requestRecordTurn,
    // ── provider-level members ──
    captureId,
    isStarting,
    startRecordingWithCapture,
    startRecordingForCapture,
    resumeCapture,
    pendingRecovery,
    confirmRecovery,
    dismissRecovery,
    stopRecordingWithCapture,
    discardRecordingWithCapture,
    agentId,
    setAgentId,
    setPostLiveBatchHints,
    liveModeEnabled,
    setLiveModeEnabled,
    flushTranscriptForAgent,
    correctionsLog,
    addCorrection,
    registerNavigate,
    unregisterNavigate,
  ])

  // Stable subset, memoized over individually-stable members (all the action
  // functions are identity-stable useCallbacks; the rest are primitives). Its
  // reference therefore changes only when one of those actually changes — NOT on
  // every audio-level/elapsed/transcript update. Consumers that read only this
  // (tab bar, capture button, tray handler, etc.) stop re-rendering ~10×/s during
  // a recording. This is the core fix for the long-session sluggishness.
  const stableValue = useMemo<RecordingStableState>(() => ({
    isRecording: recording.isRecording,
    captureId,
    isStarting,
    recordingError: recording.recordingError,
    transcriptionStatus: recording.transcriptionStatus,
    pendingRecovery,
    startRecording: startRecordingWithCapture,
    startRecordingForCapture,
    stopRecording: stopRecordingWithCapture,
    resumeCapture,
    discardRecording: discardRecordingWithCapture,
    confirmRecovery,
    dismissRecovery,
    registerNavigate,
    unregisterNavigate,
    isPaused: recording.isPaused,
    isAgentFinalizing: recording.isAgentFinalizing,
    pauseRecording: recording.pauseRecording,
    resumeRecording: recording.resumeRecording,
    flushTranscriptForAgent,
    requestRecordTurn: recording.requestRecordTurn,
    getTranscriptSegments,
    getLevels: recording.getLevels,
    subscribeLevels: recording.subscribeLevels,
    getElapsed: recording.getElapsed,
    subscribeElapsed: recording.subscribeElapsed,
    getTranscriptSegmentsSnapshot: recording.getTranscriptSegmentsSnapshot,
    subscribeTranscriptSegments: recording.subscribeTranscriptSegments,
    getFinalSegmentCount: recording.getFinalSegmentCount,
    subscribeFinalSegmentCount: recording.subscribeFinalSegmentCount,
    getDetectedSpeakers: recording.getDetectedSpeakers,
    subscribeDetectedSpeakers: recording.subscribeDetectedSpeakers,
    getAgentActivity: recording.getAgentActivity,
    subscribeAgentActivity: recording.subscribeAgentActivity,
    getLiveAgentStatus,
    subscribeLiveAgentStatus,
    getAutoAcceptTick: recording.getAutoAcceptTick,
    subscribeAutoAcceptTicks: recording.subscribeAutoAcceptTicks,
  }), [
    recording.isRecording,
    captureId,
    isStarting,
    recording.recordingError,
    recording.transcriptionStatus,
    pendingRecovery,
    startRecordingWithCapture,
    startRecordingForCapture,
    stopRecordingWithCapture,
    resumeCapture,
    discardRecordingWithCapture,
    confirmRecovery,
    dismissRecovery,
    registerNavigate,
    unregisterNavigate,
    recording.isPaused,
    recording.isAgentFinalizing,
    recording.pauseRecording,
    recording.resumeRecording,
    flushTranscriptForAgent,
    recording.requestRecordTurn,
    getTranscriptSegments,
    // External-store accessors — identity-stable, but listed for correctness.
    recording.getLevels,
    recording.subscribeLevels,
    recording.getElapsed,
    recording.subscribeElapsed,
    recording.getTranscriptSegmentsSnapshot,
    recording.subscribeTranscriptSegments,
    recording.getFinalSegmentCount,
    recording.subscribeFinalSegmentCount,
    recording.getDetectedSpeakers,
    recording.subscribeDetectedSpeakers,
    recording.getAgentActivity,
    recording.subscribeAgentActivity,
    getLiveAgentStatus,
    subscribeLiveAgentStatus,
    recording.getAutoAcceptTick,
    recording.subscribeAutoAcceptTicks,
  ])

  return (
    <RecordingStableContext.Provider value={stableValue}>
      <RecordingContext.Provider value={value}>
        {children}
        {/* Mic-capture failure dialog (web). Explains permission/device issues
            instead of a stray red error string. "Try again" re-runs start. */}
        <MicPermissionDialog
          kind={micCaptureError}
          onClose={() => setMicCaptureError(null)}
          onRetry={() => {
            setMicCaptureError(null)
            void startRecordingWithCapture()
          }}
        />
      </RecordingContext.Provider>
    </RecordingStableContext.Provider>
  )
}

export function useRecordingContext() {
  const ctx = useContext(RecordingContext)
  if (!ctx) throw new Error('useRecordingContext must be used within RecordingProvider')
  return ctx
}

/** Optional version — returns null when not inside RecordingProvider (e.g. onboarding) */
export function useOptionalRecordingContext() {
  return useContext(RecordingContext)
}

/** Subscribe to the STABLE recording subset (actions + low-frequency flags) only.
 *  Use this instead of useRecordingContext() in components that don't need the
 *  high-frequency live state (levels/elapsed/transcriptSegments) — they won't
 *  re-render on every audio frame during a recording. */
export function useRecordingStable() {
  const ctx = useContext(RecordingStableContext)
  if (!ctx) throw new Error('useRecordingStable must be used within RecordingProvider')
  return ctx
}

/** Optional version of useRecordingStable — null outside the provider. */
export function useOptionalRecordingStable() {
  return useContext(RecordingStableContext)
}

// ── Leaf hooks for the audio-frame-rate signals ─────────────────────────────
// These subscribe to the ref-backed external stores in useRecording via
// useSyncExternalStore, so ONLY the component that calls them re-renders on each
// audio frame (levels ~10×/s) or timer tick (elapsed 1×/s). Everything else that
// reads the recording context is insulated. Mount these at the LOWEST possible
// leaf (the waveform canvas, the timer <span>) — never in a big panel.

/** Zero payload returned when mounted outside RecordingProvider. Frozen +
 *  module-constant so getSnapshot returns a stable reference (a fresh object each
 *  call would make useSyncExternalStore throw "getSnapshot should be cached"). */
const ZERO_LEVELS: AudioLevelPayload = { micLevel: 0, systemLevel: 0, timestamp: 0 }
/** Frozen module-constant empty array — the stable snapshot when there are no
 *  segments / mounted outside the provider (a fresh [] each call would make
 *  useSyncExternalStore throw "getSnapshot should be cached"). */
const EMPTY_SEGMENTS: ReturnType<RecordingStableState['getTranscriptSegmentsSnapshot']> = []
const noopSubscribe = () => () => {}

/** Subscribe to the latest audio-level payload (mic/system). Re-renders the
 *  calling component on each published level frame — nothing else. Returns static
 *  zeros (no-op subscribe) when mounted outside the provider. */
export function useAudioLevels(): AudioLevelPayload {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeLevels ?? noopSubscribe,
    ctx?.getLevels ?? (() => ZERO_LEVELS),
    () => ZERO_LEVELS, // getServerSnapshot — SSR renders no live audio
  )
}

/** Subscribe to the elapsed recording seconds. Re-renders the calling component
 *  once per second — nothing else. Returns 0 (no-op subscribe) outside the
 *  provider. */
export function useRecordingElapsed(): number {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeElapsed ?? noopSubscribe,
    ctx?.getElapsed ?? (() => 0),
    () => 0, // getServerSnapshot — SSR has no elapsed time
  )
}

/** Subscribe to the live transcript-segment array. Re-renders the calling
 *  component on each ~150ms transcript flush — nothing else that reads the
 *  recording context does. Mount this at the LOWEST leaf that paints the live
 *  transcript so the surrounding panel stays off the per-flush render path.
 *  Returns a frozen empty array (no-op subscribe) outside the provider. */
export function useTranscriptSegments(): ReturnType<RecordingStableState['getTranscriptSegmentsSnapshot']> {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeTranscriptSegments ?? noopSubscribe,
    ctx?.getTranscriptSegmentsSnapshot ?? (() => EMPTY_SEGMENTS),
    () => EMPTY_SEGMENTS, // getServerSnapshot — SSR renders no live transcript
  )
}

// ── Leaf hooks for the per-utterance signals (audit finding 7) ──────────────
// finalSegmentCount / detectedSpeakers / agentActivity / liveAgentStatus change
// on finalized utterances and live-agent turns — far rarer than audio frames,
// but frequent enough that carrying them as context fields re-rendered the full
// capture detail panel (×2 mounted copies) 6–20×/min all meeting. These
// subscribe to their ref-backed stores instead; the context fields they replace
// are DEPRECATED and disappear in Wave 2.

/** Frozen module-constant fallbacks — getSnapshot must return a stable
 *  reference or useSyncExternalStore throws "getSnapshot should be cached". */
const EMPTY_SPEAKERS: string[] = []
const EMPTY_ACTIVITY: AgentActivityEvent[] = []

/** Subscribe to the live final-segment count. Re-renders the calling component
 *  when a new FINAL lands — never on interim flushes. Returns 0 (no-op
 *  subscribe) outside the provider. */
export function useFinalSegmentCount(): number {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeFinalSegmentCount ?? noopSubscribe,
    ctx?.getFinalSegmentCount ?? (() => 0),
    () => 0, // getServerSnapshot — SSR has no live transcript
  )
}

/** Subscribe to the sorted detected-speaker list. Re-renders the calling
 *  component only when a speaker appears / the set changes (the store preserves
 *  array identity otherwise). Returns a frozen empty array outside the
 *  provider. */
export function useDetectedSpeakers(): string[] {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeDetectedSpeakers ?? noopSubscribe,
    ctx?.getDetectedSpeakers ?? (() => EMPTY_SPEAKERS),
    () => EMPTY_SPEAKERS, // getServerSnapshot — SSR has no live speakers
  )
}

/** Subscribe to the live-agent activity feed. Re-renders the calling component
 *  per appended tool-call event — nothing else. Returns a frozen empty array
 *  outside the provider. */
export function useAgentActivity(): AgentActivityEvent[] {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeAgentActivity ?? noopSubscribe,
    ctx?.getAgentActivity ?? (() => EMPTY_ACTIVITY),
    () => EMPTY_ACTIVITY, // getServerSnapshot — SSR has no live agent
  )
}

/** Subscribe to the live-agent status. Re-renders the calling component on each
 *  status transition (the store notifies only on an actual change). Returns
 *  'idle' (no-op subscribe) outside the provider. */
export function useLiveAgentStatus(): LiveAgentStatus {
  const ctx = useContext(RecordingStableContext)
  return useSyncExternalStore(
    ctx?.subscribeLiveAgentStatus ?? noopSubscribe,
    ctx?.getLiveAgentStatus ?? (() => 'idle' as const),
    () => 'idle' as const, // getServerSnapshot — SSR has no live agent
  )
}

// ── Derived transcript leaves (primitive snapshots) ─────────────────────────
// Some leaves paint one small fact ABOUT the live transcript — whether there is
// any, who is talking — not the transcript itself. These subscribe to the same
// segment store as useTranscriptSegments() but return a PRIMITIVE derived from
// the snapshot, so useSyncExternalStore re-renders the caller only when that
// value actually changes: a ~150ms interim flush that leaves it as it was
// wakes nobody.

type LiveSegments = ReturnType<RecordingStableState['getTranscriptSegmentsSnapshot']>

/** useSyncExternalStore over the segment store, selecting `derive(segments)`.
 *  The derivation re-runs only when the snapshot ARRAY changes identity (React
 *  calls getSnapshot on every notify and every render). `derive` must be a
 *  module-level function — its identity keys the cached selector. */
function useDerivedTranscriptSignal<T extends string | number | boolean | null>(
  derive: (segments: LiveSegments) => T,
  fallback: T,
): T {
  const ctx = useContext(RecordingStableContext)
  const getSegments = ctx?.getTranscriptSegmentsSnapshot
  const getSnapshot = useMemo(() => {
    if (!getSegments) return () => fallback
    let lastSegments: LiveSegments | null = null
    let lastValue = fallback
    return () => {
      const segments = getSegments()
      if (segments !== lastSegments) {
        lastSegments = segments
        lastValue = derive(segments)
      }
      return lastValue
    }
  }, [getSegments, derive, fallback])
  return useSyncExternalStore(
    ctx?.subscribeTranscriptSegments ?? noopSubscribe,
    getSnapshot,
    () => fallback, // getServerSnapshot — SSR has no live transcript
  )
}

function hasAnySegment(segments: LiveSegments): boolean {
  return segments.length > 0
}

/** The speaker of the latest interim (still-forming) segment, else of the
 *  latest final one; null when there are none. The same rule as
 *  activeSpeakerOf in components/capture/live-capture-header.tsx — keep the
 *  two in step. */
function latestSpeakerOf(segments: LiveSegments): string | null {
  if (segments.length === 0) return null
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].isFinal) return segments[i].speaker
  }
  return segments[segments.length - 1].speaker
}

/** Whether the live transcript holds any segment (interim or final). Re-renders
 *  the calling component only when that flips — never on a flush that merely
 *  grows or rewrites the lines. Returns false (no-op subscribe) outside the
 *  provider. */
export function useHasLiveTranscriptSegments(): boolean {
  return useDerivedTranscriptSignal(hasAnySegment, false)
}

/** Who's talking in the live transcript: the speaker of its latest interim
 *  segment, else of its latest final one (null when it's empty). Re-renders the
 *  calling component only when that speaker changes — not per flush. Returns
 *  null (no-op subscribe) outside the provider. */
export function useLiveActiveSpeaker(): string | null {
  return useDerivedTranscriptSignal(latestSpeakerOf, null)
}

// ── Voice ID auto-accept countdown ──────────────────────────────────────────

/** A Voice ID suggestion as speakerContacts holds it. */
type SpeakerSuggestion = RecordingState['speakerContacts'][string]

/** The seconds left on `suggestion`'s auto-accept countdown (a speakerContacts
 *  entry): the latest 1 Hz tick for that entry, else — before its first tick —
 *  the entry's own `autoAcceptCountdown`. Subscribes to the tick store, so each
 *  tick re-renders only the calling component (the countdown in its chip), and
 *  only when its number changed; speakerContacts — and so the recording
 *  context — never changes per tick. Outside the provider: the entry's own
 *  value. */
export function useAutoAcceptCountdown(suggestion: SpeakerSuggestion): number | undefined {
  const ctx = useContext(RecordingStableContext)
  const getTick = ctx?.getAutoAcceptTick
  const ticked = useSyncExternalStore(
    ctx?.subscribeAutoAcceptTicks ?? noopSubscribe,
    () => getTick?.(suggestion) ?? suggestion.autoAcceptCountdown,
    () => suggestion.autoAcceptCountdown, // getServerSnapshot — SSR has no ticks
  )
  // A copy sent to another window (the desktop HUD) has no tick store: it
  // counts down to the moment it runs out itself.
  const deadline = ctx ? undefined : suggestion.autoAcceptAt
  const local = useSecondsUntil(deadline)
  return deadline !== undefined ? local : ticked
}

/** Whole seconds until `at` (epoch ms), kept current by ONE timeout at a time
 *  (to the next whole second), in the calling component alone; undefined
 *  without a deadline. Stops at 0. */
function useSecondsUntil(at: number | undefined): number | undefined {
  const [seconds, setSeconds] = useState<number | undefined>(() =>
    at === undefined ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000)),
  )
  useEffect(() => {
    if (at === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = () => {
      const msLeft = at - Date.now()
      const s = Math.max(0, Math.ceil(msLeft / 1000))
      setSeconds(s)
      if (s > 0) timer = setTimeout(step, msLeft % 1000 || 1000)
    }
    step()
    return () => clearTimeout(timer)
  }, [at])
  return at === undefined ? undefined : seconds
}
